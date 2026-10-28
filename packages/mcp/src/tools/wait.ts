/**
 * Waiting for a pane to say something, without polling and without hanging.
 *
 * These stream tmux's own notifications, so nothing is spent while nothing is
 * happening. The ceiling is low because the wait still spends the caller's
 * turn.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  compileBoundedRegex,
  ObjectNotFoundError,
  TmuxTransportError,
  WaitTimeoutError,
} from "libtmux";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { readServerAuthority } from "../caller.js";
import { requireLiveCursor, type ToolContext } from "../context.js";
import { captureGridBounded } from "../grid_capture.js";
import { liveEcho, withoutEchoes, type PaneServerIdentity } from "../pane_echo.js";
import {
  DEFAULT_BLOCKING_WAIT_MS,
  effectiveResultLines,
  effectiveWaitMs,
  MAX_RESULT_BYTES,
} from "../policy.js";
import { type ToolRegistrar } from "../register.js";
import { boundText, fail, ok, renderBoundedText } from "../results.js";
import { paneCursorSchema, paneIdSchema, requestTextArray } from "../schemas.js";
import { isFailure, requirePane, type ReadablePane } from "../target_resolution.js";
import type { PaneTailEndReason } from "../pane_tail.js";

type WaitOutcome =
  | "cancelled"
  | "matched"
  | "no_stream"
  | "output_lost"
  | "pane_died"
  | "stream_lost"
  | "timed_out";

interface WaitReport {
  readonly cursor: string | null;
  readonly effectiveTimeoutMs: number;
  readonly matched: string | null;
  readonly missedBytes: number;
  readonly outcome: WaitOutcome;
  readonly output: string;
  readonly streamFailure: PaneTailEndReason | null;
}

/** How long a quiet stream is left alone before the loop looks again. */
const IDLE_WAKE_MS = 500;

/**
 * How often a wait that is hearing nothing checks that its pane still exists.
 *
 * A pane's death is not output, so nothing wakes the wait to announce it and
 * the only way to hear about it is to ask. Asking on every idle wake would
 * spend a snapshot twice a second, so a quiet wait asks on this interval
 * instead, and a wait that is hearing output never asks at all.
 */
const LIVENESS_MS = 5_000;

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Whether the watched pane is still there to be read.
 *
 * A server that no longer answers has no panes, so a failed snapshot against
 * a dead daemon is the pane's end, not an error the caller can act on. Any
 * other failure, and a cancelled read, still propagates.
 */
async function paneExists(
  context: ToolContext,
  pane: ReadablePane,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    const current = (await context.snapshot(signal)).panes.first({ id: pane.id });
    return current !== undefined && current.dead !== true;
  } catch (error) {
    if (isCancelled(signal) || (await context.tmux.isAlive())) throw error;
    return false;
  }
}

/**
 * Remove this server's own typed-but-not-real-output text from candidate output.
 *
 * `pending` (the line still being edited) is read fresh every call: a key this
 * server cannot model invalidates it immediately (`pane_echo.ts`), and a wait
 * already in progress must see that right away rather than keep discounting
 * text that may no longer describe the line. `recentSoFar` instead only ever
 * grows across one wait's whole loop: a submitted line's echo ages out of the
 * shared store on a fixed TTL, but the bytes it discounts are already sitting
 * in this wait's own buffered tail, unmoved by wall-clock time — a wait still
 * reading them must keep discounting a line it once saw, even past the TTL
 * that bounds how long a *new* wait would still discount it.
 */
function withoutPendingEcho(
  text: string,
  paneId: string,
  identity: PaneServerIdentity,
  recentSoFar: Set<string>,
): string {
  const echo = liveEcho(paneId, identity);
  for (const line of echo.recent) recentSoFar.add(line);
  if (echo.pending === "" && recentSoFar.size === 0) return text;
  return withoutEchoes(text, echo.pending === "" ? recentSoFar : [echo.pending, ...recentSoFar]);
}

/** What the pane already showed before this wait subscribed. */
async function screenAtEntry(context: ToolContext, pane: ReadablePane): Promise<string> {
  const capture = await captureGridBounded(pane, {
    byteLimit: MAX_RESULT_BYTES,
    joinWrapped: true,
    lineLimit: effectiveResultLines(context.policy, undefined),
  }).catch(() => undefined);
  return capture === undefined ? "" : capture.lines.join("\n");
}

