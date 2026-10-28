// Program runs: validating a request, making the pane, and starting the program in it.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LibTmuxError,
  ServerNotLocalError,
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
import { lastObservedDaemon, type RuntimeContext } from "../runtime/context.js";
import { requireOnServer } from "../runtime/live_handle.js";
import { capabilitySince, hasCapability } from "../support/capabilities.js";
import { acquireServerGraph } from "./acquire.js";
import { executableTmuxVersion, isColdEndpoint, runCommand, runCommands } from "./command.js";
import {
  cancelled,
  drainChannel,
  exists,
  isAborted,
  killProgram,
  MAX_TIMER_MS,
  PLACEHOLDER,
  programOutput,
  programStderr,
  readPane,
  registerProgram,
  removeOwned,
  requireCount,
  stopPane,
  waitProgram,
  type Owned,
  type RunFiles,
} from "./program.js";
import { leaseTimer, startRenewal, type Lease } from "./program_lease.js";
import { markSequence } from "./program_stream.js";

/**
 * Runs argv unparsed, writes ST and the run's OSC 7 mark, lingers, and exits
 * with its status. Only a pane whose path is the mark was read to the end.
 */
export const RUN: string =
  'trap : INT QUIT TERM; exec 3>&2 2>/dev/null; (exec "$0" "$@" 2>&3 3>&-); s=$?; ' +
  "printf '\\033\\\\\\033]7;%s\\007' \"$m\"; " +
  'sleep 0.05 2>/dev/null || sleep 1; exit "$s"';
/**
 * Steps before `RUN`, each shifting its argument off `$1`. tmux's `-c` falls
 * back to `$HOME` for a directory it cannot enter, where this exits 126.
 */
export const MARK = "m=$1; shift; ";
const ENTER = 'cd -- "$1" || exit 126; shift; ';
const READ = 'exec <"$1"; shift; ';
const ERR = 'exec 2>"$1"; shift; ';
/** How long setup waits for tmux to start the program. */
const SETUP_MS = 10_000;
/** How long tmux waits, after this process is gone, before ending the program. */
const DEFAULT_ORPHAN_MS = 60_000;
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
  requireCount("orphanAfterMs", spawn.orphanAfterMs ?? undefined, MAX_TIMER_MS);
  if (typeof spawn.orphanAfterMs === "number" && spawn.orphanAfterMs < MIN_ORPHAN_MS) {
    throw new TypeError(`orphanAfterMs must be at least ${String(MIN_ORPHAN_MS)}`);
  }
  return placement;
}

/**
 * The pane's files and its first lease, sent in the list that creates the pane,
 * so a caller that dies before the program starts leaves nothing behind.
 */
function arming(
  target: string,
  owned: Owned,
  keep: boolean,
  files: RunFiles | undefined,
  lease: Lease | undefined,
): string[][] {
  return [
    ...(files === undefined
      ? []
      : [["set-option", "-p", "-t", target, "@libtmux-files", files.directory]]),
    ...(lease === undefined
      ? []
      : leaseTimer(target, owned, keep, files !== undefined, 0, lease.ms / 1000)),
  ];
}

/** Create the session whose dead placeholder pane the program will be respawned into. */
async function createSession(
  runtime: RuntimeContext,
  sessionName: string,
  spawn: SpawnOptions,
  arm: (target: string, owned: Owned) => string[][],
): Promise<string> {
  const target = `=${sessionName}:`;
  const [line = ""] = await runCommands(runtime, [
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id} #{pid} #{start_time}",
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
    ...arm(target, { kind: "session", target: `=${sessionName}` }),
  ]);
  const [paneId = "", pid = "", startTime = ""] = line.split(" ");
  const seen = lastObservedDaemon(runtime);
  // new-session started a server where the last one exited; the ids sent next are its.
  if (seen !== undefined && (seen.pid !== pid || seen.startTime !== startTime)) {
    await acquireServerGraph(runtime);
  }
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
 * window is named by its unique name; a split takes remain-on-exit with `-m`.
 */
async function createBeside(
  runtime: RuntimeContext,
  from: Pane,
  placement: "split" | "window",
  arm: (target: string, owned: Owned) => string[][],
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
    // -n turns automatic-rename off, so the name holds until a timer fires.
    ...arm(window, { kind: "window", target: window }),
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
  mark: string,
  input: string | undefined,
  stderr: string | undefined,
): string[] {
  const [program = "", ...rest] = argv;
  const steps: [string, string][] = [[MARK, mark]];
  // First, so a start directory the sh cannot enter says so there too.
  if (stderr !== undefined) steps.push([ERR, stderr]);
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
    throw new ServerNotLocalError(
      "stream, input and separateStderr need a tmux server that shares this process's temporary directory: a file its shell wrote there never arrived",
    );
  }
}

