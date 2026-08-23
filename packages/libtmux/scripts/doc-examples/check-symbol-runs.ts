import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";
import { readApiSurface } from "../api_surface.js";
import { packageRoot } from "../package_root.js";
import { bindingsFor, fencedBlocks, splitForExecution, type Example } from "./example_harness.js";
import { buildWorld, disposeWorld, type World } from "./readme_world.js";
import { sweepStrayTmux } from "./tmux_sweep.js";

/**
 * Execute every TSDoc symbol example against real tmux, cheaply.
 *
 * `typecheck:symbols` proves 158 one-liners compile; it has never run one.
 * Running each the way README.md's blocks run — a fresh tmux server per
 * example — is the 4.8s-a-block bill the README gate already pays, and this
 * package has six source files' worth of getters and one-line property reads
 * for which that price buys almost nothing: `pane.window?.name;` cannot
 * damage the world it reads.
 *
 * So one world is built and held open across every example in a file, in the
 * order `readApiSurface()` reports them — the order a reader meets them in
 * the source. Most examples are read-only and cost nothing to validate.
 * A cheap liveness check runs before every example, and only a check that
 * finds something missing pays for a full rebuild. It is unconditional on
 * purpose: predicting which examples damage the world from the shape of their
 * code kept being wrong, and a wrong prediction surfaces as a failure against
 * a later example that did nothing wrong. One snapshot is a few milliseconds.
 * An example that throws anyway forces a rebuild and one retry, so undetected
 * damage poisons at most one attempt, and the counts printed below are the
 * evidence for that rather than an assertion of it.
 */

const SOURCE_LABEL = "TSDoc symbol examples";

/**
 * Examples this shared world cannot run as written, and why. TSDoc has no
 * equivalent of README.md's `<!-- static: why -->` marker, so the reason is
 * recorded here instead.
 */
const EXCUSED = new Map<string, string>([
  // Keyed by symbol rather than by `file:line`. A line number moves with any
  // edit above it, and an excuse that stops matching its example either fails
  // the gate for nothing or excuses a different example than it names.
  [
    "Server.open",
    "targets tmux's default socket, which this isolated harness deliberately leaves with nothing listening",
  ],
  [
    "Server.watch",
    "reads every event until the process is interrupted, like the README recipe it mirrors",
  ],
  [
    "Server.connect",
    "reads every event until the process is interrupted, like the README recipe it mirrors",
  ],
  ["Server.newSession", "creates the session named work that the shared world is built around"],
  [
    "Session.fromEnv",
    "needs $TMUX and $TMUX_PANE pointed at this world's own socket, which the shared world does not expose",
  ],
  [
    "Pane.pasteBuffer",
    "depends on a buffer named greeting that a later example in server.ts deletes before this one runs",
  ],
  [
    "Pane.joinTo",
    "the shared world binds `window` to `pane`'s own window, so this joins a pane into the window it is already in",
  ],
  [
    "Pane.displayPopup",
    "blocks waiting for a keypress once a client is attached, unlike chooseTree and chooseBuffer's documented no-op",
  ],
  [
    "Pane.displayMenu",
    "blocks waiting for a keypress once a client is attached, unlike chooseTree and chooseBuffer's documented no-op",
  ],
]);

/**
 * Code that can invalidate the ids the shared world hands out.
 *
 * Deliberately generous: a false positive costs one liveness snapshot before
 * the next example, which is cheap; a false negative is caught anyway by the
 * failure-triggered rebuild below, just later and noisily. `newSession` and
 * `newWindow` are included even though they only add scenery, because an
 * example that names a fixed id (`"work"`) can collide with the world's own.
 */
/**
 * Examples that change the world get one of their own.
 *
 * Sharing is what makes 158 examples cheap, and it works because most of them
 * only read — `pane.window?.name` cannot damage anything. Repairing the world
 * after a mutation instead of preventing the mutation from being shared was
 * measurably not enough: `Server.kill`, `Session.kill`, `Window.kill` and
 * `Pane.kill` all have examples, their damage accumulates, and the failures
 * surface far from the cause as a socket that is no longer there. Rebuilding
 * when a check notices is a race against how much has already been taken
 * apart.
 *
 * Isolating every mutation is the same rule stated once instead of a list of
 * verbs that has to stay complete. A reader costs nothing; a writer costs one
 * world, and there are few enough writers for that to be affordable.
 */
