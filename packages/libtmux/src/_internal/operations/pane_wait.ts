// Waiting on any pane through tmux's own events: its program's exit, a shell command's end, or text.
import { randomUUID } from "node:crypto";

import {
  LibTmuxError,
  TmuxObjectNotFoundError,
  VersionTooLowError,
  WaitTimeoutError,
} from "../../errors.js";
import type { CommandWaitOptions, ProgramExit, ProgramWaitOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { capabilitySince, hasCapability } from "../support/capabilities.js";
import { isServerGone, runCommand, runCommands } from "./command.js";
import { sendKeys } from "./pane_io.js";
import {
  BACKSTOP_MS,
  cancelled,
  drainChannel,
  isAborted,
  paneGone,
  MAX_TIMER_MS,
  readPane,
  requireCount,
  signalName,
  sleep,
} from "./program.js";

/** How long arming waits for tmux to register the waiter. */
const ARM_MS = 10_000;
/** How long a pane found gone may take to deliver the event its closing fired. */
const DELIVERY_MS = 1000;
/** The least time between two reads of a busy pane's screen. */
const TEXT_ROUND_MS = 50;

type Payload = ReadonlyMap<string, string>;

/**
 * The last of the payloads a `wait-for -E -v` client printed, one per event it
 * checked, each with sorted keys: a key not after the one before starts the next.
 * tmux prints values raw, so only a session name holding a newline could split one.
 */
export function lastPayload(lines: readonly string[]): Payload {
  let block = new Map<string, string>();
  let previous = "";
  for (const line of lines) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at);
    if (key <= previous) block = new Map();
    block.set(key, line.slice(at + 1));
    previous = key;
  }
  return block;
}

async function requirePaneWait(runtime: RuntimeContext): Promise<void> {
  const { tmuxVersion } = await runtime.capabilities.bind();
  if (hasCapability("pane-wait", tmuxVersion)) return;
  throw new VersionTooLowError({
    criteriaName: "pane wait",
    delivery: "not_started",
    remedy: "Upgrade tmux to 3.8 or newer and restart the server",
    serverVersion: tmuxVersion.raw,
    since: capabilitySince("pane-wait").raw,
  });
}

/**
 * Register a waiter for `event` and return once tmux has it: one list signals a
 * channel, then waits. `fired` is wrapped, since awaiting it would await the event.
 */
async function arm(
  runtime: RuntimeContext,
  paneId: string,
  event: string,
  stop: AbortSignal,
): Promise<{ readonly fired: Promise<Payload | undefined> }> {
  const armed = `libtmux-wait-${randomUUID()}`;
  let failure: unknown;
  const fired = runCommands(
    runtime,
    [
      ["wait-for", "-S", armed],
      ["wait-for", "-E", "-v", "-F", `#{==:#{pane},${paneId}}`, event],
    ],
    { signal: stop, timeoutMs: null },
  ).then(lastPayload, (error: unknown) => {
    failure = error;
    return undefined;
  });
  // The arming wait stops only once the list can no longer signal, which a
  // failed list cannot: a waiter stopped first would leave the channel woken.
  const giveUp = new AbortController();
  void fired.then(() => {
    if (failure !== undefined) giveUp.abort();
  });
  try {
    await runCommand(runtime, ["wait-for", armed], { signal: giveUp.signal, timeoutMs: ARM_MS });
  } catch (error) {
    // A server that exited with the pane, its last, took the pane with it.
    if (failure !== undefined && !stop.aborted) {
      throw isServerGone(failure) ? paneGone(paneId) : failure;
    }
    if (!stop.aborted) throw isServerGone(error) ? paneGone(paneId) : error;
    // Cancelled: a list that signalled left the channel woken, which one more wait consumes.
    drainChannel(runtime, armed);
  }
  return { fired };
}

/** How a pane's program ended, from a `pane-exited` or `pane-died` payload. */
function exitOf(payload: Payload): ProgramExit | undefined {
  const status = payload.get("exit_status");
  const signal = payload.get("exit_signal");
  if (status === undefined && signal === undefined) return undefined;
  return {
    exitCode: status === undefined ? null : Number(status),
    signalCode: signal === undefined ? null : signalName(signal),
  };
}