/**
 * Starts the program and waits for its exit in one list, inside which tmux
 * handles no other event. `armed` is what the creating list could not send.
 */
function startList(
  paneId: string,
  argv: readonly string[],
  spawn: SpawnOptions,
  files: RunFiles | undefined,
  mark: string,
  armed: string[][],
  started: string,
): string[][] {
  const stream = files?.stream;
  // One byte past the limit and the mark, so a cut copy can be told from one that fit.
  const room =
    stream?.limit === undefined ? undefined : stream.limit + markSequence(mark).length + 1;
  // GNU head holds its writes to a file until it exits; stdbuf, where there is one, lets
  // them through as they come.
  const copy =
    room === undefined
      ? "cat"
      : `if command -v stdbuf >/dev/null 2>&1; then stdbuf -o0 head -c ${String(room)}; ` +
        `else head -c ${String(room)}; fi`;
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
      ...wrapped(argv, spawn, mark, files?.input, files?.stderr),
    ],
    ...armed,
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
 * Wait until tmux has run the start list up to its `started` signal; a channel
 * signalled before its waiter arrives stays woken, so the order does not matter.
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
  // An abort during the creating list came before the listener.
  if (isAborted(signal)) giveUp();
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
  if (isAborted(signal) || timedOut) {
    // A signal that reached tmux after this waiter stopped left the channel woken.
    drainChannel(runtime, started);
  }
  if (isAborted(signal)) {
    throw cancelled(signal, "the start was cancelled and its pane removed", "indeterminate");
  }
  if (timedOut) throw new LibTmuxError(`tmux did not start the program in ${paneId}`);
}

/** Whether a command failed because the server exited under it, or had already. */
function serverWentAway(error: unknown): boolean {
  return (
    isColdEndpoint(error) ||
    (error instanceof TmuxTransportError && error.message.endsWith("server exited unexpectedly"))
  );
}

/** Refuse a tmux below 3.8; on a cold socket, the executable that will start the server answers. */
async function requireProgramRun(runtime: RuntimeContext, mayStart: boolean): Promise<void> {
  const tmuxVersion = await runtime.capabilities.bind().then(
    ({ tmuxVersion: daemon }) => daemon,
    async (error: unknown) => {
      if (!mayStart || !isColdEndpoint(error)) throw error;
      return executableTmuxVersion(runtime);
    },
  );
  if (hasCapability("program-run", tmuxVersion)) return;
  throw new VersionTooLowError({
    criteriaName: "program run",
    delivery: "not_started",
    remedy: "Upgrade tmux to 3.8 or newer and restart the server",
    serverVersion: tmuxVersion.raw,
    since: capabilitySince("program-run").raw,
  });
}