const POLL_MS = 100;

/**
 * Wait by reading the screen, for a daemon that cannot be watched.
 *
 * A match counts only when it is not text the screen already showed on entry,
 * and the cursor is null because a screen read has no stream position to resume.
 */
async function pollForOutput(
  context: ToolContext,
  pane: ReadablePane,
  entryScreen: string,
  options: {
    readonly matches: (text: string) => string | undefined;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
): Promise<WaitReport> {
  const identity = await readServerAuthority(context.tmux, options.signal);
  const recentSoFar = new Set<string>();
  const deadline = Date.now() + options.timeoutMs;
  let output = "";
  const report = (outcome: WaitReport["outcome"], matched: string | null): WaitReport => ({
    cursor: null,
    effectiveTimeoutMs: options.timeoutMs,
    matched,
    missedBytes: 0,
    outcome,
    output,
    streamFailure: null,
  });
  for (;;) {
    if (isCancelled(options.signal)) return report("cancelled", null);
    // Rows joined on the wrap flag, as the control stream presents them, so a
    // match straddling the pane's last column is found. A pane that vanished
    // mid-read fails the capture; it ended the wait, so it answers as that.
    // eslint-disable-next-line no-await-in-loop -- each read follows the last.
    const capture = await captureGridBounded(pane, {
      byteLimit: MAX_RESULT_BYTES,
      joinWrapped: true,
      lineLimit: effectiveResultLines(context.policy, undefined),
    }).catch(async (error: unknown) => {
      if (!(await paneExists(context, pane, options.signal))) return undefined;
      throw error;
    });
    if (capture === undefined) return report("pane_died", null);
    output = capture.lines.join("\n");
    const hit = options.matches(withoutPendingEcho(output, pane.id, identity, recentSoFar));
    if (hit !== undefined && !entryScreen.includes(hit)) return report("matched", hit);
    if (Date.now() >= deadline) {
      // eslint-disable-next-line no-await-in-loop -- reached once, on the way out.
      const alive = await paneExists(context, pane, options.signal);
      return report(alive ? "timed_out" : "pane_died", null);
    }
    // eslint-disable-next-line no-await-in-loop -- the poll follows its read.
    await delay(
      Math.min(POLL_MS, Math.max(1, deadline - Date.now())),
      undefined,
      options.signal === undefined ? undefined : { signal: options.signal },
    ).catch(() => undefined);
  }
}

/**
 * Wait for a pane to print something matching, and report why the wait ended.
 *
 * Subscribes before it looks. A control client is told nothing that happened
 * before it attached, so reading first and subscribing second waits forever on
 * text that already arrived.
 *
 * A fresh subscribe's first match is not allowed to be either of two things:
 * text already on the screen when this wait started, or this server's own
 * not-yet-submitted type-ahead. A pane's line editor re-prints a pending line
 * once it starts reading, and that re-print is genuinely new bytes arriving
 * after subscribe — indistinguishable from real output by timing alone, so
 * both are excluded by what they are rather than when they arrived. A wait
 * continued from an earlier `cursor` carries no such ambiguity — the cursor
 * already names exactly which bytes are new — so only a fresh subscribe
 * pays for the entry screen or excludes against it.
 */
async function waitForOutput(
  context: ToolContext,
  pane: ReadablePane,
  options: {
    readonly cursor?: string;
    readonly matches: (text: string) => string | undefined;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
): Promise<WaitReport> {
  const sessionId = pane.format.session_id;
  const entryScreen = options.cursor === undefined ? await screenAtEntry(context, pane) : "";
  // Control is chosen before it is attempted: below 3.7 no client attaches and
  // the wait polls the pane, as it does when live observation is switched off.
  const controlAllowed = context.policy.liveEnabled && (await context.tmux.versionAtLeast("3.7"));
  const tail = controlAllowed
    ? await context.hub.tail(sessionId, pane.id, options.signal)
    : undefined;
  if (isCancelled(options.signal)) {
    return {
      cursor: null,
      effectiveTimeoutMs: options.timeoutMs,
      matched: null,
      missedBytes: 0,
      outcome: "cancelled",
      output: "",
      streamFailure: null,
    };
  }
  if (tail === undefined) return pollForOutput(context, pane, entryScreen, options);

  // Fetched once, not per loop iteration: the pane-input paths that record an
  // echo already have their own authenticated authority on hand, and a wait
  // only needs enough of one round trip to find the same server-keyed record.
  const identity = await readServerAuthority(context.tmux, options.signal);
  const recentSoFar = new Set<string>();
  const from = options.cursor ?? tail.cursor;
  const deadline = Date.now() + options.timeoutMs;
  let askedAlive = Date.now();
  // Whether a genuine push notification — not the first read after subscribe,
  // where a screen-at-entry replay is indistinguishable from fresh bytes by
  // timing alone — has arrived on this stream yet.
  let freshOutputSeen = false;
  for (;;) {
    const seen = tail.read(from);
    const candidate = withoutPendingEcho(seen.text, pane.id, identity, recentSoFar);
    const hit = options.matches(candidate);
    // A hit that is only ever a replay of what the entry screen already showed
    // is not counted until real output has been observed at least once. Moot
    // once `options.cursor` was given: `entryScreen` is already empty then.
    const echoOnly = hit !== undefined && !freshOutputSeen && entryScreen.includes(hit);
    if (hit !== undefined && !echoOnly) {
      return {
        cursor: seen.cursor,
        effectiveTimeoutMs: options.timeoutMs,
        matched: hit,
        missedBytes: seen.missedBytes,
        outcome: "matched",
        output: seen.text,
        streamFailure: null,
      };
    }
    if (seen.missedBytes > 0) {
      return {
        cursor: null,
        effectiveTimeoutMs: options.timeoutMs,
        matched: null,
        missedBytes: seen.missedBytes,
        outcome: "output_lost",
        output: seen.text,
        streamFailure: null,
      };
    }
    // A caller that has gone away is not owed the rest of its deadline, and the
    // connection it was holding is wanted by somebody else.
    if (isCancelled(options.signal)) {
      return {
        cursor: seen.cursor,
        effectiveTimeoutMs: options.timeoutMs,
        matched: null,
        missedBytes: 0,
        outcome: "cancelled",
        output: seen.text,
        streamFailure: null,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // A dead pane and a quiet one look the same from the stream, and only one
      // of them is worth waiting on again.
      // eslint-disable-next-line no-await-in-loop -- reached once, on the way out.
      const alive = await paneExists(context, pane, options.signal);
      return {
        cursor: seen.cursor,
        effectiveTimeoutMs: options.timeoutMs,
        matched: null,
        missedBytes: 0,
        outcome: alive ? "timed_out" : "pane_died",
        output: seen.text,
        streamFailure: null,
      };
    }
    // eslint-disable-next-line no-await-in-loop -- each wait follows its read.
    const change = await tail.changed(Math.min(remaining, IDLE_WAKE_MS), options.signal);
    if (change === "closed") {
      const last = tail.read(from);
      // A stream also ends because its pane did. Waiting again cannot help
      // then, so the answer is the one the poll gives, not "start again".
      // eslint-disable-next-line no-await-in-loop -- reached once, on the way out.
      if (!(await paneExists(context, pane, options.signal))) {
        return {
          cursor: null,
          effectiveTimeoutMs: options.timeoutMs,
          matched: null,
          missedBytes: last.missedBytes,
          outcome: "pane_died",
          output: last.text,
          streamFailure: null,
        };
      }
      return {
        cursor: null,
        effectiveTimeoutMs: options.timeoutMs,
        matched: null,
        missedBytes: last.missedBytes,
        outcome: "stream_lost",
        output: last.text,
        streamFailure: tail.endReason ?? "connection_lost",
      };
    }
    if (change === "changed") freshOutputSeen = true;
    if (change === "changed" || change === "cancelled" || Date.now() - askedAlive < LIVENESS_MS) {
      continue;
    }

    // Nothing arrived, and a pane that has died will never make anything
    // arrive. Waiting out the deadline reports the death long after it mattered.
    askedAlive = Date.now();
    // eslint-disable-next-line no-await-in-loop -- only a wait hearing nothing pays this.
    if (!(await paneExists(context, pane, options.signal))) {
      const last = tail.read(from);
      return {
        cursor: last.cursor,
        effectiveTimeoutMs: options.timeoutMs,
        matched: null,
        missedBytes: last.missedBytes,
        outcome: "pane_died",
        output: last.text,
        streamFailure: null,
      };
    }
  }
}

/**
 * Turn a report into the answer a caller reads, matched or not.
 *
 * A wait that did not match also reports the pane's screen. The stream starts
 * where the wait started, so text printed before it began is not in the stream
 * at all — an agent that waits for something that already happened would
 * otherwise be told nothing twice. The screen is not matched against, so stale
 * text on it cannot satisfy a wait that should have failed.
 */
async function renderWait(
  context: ToolContext,
  pane: ReadablePane,
  report: WaitReport,
  maxLines: number | undefined,
  describe: string,
  matches: (text: string) => string | undefined,
): Promise<CallToolResult> {
  const paneId = pane.id;
  if (report.outcome === "no_stream") {
    return fail({
      hint:
        context.hub.controlRefusal === undefined
          ? "Use capture_pane, or start the server without LIBTMUX_MCP_LIVE=0."
          : "Use capture_pane to read the pane on this tmux.",
      reason:
        context.hub.controlRefusal === undefined
          ? `Cannot watch ${paneId}: no control-mode connection is available.`
          : `Cannot watch ${paneId}: ${context.hub.controlRefusal}.`,
    });
  }
  const limit = effectiveResultLines(context.policy, maxLines);
  const output = boundText(
    report.output === "" ? [] : report.output.split("\n"),
    limit,
    MAX_RESULT_BYTES,
  );
  const screenBudget = MAX_RESULT_BYTES - output.returnedBytes;
  const capture =
    report.outcome === "matched" || report.outcome === "cancelled"
      ? undefined
      : await captureGridBounded(pane, {
          byteLimit: screenBudget,
          lineLimit: limit,
        }).catch(() => undefined);
  const boundedScreen = boundText(capture?.lines ?? [], limit, screenBudget);
  const screen = boundedScreen.text;
  const screenClamped =
    capture !== undefined &&
    (capture.byteClamped || capture.range.clamped || boundedScreen.omittedBytes > 0);

  // A wait is deliberately blind to what was already on the screen: matching it
  // would let text from an hour ago satisfy a wait that should have failed. But
  // "it printed just before you asked" and "it never printed" are different
  // answers, and only one of them is worth waiting again for — so the screen is
  // tested here, where it changes what the caller is told rather than whether
  // the wait matched.
  const alreadyOnScreen = screen !== "" && matches(screen) !== undefined;

  const note =
    report.outcome === "matched"
      ? `matched ${describe}`
      : report.outcome === "cancelled"
        ? "cancelled before it matched"
        : report.outcome === "stream_lost"
          ? `the live stream ended (${report.streamFailure ?? "connection_lost"}); omit cursor to start again or use capture_pane`
          : report.outcome === "output_lost"
            ? "output passed the retained tail before it could be checked; omit cursor to start a fresh wait"
            : alreadyOnScreen
              ? `no match while waiting, but ${describe} is on the pane now — it printed before this wait began. Read it with capture_pane; wait again from cursor=${String(report.cursor)} only if you want the next one`
              : report.outcome === "pane_died"
                ? "the pane exited before it matched; waiting again cannot help"
                : `no match in ${String(report.effectiveTimeoutMs)}ms — call again with cursor=${String(report.cursor)} to carry on from here`;

  const outputText = renderBoundedText(output, "read again from the returned cursor");
  const screenText =
    screen === ""
      ? screenClamped
        ? "[pane screen omitted by the result limits]"
        : ""
      : `${screenClamped ? "[pane screen shortened by the result limits]\n" : ""}${screen}`;
  const body =
    screenText === "" ? outputText : `${outputText}\n\n[the pane currently shows]\n${screenText}`;
  const missed =
    report.missedBytes === 0
      ? ""
      : `\n\n[${String(report.missedBytes)} retained bytes were lost before this read; the result is incomplete]`;

  return ok(
    {
      alreadyOnScreen,
      cursor: report.cursor,
      droppedLines: output.droppedLines,
      effectiveTimeoutMs: report.effectiveTimeoutMs,
      matched: report.matched,
      missedBytes: report.missedBytes,
      omittedBytes: output.omittedBytes,
      outcome: report.outcome,
      output: output.text,
      paneId,
      returnedBytes: output.returnedBytes + boundedScreen.returnedBytes,
      screen,
      screenClamped,
      streamFailure: report.streamFailure,
    },
    `${body}${missed}\n\n[${note}]`,
  );
}

const waitOutputSchema = {
  alreadyOnScreen: z
    .boolean()
    .describe(
      "The pattern is on the pane now but printed before this wait began, so the wait could not match it. Read it with capture_pane rather than waiting again.",
    ),
  cursor: paneCursorSchema
    .nullable()
    .describe(
      "Pass to capture_since or another wait; null means the live stream cannot be resumed.",
    ),
  droppedLines: z.number().int().describe("Output lines omitted by the result limit."),
  effectiveTimeoutMs: z.number().int().describe("The timeout actually enforced, after clamping."),
  matched: z.string().nullable().describe("The text that matched, or null."),
  missedBytes: z
    .number()
    .int()
    .describe("Retained output lost before this read; non-zero means the result is incomplete."),
  omittedBytes: z.number().int().describe("Output bytes omitted by the result ceiling."),
  outcome: z
    .enum([
      "matched",
      "timed_out",
      "pane_died",
      "no_stream",
      "cancelled",
      "output_lost",
      "stream_lost",
    ])
    .describe("Why the wait ended. Read this rather than guessing from the output."),
  output: z.string().describe("The bounded tail of what the pane printed while waiting."),
  paneId: paneIdSchema,
  returnedBytes: z.number().int().describe("UTF-8 bytes returned across output and screen."),
  screen: z
    .string()
    .describe(
      "What the pane shows now after a miss, unless result limits omit it; see screenClamped.",
    ),
  screenClamped: z.boolean().describe("Whether result limits shortened the pane screen."),
  streamFailure: z
    .enum(["connection_lost", "events_dropped", "expired", "hub_closed", "topology_changed"])
    .nullable()
    .describe("Why the live stream ended, or null while it remained valid."),
};

export function registerWait(mcp: ToolRegistrar, context: ToolContext): void {
  const inputSchema = {
    cursor: paneCursorSchema
      .optional()
      .describe("Start from a cursor an earlier capture_since or wait returned."),
    maxLines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Keep at most this many lines, from the end. Defaults to the server limit."),
    paneId: paneIdSchema,
    patterns: requestTextArray("pattern", "patterns")
      .optional()
      .describe("Any one of these ends the wait. Omit to wait for any output at all."),
    regex: z
      .boolean()
      .optional()
      .describe("Interpret patterns using libtmux's bounded regular-expression grammar."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Clamped by the server ceiling; the result reports what was used."),
  };

  const description =
    "Wait until a pane prints something, streaming tmux's notifications rather " +
    "than polling. Use for output you did NOT author — another process, a person, " +
    "a background job. For a command you wrote, use run_shell_command: it knows when the " +
    "command ended and reports exit status, which no text match can. This discounts " +
    "text this server itself typed into the pane, for as long as it is unsubmitted " +
    "or was submitted within the last ten seconds, so a command you just sent cannot " +
    "match its own echo — but a pane not yet reading input can still echo type-ahead " +
    "back once it starts, so wait for a prompt before typing into a cold shell. " +
    "Whatever happens you get back what the pane printed and why the wait ended — " +
    "a timeout is never an empty answer.";

  function buildMatcher(
    patterns: readonly string[] | undefined,
    regex: boolean,
  ): (text: string) => string | undefined {
    if (patterns === undefined || patterns.length === 0) {
      return (text) => (text === "" ? undefined : text.slice(-80));
    }
    if (!regex) return (text) => patterns.find((pattern) => text.includes(pattern));
    const compiled = patterns.map((pattern) => compileBoundedRegex(pattern));
    return (text) => patterns.find((_, index) => compiled[index]?.test(text) === true);
  }

  async function run(
    signal: AbortSignal | undefined,
    args: {
      cursor?: string | undefined;
      maxLines?: number | undefined;
      paneId: string;
      patterns?: string[] | undefined;
      regex?: boolean | undefined;
      timeoutMs?: number | undefined;
    },
  ): Promise<CallToolResult> {
    const matcher = buildMatcher(args.patterns, args.regex === true);

    const snapshot = await context.snapshot();
    const pane = requirePane(snapshot, args.paneId);
    if (isFailure(pane)) return pane;

    if (context.policy.liveEnabled && args.cursor !== undefined) {
      const tail = await context.hub.tail(pane.format.session_id, pane.id, signal);
      const stale =
        tail === undefined ? undefined : requireLiveCursor(tail, args.cursor, args.paneId);
      if (stale !== undefined) return stale;
    }

    const report = await waitForOutput(context, pane, {
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      matches: matcher,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: effectiveWaitMs(context.policy, args.timeoutMs),
    });
    return renderWait(
      context,
      pane,
      report,
      args.maxLines,
      args.patterns === undefined || args.patterns.length === 0
        ? "new output"
        : args.patterns.join(" or "),
      matcher,
    );
  }

  mcp.registerTool(
    "wait_for_text",
    {
      description,
      inputSchema,
      outputSchema: waitOutputSchema,
      title: "Wait for output",
    },
    (args, extra) => run(extra.signal, args),
  );

  mcp.registerTool(
    "wait_for_exit",
    {
      description:
        "Wait until the program in a pane exits and return its exit status or signal. Use " +
        "it for a pane you did not start, such as a person's build or a server someone " +
        "launched; for run_program and start_program, their own results report the exit. " +
        "A pane that closes on exit still reports its status; a pane killed from outside " +
        "during the wait has none and answers gone, within about two seconds, and a pane id " +
        "that is already gone is not found. A pane at a " +
        "shell prompt exits only when the shell does: for a command typed into it, use " +
        "run_shell_command or wait_for_text. Requires tmux 3.8 or newer.",
      inputSchema: {
        paneId: paneIdSchema,
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `How long to wait for the exit: ${String(DEFAULT_BLOCKING_WAIT_MS / 1000)} seconds ` +
              "when omitted, clamped by the server ceiling; the result reports what was used, " +
              "and timed_out leaves the program running.",
          ),
      },
      outputSchema: {
        effectiveTimeoutMs: z.number().int().describe("The timeout enforced."),
        exitStatus: z
          .number()
          .int()
          .nullable()
          .describe(
            "The exit status, as tmux read it from the pane's process: null when a signal " +
              "ended it, with signal set, or when it has not exited. run_program's exitStatus " +
              "shows a signal as 128 plus its number instead.",
          ),
        outcome: z
          .enum(["completed", "timed_out", "gone", "cancelled"])
          .describe(
            "completed: the program ended; exitStatus holds its status, or is null with " +
              "signal set. timed_out: it still runs; call again to keep waiting. gone: the " +
              "pane was removed without an exit status. cancelled: the request was cancelled.",
          ),
        signal: z
          .string()
          .nullable()
          .describe('The signal that ended the program, such as "SIGTERM"; otherwise null.'),
      },
      title: "Wait for a pane's program to exit",
    },
    async ({ paneId, timeoutMs }, extra) => {
      const pane = requirePane(await context.snapshot(), paneId);
      if (isFailure(pane)) return pane;
      const effectiveTimeoutMs = effectiveWaitMs(context.policy, timeoutMs);
      const answer = (
        outcome: "cancelled" | "completed" | "gone" | "timed_out",
        exitStatus: number | null,
        signal: string | null,
        headline: string,
      ): CallToolResult => ok({ effectiveTimeoutMs, exitStatus, outcome, signal }, `[${headline}]`);
      try {
        const exit = await pane.waitForExit({
          signal: extra.signal,
          timeoutMs: effectiveTimeoutMs,
        });
        return answer(
          "completed",
          exit.exitCode,
          exit.signalCode,
          exit.signalCode === null
            ? `exit ${String(exit.exitCode)}`
            : `ended by ${exit.signalCode}`,
        );
      } catch (error) {
        if (error instanceof WaitTimeoutError) {
          return answer(
            "timed_out",
            null,
            null,
            `still running after ${String(effectiveTimeoutMs)}ms`,
          );
        }
        if (error instanceof ObjectNotFoundError) {
          return answer("gone", null, null, `${paneId} was removed without an exit status`);
        }
        if (error instanceof TmuxTransportError && error.kind === "cancelled") {
          return answer("cancelled", null, null, "request cancelled; the program still runs");
        }
        throw error;
      }
    },
  );
}
