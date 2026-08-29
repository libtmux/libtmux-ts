import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { packageRoot } from "../package_root.js";
import { bindingsFor, fencedBlocks, splitForExecution, type Example } from "./example_harness.js";
import { sweepStrayTmux } from "./tmux_sweep.js";

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

/**
 * Commands a machine running this can be assumed to have.
 *
 * Everything else an example names has to be supplied by the fixture. The
 * distinction is not fussiness: a pane whose command does not exist dies the
 * moment it starts, so an example naming an uninstalled command fails for a
 * reason that has nothing to do with the example — on some machines and not
 * others, which is the worst version of a gate.
 */
const UBIQUITOUS: ReadonlySet<string> = new Set([
  "cat",
  "echo",
  "git",
  "ls",
  "printf",
  "sh",
  "sleep",
  "tail",
  "true",
]);

/**
 * The executables an example asks a pane to run.
 *
 * `shellCommand` and `respawn` replace a pane's process outright. A `sendKeys`
 * string with a space in it is a command line rather than a keypress, and
 * `sendKeys("q")` is the latter.
 */
function commandsNamedBy(example: Example): readonly string[] {
  const found: string[] = [];
  const patterns = [
    /shellCommand:\s*"(?<line>[^"]+)"/gu,
    /\brespawn\(\s*"(?<line>[^"]+)"/gu,
    /\bsendKeys\(\s*"(?<line>[^" ]+ [^"]*)"/gu,
  ];
  for (const pattern of patterns) {
    for (const match of example.code.matchAll(pattern)) {
      const first = (match.groups?.["line"] ?? "").trim().split(/\s+/u)[0];
      if (first !== undefined && first !== "") found.push(first);
    }
  }
  return found;
}
/** Long enough for a real server to answer, short enough to name a deadlock. */
const DEADLINE_MS = 15_000;

interface Outcome {
  readonly detail?: string;
  readonly origin: string;
  readonly state: "covered" | "excused" | "failed" | "ran";
}

/** One callable per block, binding only the names it uses and does not declare. */
function generate(examples: readonly Example[]): string {
  const imports: string[] = [];
  const bodies: string[] = [];
  const taken = new Map<string, string>();
  for (const [index, example] of examples.entries()) {
    const { body, imports: exampleImports } = splitForExecution(example.code, taken);
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
const { STAYS_UP_COMMANDS } = await import("./readme_world.js");
const supplied = new Set([...STAYS_UP_COMMANDS, "make"]);
const unsupplied = blocks
  .filter((block) => block.coverage === undefined)
  .flatMap((block) => commandsNamedBy(block).map((name) => ({ name, origin: block.origin })))
  .filter((named) => !supplied.has(named.name) && !UBIQUITOUS.has(named.name));
if (unsupplied.length > 0) {
  for (const named of unsupplied) {
    process.stderr.write(
      `${named.origin} names \`${named.name}\`, which the fixture does not supply\n`,
    );
  }
  process.stderr.write(
    "\nAdd it to STAYS_UP_COMMANDS in readme_world.ts, or to UBIQUITOUS here if every machine has it.\n",
  );
  process.exit(1);
}

const isolated = await mkdtemp(join(tmpdir(), "ltx-readme-runs-"));
process.env["TMUX_TMPDIR"] = isolated;

const directory = join(packageRoot, "node_modules", ".examples-runs");
await mkdir(directory, { recursive: true });
const modulePath = join(directory, "examples.ts");
const outcomes: Outcome[] = [];

// One run root for every block, so one reap at the end accounts for every
// server this gate started. A block that leaves one behind is a leak whether or
// not its own example passed.
const parent = await makeTestDirectory("ltx-readme-");
const runRoot = join(parent, "run, root");
await prepareRunRoot(runRoot);
const scratch = join(parent, "blocks");
await mkdir(scratch, { recursive: true });
let leaks: readonly string[] = [];
let strayServers: readonly string[] = [];

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
      // Before the directory it lives under is removed: a socket file gone
      // does not stop the daemon behind it, so this has to run first.
      strayServers = await sweepStrayTmux(isolated);
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
if (strayServers.length > 0) {
  process.stderr.write(`${strayServers.join("\n")}\n`);
  process.stderr.write(
    `\n${OUTPUT} examples left tmux servers behind that this package's own fixtures do not track — a block built its own \`new Server()\` and nothing killed it. Killed above; the run is not clean.\n`,
  );
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
