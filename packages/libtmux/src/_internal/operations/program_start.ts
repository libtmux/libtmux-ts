// Program runs: validating a request, making the pane, and starting the program in it.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LibTmuxError,
  TmuxObjectNotFoundError,
  TmuxTransportError,
  VersionTooLowError,
  WaitTimeoutError,
} from "../../errors.js";
import type { Pane } from "../../pane.js";
import { Program } from "../../program.js";
import type { Server } from "../../server.js";
import type {
  AbortLike,
  ProgramExit,
  ProgramPlacement,
  ProgramResult,
  RunOptions,
  SpawnOptions,
} from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { requireOnServer } from "../runtime/live_handle.js";
import { capabilitySince, hasCapability } from "../support/capabilities.js";
import { runCommand, runCommands } from "./command.js";
import {
  cancelled,
  exists,
  isAborted,
  killProgram,
  leaseTimer,
  MAX_TIMER_MS,
  PLACEHOLDER,
  programOutput,
  readPane,
  registerProgram,
  removeOwned,
  requireCount,
  stopPane,
  waitProgram,
  type Lease,
  type Owned,
  type RunFiles,
} from "./program.js";

/**
 * Runs argv unparsed, as positional parameters, then lingers 50 ms and exits or dies
 * as the program did: tmux can remove a pane before reading its last output.
 */
const RUN =
  'trap : HUP INT QUIT TERM; exec 3>&2 2>/dev/null; (exec "$0" "$@" 2>&3 3>&-); s=$?; ' +
  'sleep 0.05 2>/dev/null || sleep 1; if [ "$s" -gt 128 ] && n=$(kill -l "$s") && [ -n "$n" ]; then ' +
  'trap - "$n"; kill -s "$n" "$$"; fi; exit "$s"';
/**
 * Steps before `RUN`, each taking its argument from `$1` and shifting it off:
 * tmux's own `-c` falls back to `$HOME` for a directory it cannot enter, where
 * this ends the run with 126.
 */
const ENTER = 'cd -- "$1" || exit 126; shift; ';
const READ = 'exec <"$1"; shift; ';
/** How long setup waits for tmux to start the program. */
const SETUP_MS = 10_000;
/** How long `run` lets tmux wait, after this process is gone, before ending the program. */
const RUN_ORPHAN_MS = 60_000;
const MIN_ORPHAN_MS = 1000;
const DEFAULT_HISTORY_LIMIT = 100_000;
/** tmux's own ceiling on a window's width and height. */
const MAX_SIZE = 10_000;
/** tmux's own ceiling on `history-limit`, `INT_MAX`. */
const MAX_HISTORY_LIMIT = 2 ** 31 - 1;

/** A directory as tmux's `-c` takes it: tmux expands start directories as formats. */
function literalDirectory(path: string): string {
  return path.replaceAll("#", "##");
}

