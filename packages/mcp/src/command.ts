import { setTimeout as delay } from "node:timers/promises";

import type { Pane } from "libtmux";

import type { ToolContext } from "./context.js";
import { frame, parseFramedOutput, randomId, withoutForeignFraming } from "./command_frame.js";
import { captureGridBounded } from "./grid_capture.js";
import { effectiveWaitMs, MAX_RESULT_BYTES } from "./policy.js";

interface FramedResultBase {
  /** Whether the marker that releases the staged command was delivered. */
  readonly commandStarted: boolean;
  readonly effectiveTimeoutMs: number;
  /** Another writer was seen in this command's own output. */
  readonly foreignOutputSuspected: boolean;
  /** Output that fell out of the pane's buffer before this read reached it. */
  readonly missedBytes: number;
  readonly output: string;
  /** False when the start marker was gone and the returned output starts partway through. */
  readonly outputComplete: boolean;
  /** Settles when the wrapper ends or the pane can no longer run it. */
  readonly settled: Promise<void>;
}

export type FramedResult =
  | (FramedResultBase & { readonly exitStatus: number; readonly outcome: "completed" })
  | (FramedResultBase & {
      readonly exitStatus: null;
      readonly outcome: "cancelled" | "pane_died" | "timed_out";
    });

function beforeStartResult(
  effectiveTimeoutMs: number,
  outcome: "cancelled" | "pane_died" | "timed_out",
): FramedResult {
  return {
    commandStarted: false,
    effectiveTimeoutMs,
    exitStatus: null,
    foreignOutputSuspected: false,
    missedBytes: 0,
    outcome,
    output: "",
    outputComplete: true,
    settled: Promise.resolve(),
  };
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export interface FramedCommandReservation {
  release(): void;
  settleWith(settled: Promise<void>): void;
}

const activeCommands = new WeakMap<ToolContext, Map<string, Map<symbol, string>>>();

/** Describe the first unfinished command this server started in a pane. */
export function activeFramedCommand(context: ToolContext, paneId: string): string | undefined {
  return activeCommands.get(context)?.get(paneId)?.values().next().value;
}

/** Reserve a pane until the command's framing proves that it settled. */
export function reserveFramedCommand(
  context: ToolContext,
  paneId: string,
  command: string,
): FramedCommandReservation {
  const byPane = activeCommands.get(context) ?? new Map<string, Map<symbol, string>>();
  const commands = byPane.get(paneId) ?? new Map<symbol, string>();
  const token = Symbol(paneId);
  commands.set(token, JSON.stringify(command.slice(0, 80)));
  byPane.set(paneId, commands);
  activeCommands.set(context, byPane);

  const release = (): void => {
    commands.delete(token);
    if (commands.size === 0) byPane.delete(paneId);
    if (byPane.size === 0) activeCommands.delete(context);
  };
  return {
    release,
    settleWith: (settled) => {
      void settled.then(release, () => undefined);
    },
  };
}

/** How far back a fallback capture reads, so a marker that scrolled is still found. */
const FALLBACK_SCROLLBACK = 400;

/** How often the fallback re-reads the pane when no stream is available. */
const FALLBACK_POLL_MS = 60;

/** How often an already-returned command checks a streamless pane. */
const SETTLEMENT_POLL_MS = 1_000;

/** How often settlement confirms that a quiet pane still exists. */
const SETTLEMENT_LIVENESS_MS = 5_000;

/** Read a bounded tail of the rendered grid when no live stream is available. */
async function fallbackStream(
  pane: Pane,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<string> {
  const height =
    pane.height !== null && Number.isSafeInteger(pane.height) && pane.height > 0 ? pane.height : 1;
  return captureGridBounded(pane, {
    byteLimit: MAX_RESULT_BYTES,
    joinWrapped: true,
    lineLimit: Math.min(Number.MAX_SAFE_INTEGER, FALLBACK_SCROLLBACK + height),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    start: -FALLBACK_SCROLLBACK,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
    .then(({ lines }) => lines.join("\n"))
    .catch(() => "");
}

/** Keep a timed-out pane reserved until its wrapper ends or its pane dies. */
async function waitForSettlement(
  context: ToolContext,
  pane: Pane,
  id: string,
  cursor: string | undefined,
  initialTail: Awaited<ReturnType<ToolContext["hub"]["tail"]>>,
): Promise<void> {
  let tail = initialTail;
  let askedAlive = 0;
  for (;;) {
    if (context.hub.closed) return;
    if (tail?.endReason !== undefined) {
      if (tail.endReason === "hub_closed") return;
      tail = undefined;
    }

    let stream: string;
    if (tail === undefined) {
      // eslint-disable-next-line no-await-in-loop -- each capture follows the previous observation.
      stream = await fallbackStream(pane);
    } else {
      stream = tail.read(cursor).text;
    }
    if (parseFramedOutput(stream, id) !== undefined) return;

    if (Date.now() - askedAlive >= SETTLEMENT_LIVENESS_MS) {
      askedAlive = Date.now();
      // eslint-disable-next-line no-await-in-loop -- liveness is sampled over time.
      const current = await context
        .snapshot()
        .then((snapshot) => snapshot.panes.first({ id: pane.id }))
        .catch(() => undefined);
      if (current === undefined || current.dead === true) return;
    }

    if (tail === undefined) {
      // eslint-disable-next-line no-await-in-loop -- a streamless monitor polls serially.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SETTLEMENT_POLL_MS);
        timer.unref?.();
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- each wait follows the previous read.
    const changed = await tail.changed(SETTLEMENT_POLL_MS);
    if (changed === "closed" && tail.endReason === "hub_closed") return;
  }
}

async function sendLiteralLine(pane: Pane, line: string): Promise<void> {
  await pane.sendKeys(line, { literal: true });
}

function hasExactLine(stream: string, expected: string): boolean {
  return stream.split("\n").some((line) => line.trimEnd() === expected);
}

/**
 * Run `command` in `pane` and wait for it to finish.
 *
 * Streams tmux's notifications when a control connection can be had, and falls
 * back to re-reading the pane when it cannot — the framing makes both correct,
 * so the difference is cost rather than accuracy.
 */
export async function runFramedCommand(
  context: ToolContext,
  pane: Pane,
  command: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
  suppressHistory = true,
): Promise<FramedResult> {
  const budget = effectiveWaitMs(context.policy, timeoutMs);
  if (isCancelled(signal)) return beforeStartResult(budget, "cancelled");
  const id = `ltx${randomId()}`;
  const ready = `ltxr${randomId()}`;
  const source = frame(command, ready, suppressHistory);
  const sessionId = pane.format.session_id;

  let tail = context.policy.liveEnabled
    ? await context.hub.tail(sessionId, pane.id, signal)
    : undefined;
  if (isCancelled(signal)) return beforeStartResult(budget, "cancelled");

  // Read the stream position before sending: output printed between the send
  // and the first read would otherwise be attributed to whatever came before.
  const cursor = tail?.cursor;
  const deadline = Date.now() + budget;
  let missedBytes = 0;
  let commandStarted = false;
  let usedFallback = tail === undefined;
  await sendLiteralLine(pane, source);
  for (;;) {
    if (Date.now() >= deadline || isCancelled(signal)) break;
    if (tail?.endReason !== undefined) {
      tail = undefined;
      usedFallback = true;
    }
    let stream: string;
    if (tail === undefined) {
      // eslint-disable-next-line no-await-in-loop -- each read follows the last.
      stream = await fallbackStream(pane, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    } else {
      const reading = tail.read(cursor);
      stream = reading.text;
      missedBytes = Math.max(missedBytes, reading.missedBytes);
    }
    if (!commandStarted && hasExactLine(stream, `${ready}_R`)) {
      if (Date.now() >= deadline || isCancelled(signal)) break;
      // eslint-disable-next-line no-await-in-loop -- input follows the readiness observation.
      await sendLiteralLine(pane, id);
      commandStarted = true;
    }
    if (commandStarted) {
      const found = parseFramedOutput(stream, id);
      if (found !== undefined) {
        return {
          commandStarted: true,
          effectiveTimeoutMs: budget,
          missedBytes,
          ...found,
          outcome: "completed",
          outputComplete: found.outputComplete && !usedFallback,
          settled: Promise.resolve(),
        };
      }
    }
    if (Date.now() >= deadline || isCancelled(signal)) break;
    if (tail === undefined) {
      try {
        // eslint-disable-next-line no-await-in-loop -- the poll follows its read.
        await delay(
          Math.min(FALLBACK_POLL_MS, Math.max(1, deadline - Date.now())),
          undefined,
          signal === undefined ? undefined : { signal },
        );
      } catch (error) {
        if (!isCancelled(signal)) throw error;
      }
    } else {
      // eslint-disable-next-line no-await-in-loop -- the wait follows its read.
      const change = await tail.changed(
        Math.min(FALLBACK_POLL_MS * 4, Math.max(1, deadline - Date.now())),
        signal,
      );
      if (change === "closed") {
        tail = undefined;
        usedFallback = true;
      }
    }
  }
  const cancelled = isCancelled(signal);
  if (!commandStarted) {
    await pane.sendKeys("C-c", { enter: false });
    if (cancelled) return beforeStartResult(budget, "cancelled");
    const after = (await context.snapshot()).panes.first({ id: pane.id });
    return beforeStartResult(
      budget,
      after !== undefined && after.dead !== true ? "timed_out" : "pane_died",
    );
  }
  if (cancelled) {
    return {
      commandStarted: true,
      effectiveTimeoutMs: budget,
      exitStatus: null,
      foreignOutputSuspected: false,
      missedBytes,
      outcome: "cancelled",
      output: "",
      outputComplete: false,
      settled: waitForSettlement(context, pane, id, cursor, tail),
    };
  }

  // Timed out, or the pane died under it — which is a different answer, and the
  // only one where calling again would wait on something that cannot arrive.
  const partial = tail === undefined ? await fallbackStream(pane) : tail.read(cursor).text;
  const startAt = partial.indexOf(`${id}_S`);
  const afterStart = startAt < 0 ? -1 : partial.indexOf("\n", startAt);
  const output = afterStart < 0 ? partial : partial.slice(afterStart + 1);
  // The same cleaning as the completed path: a command that timed out has been
  // sharing the pane for longer, not less.
  const cleaned = withoutForeignFraming(output.replaceAll("\r\n", "\n"), id);

  // Present is not alive: a pane kept by remain-on-exit still exists, and
  // reporting timed_out for it says the command may yet finish.
  const after = (await context.snapshot()).panes.first({ id: pane.id });
  const alive = after !== undefined && after.dead !== true;
  return {
    commandStarted: true,
    effectiveTimeoutMs: budget,
    exitStatus: null,
    foreignOutputSuspected: cleaned.foreignOutputSuspected,
    missedBytes,
    outcome: alive ? "timed_out" : "pane_died",
    output: cleaned.text,
    outputComplete: startAt >= 0 && missedBytes === 0 && !usedFallback,
    settled: alive ? waitForSettlement(context, pane, id, cursor, tail) : Promise.resolve(),
  };
}
