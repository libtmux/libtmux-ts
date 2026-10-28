// Program runs: validating a request, making the pane, and starting the program in it.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  MAX_TIMER_MS,
  PLACEHOLDER,
  programOutput,
  readPane,
  registerProgram,
  removeOwned,
  requireCount,
  stopPane,
  waitProgram,
  type Owned,
  type StreamFiles,
} from "./program.js";

/**
 * Runs argv unparsed, as positional parameters, then lingers 50 ms and exits or dies
 * as the program did: tmux can remove a pane before reading its last output.
 */
const RUN =
  'trap : HUP INT QUIT TERM; exec 3>&2 2>/dev/null; (exec "$0" "$@" 2>&3 3>&-); s=$?; ' +
  'sleep 0.05 2>/dev/null || sleep 1; if [ "$s" -gt 128 ] && n=$(kill -l "$s") && [ -n "$n" ]; then ' +
  'trap - "$n"; kill -s "$n" "$$"; fi; exit "$s"';
const EXEC = ["sh", "-c", RUN] as const;
/**
 * The same, after entering the directory given as `$1`: tmux's own `-c` falls
 * back to `$HOME` for one it cannot enter, where this ends the run with 126.
 */
const EXEC_IN = ["sh", "-c", `cd -- "$1" || exit 126; shift; ${RUN}`] as const;
/** How long setup waits for tmux to start the program, and for the stream copy to appear. */
const SETUP_MS = 10_000;
/** How long tmux keeps a finished run's session if the caller never removed it. */
const ORPHAN_SECONDS = 60;
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

function requireSpawn(argv: readonly string[], spawn: SpawnOptions): void {
  const [program = ""] = argv;
  if (program === "") throw new TypeError("argv must name a program");
  // bash, which is /bin/sh on some systems, reads `exec -l` as an option to exec itself.
  if (program.startsWith("-")) throw new TypeError("argv[0] must not start with -; name it ./-x");
  for (const name of Object.keys(spawn.environment ?? {})) {
    if (name === "" || name.includes("=")) {
      throw new TypeError(`environment variable name ${JSON.stringify(name)} is not valid`);
    }
  }
  if (spawn.from !== undefined) {
    // The window joins that pane's session, whose size and scrollback are its owner's.
    for (const name of ["width", "height", "historyLimit"] as const) {
      if (spawn[name] !== undefined) throw new TypeError(`${name} cannot be set with from`);
    }
  }
  requireCount("width", spawn.width, MAX_SIZE);
  requireCount("height", spawn.height, MAX_SIZE);
  requireCount("historyLimit", spawn.historyLimit, MAX_HISTORY_LIMIT);
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

/**
 * A window in `from`'s session and directory, holding the placeholder. Its id is
 * unknown inside the creating list, so remain-on-exit is set by its unique name.
 */
async function createWindow(
  runtime: RuntimeContext,
  from: Pane,
): Promise<{ readonly paneId: string; readonly sessionName: string; readonly windowId: string }> {
  const [sessionId = "", sessionName = "", path = ""] = await readPane(runtime, from.id, [
    "#{session_id}",
    "#{session_name}",
    "#{pane_current_path}",
  ]);
  const name = `libtmux-program-${randomUUID().slice(0, 12)}`;
  const window = `${sessionId}:=${name}`;
  // tmux expands a start directory as a format; the inherited path is literal.
  const directory = path === "" ? undefined : literalDirectory(path);
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
      ...(directory === undefined ? [] : ["-c", directory]),
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
  return { paneId, sessionName, windowId };
}

/** What `run` adds: tmux cleans up for a dead caller, and `signal` also stops setup. */
type Reap = { readonly signal?: AbortLike; readonly timeoutMs?: number };

/**
 * Has tmux SIGKILL the program in `seconds` if its pane still lives; the death
 * wakes the waiter and fires the hook. `##` defers the pane read to that moment.
 */
export function deadlineReap(paneId: string, seconds: number): string[] {
  const end = "'##{?pane_dead,:,kill -s KILL -- -##{pane_pid} 2>/dev/null; :}'";
  return ["run-shell", "-b", "-d", String(seconds), "-C", `run-shell -t ${paneId} ${end}`];
}

/**
 * Starts the program and waits for its exit in one list, inside which tmux
 * handles no other event; a `reap` adds the removing hook and the deadline timer.
 */
function startList(
  paneId: string,
  owned: Owned,
  argv: readonly string[],
  spawn: SpawnOptions,
  files: StreamFiles | undefined,
  reap: Reap | undefined,
  started: string,
): string[][] {
  const remove = `run-shell -b -d ${String(ORPHAN_SECONDS)} -C 'kill-${owned.kind} -t ${owned.target}'`;
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
      ...(spawn.startDirectory === undefined
        ? [...EXEC, ...argv]
        : [...EXEC_IN, argv[0] ?? "", spawn.startDirectory, ...argv.slice(1)]),
    ],
    ...(reap === undefined ? [] : [["set-hook", "-p", "-t", paneId, "pane-died", remove]]),
    ...(reap?.timeoutMs === undefined
      ? []
      : [deadlineReap(paneId, Math.ceil(reap.timeoutMs / 1000) + ORPHAN_SECONDS)]),
    ...(files === undefined
      ? []
      : [
          [
            "pipe-pane",
            "-O",
            "-t",
            paneId,
            literalPipe(`cat > ${shellQuote(files.out)}; : > ${shellQuote(files.done)}`),
          ],
        ]),
    ["wait-for", "-S", started],
    ["wait-for", "-E", "-F", `#{==:#{pane},${paneId}}`, "pane-died"],
  ];
}

