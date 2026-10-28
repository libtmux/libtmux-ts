// Program runs: the program's state once started, and waiting on, reading and ending it.
import { access, readFile, rm } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
  ProgramStartError,
  TmuxObjectNotFoundError,
  TmuxTransportError,
  WaitTimeoutError,
  type ProgramStartFailure,
} from "../../errors.js";
import type { DeliveryStatus } from "../../common.js";
import type { DaemonGuard } from "../../engine.js";
import type { Program } from "../../program.js";
import type { AbortLike, ProgramExit, ProgramWaitOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { isColdEndpoint, runCommand, runCommands, type PinnedCommandOptions } from "./command.js";
import type { Lease } from "./program_lease.js";

/** The pane's first process: it exits at once and stays, so the pane id exists before the program. */
export const PLACEHOLDER: readonly ["true", "libtmux-program-placeholder"] = [
  "true",
  "libtmux-program-placeholder",
];
export const PLACEHOLDER_COMMAND: string = PLACEHOLDER.join(" ");
/** A killed pane fires no event, so a wait also reads the pane this often. */
export const BACKSTOP_MS = 1000;
/**
 * How often a wait reads the pane after the watcher has settled without an exit:
 * during a kill's grace period, or after the waiter's tmux client ended.
 */
const SETTLED_POLL_MS = 50;
/** How long a killed program gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;
/** How long a cancelled waiter's channel is given to deliver the wake its list may still send. */
const CHANNEL_DRAIN_MS = 1000;
export const MAX_TIMER_MS: number = 2 ** 31 - 1;

/** Consume the wake a list may still leave on `channel` after its waiter gave up. */
export function drainChannel(runtime: RuntimeContext, channel: string): void {
  void runCommand(runtime, ["wait-for", channel], { timeoutMs: CHANNEL_DRAIN_MS }).catch(
    () => undefined,
  );
}

/** The run's private directory, holding its input, its stream copy and its stderr. */
export interface RunFiles {
  readonly directory: string;
  /** The program's stdin, from `input`. */
  readonly input: string | undefined;
  readonly stream: StreamFiles | undefined;
  /** Where the program's stderr goes, when kept apart from the terminal. */
  readonly stderr: string | undefined;
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

/**
 * The daemon a program was started on. Its pane's `%N` names another pane on a
 * restarted server, so every command for the program is refused anywhere else.
 * Unset only until the first read of a server this spawn started.
 */
export interface DaemonPin {
  daemon: DaemonGuard | undefined;
}

export interface ProgramState {
  readonly runtime: RuntimeContext;
  readonly pin: DaemonPin;
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
  /** The OSC 7 path the wrapper writes after the program: tmux read to the end iff it shows. */
  readonly mark: string;
  /** `argv[0]`, for the error a program that never ran raises. */
  readonly program: string;
  exit: ProgramExit | undefined;
  /** Set with `exit` when the wrapper's mark said the program never ran. */
  startError: ProgramStartError | undefined;
  killing: Promise<void> | undefined;
  /** Whether `exited` has settled; then each wait in `wakes` was woken once. */
  settled: boolean;
  readonly wakes: Set<AbortController>;
}

// Kept off the object, so a `Program` carries no field a caller could read or set.
const states = new WeakMap<object, ProgramState>();

/** Attach a started program's state to its handle; `program_start.ts` calls it once. */
export function registerProgram(program: Program, state: ProgramState): void {
  states.set(program, state);
  // One listener per program: one per wait would pile up on a long-lived exit.
  void state.exited.then(() => {
    state.settled = true;
    for (const wake of state.wakes) wake.abort();
  });
}

export function stateOf(program: Program): ProgramState {
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

/** `delivery` says how far the program got: a wait leaves it as it was. */
export function cancelled(
  signal: AbortLike,
  message = "the wait for the program was cancelled",
  delivery: DeliveryStatus = "replied",
): TmuxTransportError {
  return new TmuxTransportError(message, { cause: signal.reason, delivery, kind: "cancelled" });
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
 * Read `formats` from a pane that must exist: `display-message` on a gone
 * target expands against nothing and succeeds. The last value keeps its tabs.
 */
export async function readPane(
  runtime: RuntimeContext,
  paneId: string,
  formats: readonly string[],
  options: PinnedCommandOptions = {},
): Promise<string[]> {
  const missing = (): TmuxObjectNotFoundError =>
    new TmuxObjectNotFoundError({
      list_cmd: "display-message",
      list_extra_args: ["-t", paneId],
      obj_id: paneId,
      obj_key: "pane_id",
    });
  const [line = ""] = await runCommand(
    runtime,
    ["display-message", "-p", "-t", paneId, ["#{pane_id}", ...formats].join("\t")],
    options,
  ).catch((error: unknown) => {
    // A server that exited with its last session took the pane with it.
    throw isColdEndpoint(error) ? missing() : error;
  });
  const [id, ...values] = line.split("\t");
  if (id !== paneId) throw missing();
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
  options: PinnedCommandOptions = {},
): Promise<(ProgramExit & { readonly path: string }) | undefined> {
  const [dead, status = "", signal = "", path = "", command] = await readPane(
    runtime,
    paneId,
    [
      "#{pane_dead}",
      "#{pane_dead_status}",
      "#{pane_dead_signal}",
      "#{pane_path}",
      "#{pane_start_command}",
    ],
    options,
  );
  if (dead !== "1" || command === PLACEHOLDER_COMMAND || (status === "" && signal === "")) {
    return undefined;
  }
  return { exitCode: status === "" ? null : Number(status), path, signalCode: signalName(signal) };
}

const START_FAILURES: Readonly<Record<ProgramStartFailure, (program: string) => string>> = {
  "not-executable": (program) => `${program} is not an executable file`,
  "not-found": (program) => `${program} was not found on the program's PATH`,
  "start-directory": () => "the program's startDirectory could not be entered",
};

/** The error for a program the wrapper's mark says never ran, if it did not. */
function startError(state: ProgramState, path: string): ProgramStartError | undefined {
  if (!path.startsWith(`${state.mark}:`)) return undefined;
  const reason = path.slice(state.mark.length + 1);
  if (!Object.hasOwn(START_FAILURES, reason)) return undefined;
  const failure = reason as ProgramStartFailure;
  return new ProgramStartError(START_FAILURES[failure](state.program), failure);
}

/** Resolve when the program exits. */
export async function waitProgram(
  program: Program,
  options: ProgramWaitOptions = {},
): Promise<ProgramExit> {
  const state = stateOf(program);
  if (state.startError !== undefined) throw state.startError;
  if (state.exit !== undefined) return state.exit;
  const { signal, timeoutMs } = options;
  requireCount("timeoutMs", timeoutMs, MAX_TIMER_MS);
  const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
  const [aborted, stopListening] = onAbort(signal);
  // An abort also stops a read already in flight.
  const read = {
    daemon: state.pin.daemon,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  // Once the watcher has settled, waking on it again would spin.
  const wake = new AbortController();
  state.wakes.add(wake);
  void aborted.then(() => wake.abort());
  try {
    for (;;) {
      // An abort wakes the loop; a read sent after it would be refused as unsent.
      if (isAborted(signal)) throw cancelled(signal);
      // eslint-disable-next-line no-await-in-loop -- each read follows the last wake.
      const exit = await readExit(state.runtime, state.paneId, read).catch((error: unknown) => {
        // A read the abort cut short leaves the program running, as any cancelled wait does.
        if (isAborted(signal)) throw cancelled(signal);
        // tmux fires no event for a pane removed from outside, so its exit watch would wait on.
        if (error instanceof TmuxObjectNotFoundError) state.watcher.abort();
        throw error;
      });
      if (exit !== undefined) {
        state.exit = { exitCode: exit.exitCode, signalCode: exit.signalCode };
        state.startError = startError(state, exit.path);
        if (state.startError !== undefined) throw state.startError;
        return state.exit;
      }
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

/** What the program wrote to stderr, for a run that kept it apart from the terminal. */
export async function programStderr(program: Program): Promise<string | undefined> {
  const path = stateOf(program).files?.stderr;
  if (path === undefined) return undefined;
  return new TextDecoder().decode(await readFile(path));
}

/** The pane's rendered text, and whether its start or, once ended, its end may be missing. */
export async function programOutput(
  program: Program,
): Promise<{ readonly lostEnd: boolean; readonly lostStart: boolean; readonly text: string }> {
  const { mark, paneId, pin, runtime } = stateOf(program);
  const [read = "", ...lines] = await runCommands(
    runtime,
    [
      ["display-message", "-p", "-t", paneId, "#{history_collected}\t#{pane_dead}\t#{pane_path}"],
      ["capture-pane", "-p", "-J", "-S", "-", "-E", "-", "-t", paneId],
    ],
    { daemon: pin.daemon },
  ).catch(async (error: unknown) => {
    // Only the capture fails for a pane that is gone; say so as a missing pane.
    await readPane(runtime, paneId, [], { daemon: pin.daemon });
    throw error;
  });
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  const [collected = "", dead = "", path = ""] = read.split("\t");
  return {
    lostEnd: dead === "1" && path !== mark && !path.startsWith(`${mark}:`),
    lostStart: Number(collected) > 0,
    text: lines.slice(0, end).join("\n"),
  };
}

/**
 * Signal a live pane's process group on the tmux server's machine. tmux reads
 * `pane_dead` and `pane_pid` as it runs this, so a dead pane's reused pid is spared.
 */
async function signalPane(
  runtime: RuntimeContext,
  paneId: string,
  signal: "KILL" | "TERM",
  daemon: DaemonGuard | undefined,
): Promise<void> {
  // `-s NAME` is POSIX's form, and dash takes no other: it refuses `-NAME -- -PID`.
  await runCommand(
    runtime,
    ["run-shell", "-t", paneId, `#{?pane_dead,:,kill -s ${signal} -- -#{pane_pid} 2>/dev/null}; :`],
    { daemon },
  ).catch(() => undefined);
}

/** Whether tmux records the pane's death within `ms`, which it does once it has reaped it. */
async function reaped(
  runtime: RuntimeContext,
  paneId: string,
  ms: number,
  daemon: DaemonGuard | undefined,
): Promise<boolean> {
  const deadline = performance.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- read until it is gone; a vanished pane counts.
    const ended = await readExit(runtime, paneId, { daemon }).then(
      (exit) => exit !== undefined,
      () => true,
    );
    if (ended || performance.now() >= deadline) return ended;
    // eslint-disable-next-line no-await-in-loop -- not yet.
    await delay(50);
  }
}

/**
 * End the program in a pane: SIGTERM, then SIGKILL after the grace, back once
 * tmux has reaped it. A program ignoring SIGHUP outlives its pane's removal.
 */
export async function stopPane(
  runtime: RuntimeContext,
  paneId: string,
  daemon: DaemonGuard | undefined,
): Promise<void> {
  const [dead] =
    (await readPane(runtime, paneId, ["#{pane_dead}"], { daemon }).catch(() => undefined)) ?? [];
  if (dead !== "0") return;
  await signalPane(runtime, paneId, "TERM", daemon);
  if (await reaped(runtime, paneId, KILL_GRACE_MS, daemon)) return;
  await signalPane(runtime, paneId, "KILL", daemon);
  await reaped(runtime, paneId, KILL_GRACE_MS, daemon);
}

async function endProgram(state: ProgramState): Promise<void> {
  clearInterval(state.lease?.timer);
  try {
    state.watcher.abort();
    await state.exited;
    // A server that has restarted took the pane with it: each of these is refused there.
    await stopPane(state.runtime, state.paneId, state.pin.daemon);
    if (!state.keep) await removeOwned(state.runtime, state.owned, state.pin.daemon);
    // A kept pane outlives its lease: retire the token, so no queued timer acts on it.
    else if (state.lease !== undefined) {
      await runCommand(
        state.runtime,
        ["set-option", "-p", "-t", state.paneId, "@libtmux-lease", "ended"],
        { daemon: state.pin.daemon },
      ).catch(() => undefined);
    }
  } finally {
    if (state.files !== undefined) {
      await rm(state.files.directory, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

/** Remove what a program created; an error stands only while that still exists. */
export async function removeOwned(
  runtime: RuntimeContext,
  owned: Owned,
  daemon: DaemonGuard | undefined,
): Promise<void> {
  try {
    await runCommand(runtime, [`kill-${owned.kind}`, "-t", owned.target], { daemon });
  } catch (error) {
    const probe =
      owned.kind === "session"
        ? ["has-session", "-t", owned.target]
        : ["display-message", "-p", "-t", owned.target, `#{${owned.kind}_id}`];
    const [still = ""] = await runCommand(runtime, probe, { daemon }).then(
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
