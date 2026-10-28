// Program runs: the program's state once started, and waiting on, reading, streaming and ending it.
import { access, open, rm } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
  LibTmuxError,
  TmuxCommandError,
  TmuxObjectNotFoundError,
  TmuxTransportError,
  WaitTimeoutError,
} from "../../errors.js";
import type { CommandOptions } from "../../common.js";
import type { Program } from "../../program.js";
import type { AbortLike, ProgramExit, ProgramWaitOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand, runCommands } from "./command.js";

/** The pane's first process: it exits at once and stays, so the pane id exists before the program. */
export const PLACEHOLDER: readonly ["true", "libtmux-program-placeholder"] = [
  "true",
  "libtmux-program-placeholder",
];
export const PLACEHOLDER_COMMAND: string = PLACEHOLDER.join(" ");
/** A killed pane fires no event, so a wait reads the pane again this often anyway. */
const BACKSTOP_MS = 1000;
/**
 * How often a wait reads the pane after the watcher has settled without an exit:
 * during a kill's grace period, or after the waiter's tmux client ended.
 */
const SETTLED_POLL_MS = 50;
/** How long a killed program gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;
/** How long a stream waits, after the exit, for the copy to finish. */
const DRAIN_MS = 5000;
const STREAM_POLL_MS = 25;
export const MAX_TIMER_MS: number = 2 ** 31 - 1;

/** The run's private directory, holding its input and its stream copy. */
export interface RunFiles {
  readonly directory: string;
  readonly stream: StreamFiles | undefined;
}

export interface StreamFiles {
  /** Written once the copy has ended. */
  readonly done: string;
  /** The bytes the program wrote, in order. */
  readonly out: string;
  /** Where the copy stops, from `maxStreamBytes`. */
  readonly limit: number | undefined;
}

/** A session of the program's own, or the window or split it added to someone else's. */
export interface Owned {
  readonly kind: "pane" | "session" | "window";
  /** `=name` for a session, `@N` for a window, `%N` for a pane. */
  readonly target: string;
}

/** A lease tmux holds on the program; see {@link leaseTimer}. */
export interface Lease {
  readonly ms: number;
  token: number;
  renewing: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
}

export interface ProgramState {
  readonly runtime: RuntimeContext;
  readonly paneId: string;
  /** What this program created, and removes when it ends. */
  readonly owned: Owned;
  /** Aborts the `wait-for` client when the program is killed first. */
  readonly watcher: AbortController;
  /** Settles when tmux reports the exit, or the waiter is stopped; never rejects. */
  readonly exited: Promise<void>;
  readonly files: RunFiles | undefined;
  /** Whether the pane outlives the program, for a person to read. */
  readonly keep: boolean;
  readonly lease: Lease | undefined;
  exit: ProgramExit | undefined;
  killing: Promise<void> | undefined;
  /** Whether `exited` has settled; then each wait in `wakes` was woken once. */
  settled: boolean;
  readonly wakes: Set<AbortController>;
}

// Kept off the object, so a `Program` carries no field a caller could read or set.
const states = new WeakMap<object, ProgramState>();

/**
 * tmux's side of a lease: in `seconds`, if the pane's lease still holds `token`,
 * SIGKILL a program still running and remove what it ran in, unless kept. The
 * files go a second later, once a stream's writer, ended with the pane, has
 * finished. A renewal moves the token on. `##` defers each read to that moment.
 */
export function leaseTimer(
  paneId: string,
  owned: Owned,
  keep: boolean,
  files: boolean,
  token: number,
  seconds: number,
): string[][] {
  const kill = "##{?pane_dead,:,kill -s KILL -- -##{pane_pid} 2>/dev/null}";
  const clear = files ? "(sleep 1; rm -rf -- ##{q:@libtmux-files}) >/dev/null 2>&1 &" : ":";
  const remove = keep ? "" : ` ; kill-${owned.kind} -t ${owned.target}`;
  const expire = `if-shell -F -t ${paneId} "##{==:##{@libtmux-lease},${String(token)}}" "run-shell -t ${paneId} '${kill}; ${clear}'${remove}"`;
  return [
    ["set-option", "-p", "-t", paneId, "@libtmux-lease", String(token)],
    ["run-shell", "-b", "-d", seconds.toFixed(3), "-C", expire],
  ];
}

