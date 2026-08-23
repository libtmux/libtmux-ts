import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindingsFor,
  fencedBlocks,
  type Example,
} from "../packages/libtmux/scripts/doc-examples/example_harness.js";
import { sweepStrayTmux } from "../packages/libtmux/scripts/doc-examples/tmux_sweep.js";
import { workspaceDocuments } from "./workspace_documents.js";

/**
 * Run the documents that span more than one package.
 *
 * `typecheck:readme` compiles these and the library's own gate executes its
 * README, which left the recipes above the package — the ones that reach
 * across it to `@libtmux/workspace` and `@libtmux/mcp` — compiled and never
 * run. Those are the recipes a reader meets first.
 *
 * They differ from the library's own blocks in what they assume. A block here
 * writes `new Server()` and expects to find tmux already running, because its
 * reader has tmux already running. So this starts one on an isolated default
 * socket rather than handing over a fixture's, and sweeps it afterwards.
 *
 * Generated into the examples package so `libtmux`, `@libtmux/workspace` and
 * `@libtmux/mcp` resolve the way they resolve for anyone who installed them —
 * no rewriting of import paths, and the blocks run against what the names
 * actually mean.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
/** Long enough for a real server, short enough to name a hang. */
const DEADLINE_MS = 20_000;

/** Commands the recipes name that a machine cannot be assumed to have. */
const STUBS: readonly string[] = Object.freeze(["bun", "git", "vim", "nvim", "npm"]);

interface Outcome {
  readonly detail?: string;
  readonly origin: string;
  readonly state: "covered" | "excused" | "failed" | "ran";
}

