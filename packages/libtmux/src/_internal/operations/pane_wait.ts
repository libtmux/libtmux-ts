// Waiting on any pane through tmux's own events: its program's exit, or a shell command's end.
import { randomUUID } from "node:crypto";

import { VersionTooLowError, WaitTimeoutError } from "../../errors.js";
import type { CommandWaitOptions, ProgramExit, ProgramWaitOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { capabilitySince, hasCapability } from "../support/capabilities.js";
import { runCommand, runCommands } from "./command.js";
import { sendKeys } from "./pane_io.js";
import {
  cancelled,
  isAborted,
  MAX_TIMER_MS,
  readPane,
  requireCount,
  signalName,
  sleep,
} from "./program.js";

/** tmux fires no event for a pane killed from outside, so a wait reads the pane this often anyway. */
const BACKSTOP_MS = 1000;
/** How long arming waits for tmux to register the waiter. */
const ARM_MS = 10_000;

type Payload = ReadonlyMap<string, string>;

/**
 * The payload of the event that ended a `wait-for -E -v` client. tmux prints
 * every event it checked, matching or not, each as its keys in sorted order
 * (`event_payload_first`), so a key that does not sort after the one before it
 * starts the next event, and the match is the last.
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
 * Register a waiter for `event` on the pane and return once tmux has it: one
 * list signals a channel of its own, then waits, and tmux handles no other
 * event in between. `fired` settles with the event's payload, or undefined
 * once `stop` ends the waiter; it is wrapped, since awaiting a promise of a
 * promise would wait for the event itself.
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
    if (failure !== undefined && !stop.aborted) throw failure;
    if (!stop.aborted) throw error;
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

/**
 * Arm waiters for `events`, run `act`, then resolve with the first payload
 * `decide` accepts, or the value `check` reads from the pane itself. A pane
 * that disappears without an event fails the read, as a missing pane.
 */
async function waitOnPane<T>(
  runtime: RuntimeContext,
  paneId: string,
  events: readonly string[],
  options: ProgramWaitOptions,
  decide: (payload: Payload) => T | undefined,
  check: () => Promise<T | undefined>,
  act: () => Promise<void>,
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
      events.map((event) => arm(runtime, paneId, event, stop.signal)),
    );
    if (isAborted(signal)) throw cancelled(signal);
    let found: T | undefined;
    const wake = new AbortController();
    stop.signal.addEventListener("abort", () => wake.abort(), { once: true });
    for (const { fired } of waiters) {
      void fired.then((payload) => {
        const value = payload === undefined ? undefined : decide(payload);
        if (value !== undefined && found === undefined) {
          found = value;
          wake.abort();
        }
      });
    }
    // An end before the waiters armed shows in the pane, which every read checks.
    await act();
    for (;;) {
      if (found !== undefined) return found;
      // eslint-disable-next-line no-await-in-loop -- each read follows the last wake.
      const seen = await check();
      if (seen !== undefined) return seen;
      if (found !== undefined) return found;
      if (isAborted(signal)) throw cancelled(signal);
      if (performance.now() >= deadline) {
        throw new WaitTimeoutError(`${paneId} was still running after ${String(timeoutMs)}ms`);
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
  return waitOnPane(
    runtime,
    paneId,
    ["pane-exited", "pane-died"],
    options,
    exitOf,
    () => deadExit(runtime, paneId),
    async () => undefined,
  );
}

/** Resolve with the status of the next command the pane's shell marks as finished with OSC 133. */
export async function waitForPaneCommand(
  runtime: RuntimeContext,
  paneId: string,
  options: CommandWaitOptions = {},
): Promise<number> {
  return waitOnPane(
    runtime,
    paneId,
    ["pane-command-finished"],
    options,
    (payload) => {
      const status = payload.get("command_status");
      return status === undefined ? undefined : Number(status);
    },
    async () => {
      // Only a read that fails says anything here: a pane that is gone.
      await readPane(runtime, paneId, []);
      return undefined;
    },
    async () => {
      if (options.send !== undefined)
        await sendKeys(runtime, paneId, options.send, { literal: true });
    },
  );
}