/**
 * Wait until tmux has run the start list up to its `started` signal and, for a
 * stream, created its copy. A channel signalled before its waiter arrives stays
 * woken, so the order of the two clients does not matter.
 */
async function confirmStarted(
  runtime: RuntimeContext,
  paneId: string,
  files: StreamFiles | undefined,
  failure: () => unknown,
  exited: Promise<void>,
  signal: AbortLike | undefined,
  started: string,
  watcher: AbortController,
): Promise<void> {
  const deadline = performance.now() + SETUP_MS;
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
  if (files === undefined) return;
  // The copy is written on the tmux server's machine; elsewhere the file never appears.
  // eslint-disable-next-line no-await-in-loop -- the pipe's shell creates the file at once.
  while (!(await exists(files.out))) {
    if (isAborted(signal)) throw cancelled(signal);
    const failed = failure();
    if (failed !== undefined) throw failed;
    if (performance.now() >= deadline) {
      throw new LibTmuxError(
        "stream needs the tmux server on this machine: its copy never appeared in this temporary directory",
      );
    }
    // eslint-disable-next-line no-await-in-loop -- not there yet.
    await delay(5);
  }
}

/**
 * Start `argv` in a fresh detached session, with no shell parsing it; `run`
 * passes a `reap` so tmux cleans up for a caller that dies first.
 */
export async function spawnProgram(
  server: Server,
  runtime: RuntimeContext,
  argv: readonly string[],
  spawn: SpawnOptions = {},
  reap?: Reap,
): Promise<Program> {
  requireSpawn(argv, spawn);
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
  let files: StreamFiles | undefined;
  let owned: Owned | undefined;
  let paneId: string | undefined;
  try {
    let sessionName: string;
    if (spawn.from === undefined) {
      sessionName = `libtmux-program-${randomUUID().slice(0, 12)}`;
      owned = { kind: "session", target: `=${sessionName}` };
      paneId = await createSession(runtime, sessionName, spawn);
    } else {
      const window = await createWindow(runtime, spawn.from);
      ({ paneId, sessionName } = window);
      owned = { kind: "window", target: window.windowId };
    }
    if (spawn.stream === true) {
      // mkdtemp makes the directory 0700 whatever the umask, which keeps the copy private.
      const directory = await mkdtemp(join(tmpdir(), "libtmux-program-"));
      files = { directory, done: join(directory, "done"), out: join(directory, "out") };
    }
    let failure: unknown;
    const started = `libtmux-program-started-${randomUUID()}`;
    const exited = runCommands(
      runtime,
      startList(paneId, owned, argv, spawn, files, reap, started),
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
    await confirmStarted(
      runtime,
      paneId,
      files,
      () => failure,
      exited,
      reap?.signal,
      started,
      watcher,
    );
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
      killing: undefined,
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
    if (owned !== undefined) await removeOwned(runtime, owned).catch(() => undefined);
    if (files !== undefined) await rm(files.directory, { force: true, recursive: true });
    throw error;
  }
}

/** Run `argv` to completion in a detached session and report what it printed. */
export async function runProgram(
  server: Server,
  runtime: RuntimeContext,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<ProgramResult> {
  requireCount("timeoutMs", options.timeoutMs, MAX_TIMER_MS);
  if (isAborted(options.signal)) throw cancelled(options.signal);
  // The deadline and the signal bound the program, not the tmux commands that start it.
  const program = await spawnProgram(server, runtime, argv, options, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
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