/** The run's private files, for an input, a stream or a separate stderr; none without them. */
async function runFiles(
  spawn: SpawnOptions & Pick<RunOptions, "separateStderr">,
): Promise<RunFiles | undefined> {
  if (spawn.stream !== true && spawn.input === undefined && spawn.separateStderr !== true) {
    return undefined;
  }
  // mkdtemp makes the directory 0700 whatever the umask, which keeps its files private.
  const directory = await mkdtemp(join(tmpdir(), "ltx-program-"));
  const files: RunFiles = {
    directory,
    input: spawn.input === undefined ? undefined : join(directory, "in"),
    stderr: spawn.separateStderr === true ? join(directory, "err") : undefined,
    stream:
      spawn.stream === true
        ? {
            done: join(directory, "done"),
            limit: spawn.maxStreamBytes,
            out: join(directory, "out"),
          }
        : undefined,
  };
  try {
    if (files.stream !== undefined) await writeFile(files.stream.out, "", { mode: 0o600 });
    if (files.stderr !== undefined) await writeFile(files.stderr, "", { mode: 0o600 });
    if (files.input !== undefined) await writeFile(files.input, spawn.input ?? "", { mode: 0o600 });
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
  return files;
}

/** Start `argv` in a pane of its own, with no shell parsing it; `signal` also stops setup. */
export async function spawnProgram(
  server: Server,
  runtime: RuntimeContext,
  argv: readonly string[],
  spawn: SpawnOptions & Pick<RunOptions, "separateStderr"> = {},
  signal?: AbortLike,
): Promise<Program> {
  const placement = requireSpawn(argv, spawn);
  if (spawn.from !== undefined) requireOnServer(spawn.from, server, "from");
  if (isAborted(signal)) throw cancelled(signal, "the start was cancelled", "not_started");
  await requireProgramRun(runtime, spawn.from === undefined);
  const watcher = new AbortController();
  let files: RunFiles | undefined;
  let lease: Lease | undefined;
  let owned: Owned | undefined;
  let paneId: string | undefined;
  try {
    files = await runFiles(spawn);
    const orphanAfterMs =
      spawn.orphanAfterMs === undefined ? DEFAULT_ORPHAN_MS : spawn.orphanAfterMs;
    lease =
      orphanAfterMs === null
        ? undefined
        : { ms: orphanAfterMs, renewing: false, timer: undefined, token: 0 };
    const keep = spawn.keep === true;
    const arm = (target: string, armed: Owned): string[][] =>
      arming(target, armed, keep, files, lease);
    let sessionName: string;
    // A split is made by one command, so its files and lease wait for the start list.
    let armed: string[][] = [];
    if (spawn.from === undefined) {
      sessionName = `libtmux-program-${randomUUID().slice(0, 12)}`;
      owned = { kind: "session", target: `=${sessionName}` };
      // A run that removed its server's last session leaves the server exiting, and this
      // new-session can meet it on the way out; nothing it made survives that, so try again.
      paneId = await createSession(runtime, sessionName, spawn, arm).catch(
        async (error: unknown) => {
          if (!serverWentAway(error)) throw error;
          return createSession(runtime, sessionName, spawn, arm);
        },
      );
    } else {
      ({ owned, paneId, sessionName } = await createBeside(
        runtime,
        spawn.from,
        placement === "split" ? "split" : "window",
        arm,
      ));
      if (placement === "split") armed = arm(paneId, owned);
    }
    // Asked once the pane exists, since a cold socket has no server to ask before.
    if (files !== undefined) await requireShared(runtime, files.directory);
    // Renewed from the moment the pane exists, however long the rest of setup takes.
    if (lease !== undefined)
      startRenewal({ files: files !== undefined, keep, owned, paneId, runtime, watcher }, lease);
    let failure: unknown;
    const mark = `libtmux-ran-${randomUUID()}`;
    const started = `libtmux-program-started-${randomUUID()}`;
    const exited = runCommands(
      runtime,
      startList(paneId, argv, spawn, files, mark, armed, started),
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
      keep,
      killing: undefined,
      lease,
      mark,
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
    clearInterval(lease?.timer);
    if (paneId !== undefined) await stopPane(runtime, paneId).catch(() => undefined);
    if (owned !== undefined && spawn.keep !== true) {
      await removeOwned(runtime, owned).catch(() => undefined);
    }
    if (files !== undefined) {
      await rm(files.directory, { force: true, recursive: true }).catch(() => undefined);
    }
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
  // Bun 1.3.14 stops an AbortSignal.timeout once its last listener goes, as setup's does;
  // 1.4 does not. The cancel example's test, which CI runs on 1.3.14, fails without this.
  const hold = (): void => undefined;
  options.signal?.addEventListener("abort", hold);
  try {
    return await runSpawned(server, runtime, argv, options);
  } finally {
    options.signal?.removeEventListener("abort", hold);
  }
}

async function runSpawned(
  server: Server,
  runtime: RuntimeContext,
  argv: readonly string[],
  options: RunOptions,
): Promise<ProgramResult> {
  const program = await spawnProgram(server, runtime, argv, options, options.signal);
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
      if (isAborted(options.signal)) {
        throw cancelled(options.signal, "the run was cancelled and its program ended", "written");
      }
      if (!(error instanceof WaitTimeoutError)) throw error;
      timedOut = true;
    }
    const { lostEnd, lostStart, text } = await programOutput(program);
    const stderr = await programStderr(program);
    failed = false;
    // A timed-out run is read before its end, so no mark is due yet.
    return {
      ...exit,
      lostEnd: lostEnd && !timedOut,
      lostStart,
      output: text,
      ...(stderr === undefined ? {} : { stderr }),
      success: exit.exitCode === 0,
      timedOut,
    };
  } finally {
    // Ending it must not hide the error the run failed with, as `await using` would.
    await killProgram(program).catch((error: unknown) => {
      if (!failed) throw error;
    });
  }
}
