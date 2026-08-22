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

import { isFailure, requirePane, type ReadablePane, type ToolContext } from "../context.js";
import { effectiveWaitMs } from "../policy.js";
import { offers, READ_ONLY } from "../register.js";
import { fail, ok, renderOutput, tailLines } from "../results.js";

type WaitOutcome = "cancelled" | "matched" | "no_stream" | "pane_died" | "timed_out";

interface WaitReport {
  readonly cursor: number;
  readonly effectiveTimeoutMs: number;
  readonly matched: string | null;
  readonly outcome: WaitOutcome;
  readonly output: string;
}

/** How long an idle stream is left alone between liveness checks. */
const LIVENESS_MS = 500;

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
    readonly cursor?: number;
    readonly matches: (text: string) => string | undefined;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
): Promise<WaitReport> {
  const sessionId = pane.sessionId;
  const tail =
    context.policy.liveEnabled && sessionId !== null
      ? await context.hub.tail(sessionId, pane.id)
      : undefined;
  if (tail === undefined) {
    return {
      cursor: 0,
      effectiveTimeoutMs: options.timeoutMs,
      matched: null,
      outcome: "no_stream",
      output: "",
    };
  }

  const from = options.cursor;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const seen = tail.read(from);
    const hit = options.matches(seen.text);
    if (hit !== undefined) {
      return {
        cursor: seen.cursor,
        effectiveTimeoutMs: options.timeoutMs,
        matched: hit,
        outcome: "matched",
        output: seen.text,
      };
    }
    // A caller that has gone away is not owed the rest of its deadline, and the
    // connection it was holding is wanted by somebody else.
    if (options.signal?.aborted === true) {
      return {
        cursor: seen.cursor,
        effectiveTimeoutMs: options.timeoutMs,
        matched: null,
        outcome: "cancelled",
        output: seen.text,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // A dead pane and a quiet one look the same from the stream, and only one
      // of them is worth waiting on again.
      // eslint-disable-next-line no-await-in-loop -- reached once, on the way out.
      const alive = (await context.snapshot()).panes.exists({ id: pane.id });
      return {
        cursor: seen.cursor,
        effectiveTimeoutMs: options.timeoutMs,
        matched: null,
        outcome: alive ? "timed_out" : "pane_died",
        output: seen.text,
      };
    }
    // eslint-disable-next-line no-await-in-loop -- each wait follows its read.
    await tail.changed(Math.min(remaining, LIVENESS_MS), options.signal);
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
  const limit = maxLines ?? context.policy.maxResultLines;
  const trimmed = tailLines(report.output === "" ? [] : report.output.split("\n"), limit);
  const screen =
    report.outcome === "matched" || report.outcome === "cancelled"
      ? ""
      : tailLines(await pane.capture().catch(() => []), limit).lines.join("\n");

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
        : alreadyOnScreen
          ? `no match while waiting, but ${describe} is on the pane now — it printed before this wait began. Read it with capture_pane; wait again from cursor=${String(report.cursor)} only if you want the next one`
          : report.outcome === "pane_died"
            ? "the pane exited before it matched; waiting again cannot help"
            : `no match in ${String(report.effectiveTimeoutMs)}ms — call again with cursor=${String(report.cursor)} to carry on from here`;

  const body =
    screen === ""
      ? renderOutput(trimmed)
      : `${renderOutput(trimmed)}\n\n[the pane currently shows]\n${screen}`;

  return ok(
    {
      alreadyOnScreen,
      cursor: report.cursor,
      effectiveTimeoutMs: report.effectiveTimeoutMs,
      matched: report.matched,
      outcome: report.outcome,
      output: trimmed.lines.join("\n"),
      paneId,
      screen,
    },
    `${body}\n\n[${note}]`,
  );
}

const waitOutputSchema = {
  alreadyOnScreen: z
    .boolean()
    .describe(
      "The pattern is on the pane now but printed before this wait began, so the wait could not match it. Read it with capture_pane rather than waiting again.",
    ),
  cursor: z.number().int().describe("Pass to observe or to another wait to carry on from here."),
  effectiveTimeoutMs: z.number().int().describe("The timeout actually enforced, after clamping."),
  matched: z.string().nullable().describe("The text that matched, or null."),
  outcome: z
    .enum(["matched", "timed_out", "pane_died", "no_stream", "cancelled"])
    .describe("Why the wait ended. Read this rather than guessing from the output."),
  output: z.string().describe("Everything the pane printed while waiting, matched or not."),
  paneId: z.string(),
  screen: z
    .string()
    .describe(
      "What the pane shows now. Filled when the wait did not match, so a miss is never blind.",
    ),
};

export function registerWait(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "readonly")) return;

  const inputSchema = {
    cursor: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Start from a cursor an earlier observe or wait returned."),
    maxLines: z.number().int().positive().optional(),
    paneId: z.string(),
    patterns: z
      .array(z.string())
      .optional()
      .describe("Any one of these ends the wait. Omit to wait for any output at all."),
    regex: z.boolean().optional().describe("Treat patterns as regular expressions."),
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

  /** Build the matcher once, so a bad expression fails before anything waits. */
  function buildMatcher(
    patterns: readonly string[] | undefined,
    regex: boolean | undefined,
  ): ((text: string) => string | undefined) | CallToolResult {
    if (patterns === undefined || patterns.length === 0) {
      return (text) => (text === "" ? undefined : text.slice(-80));
    }
    if (regex === true) {
      const expressions: RegExp[] = [];
      for (const pattern of patterns) {
        try {
          expressions.push(new RegExp(pattern));
        } catch (error) {
          return fail({
            hint: "Set regex to false to match them as plain text.",
            reason: `Not a valid regular expression: ${pattern} (${error instanceof Error ? error.message : String(error)})`,
          });
        }
      }
      return (text) =>
        expressions
          .map((expression) => expression.exec(text)?.[0])
          .find((hit) => hit !== undefined);
    }
    return (text) => patterns.find((pattern) => text.includes(pattern));
  }

  async function run(
    signal: AbortSignal | undefined,
    args: {
      cursor?: number | undefined;
      maxLines?: number | undefined;
      paneId: string;
      patterns?: string[] | undefined;
      regex?: boolean | undefined;
      timeoutMs?: number | undefined;
    },
    asTask: boolean,
  ): Promise<CallToolResult> {
    const matcher = buildMatcher(args.patterns, args.regex);
    if (typeof matcher !== "function") return matcher;

    const snapshot = await context.snapshot();
    const pane = requirePane(snapshot, args.paneId);
    if (isFailure(pane)) return pane;

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

  // The same wait, offered as a task. A client that speaks tasks gets a handle
  // immediately and can cancel; one that does not has the SDK poll on its
  // behalf and sees exactly the blocking tool it saw before — which is why this
  // is `optional` rather than `required`.
  mcp.experimental.tasks.registerToolTask(
    "wait_for_text_task",
    {
      annotations: READ_ONLY,
      description: `${description} Runs as a task: you get a handle at once and can do other work, so a long timeoutMs costs you nothing to wait on.`,
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
        void run(extra.signal, args, true)
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
