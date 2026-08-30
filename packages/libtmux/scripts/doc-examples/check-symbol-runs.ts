import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  sweepStaleRunRoots,
  runWithCleanup,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import {
  readApiSurface,
  readRootApiSurface,
  requireRootExamples,
  requireSymbolExamples,
} from "../api_surface.js";
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
 * An example that still throws fails the gate. Repeating an unclassified
 * failure against a fresh fixture would hide the shared-state defect that made
 * the first attempt fail.
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
  readonly state: "excused" | "failed" | "ran";
}

interface FingerprintHandle {
  readonly format: Readonly<Record<string, string | null>>;
}

interface FingerprintSnapshot {
  readonly clients: { toArray: () => readonly FingerprintHandle[] };
  readonly panes: { toArray: () => readonly FingerprintHandle[] };
  readonly sessions: { toArray: () => readonly FingerprintHandle[] };
  readonly windows: { toArray: () => readonly FingerprintHandle[] };
}

const FINGERPRINT_ANCHORS = Object.freeze([
  {
    bindings: ["client"],
    fields: ["client_name", "session_id", "window_id", "pane_id"],
    identity: "client_name",
    selection: "clients",
  },
  {
    bindings: ["pane", "otherPane"],
    fields: ["session_id", "window_id", "window_index", "pane_id", "pane_index"],
    identity: "pane_id",
    selection: "panes",
  },
  {
    bindings: ["session"],
    fields: ["session_id", "session_name"],
    identity: "session_id",
    selection: "sessions",
  },
  {
    bindings: ["editor", "other"],
    fields: ["session_id", "window_id", "window_index", "window_name"],
    identity: "window_id",
    selection: "windows",
  },
] as const);

function bindingField(world: World, name: string, field: string): string | undefined {
  const value = (world.bindings[name] as FingerprintHandle | undefined)?.format[field];
  return value ?? undefined;
}

function anchoredRows(
  handles: readonly FingerprintHandle[],
  identityField: string,
  identities: ReadonlySet<string>,
  fields: readonly string[],
): readonly string[] {
  return handles
    .filter((handle) => {
      const identity = handle.format[identityField];
      return identity !== null && identity !== undefined && identities.has(identity);
    })
    .map((handle) => JSON.stringify(fields.map((field) => handle.format[field] ?? null)))
    .toSorted();
}

function worldFingerprint(world: World, snapshot: FingerprintSnapshot): string {
  return JSON.stringify(
    Object.fromEntries(
      FINGERPRINT_ANCHORS.map(({ bindings, fields, identity, selection }) => {
        const identities = new Set(
          bindings
            .map((name) => bindingField(world, name, identity))
            .filter((value): value is string => value !== undefined),
        );
        return [
          selection,
          anchoredRows(snapshot[selection].toArray(), identity, identities, fields),
        ];
      }),
    ),
  );
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
const members = requireSymbolExamples(
  surface.flatMap((entry) =>
    entry.members.map((member) => ({
      ...member,
      owner: entry.name,
    })),
  ),
);
const examples: SymbolExample[] = members.map((member) => ({
  code: member.example,
  origin: `${member.file}:${String(member.line)}`,
  symbol: `${member.owner}.${member.name}`,
}));
for (const entry of surface) {
  examples.push(...fencedBlocks(entry.prose, (line) => `${entry.file}:${String(line)}`));
}
const root = requireRootExamples(await readRootApiSurface());
examples.push(
  ...root.map((entry) => ({
    code: entry.example,
    origin: `${entry.file}:${String(entry.line)}`,
    symbol: entry.name,
  })),
);
if (examples.length === 0) throw new Error("no symbol examples were found to run");

// Cleanup is a finally, and SIGKILL skips it. A run killed that way left its
// tmux daemon behind under a name no later run revisits; this is where one
// still can. Once per suite process, before anything creates a root of its own.
await sweepStaleRunRoots();

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
const started = performance.now();

try {
  await writeFile(modulePath, generate(examples));
  const module_ = (await import(modulePath)) as Record<
    string,
    ((world: Record<string, unknown>) => Promise<void>) | undefined
  >;

  let worldIndex = 0;
  let world: World | undefined;
  let expectedWorldFingerprint = "";
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
    const server = world.bindings["server"] as { snapshot: () => Promise<unknown> };
    expectedWorldFingerprint = worldFingerprint(
      world,
      (await server.snapshot()) as FingerprintSnapshot,
    );
    worldIndex += 1;
    rebuildCount += 1;
  };
  await rebuild();

  /** Whether every bound handle still names the fixture placement it began on. */
  const worldIsIntact = async (candidate: World): Promise<boolean> => {
    const server = candidate.bindings["server"] as { snapshot: () => Promise<unknown> };
    let fresh: unknown;
    try {
      fresh = await server.snapshot();
    } catch {
      return false;
    }
    if (worldFingerprint(candidate, fresh as FingerprintSnapshot) !== expectedWorldFingerprint) {
      return false;
    }

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

    // Read at call time so a rebuild never leaves handles into the world it
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
    const outcome = await attempt();

    if (outcome === undefined) {
      outcomes.push({ origin, state: "ran" });
    } else {
      outcomes.push({
        detail: `${outcome.constructor.name}: ${outcome.message.split("\n")[0] ?? ""}`,
        origin,
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
    `unpredicted retries: 0\n`,
);
for (const outcome of excused) {
  process.stdout.write(`  excused ${outcome.origin}: ${outcome.detail ?? ""}\n`);
}