/** The pane's exit, if it is a dead one tmux kept; undefined while it runs. */
async function deadExit(runtime: RuntimeContext, paneId: string): Promise<ProgramExit | undefined> {
  const [dead, status = "", signal = ""] = await readPane(runtime, paneId, [
    "#{pane_dead}",
    "#{pane_dead_status}",
    "#{pane_dead_signal}",
  ]);
  if (dead !== "1" || (status === "" && signal === "")) return undefined;
  return { exitCode: status === "" ? null : Number(status), signalCode: signalName(signal) };
}

/** What a pane wait listens for and how it reads its answer. */
interface PaneWait<T> {
  readonly events: readonly string[];
  /** The answer a payload carries, if any. */
  readonly decide: (payload: Payload) => T | undefined;
  /** Read the pane for an answer the events may have come before. */
  readonly check: () => Promise<T | undefined>;
  /** Run once the waiters are armed. */
  readonly act?: () => Promise<void>;
  /** What a timeout says was still awaited, and the likely reason. */
  readonly awaited: string;
}

/**
 * Arm waiters for `wait.events`, run `wait.act`, then resolve with the first
 * payload `wait.decide` accepts, or what `wait.check` reads from the pane.
 */
async function waitOnPane<T>(
  runtime: RuntimeContext,
  paneId: string,
  options: ProgramWaitOptions,
  wait: PaneWait<T>,
): Promise<T> {
  const { signal, timeoutMs } = options;
  requireCount("timeoutMs", timeoutMs, MAX_TIMER_MS);
  if (isAborted(signal)) throw cancelled(signal);
  await requirePaneWait(runtime);
  const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
  const stop = new AbortController();
  const onAbort = (): void => stop.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const waiters = await Promise.all(
      wait.events.map((event) => arm(runtime, paneId, event, stop.signal)),
    );
    if (isAborted(signal)) throw cancelled(signal);
    let found: T | undefined;
    const wake = new AbortController();
    stop.signal.addEventListener("abort", () => wake.abort(), { once: true });
    for (const { fired } of waiters) {
      void fired.then((payload) => {
        const value = payload === undefined ? undefined : wait.decide(payload);
        if (value !== undefined && found === undefined) {
          found = value;
          wake.abort();
        }
      });
    }
    // An end before the waiters armed shows in the pane, which every read checks.
    await wait.act?.();
    for (;;) {
      if (found !== undefined) return found;
      let seen: T | undefined;
      try {
        // eslint-disable-next-line no-await-in-loop -- each read follows the last wake.
        seen = await wait.check();
      } catch (error) {
        if (!(error instanceof TmuxObjectNotFoundError)) throw error;
        // A pane that closed fired its event as it went; the payload may still be on its way.
        // An answer ends the grace at once, as does every waiter having had its say.
        const delivered = new AbortController();
        const answered = (): void => delivered.abort();
        wake.signal.addEventListener("abort", answered, { once: true });
        if (wake.signal.aborted) answered();
        // eslint-disable-next-line no-await-in-loop -- once, on the way out.
        await Promise.race([
          Promise.all(waiters.map(({ fired }) => fired)).finally(answered),
          sleep(DELIVERY_MS, delivered.signal),
        ]);
        wake.signal.removeEventListener("abort", answered);
        if (found !== undefined) return found;
        throw error;
      }
      if (seen !== undefined) return seen;
      if (found !== undefined) return found;
      if (isAborted(signal)) throw cancelled(signal);
      if (performance.now() >= deadline) {
        throw new WaitTimeoutError(`${paneId}: after ${String(timeoutMs)}ms, ${wait.awaited}`);
      }
      // eslint-disable-next-line no-await-in-loop -- sleep until an event, an abort, or the next read.
      await sleep(Math.min(BACKSTOP_MS, Math.max(1, deadline - performance.now())), wake.signal);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    stop.abort();
  }
}

/** Resolve with how the pane's program ended: `pane-exited` for a pane that closes, `pane-died` for one kept. */
export async function waitForPaneExit(
  runtime: RuntimeContext,
  paneId: string,
  options: ProgramWaitOptions = {},
): Promise<ProgramExit> {
  return waitOnPane(runtime, paneId, options, {
    awaited: "its program was still running",
    check: () => deadExit(runtime, paneId),
    decide: exitOf,
    events: ["pane-exited", "pane-died"],
  });
}