/** A command as `pipe-pane` takes it: tmux expands it as a format and with strftime. */
function literalPipe(command: string): string {
  return command.replaceAll("#", "##").replaceAll("%", "%%");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Where the program runs, refusing a placement its options do not fit. */
function requireSpawn(argv: readonly string[], spawn: SpawnOptions): ProgramPlacement {
  const [program = ""] = argv;
  if (program === "") throw new TypeError("argv must name a program");
  // bash, which is /bin/sh on some systems, reads `exec -l` as an option to exec itself.
  if (program.startsWith("-")) throw new TypeError("argv[0] must not start with -; name it ./-x");
  for (const name of Object.keys(spawn.environment ?? {})) {
    if (name === "" || name.includes("=")) {
      throw new TypeError(`environment variable name ${JSON.stringify(name)} is not valid`);
    }
  }
  const placement = spawn.placement ?? (spawn.from === undefined ? "session" : "window");
  if (!["session", "split", "window"].includes(placement)) {
    throw new TypeError(`placement must be "session", "window" or "split"`);
  }
  if ((placement === "session") !== (spawn.from === undefined)) {
    throw new TypeError(
      `placement "${placement}" ${spawn.from === undefined ? "needs" : "takes no"} from`,
    );
  }
  if (placement !== "session") {
    // The pane joins that pane's session, whose size and scrollback are its owner's.
    for (const name of ["width", "height", "historyLimit"] as const) {
      if (spawn[name] !== undefined) throw new TypeError(`${name} cannot be set with from`);
    }
  }
  if (
    spawn.input !== undefined &&
    typeof spawn.input !== "string" &&
    !(spawn.input instanceof Uint8Array)
  ) {
    throw new TypeError("input must be a string or a Uint8Array");
  }
  if (spawn.maxStreamBytes !== undefined && spawn.stream !== true) {
    throw new TypeError("maxStreamBytes needs stream: true");
  }
  requireCount("width", spawn.width, MAX_SIZE);
  requireCount("height", spawn.height, MAX_SIZE);
  requireCount("historyLimit", spawn.historyLimit, MAX_HISTORY_LIMIT);
  requireCount("maxStreamBytes", spawn.maxStreamBytes, Number.MAX_SAFE_INTEGER - 1);
  requireCount("orphanAfterMs", spawn.orphanAfterMs, MAX_TIMER_MS);
  if (spawn.orphanAfterMs !== undefined && spawn.orphanAfterMs < MIN_ORPHAN_MS) {
    throw new TypeError(`orphanAfterMs must be at least ${String(MIN_ORPHAN_MS)}`);
  }
  return placement;
}

/** Create the session whose dead placeholder pane the program will be respawned into. */
async function createSession(
  runtime: RuntimeContext,
  sessionName: string,
  spawn: SpawnOptions,
): Promise<string> {
  const target = `=${sessionName}:`;
  const [paneId = ""] = await runCommands(runtime, [
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      sessionName,
      ...(spawn.width === undefined ? [] : ["-x", String(spawn.width)]),
      ...(spawn.height === undefined ? [] : ["-y", String(spawn.height)]),
      "--",
      ...PLACEHOLDER,
    ],
    // In the creating list: set by a second invocation, it arrives after an
    // instant program's pane is already gone.
    ["set-option", "-w", "-t", target, "remain-on-exit", "on"],
    ["set-option", "-w", "-t", target, "remain-on-exit-format", ""],
    [
      "set-option",
      "-t",
      target,
      "history-limit",
      String(spawn.historyLimit ?? DEFAULT_HISTORY_LIMIT),
    ],
  ]);
  return paneId;
}

/** The placeholder's pane beside `from`, in its session and directory, and what to remove. */
interface Beside {
  readonly owned: Owned;
  readonly paneId: string;
  readonly sessionName: string;
}

/**
 * A split of `from`, or a window in its session, holding the placeholder. A
 * window's id is unknown inside the creating list, so remain-on-exit is set by
 * its unique name; a split takes it with `-m`, on its own pane alone.
 */
async function createBeside(
  runtime: RuntimeContext,
  from: Pane,
  placement: "split" | "window",
): Promise<Beside> {
  const [sessionId = "", sessionName = "", path = ""] = await readPane(runtime, from.id, [
    "#{session_id}",
    "#{session_name}",
    "#{pane_current_path}",
  ]);
  // tmux expands a start directory as a format; the inherited path is literal.
  const directory = path === "" ? [] : ["-c", literalDirectory(path)];
  if (placement === "split") {
    const [paneId = ""] = await runCommand(runtime, [
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-m",
      "",
      "-t",
      from.id,
      ...directory,
      "--",
      ...PLACEHOLDER,
    ]);
    return { owned: { kind: "pane", target: paneId }, paneId, sessionName };
  }
  const name = `libtmux-program-${randomUUID().slice(0, 12)}`;
  const window = `${sessionId}:=${name}`;
  const [created = ""] = await runCommands(runtime, [
    [
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}\t#{window_id}",
      "-t",
      `${sessionId}:`,
      "-n",
      name,
      ...directory,
      "--",
      ...PLACEHOLDER,
    ],
    ["set-option", "-w", "-t", window, "remain-on-exit", "on"],
    ["set-option", "-w", "-t", window, "remain-on-exit-format", ""],
  ]).catch(async (error: unknown) => {
    // The window can exist though a later command in its list failed.
    await removeOwned(runtime, { kind: "window", target: window }).catch(() => undefined);
    throw error;
  });
  const [paneId = "", windowId = ""] = created.split("\t");
  return { owned: { kind: "window", target: windowId }, paneId, sessionName };
}

/** The wrapper and its arguments: argv stays `$0 "$@"`, after what the steps take. */
function wrapped(
  argv: readonly string[],
  spawn: SpawnOptions,
  input: string | undefined,
): string[] {
  const [program = "", ...rest] = argv;
  const steps: [string, string][] = [];
  if (spawn.startDirectory !== undefined) steps.push([ENTER, spawn.startDirectory]);
  if (input !== undefined) steps.push([READ, input]);
  return [
    "sh",
    "-c",
    `${steps.map(([step]) => step).join("")}${RUN}`,
    program,
    ...steps.map(([, value]) => value),
    ...rest,
  ];
}

