/**
 * Waiting for a pane to say something, without polling and without hanging.
 *
 * These stream tmux's own notifications, so nothing is spent while nothing is
 * happening. What they cost instead is the caller's turn, which is why the
 * blocking ceiling is low and why the same waits are also offered as tasks: a
 * task hands back a handle at once, so a ten-minute build is a thing to check
 * on rather than a thing to sit through.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  isFailure,
  requireLiveCursor,
  requirePane,
  type ReadablePane,
  type ToolContext,
} from "../context.js";
import { captureGridBounded } from "../grid_capture.js";
import { effectiveResultLines, effectiveWaitMs, MAX_RESULT_BYTES } from "../policy.js";
import { offers, READ_ONLY } from "../register.js";
import { boundText, fail, ok, renderBoundedText } from "../results.js";
import { paneCursorSchema, paneIdSchema } from "../schemas.js";
import type { PaneTailEndReason } from "../live.js";

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
 * spend a snapshot twice a second — seven thousand of them across the hour a
 * task wait may run — so a quiet wait asks on this interval instead, and a wait
 * that is hearing output never asks at all.
 */
const LIVENESS_MS = 5_000;

/**
 * Wait for a pane to print something matching, and report why the wait ended.
 *
 * Subscribes before it looks. A control client is told nothing that happened
 * before it attached, so reading first and subscribing second waits forever on
 * text that already arrived.
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
  const tail = context.policy.liveEnabled ? await context.hub.tail(sessionId, pane.id) : undefined;
  if (tail === undefined) {
    return {
      cursor: null,
      effectiveTimeoutMs: options.timeoutMs,
      matched: null,
      missedBytes: 0,
      outcome: "no_stream",
      output: "",
      streamFailure: null,
    };
  }

  const from = options.cursor ?? tail.cursor;
  const deadline = Date.now() + options.timeoutMs;
  let askedAlive = Date.now();
  for (;;) {
    const seen = tail.read(from);
    const hit = options.matches(seen.text);
    if (hit !== undefined) {
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
    if (options.signal?.aborted === true) {
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
      const current = (await context.snapshot()).panes.first({ id: pane.id });
      const alive = current !== undefined && current.dead !== true;
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
    if (change === "changed" || change === "cancelled" || Date.now() - askedAlive < LIVENESS_MS) {
      continue;
    }

    // Nothing arrived, and a pane that has died will never make anything
    // arrive. A task wait may run for an hour, so waiting out the deadline
    // reports the death long after it mattered.
    askedAlive = Date.now();
    // eslint-disable-next-line no-await-in-loop -- only a wait hearing nothing pays this.
    const current = (await context.snapshot()).panes.first({ id: pane.id });
    if (current === undefined || current.dead === true) {
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
      hint: "Unset LIBTMUX_MCP_LIVE, or use capture_pane if this server cannot open a control connection.",
      reason: `Cannot watch ${paneId}: no control-mode connection is available.`,
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
    .describe("Pass to observe or another wait; null means the live stream cannot be resumed."),
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

export function registerWait(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "readonly")) return;

  const inputSchema = {
    cursor: paneCursorSchema
      .optional()
      .describe("Start from a cursor an earlier observe or wait returned."),
    maxLines: z.number().int().positive().optional(),
    paneId: paneIdSchema,
    patterns: z
      .array(z.string().min(1))
      .optional()
      .describe("Any one of these ends the wait. Omit to wait for any output at all."),
    regex: z
      .literal(false)
      .optional()
      .describe("Regular expressions are disabled because native matching can block the server."),
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
    "a background job. For a command you wrote, use run_command: it knows when the " +
    "command ended and reports exit status, which no text match can. A pane echoes " +
    "what is typed into it, so waiting for text that also appears in a command you " +
    "just sent matches the echo. Whatever happens you get back what the pane " +
    "printed and why the wait ended — a timeout is never an empty answer.";

  function buildMatcher(
    patterns: readonly string[] | undefined,
  ): (text: string) => string | undefined {
    if (patterns === undefined || patterns.length === 0) {
      return (text) => (text === "" ? undefined : text.slice(-80));
    }
    return (text) => patterns.find((pattern) => text.includes(pattern));
  }

  async function run(
    signal: AbortSignal | undefined,
    args: {
      cursor?: string | undefined;
      maxLines?: number | undefined;
      paneId: string;
      patterns?: string[] | undefined;
      regex?: false | undefined;
      timeoutMs?: number | undefined;
    },
    asTask: boolean,
  ): Promise<CallToolResult> {
    const matcher = buildMatcher(args.patterns);

    const snapshot = await context.snapshot();
    const pane = requirePane(snapshot, args.paneId);
    if (isFailure(pane)) return pane;

    if (context.policy.liveEnabled && args.cursor !== undefined) {
      const tail = await context.hub.tail(pane.format.session_id, pane.id);
      const stale =
        tail === undefined ? undefined : requireLiveCursor(tail, args.cursor, args.paneId);
      if (stale !== undefined) return stale;
    }

    const report = await waitForOutput(context, pane, {
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      matches: matcher,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: effectiveWaitMs(context.policy, args.timeoutMs, asTask),
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
      annotations: READ_ONLY,
      description,
      inputSchema,
      outputSchema: waitOutputSchema,
      title: "Wait for output",
    },
    (args, extra) => run(extra.signal, args, false),
  );

  /**
   * Whether the client on the other end actually speaks tasks.
   *
   * The task ceiling is traded for a handle that arrives at once and can be
   * cancelled. A client that declares no task capability gets neither: the SDK
   * runs the tool and polls on its behalf, so the call blocks and cannot be
   * called off. Charging it the task ceiling hands it the worst combination
   * available — an uncancellable wait carrying twenty times the ceiling the
   * blocking tool would have used — which is the turn-destroying outcome the
   * low blocking ceiling exists to prevent.
   */
  const clientSpeaksTasks = (): boolean => mcp.server.getClientCapabilities()?.tasks !== undefined;

  // The same wait, offered as a task. A client that speaks tasks gets a handle
  // immediately and can cancel; one that does not has the SDK poll on its
  // behalf and sees exactly the blocking tool it saw before — which is why this
  // is `optional` rather than `required`, and why the ceiling follows the
  // client's capability rather than the tool's name.
  mcp.experimental.tasks.registerToolTask(
    "wait_for_text_task",
    {
      annotations: READ_ONLY,
      description: `${description} If your client speaks tasks, you get a handle at once and can do other work, so a long timeoutMs costs nothing to wait on. If it does not, this blocks exactly like wait_for_text and is held to the same lower ceiling — the reply says which one it used.`,
      execution: { taskSupport: "optional" },
      inputSchema,
      outputSchema: waitOutputSchema,
      title: "Wait for output (task)",
    },
    {
      createTask: async (args, extra) => {
        const task = await extra.taskStore.createTask({
          // The SDK polls at this interval for a client that does not speak
          // tasks, so it is the added latency of the degraded path.
          pollInterval: 200,
          ttl: context.policy.taskWaitMaxMs + 60_000,
        });
        void run(extra.signal, args, clientSpeaksTasks())
          .then((result) => extra.taskStore.storeTaskResult(task.taskId, "completed", result))
          .catch((error: unknown) =>
            extra.taskStore.storeTaskResult(
              task.taskId,
              "failed",
              fail({ reason: error instanceof Error ? error.message : String(error) }),
            ),
          );
        return { task };
      },
      getTask: (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) => {
        // The store holds an arbitrary result; only one this tool wrote has
        // `content`. Anything else means the task ended without one, and saying
        // that beats handing back a shape the client will reject.
        const stored: unknown = await extra.taskStore.getTaskResult(extra.taskId);
        return typeof stored === "object" && stored !== null && "content" in stored
          ? (stored as CallToolResult)
          : fail({ reason: `Task ${extra.taskId} finished without a result.` });
      },
    },
  );
}