const DESTRUCTIVE = /\b(?:kill|detach)\s*\(/u;

/** Generous, and short-lived: most examples finish in well under this. */
const DEADLINE_MS = 5_000;

/**
 * An example and the symbol it documents.
 *
 * The symbol is what an excuse is keyed on: a line number moves whenever
 * anything above it is edited, and an excuse that stops matching its example
 * either fails the gate for no reason or quietly excuses a different one.
 */
interface SymbolExample extends Example {
  readonly symbol?: string;
}

interface Outcome {
  readonly detail?: string;
  readonly origin: string;
  readonly rebuilt?: boolean;
  readonly retried?: boolean;
  readonly state: "excused" | "failed" | "ran";
}

function generate(examples: readonly Example[]): string {
  // A TSDoc one-liner is a fragment: the compile-only gate declares `Server`
  // and `Session` in a preamble, so a generated module has to import them.
  const imports: string[] = ['import { Server, Session } from "../../src/index.js";'];
  const bodies: string[] = [];
  const taken = new Map<string, string>([
    ["Server", '"../../src/index.js"'],
    ["Session", '"../../src/index.js"'],
  ]);
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

const surface = await readApiSurface();
const members = surface.flatMap((entry) =>
  entry.members.map((member) => ({ ...member, symbol: `${entry.name}.${member.name}` })),
);
const examples: SymbolExample[] = members
  .filter((member) => member.example !== undefined)
  .map((member) => ({
    code: member.example ?? "",
    origin: `${member.file}:${String(member.line)}`,
    symbol: member.symbol,
  }));
for (const entry of surface) {
  examples.push(...fencedBlocks(entry.prose, (line) => `${entry.file}:${String(line)}`));
}
if (examples.length === 0) throw new Error("no symbol examples were found to run");

const isolated = await mkdtemp(join(tmpdir(), "ltx-symbol-runs-"));
process.env["TMUX_TMPDIR"] = isolated;

const directory = join(packageRoot, "node_modules", ".examples-symbol-runs");
await mkdir(directory, { recursive: true });
const modulePath = join(directory, "examples.ts");

const parent = await makeTestDirectory("ltx-symbols-");
const roots: string[] = [];
const scratch = join(parent, "blocks");
await mkdir(scratch, { recursive: true });

const outcomes: Outcome[] = [];
let leaks: readonly string[] = [];
let strayServers: readonly string[] = [];
let rebuildCount = 0;
let validateOnlyCount = 0;
let retryCount = 0;
const started = performance.now();

try {
  await writeFile(modulePath, generate(examples));
  const module_ = (await import(modulePath)) as Record<
    string,
    ((world: Record<string, unknown>) => Promise<void>) | undefined
  >;

  let worldIndex = 0;
  let world: World | undefined;
  // Always true so `pane.sendKeys(...)` examples — there are several — never
  // race the shell's line editor the way the finding in readme_world.ts
  // describes; every rebuild pays this once, not once per example.
  const rebuild = async (): Promise<void> => {
    if (world !== undefined) await disposeWorld(world).catch(() => undefined);
    // A run root per world. Reaping a fixture walks the root it lives in, so a
    // shared root races the reap of the world before it.
    const worldRoot = join(parent, `run-${String(worldIndex)}`);
    await prepareRunRoot(worldRoot);
    roots.push(worldRoot);
    world = await buildWorld({
      code: 'pane.sendKeys("settle");',
      index: worldIndex,
      runRoot: worldRoot,
      scratch,
    });
    worldIndex += 1;
    rebuildCount += 1;
  };
  await rebuild();

  /** Whether every id this world handed out still resolves. */
  const worldIsIntact = async (candidate: World): Promise<boolean> => {
    const ids = [
      candidate.bindings["session"],
      candidate.bindings["editor"],
      candidate.bindings["other"],
      candidate.bindings["pane"],
      candidate.bindings["otherPane"],
    ]
      .map((each) => (each as { id?: unknown } | undefined)?.id)
      .filter((id): id is string => typeof id === "string");
    const server = candidate.bindings["server"] as { snapshot: () => Promise<unknown> };
    let fresh: unknown;
    try {
      fresh = await server.snapshot();
    } catch {
      return false;
    }
    const flat = fresh as {
      panes: { toArray: () => readonly { id: string }[] };
      sessions: { toArray: () => readonly { id: string }[] };
      windows: { toArray: () => readonly { id: string }[] };
    };
    const known = new Set([
      ...flat.sessions.toArray().map((each) => each.id),
      ...flat.windows.toArray().map((each) => each.id),
      ...flat.panes.toArray().map((each) => each.id),
    ]);
    if (!ids.every((id) => known.has(id))) return false;

    // The connection, too. `session.detach()` ends this world's control
    // connection without touching an id, so every id above still resolves while
    // the next example reading through `live` meets a connection that is gone.
    const live = candidate.bindings["live"] as { snapshot: () => Promise<unknown> } | undefined;
    if (live === undefined) return true;
    try {
      await live.snapshot();
    } catch {
      return false;
    }
    return true;
  };

  for (const [index, example] of examples.entries()) {
    const origin = example.origin;
    const excuse = example.symbol === undefined ? undefined : EXCUSED.get(example.symbol);
    if (excuse !== undefined) {
      outcomes.push({ detail: excuse, origin, state: "excused" });
      continue;
    }

    // Checked before every example rather than only after one that looks
    // destructive: a wrong prediction surfaces as a failure against whichever
    // later example was holding the socket.
    const destructive = DESTRUCTIVE.test(example.code);
    {
      // A destructive example gets a world nobody else has a handle into, so
      // what it destroys is only ever its own.
      // eslint-disable-next-line no-await-in-loop -- one liveness check before the next example, not one per example.
      const intact = destructive || world === undefined ? false : await worldIsIntact(world);
      if (!intact) {
        // eslint-disable-next-line no-await-in-loop -- rebuilding is what "not intact" means.
        await rebuild();
      } else {
        validateOnlyCount += 1;
      }
    }

    const run = module_[`example${String(index)}`];
    if (run === undefined || world === undefined) {
      outcomes.push({
        detail: "no function was generated for this example",
        origin,
        state: "failed",
      });
      continue;
    }

    // Read at call time, not captured. A retry rebuilds the world first, so
    // bindings taken before that point are handles into a server the rebuild
    // already disposed.
    const attempt = async (): Promise<Error | undefined> => {
      const bindings = world?.bindings ?? {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run(bindings).then(
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
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    // eslint-disable-next-line no-await-in-loop -- one example at a time against the one shared world.
    let outcome = await attempt();
    let retried = false;
    if (outcome !== undefined) {
      // Rebuild and try once more, for damage the liveness check cannot see —
      // a connection that ended with every id intact. The retry reads the
      // rebuilt world's bindings, not the ones captured before it.
      retried = true;
      retryCount += 1;
      // eslint-disable-next-line no-await-in-loop -- as above.
      await rebuild();
      // eslint-disable-next-line no-await-in-loop -- as above.
      outcome = await attempt();
    }

    if (outcome === undefined) {
      outcomes.push({ origin, retried, state: "ran" });
    } else {
      outcomes.push({
        detail: `${outcome.constructor.name}: ${outcome.message.split("\n")[0] ?? ""}`,
        origin,
        retried,
        state: "failed",
      });
    }
  }

  if (world !== undefined) await disposeWorld(world);
} finally {
  await runWithCleanup(
    async () => {
      const reports = await Promise.all(roots.map(async (root) => reapOwnedRunRoot(root)));
      leaks = reports.flatMap((report) => report.leaks);
    },
    async () => {
      strayServers = await sweepStrayTmux(isolated);
      await rm(parent, { force: true, recursive: true });
      await rm(directory, { force: true, recursive: true });
      await rm(isolated, { force: true, recursive: true });
    },
  );
}

const elapsedMs = performance.now() - started;
const ran = outcomes.filter((outcome) => outcome.state === "ran");
const failed = outcomes.filter((outcome) => outcome.state === "failed");
const excused = outcomes.filter((outcome) => outcome.state === "excused");
const retried = outcomes.filter((outcome) => outcome.retried === true);

for (const outcome of failed) {
  process.stderr.write(`${outcome.origin} ${outcome.detail ?? ""}\n`);
}
if (leaks.length > 0) {
  process.stderr.write(`${leaks.join("\n")}\n`);
  process.stderr.write(`\n${SOURCE_LABEL} left tmux servers behind.\n`);
  process.exit(1);
}
if (strayServers.length > 0) {
  process.stderr.write(`${strayServers.join("\n")}\n`);
  process.stderr.write(
    `\n${SOURCE_LABEL} left tmux servers behind that this package's own fixtures do not track.\n`,
  );
  process.exit(1);
}
if (failed.length > 0) {
  process.stderr.write(
    `\n${SOURCE_LABEL} that do not run. Fix the example, or add it to EXCUSED with why.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${SOURCE_LABEL}: ${String(ran.length)} executed, ${String(excused.length)} excused, ` +
    `${String(examples.length)} total in ${elapsedMs.toFixed(0)}ms ` +
    `(${(elapsedMs / examples.length).toFixed(1)}ms/example)\n` +
    `  world rebuilds: ${String(rebuildCount)}, liveness checks that found no damage: ${String(validateOnlyCount)}, ` +
    `retries after an unpredicted failure: ${String(retryCount)}\n`,
);
if (retried.length > 0) {
  for (const outcome of retried) process.stdout.write(`  retried ${outcome.origin}\n`);
}
for (const outcome of excused) {
  process.stdout.write(`  excused ${outcome.origin}: ${outcome.detail ?? ""}\n`);
}