/** Resolve with the status of the next command the pane's shell marks as finished with OSC 133. */
export async function waitForPaneCommand(
  runtime: RuntimeContext,
  paneId: string,
  options: CommandWaitOptions = {},
): Promise<number> {
  return waitOnPane(runtime, paneId, options, {
    act: async () => {
      if (options.send !== undefined) {
        await sendKeys(runtime, paneId, options.send, { literal: true });
      }
    },
    awaited:
      "no command had finished; only a shell that marks each command's end with OSC 133 D " +
      "reports one",
    check: async () => {
      // A gone pane fails the read; a dead one will finish no command.
      const [dead] = await readPane(runtime, paneId, ["#{pane_dead}"]);
      if (dead === "1") throw new LibTmuxError(`${paneId} has exited; no command will finish`);
      return undefined;
    },
    decide: (payload) => {
      const status = Number(payload.get("command_status") ?? Number.NaN);
      return Number.isSafeInteger(status) ? status : undefined;
    },
    events: ["pane-command-finished"],
  });
}

/**
 * Resolve with the first line of the pane's screen that `pattern` matches. tmux
 * fires `pane-activity` on each server loop in which the pane printed, so a
 * waiter armed before each read wakes for any output after it.
 */
export async function waitForPaneText(
  runtime: RuntimeContext,
  paneId: string,
  pattern: string | RegExp,
  options: ProgramWaitOptions = {},
): Promise<string> {
  const { signal, timeoutMs } = options;
  requireCount("timeoutMs", timeoutMs, MAX_TIMER_MS);
  if (isAborted(signal)) throw cancelled(signal);
  await requirePaneWait(runtime);
  const matches =
    typeof pattern === "string"
      ? (line: string): boolean => line.includes(pattern)
      : (line: string): boolean => {
          pattern.lastIndex = 0;
          return pattern.test(line);
        };
  const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
  // The waiter armed for this round, and what wakes the sleep after its read.
  let round: AbortController | undefined;
  let fired: Promise<Payload | undefined> | undefined;
  let wake = new AbortController();
  const stop = new AbortController();
  const onAbort = (): void => {
    stop.abort();
    wake.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (fired === undefined) {
        round = new AbortController();
        // eslint-disable-next-line no-await-in-loop -- armed before the read it follows.
        ({ fired } = await arm(runtime, paneId, "pane-activity", round.signal));
        const woken = new AbortController();
        wake = woken;
        void fired.then(() => woken.abort());
      }
      if (isAborted(signal)) throw cancelled(signal);
      // eslint-disable-next-line no-await-in-loop -- each read follows the last wake.
      const [dead = "", ...screen] = await runCommands(runtime, [
        ["display-message", "-p", "-t", paneId, "#{pane_dead}"],
        ["capture-pane", "-p", "-J", "-t", paneId],
      ]).catch(async (error: unknown) => {
        // A pane that is gone fails the list; say so as a missing pane.
        await readPane(runtime, paneId, []);
        throw error;
      });
      const found = screen.find(matches);
      if (found !== undefined) return found;
      if (dead === "1") throw new LibTmuxError(`${paneId} has exited; its screen will not change`);
      if (performance.now() >= deadline) {
        throw new WaitTimeoutError(
          `${paneId}: after ${String(timeoutMs)}ms, no line matched ${String(pattern)}`,
        );
      }
      // eslint-disable-next-line no-await-in-loop -- sleep until output, an abort, or the next read.
      await sleep(Math.min(BACKSTOP_MS, Math.max(1, deadline - performance.now())), wake.signal);
      if (isAborted(signal)) throw cancelled(signal);
      if (wake.signal.aborted) {
        // That waiter is spent; the next round arms another before reading.
        fired = undefined;
        // eslint-disable-next-line no-await-in-loop -- a busy pane is read at most this often.
        await sleep(TEXT_ROUND_MS, stop.signal);
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    stop.abort();
    round?.abort();
  }
}