function generate(examples: readonly Example[], offset: number): string {
  const imports: string[] = [];
  const bodies: string[] = [];
  const taken = new Map<string, string>();
  for (const [index, example] of examples.entries()) {
    const lines: string[] = [];
    for (const line of example.code.split("\n")) {
      if (!/^import\s/u.test(line)) {
        lines.push(line);
        continue;
      }
      const named = /^import \{([^}]*)\} from (.*)$/u.exec(line);
      if (named === null) {
        imports.push(line);
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
    const body = lines.join("\n");
    const needed = bindingsFor(body);
    const bind = needed.length === 0 ? "" : `  const { ${needed.join(", ")} } = world;\n`;
    bodies.push(
      `// ${example.origin}\n` +
        `export async function example${String(offset + index)}(world: Record<string, unknown>): Promise<void> {\n` +
        `  void world;\n${bind}${body}\n}\n`,
    );
  }
  return `${imports.join("\n")}\n\n${bodies.join("\n")}`;
}

/**
 * Where a document's blocks are generated, and so what their imports mean.
 *
 * A package's README runs from inside that package, against the dependencies
 * that package declares — the same resolution a reader gets, which catches a
 * recipe that only works because something else in the workspace happens to be
 * installed. `@libtmux/workspace` resolves inside its own package by
 * self-reference and `libtmux` resolves to source everywhere, so no import
 * path here is rewritten.
 */
function baseFor(file: string): string {
  if (file.startsWith("packages/mcp/")) return join(repositoryRoot, "packages", "mcp");
  return join(repositoryRoot, "packages", "workspace");
}

const documents = await Promise.all(
  workspaceDocuments.map(async (file) => ({
    blocks: fencedBlocks(
      await Bun.file(join(repositoryRoot, file)).text(),
      (line) => `${file}:${String(line)}`,
    ),
    file,
  })),
);
const blocks = documents.flatMap(({ blocks: found }) => found);
if (blocks.length === 0) throw new Error("no ```ts blocks found above the library package");

// A default socket of this run's own, so `new Server()` reaches something that
// is not the tmux the person running this is sitting in.
const isolated = await mkdtemp(join(tmpdir(), "ltx-doc-runs-"));
process.env["TMUX_TMPDIR"] = isolated;
const binary = join(isolated, "bin");
await mkdir(binary, { recursive: true });
for (const name of STUBS) {
  // eslint-disable-next-line no-await-in-loop -- a handful of stubs, written in order.
  await writeFile(join(binary, name), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
}
process.env["PATH"] = `${binary}:${process.env["PATH"] ?? ""}`;

const outcomes: Outcome[] = [];
const written: string[] = [];
let strays: readonly string[] = [];

try {
  const loaded: Record<string, unknown>[] = [];
  let offset = 0;
  for (const { blocks: found, file } of documents) {
    const directory = join(baseFor(file), "node_modules", ".doc-runs");
    // eslint-disable-next-line no-await-in-loop -- one directory per document.
    await mkdir(directory, { recursive: true });
    const modulePath = join(directory, `${file.replaceAll("/", "-")}.ts`);
    // eslint-disable-next-line no-await-in-loop -- one module per document.
    await writeFile(modulePath, generate(found, offset));
    written.push(directory);
    // eslint-disable-next-line no-await-in-loop -- each module is imported once it exists.
    loaded.push((await import(modulePath)) as Record<string, unknown>);
    offset += found.length;
  }
  const module_ = Object.assign({}, ...loaded) as Record<
    string,
    ((world: Record<string, unknown>) => Promise<void>) | undefined
  >;
  // The runner imports the source directly; the generated blocks keep their
  // bare specifiers, which resolve from the examples package the way they
  // resolve for a reader.
  const { Server } = await import("../packages/libtmux/src/server.js");

  /**
   * A server for one block, on the default socket its recipe reaches for.
   *
   * Rebuilt between blocks rather than shared. These recipes build sessions
   * and windows — that is what they are showing — so a block that runs after
   * another meets whatever the first one left, and the failure surfaces
   * against the innocent one. A tmux server costs milliseconds.
   */
  const freshServer = async (code: string): Promise<InstanceType<typeof Server>> => {
    const previous = new Server();
    await previous.kill().catch(() => undefined);
    const server = new Server();
    // The prose calls its session `work`, and the queries look it up by that
    // name — except in the blocks that create it, which would collide with a
    // session already there.
    const creates = [...code.matchAll(/newSession\([^)]*?name:\s*"(?<name>[^"]+)"/gsu)].map(
      (match) => match.groups?.["name"],
    );
    await server.newSession({ name: creates.includes("work") ? "docs" : "work" });
    return server;
  };

  for (const [index, block] of blocks.entries()) {
    if (block.coverage?.kind === "static") {
      outcomes.push({ detail: block.coverage.reason, origin: block.origin, state: "excused" });
      continue;
    }
    if (block.coverage?.kind === "runs") {
      outcomes.push({ detail: block.coverage.source, origin: block.origin, state: "covered" });
      continue;
    }
    const run = module_[`example${String(index)}`];
    if (run === undefined) {
      outcomes.push({
        detail: "no function was generated for this block",
        origin: block.origin,
        state: "failed",
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- one block at a time: they share a default socket.
    const server = await freshServer(block.code);
    // eslint-disable-next-line no-await-in-loop -- against the server built for this block.
    const snapshot = await server.snapshot();
    const world = { selection: snapshot.sessions, server, snapshot };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // eslint-disable-next-line no-await-in-loop -- a block runs against its own server, not beside another.
      const outcome = await Promise.race([
        run(world).then(
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
      // The block's own server, not the next `freshServer`'s problem: the last
      // block has no next one, and its daemon outlives the run.
      // eslint-disable-next-line no-await-in-loop -- one block's teardown, in order.
      await server.kill().catch(() => undefined);
    }
  }
} finally {
  strays = await sweepStrayTmux(isolated).catch(() => []);
  // eslint-disable-next-line no-await-in-loop -- removed in the order they were made.
  for (const directory of written) await rm(directory, { force: true, recursive: true });
  await rm(isolated, { force: true, recursive: true });
}

const covered = outcomes.filter((outcome) => outcome.state === "covered");
const excused = outcomes.filter((outcome) => outcome.state === "excused");
const failed = outcomes.filter((outcome) => outcome.state === "failed");
const ran = outcomes.filter((outcome) => outcome.state === "ran");

for (const outcome of failed) {
  process.stderr.write(`${outcome.origin} ${outcome.detail ?? ""}\n`);
}
if (failed.length > 0) {
  process.stderr.write(
    "\nDocuments above the library package that do not run. Fix the recipe, or mark it `<!-- static: why -->` when its effect cannot be observed here.\n",
  );
  process.exit(1);
}
if (strays.length > 0) {
  process.stderr.write(`${strays.join("\n")}\n`);
  process.stderr.write(
    "\nDocuments above the library package left tmux servers behind: a block built its own `new Server()` or `Server.open()` and nothing closed it. Killed above; the run is not clean.\n",
  );
  process.exit(1);
}
process.stdout.write(
  `Documents above the library: ${String(ran.length)} executed, ${String(covered.length)} covered by a runnable twin, ${String(excused.length)} excused\n`,
);
for (const outcome of excused) {
  process.stdout.write(`  excused ${outcome.origin}: ${outcome.detail ?? ""}\n`);
}