/**
 * Whether the tmux server's machine sees this directory, which a stream and an
 * input are written to: a file its shell creates must appear here.
 */
async function requireShared(runtime: RuntimeContext, directory: string): Promise<void> {
  const probe = join(directory, "shared");
  await runCommand(runtime, [
    "run-shell",
    "--",
    literalDirectory(`: > ${shellQuote(probe)}`),
  ]).catch(() => undefined);
  if (!(await exists(probe))) {
    throw new LibTmuxError(
      "stream and input need the tmux server on this machine: a file it wrote never reached this temporary directory",
    );
  }
}

/**
 * Starts the program and waits for its exit in one list, inside which tmux
 * handles no other event; a `lease` arms tmux's cleanup for a caller that dies.
 */
function startList(
  paneId: string,
  owned: Owned,
  argv: readonly string[],
  spawn: SpawnOptions,
  files: RunFiles | undefined,
  input: string | undefined,
  lease: Lease | undefined,
  started: string,
): string[][] {
  const stream = files?.stream;
  // One byte past the limit, so a cut copy can be told from one that fit.
  const copy = stream?.limit === undefined ? "cat" : `head -c ${String(stream.limit + 1)}`;
  return [
    [
      "respawn-pane",
      "-k",
      "-t",
      paneId,
      ...Object.entries(spawn.environment ?? {}).flatMap(([name, value]) => [
        "-e",
        `${name}=${value}`,
      ]),
      "--",
      ...wrapped(argv, spawn, input),
    ],
    ...(files === undefined
      ? []
      : [["set-option", "-p", "-t", paneId, "@libtmux-files", files.directory]]),
    ...(lease === undefined
      ? []
      : leaseTimer(paneId, owned, spawn.keep === true, files !== undefined, 0, lease.ms / 1000)),
    ...(stream === undefined
      ? []
      : [
          [
            "pipe-pane",
            "-O",
            "-t",
            paneId,
            literalPipe(`${copy} >> ${shellQuote(stream.out)}; : > ${shellQuote(stream.done)}`),
          ],
        ]),
    ["wait-for", "-S", started],
    ["wait-for", "-E", "-F", `#{==:#{pane},${paneId}}`, "pane-died"],
  ];
}

/**
 * Wait until tmux has run the start list up to its `started` signal. A channel
 * signalled before its waiter arrives stays woken, so the order of the two
 * clients does not matter.
 */
async function confirmStarted(
  runtime: RuntimeContext,
  paneId: string,
  failure: () => unknown,
  exited: Promise<void>,
  signal: AbortLike | undefined,
  started: string,
  watcher: AbortController,
): Promise<void> {
  // The waiter stops only once the list can no longer signal: a waiter stopped
  // first could miss a signal, which would then stay woken in tmux.
  const stop = new AbortController();
  let timedOut = false;
  const giveUp = (): void => {
    watcher.abort();
    void exited.then(() => stop.abort());
  };
  const timer = setTimeout(() => {
    timedOut = true;
    giveUp();
  }, SETUP_MS);
  signal?.addEventListener("abort", giveUp, { once: true });
  void exited.then(() => {
    if (failure() !== undefined) stop.abort();
  });
  try {
    await runCommand(runtime, ["wait-for", started], { signal: stop.signal, timeoutMs: null });
  } catch (error) {
    const failed = failure();
    if (failed !== undefined) throw failed;
    if (!isAborted(signal) && !timedOut) throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", giveUp);
  }
  if (isAborted(signal)) throw cancelled(signal);
  if (timedOut) throw new LibTmuxError(`tmux did not start the program in ${paneId}`);
}

