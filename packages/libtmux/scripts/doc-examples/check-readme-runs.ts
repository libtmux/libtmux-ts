import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";
import { packageRoot } from "../package_root.js";
import { bindingsFor, fencedBlocks, type Example } from "./example_harness.js";

/**
 * Run every README example against a real tmux server.
 *
 * Compiling proves a snippet typechecks, which is not the same as proving it
 * works: `window.cmd("display-panes")` satisfied every signature and asked tmux
 * to find a client named `@0`. Running is what found that, and running is all
 * this claims — a block that does not throw is not a block that did the right
 * thing. What it catches is a wrong target, an argument in the wrong position,
 * a command that cannot reach what it names, and a recipe that deadlocks.
 *
 * A block whose effect is not observable this way carries
 *
 *     <!-- static: why -->
 *
 * and is reported as excused rather than passing. Everything else runs, so a
 * block added tomorrow is executed without anyone remembering to say so.
 */

const OUTPUT = "README.md";
/** Long enough for a real server to answer, short enough to name a deadlock. */
const DEADLINE_MS = 15_000;

interface Outcome {
  readonly detail?: string;
  readonly origin: string;
  readonly state: "covered" | "excused" | "failed" | "ran";
}

/**
 * Separate an example's imports from its body, pointing them at this tree.
 *
 * The same bargain the typecheck path makes: a reader's `"libtmux"` is this
 * working tree, so a block is judged against the source rather than against
 * whatever release happens to be installed.
 */
function split(code: string, taken: Map<string, string>): { body: string; imports: string } {
  const imports: string[] = [];
  const body: string[] = [];
  for (const line of code.split("\n")) {
    if (!/^import\s/u.test(line)) {
      body.push(line);
      continue;
    }
    const rewritten = line
      .replace(/"libtmux"/u, '"../../src/index.js"')
      .replace(/"libtmux\/([\w-]+)"/u, '"../../src/$1.js"');
    const named = /^import \{([^}]*)\} from (.*)$/u.exec(rewritten);
    if (named === null) {
      imports.push(rewritten);
      continue;
    }
    const from = named[2] ?? "";
    const kept = (named[1] ?? "")
      .split(",")
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier !== "" && taken.get(specifier) !== from);
    for (const specifier of kept) taken.set(specifier, from);
    if (kept.length > 0) imports.push(`import { ${kept.join(", ")} } from ${from}`);
  }
  return { body: body.join("\n"), imports: imports.join("\n") };
}

/** One callable per block, binding only the names it uses and does not declare. */
function generate(examples: readonly Example[]): string {
  const imports: string[] = [];
  const bodies: string[] = [];
  const taken = new Map<string, string>();
  for (const [index, example] of examples.entries()) {
    const { body, imports: exampleImports } = split(example.code, taken);
    if (exampleImports !== "") imports.push(exampleImports);
    const needed = bindingsFor(body);
    const bind = needed.length === 0 ? "" : `  const { ${needed.join(", ")} } = world;\n`;
    bodies.push(
      `// ${example.origin}\n` +
        `export async function example${String(index)}(world: Record<string, unknown>): Promise<void> {\n` +
        `  void world;\n${bind}${body}\n}\n`,
    );
  }
  return `${imports.join("\n")}\n\n${bodies.join("\n")}`;
}

const readme = await Bun.file(join(packageRoot, OUTPUT)).text();
const blocks = fencedBlocks(readme, (line) => `${OUTPUT}:${String(line)}`);
if (blocks.length === 0) throw new Error(`no \`\`\`ts blocks found in ${OUTPUT}`);

// A block that builds its own `new Server()` reaches tmux's default socket.
// Pointing TMUX_TMPDIR somewhere disposable is what keeps it off the server the
// person running this is sitting in.
const isolated = await mkdtemp(join(tmpdir(), "ltx-readme-runs-"));
process.env["TMUX_TMPDIR"] = isolated;

const directory = join(packageRoot, "node_modules", ".examples-runs");
await mkdir(directory, { recursive: true });
const modulePath = join(directory, "examples.ts");
const outcomes: Outcome[] = [];