/** Move the lease on; a renewal still in flight is not overtaken, so tokens arrive in order. */
async function renew(state: ProgramState, lease: Lease): Promise<void> {
  if (lease.renewing) return;
  lease.renewing = true;
  lease.token += 1;
  try {
    await runCommands(
      state.runtime,
      leaseTimer(
        state.paneId,
        state.owned,
        state.keep,
        state.files !== undefined,
        lease.token,
        lease.ms / 1000,
      ),
    );
  } catch (error) {
    // tmux refusing it means the pane is gone from outside, with nothing left to lease.
    if (error instanceof TmuxCommandError) clearInterval(lease.timer);
  } finally {
    lease.renewing = false;
  }
}

/** Attach a started program's state to its handle; `program_start.ts` calls it once. */
export function registerProgram(program: Program, state: ProgramState): void {
  states.set(program, state);
  const { lease } = state;
  if (lease !== undefined) {
    // Unreferenced: a process with nothing else to do exits, and tmux then ends the program.
    lease.timer = setInterval(() => void renew(state, lease), lease.ms / 3);
    lease.timer.unref();
  }
  // One listener per program: one per wait would pile up on a long-lived exit.
  void state.exited.then(() => {
    state.settled = true;
    for (const wake of state.wakes) wake.abort();
  });
}

function stateOf(program: Program): ProgramState {
  const state = states.get(program);
  if (state === undefined) throw new TypeError("not a Program returned by Server.spawn");
  return state;
}

/** tmux names a signal by `sys_signame` where the platform has one (`term`), else by number (`15`). */
export function signalName(raw: string): string | null {
  if (raw === "") return null;
  if (/^[0-9]+$/u.test(raw)) {
    const number = Number(raw);
    const found = Object.entries(osConstants.signals).find(([, value]) => value === number);
    return found === undefined ? raw : found[0];
  }
  const upper = raw.toUpperCase();
  return upper.startsWith("SIG") ? upper : `SIG${upper}`;
}

export async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Read the flag afresh: a narrowed `signal.aborted` would hide an abort during an await. */
export function isAborted(signal: AbortLike | undefined): signal is AbortLike {
  return signal?.aborted === true;
}

export function cancelled(signal: AbortLike): TmuxTransportError {
  return new TmuxTransportError("the wait for the program was cancelled", {
    cause: signal.reason,
    delivery: "replied",
    kind: "cancelled",
  });
}

/** Resolve when `signal` fires; the returned function stops listening. */
function onAbort(signal: AbortLike | undefined): [Promise<void>, () => void] {
  if (signal === undefined) return [new Promise(() => undefined), () => undefined];
  let listener = (): void => undefined;
  const fired = new Promise<void>((resolve) => {
    listener = resolve;
    signal.addEventListener("abort", listener, { once: true });
  });
  return [fired, () => signal.removeEventListener("abort", listener)];
}