/** Start `argv` in a pane of its own, with no shell parsing it; `signal` also stops setup. */
export async function spawnProgram(
  server: Server,
  runtime: RuntimeContext,
  argv: readonly string[],
  spawn: SpawnOptions = {},
  signal?: AbortLike,
): Promise<Program> {
  const placement = requireSpawn(argv, spawn);
  if (spawn.from !== undefined) requireOnServer(spawn.from, server, "from");
  const { tmuxVersion } = await runtime.capabilities.bind();
  if (!hasCapability("program-run", tmuxVersion)) {
    throw new VersionTooLowError({
      criteriaName: "program run",
      delivery: "not_started",
      remedy: "Upgrade tmux to 3.8 or newer and restart the server",
      serverVersion: tmuxVersion.raw,
      since: capabilitySince("program-run").raw,
    });
  }
  const watcher = new AbortController();
  let files: RunFiles | undefined;
  let owned: Owned | undefined;
  let paneId: string | undefined;
  try {
    let input: string | undefined;
    if (spawn.stream === true || spawn.input !== undefined) {
      // mkdtemp makes the directory 0700 whatever the umask, which keeps both files private.
      const directory = await mkdtemp(join(tmpdir(), "ltx-program-"));
      const stream =
        spawn.stream === true
          ? {
              done: join(directory, "done"),
              limit: spawn.maxStreamBytes,
              out: join(directory, "out"),
            }
          : undefined;
      files = { directory, stream };
      await requireShared(runtime, directory);
      if (stream !== undefined) await writeFile(stream.out, "", { mode: 0o600 });
      if (spawn.input !== undefined) {
        input = join(directory, "in");
        await writeFile(input, spawn.input, { mode: 0o600 });
      }
    }
    let sessionName: string;
    if (spawn.from === undefined) {
      sessionName = `libtmux-program-${randomUUID().slice(0, 12)}`;
      owned = { kind: "session", target: `=${sessionName}` };
      paneId = await createSession(runtime, sessionName, spawn);
    } else {
      ({ owned, paneId, sessionName } = await createBeside(
        runtime,
        spawn.from,
        placement === "split" ? "split" : "window",
      ));
    }
    const lease: Lease | undefined =
      spawn.orphanAfterMs === undefined
        ? undefined
        : { ms: spawn.orphanAfterMs, renewing: false, timer: undefined, token: 0 };
    let failure: unknown;
    const started = `libtmux-program-started-${randomUUID()}`;
    const exited = runCommands(
      runtime,
      startList(paneId, owned, argv, spawn, files, input, lease, started),
      {
        signal: watcher.signal,
        timeoutMs: null,
      },
    ).then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof TmuxTransportError && error.kind === "cancelled")) failure = error;
      },
    );
    await confirmStarted(runtime, paneId, () => failure, exited, signal, started, watcher);
    // Handles come from a whole-server snapshot, as `Pane.refreshed` reads them.
    const pane = (await server.panes()).toArray().find((candidate) => candidate.id === paneId);
    if (pane === undefined)
      throw new TmuxObjectNotFoundError({ obj_id: paneId, obj_key: "pane_id" });
    const program = Object.create(Program.prototype) as Program;
    Object.defineProperties(program, {
      pane: { enumerable: true, value: pane satisfies Pane },
      sessionName: { enumerable: true, value: sessionName },
    });
    registerProgram(program, {
      exit: undefined,
      exited,
      files,
      keep: spawn.keep === true,
      killing: undefined,
      lease,
      owned,
      paneId,
      runtime,
      settled: false,
      wakes: new Set(),
      watcher,
    });
    return program;
  } catch (error) {
    // Nothing else would end a program whose setup failed, or remove what it ran in.
    watcher.abort();
    if (paneId !== undefined) await stopPane(runtime, paneId).catch(() => undefined);
    if (owned !== undefined && spawn.keep !== true) {
      await removeOwned(runtime, owned).catch(() => undefined);
    }
    if (files !== undefined) await rm(files.directory, { force: true, recursive: true });
    throw error;
  }
}

/** Run `argv` to completion in a pane of its own and report what it printed. */
export async function runProgram(
  server: Server,
  runtime: RuntimeContext,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<ProgramResult> {
  requireCount("timeoutMs", options.timeoutMs, MAX_TIMER_MS);
  if (isAborted(options.signal)) throw cancelled(options.signal);
  const program = await spawnProgram(
    server,
    runtime,
    argv,
    { ...options, orphanAfterMs: options.orphanAfterMs ?? RUN_ORPHAN_MS },
    options.signal,
  );
  let failed = true;
  try {
    let exit: ProgramExit = { exitCode: null, signalCode: null };
    let timedOut = false;
    try {
      exit = await waitProgram(program, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
      timedOut = true;
    }
    const { text, truncated } = await programOutput(program);
    failed = false;
    return { ...exit, output: text, success: exit.exitCode === 0, timedOut, truncated };
  } finally {
    // Ending it must not hide the error the run failed with, as `await using` would.
    await killProgram(program).catch((error: unknown) => {
      if (!failed) throw error;
    });
  }
}