// One run root for every block, so one reap at the end can account for every
// server this gate started. A block that leaves one behind is a leak whether or
// not its own example passed, and a gate that starts real servers has to say so
// rather than leaving them for whoever runs it next.
const parent = await makeTestDirectory("ltx-readme-");
const runRoot = join(parent, "run, root");
await prepareRunRoot(runRoot);
const scratch = join(parent, "blocks");
await mkdir(scratch, { recursive: true });
let leaks: readonly string[] = [];

try {
  await writeFile(modulePath, generate(blocks));
  const module_ = (await import(modulePath)) as Record<
    string,
    ((world: Record<string, unknown>) => Promise<void>) | undefined
  >;
  const { buildWorld, disposeWorld } = await import("./readme_world.js");

  for (const [index, block] of blocks.entries()) {
    if (block.coverage?.kind === "static") {
      outcomes.push({ detail: block.coverage.reason, origin: block.origin, state: "excused" });
      continue;
    }
    if (block.coverage?.kind === "runs") {
      // Its twin is executed by the integration suite, and `docs:runnable`
      // holds the block to that file line by line. Running it again here would
      // prove less than the check that already covers it.
      outcomes.push({ detail: block.coverage.source, origin: block.origin, state: "covered" });
      continue;
    }
    const run = module_[`example${String(index)}`];
    if (run === undefined) {
      // Silently skipping would defeat the point: a block nothing generated a
      // function for is a block nobody runs, reported as a clean sweep.
      outcomes.push({
        detail: "no function was generated for this block",
        origin: block.origin,
        state: "failed",
      });
      continue;
    }

    // A block that declares its own server builds its own world; one that uses
    // the ambient names is handed the world the prose describes.
    // eslint-disable-next-line no-await-in-loop -- one block at a time: they share a working directory and a process environment.
    const world = await buildWorld({ code: block.code, index, runRoot, scratch });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // eslint-disable-next-line no-await-in-loop -- a block runs against its own world, not beside another block.
      const outcome = await Promise.race([
        run(world.bindings).then(
          () => undefined,
          (error: unknown) => error as Error,
        ),
        new Promise<Error>((resolve) => {
          timer = setTimeout(
            () => resolve(new Error(`still running after ${String(DEADLINE_MS)}ms`)),
            DEADLINE_MS,
          );
        }),
      ]);
      if (outcome === undefined) outcomes.push({ origin: block.origin, state: "ran" });
      else {
        outcomes.push({
          detail: `${outcome.constructor.name}: ${outcome.message.split("\n")[0] ?? ""}`,
          origin: block.origin,
          state: "failed",
        });
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // eslint-disable-next-line no-await-in-loop -- this world is gone before the next one is built.
      await disposeWorld(world);
    }
  }
} finally {
  await runWithCleanup(
    async () => {
      leaks = (await reapOwnedRunRoot(runRoot)).leaks;
    },
    async () => {
      await rm(parent, { force: true, recursive: true });
      await rm(directory, { force: true, recursive: true });
      await rm(isolated, { force: true, recursive: true });
    },
  );
}

const covered = outcomes.filter((outcome) => outcome.state === "covered");
const failed = outcomes.filter((outcome) => outcome.state === "failed");
const excused = outcomes.filter((outcome) => outcome.state === "excused");
const ran = outcomes.filter((outcome) => outcome.state === "ran");

for (const outcome of failed) {
  process.stderr.write(`${outcome.origin} ${outcome.detail ?? ""}\n`);
}
if (leaks.length > 0) {
  process.stderr.write(`${leaks.join("\n")}\n`);
  process.stderr.write(`\n${OUTPUT} examples left tmux servers behind.\n`);
  process.exit(1);
}
if (failed.length > 0) {
  process.stderr.write(
    `\n${OUTPUT} examples that do not run. Fix the example, or mark it \`<!-- static: why -->\` when its effect cannot be observed here.\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `${OUTPUT} examples: ${String(ran.length)} executed, ${String(covered.length)} covered by a runnable twin, ${String(excused.length)} excused\n`,
);
for (const outcome of excused) {
  process.stdout.write(`  excused ${outcome.origin}: ${outcome.detail ?? ""}\n`);
}
