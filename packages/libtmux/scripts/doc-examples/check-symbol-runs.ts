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
 * Examples this shared world cannot run as written, and why.
 *
 * Small and specific on purpose, mirroring README.md's own
 * `<!-- static: why -->` marker — TSDoc doc comments have no equivalent
 * syntax, so the same judgment is recorded here instead of invented as a new
 * comment convention for a spike. Each entry was reached by running the
 * example and reading what actually happened, not by inspecting the code.
 */
const EXCUSED = new Map<string, string>([
  // Keyed by symbol rather than by `file:line`. A line number is moved by any
  // edit above it, and an excuse that quietly stops matching its example either
  // fails a gate for no reason or excuses the wrong one.
  [
    "Server.open",
    // `Server.open({ transport: "control" })` with no explicit socket path
    // attaches tmux's *default* socket under `$TMUX_TMPDIR` — not this
    // world's own fixture, which deliberately lives on a uniquely named
    // socket so a sweep can tell a doc example's server from a sibling
    // port's. tmux's control mode does not create a server to attach to the
    // way a spawning command does — "a server with no sessions has nothing
    // to attach to", the doc comment's own words — so this fails in an
    // isolated $TMUX_TMPDIR with nothing already listening on the default
    // socket, by design rather than by accident.
    "targets tmux's default socket, which this isolated harness deliberately leaves with nothing listening",
  ],
  [
    "Server.watch",
    // `Server.watch`: `for await (const event of events)` with no `break`.
    // The README's near-identical recipe is marked
    // `<!-- static: reads every event until the process is interrupted -->`;
    // TSDoc has no equivalent marker, so the per-attempt timeout below
    // reports it as a deliberate, permanent miss rather than a flake.
    "reads every event until the process is interrupted, like the README recipe it mirrors",
  ],
  [
    "Server.connect",
    // `Server.connect`: the same shape, over `live.subscribe()` instead of
    // `server.watch()`.
    "reads every event until the process is interrupted, like the README recipe it mirrors",
  ],
  [
    "Server.newSession",
    // `Server.newSession`: the shared world's baseline session is itself
    // named "work" (several other examples read `session`/`snapshot`
    // expecting exactly that name), so this example's own
    // `newSession({ name: "work" })` collides with it by construction. A
    // reader pasting this alone hits no such session.
    'collides with the shared world\'s own session, which several other examples require to be named "work"',
  ],
  [
    "Session.fromEnv",
    // `Session.fromEnv()` reads `$TMUX`/`$TMUX_PANE` from the process
    // environment. readme_world.ts sets those per block, from the socket
    // path that block's own fixture just opened; this runner holds one
    // world across many examples and never exposes that socket path to the
    // caller, so it cannot set them without widening the shared World type
    // for one example.
    "needs $TMUX/$TMUX_PANE set to this world's own socket, which the shared World does not expose",
  ],
  [
    "Pane.pasteBuffer",
    // `Pane.pasteBuffer("greeting")` depends on a buffer named "greeting"
    // that `Server.setBuffer`'s own example creates — and that
    // `Server.deleteBuffer`'s own example deletes, a few members later in
    // the same file, before this file's examples ever run. Each TSDoc
    // example is written and typechecked as an independent fragment; a
    // shared, sequential world is what turns that unstated cross-example
    // dependency into an observable failure.
    'depends on a buffer named "greeting" that a later example in server.ts deletes before this one runs',
  ],
  [
    "Pane.joinTo",
    // `Pane.joinTo(window.id, ...)`: the shared world binds `window` to
    // `pane`'s own window (`editor`), so this asks tmux to join a pane into
    // the window it is already in, and tmux refuses. A reader's own
    // `window` in scope would ordinarily be a different one — the ambient
    // name is a placeholder in both harnesses, and only the shared world's
    // reuse across many examples makes them alias the same object.
    "the shared world binds `window` to `pane`'s own window, so this joins a pane into the window it is already in",
  ],
  [
    "Pane.displayPopup",
    // `Pane.displayPopup`: same shape as `displayMenu` below — a client is
    // attached in this world, and the popup blocks on it.
    "blocks waiting for interactive input with a client attached, unlike chooseTree/chooseBuffer's documented no-op",
  ],
  [
    "Pane.displayMenu",
    // `Pane.displayMenu`: unlike `chooseTree`/`chooseBuffer`, its doc
    // comment does not say tmux draws nothing and reports success with no
    // client attached — and empirically it does not: with the two live
    // clients this world connects, it blocks waiting for a keypress.
    // Recorded as a finding rather than fixed: whether that difference from
    // its siblings is deliberate is a question for whoever owns the
    // behavior, not a guess this spike should bake into the doc comment.
    "blocks waiting for interactive input with a client attached, unlike chooseTree/chooseBuffer's documented no-op",
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
  // A TSDoc one-liner assumes a reader already imported `Server`/`Session` —
  // it is a fragment, checked by the compile-only gate against a preamble
  // that declares them, never against a module that has to import them
  // itself. Six examples reference the classes directly (`new Server(...)`,
  // `Server.open(...)`, `Session.fromEnv()`) rather than the ambient
  // `server`/`session` instances, so the generated module needs the same
  // import the compile preamble supplies.
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
    // A run root per world, not one for all of them. Reaping a fixture walks
    // the root it lives in, and a fixture reserving its place there while the
    // one before it is being reaped is a race whose symptom is a socket that
    // was alive a moment ago — reported against whichever example happened to
    // be holding it, which is never the one that caused it.
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

    // The connection, too. `session.detach()` detaches every client, which
    // ends this world's control connection without touching a session, window
    // or pane id — so everything above still resolves and the next example to
    // read through `live` or `client` fails against a connection that is gone.
    // A world is intact when what it handed out still works, not when the ids
    // it handed out still exist.
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

    // Checked before every example, not only when the example before it looked
    // like it might have done damage. Predicting damage from the shape of the
    // code kept being wrong in ways that surfaced against a later example — a
    // socket that answered a moment ago and does not now, reported against
    // whichever example was holding it. One snapshot is a few milliseconds; a
    // wrong prediction costs a failure nobody can trace back.
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

    // Read at call time, not captured. A retry rebuilds the world first, and
    // bindings taken before that point are handles into the server the rebuild
    // just disposed — so the retry reported "no such file or directory" against
    // a socket this harness had removed itself, and blamed the example.
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
      // Rebuild and try once more: the safety net for damage the liveness
      // check could not see, such as a connection that ended without any
      // session, window or pane going missing. The retry reads the rebuilt
      // world's bindings, not the ones captured before it.
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