export function requireCount(name: string, value: number | undefined, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${String(maximum)}`);
  }
}

/** Sleep `ms`, or until `wake` aborts, leaving no timer or listener behind. */
export async function sleep(ms: number, wake?: AbortSignal): Promise<void> {
  await delay(ms, undefined, wake === undefined ? undefined : { signal: wake }).catch(
    () => undefined,
  );
}

/**
 * Read `formats` from a pane that must still exist: `display-message` expands
 * against nothing, and still succeeds, when its target is gone. The last value
 * keeps any tab of its own.
 */
export async function readPane(
  runtime: RuntimeContext,
  paneId: string,
  formats: readonly string[],
  options: CommandOptions = {},
): Promise<string[]> {
  const [line = ""] = await runCommand(
    runtime,
    ["display-message", "-p", "-t", paneId, ["#{pane_id}", ...formats].join("\t")],
    options,
  );
  const [id, ...values] = line.split("\t");
  if (id !== paneId) {
    throw new TmuxObjectNotFoundError({
      list_cmd: "display-message",
      list_extra_args: ["-t", paneId],
      obj_id: paneId,
      obj_key: "pane_id",
    });
  }
  const last = formats.length - 1;
  return [...values.slice(0, last), values.slice(last).join("\t")];
}

/**
 * How the program in a pane ended, once tmux has its status or signal: `pane_dead`
 * can turn 1 first, when the pty closes. The placeholder's death never counts.
 */
async function readExit(
  runtime: RuntimeContext,
  paneId: string,
  options: CommandOptions = {},
): Promise<ProgramExit | undefined> {
  const [dead, status = "", signal = "", command] = await readPane(
    runtime,
    paneId,
    ["#{pane_dead}", "#{pane_dead_status}", "#{pane_dead_signal}", "#{pane_start_command}"],
    options,
  );
  if (dead !== "1" || command === PLACEHOLDER_COMMAND || (status === "" && signal === "")) {
    return undefined;
  }
  return { exitCode: status === "" ? null : Number(status), signalCode: signalName(signal) };
}

/** Resolve when the program exits. */
export async function waitProgram(
  program: Program,
  options: ProgramWaitOptions = {},
): Promise<ProgramExit> {
  const state = stateOf(program);
  if (state.exit !== undefined) return state.exit;
  const { signal, timeoutMs } = options;
  requireCount("timeoutMs", timeoutMs, MAX_TIMER_MS);
  if (isAborted(signal)) throw cancelled(signal);
  const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
  const [aborted, stopListening] = onAbort(signal);
  // An abort also stops a read already in flight.
  const read = options.signal === undefined ? {} : { signal: options.signal };
  // Once the watcher has settled, waking on it again would spin.
  const wake = new AbortController();
  state.wakes.add(wake);
  void aborted.then(() => wake.abort());
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- each read follows the last wake.
      const exit = await readExit(state.runtime, state.paneId, read);
      if (exit !== undefined) {
        state.exit = exit;
        return exit;
      }
      if (isAborted(signal)) throw cancelled(signal);
      if (performance.now() >= deadline) {
        throw new WaitTimeoutError(
          `the program in ${state.paneId} was still running after ${String(timeoutMs)}ms`,
        );
      }
      // eslint-disable-next-line no-await-in-loop -- sleep until the exit, an abort, or the next read.
      await sleep(
        Math.min(
          state.settled ? SETTLED_POLL_MS : BACKSTOP_MS,
          Math.max(1, deadline - performance.now()),
        ),
        state.settled ? undefined : wake.signal,
      );
    }
  } finally {
    state.wakes.delete(wake);
    stopListening();
  }
}

/** The pane's rendered text, scrollback included, and whether any of it was dropped. */
export async function programOutput(
  program: Program,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const { paneId, runtime } = stateOf(program);
  const [collected = "", ...lines] = await runCommands(runtime, [
    ["display-message", "-p", "-t", paneId, "#{history_collected}"],
    ["capture-pane", "-p", "-J", "-S", "-", "-E", "-", "-t", paneId],
  ]).catch(async (error: unknown) => {
    // Only the capture fails for a pane that is gone; say so as a missing pane.
    await readPane(runtime, paneId, []);
    throw error;
  });
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return { text: lines.slice(0, end).join("\n"), truncated: Number(collected) > 0 };
}

/** The program's output as UTF-8 text, as it is written, until it exits. */
export async function* streamProgram(program: Program): AsyncGenerator<string, void, undefined> {
  const state = stateOf(program);
  const files = state.files?.stream;
  if (files === undefined) {
    throw new TypeError("spawn the program with { stream: true } to stream its output");
  }
  if (state.killing !== undefined) {
    throw new LibTmuxError("the program was killed, and its copied output with it");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(files.out, "r");
  } catch (error) {
    // A kill that landed between the check above and this open removed the copy.
    if (state.killing !== undefined) {
      throw new LibTmuxError("the program was killed, and its copied output with it");
    }
    throw error;
  }
  // Stopped when the consumer leaves early, so no wait outlives the loop.
  const stop = new AbortController();
  let ended = false;
  let lost: unknown;
  void waitProgram(program, { signal: stop.signal }).then(
    () => {
      ended = true;
    },
    (error: unknown) => {
      ended = true;
      lost = error;
    },
  );
  const decoder = new TextDecoder();
  try {
    const buffer = new Uint8Array(64 * 1024);
    let offset = 0;
    let drainUntil = Infinity;
    for (;;) {
      // The copy is complete once the pane is dead and the `cat` writing it has
      // exited; a copy that never finishes is given up on after DRAIN_MS.
      // eslint-disable-next-line no-await-in-loop -- decided before the read that may be the last.
      const complete = ended && ((await exists(files.done)) || performance.now() >= drainUntil);
      let read: number;
      do {
        // eslint-disable-next-line no-await-in-loop -- read what has arrived, in order.
        ({ bytesRead: read } = await handle.read(buffer, 0, buffer.length, offset));
        const kept = files.limit === undefined ? read : Math.min(read, files.limit - offset);
        offset += read;
        if (kept > 0) yield decoder.decode(buffer.subarray(0, kept), { stream: true });
        // The copy holds one byte past the limit, which is how a cut copy is told apart.
        if (files.limit !== undefined && offset > files.limit) {
          const tail = decoder.decode();
          if (tail !== "") yield tail;
          throw new LibTmuxError(
            `the program wrote more than maxStreamBytes (${String(files.limit)}); the copy stopped there`,
          );
        }
      } while (read > 0);
      if (state.killing !== undefined) {
        throw new LibTmuxError("the program was killed while its output streamed");
      }
      if (complete) break;
      if (ended && drainUntil === Infinity) drainUntil = performance.now() + DRAIN_MS;
      // A plain timer: racing the long-lived wait every poll would pile reactions on it.
      // eslint-disable-next-line no-await-in-loop -- wait for more output or the exit.
      await delay(ended ? 5 : STREAM_POLL_MS);
    }
    const tail = decoder.decode();
    if (tail !== "") yield tail;
    // A pane removed from outside ends the copy too; say so after what arrived.
    if (lost !== undefined) throw lost;
  } finally {
    stop.abort();
    await handle.close();
  }
}

/**
 * Signal the pane's process group from the tmux server's own machine, where its pid means it.
 * `-s NAME` is the form every `/bin/sh` takes; dash refuses `-NAME -- -PID`.
 */
async function signalPane(
  runtime: RuntimeContext,
  pid: string,
  signal: "KILL" | "TERM",
): Promise<void> {
  if (!/^[1-9][0-9]*$/u.test(pid)) return;
  await runCommand(runtime, [
    "run-shell",
    "--",
    `kill -s ${signal} -- -${pid} 2>/dev/null; :`,
  ]).catch(() => undefined);
}

/** Whether tmux records the pane's death within `ms`, which it does once it has reaped it. */
async function reaped(runtime: RuntimeContext, paneId: string, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- read until it is gone; a vanished pane counts.
    const ended = await readExit(runtime, paneId).then(
      (exit) => exit !== undefined,
      () => true,
    );
    if (ended || performance.now() >= deadline) return ended;
    // eslint-disable-next-line no-await-in-loop -- not yet.
    await delay(50);
  }
}

/**
 * End the program in a pane, if it runs: SIGTERM, SIGKILL after the grace
 * period, and back once tmux has reaped it. Removing the session only closes
 * the pty, which a program ignoring SIGHUP outlives.
 */
export async function stopPane(runtime: RuntimeContext, paneId: string): Promise<void> {
  const [dead, pid = ""] =
    (await readPane(runtime, paneId, ["#{pane_dead}", "#{pane_pid}"]).catch(() => undefined)) ?? [];
  if (dead !== "0") return;
  await signalPane(runtime, pid, "TERM");
  if (await reaped(runtime, paneId, KILL_GRACE_MS)) return;
  await signalPane(runtime, pid, "KILL");
  await reaped(runtime, paneId, KILL_GRACE_MS);
}

async function endProgram(state: ProgramState): Promise<void> {
  clearInterval(state.lease?.timer);
  try {
    state.watcher.abort();
    await state.exited;
    await stopPane(state.runtime, state.paneId);
    if (!state.keep) await removeOwned(state.runtime, state.owned);
  } finally {
    if (state.files !== undefined)
      await rm(state.files.directory, { force: true, recursive: true });
  }
}

/** Remove what a program created; an error stands only while that still exists. */
export async function removeOwned(runtime: RuntimeContext, owned: Owned): Promise<void> {
  try {
    await runCommand(runtime, [`kill-${owned.kind}`, "-t", owned.target]);
  } catch (error) {
    const probe =
      owned.kind === "session"
        ? ["has-session", "-t", owned.target]
        : ["display-message", "-p", "-t", owned.target, `#{${owned.kind}_id}`];
    const [still = ""] = await runCommand(runtime, probe).then(
      (lines) => (owned.kind === "session" ? ["yes"] : lines),
      () => [""],
    );
    if (still !== "") throw error;
  }
}

/** End the program, then remove its pane unless kept, and its files. Every call waits for the same end. */
export function killProgram(program: Program): Promise<void> {
  const state = stateOf(program);
  // Concurrent kills share one end; a kill that failed can be tried again.
  state.killing ??= endProgram(state).catch((error: unknown) => {
    state.killing = undefined;
    throw error;
  });
  return state.killing;
}
