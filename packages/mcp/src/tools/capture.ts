/**
 * Reading what panes show, and reading it again cheaply.
 *
 * `capture_pane` answers what is on screen now. `capture_since` answers what changed,
 * which is the question an agent asks repeatedly — and the one a re-capture
 * answers by charging for the whole screen every time. When live connections
 * are disabled, `capture_since` deliberately falls back to that bounded re-capture.
 */

import { z } from "zod";

import { requireActive } from "../abort.js";
import { requireLiveCursor, type ToolContext } from "../context.js";
import { captureGridBounded } from "../grid_capture.js";
import { effectiveResultLines, MAX_RESULT_BYTES } from "../policy.js";
import { READ_ONLY, type ToolRegistrar } from "../register.js";
import { boundText, fail, ok, renderBoundedText, tailBytes, tailLines } from "../results.js";
import { paneCursorSchema, paneIdSchema } from "../schemas.js";
import { isFailure, requirePane } from "../target_resolution.js";

/** How much of a first observation is seeded from the pane's visible screen. */
const SEED_LINES = 100;

export function registerCapture(mcp: ToolRegistrar, context: ToolContext): void {
  const live = context.policy.liveEnabled;

  mcp.registerTool(
    "capture_pane",
    {
      annotations: READ_ONLY,
      description:
        "The text a pane is showing, or its scrollback. Negative `start` reaches " +
        "back into history (-100 is a hundred lines above the top of the screen)." +
        (live
          ? " For repeated reads of the same pane use capture_since instead — it returns only what is new."
          : ""),
      inputSchema: {
        end: z
          .number()
          .int()
          .optional()
          .describe(
            "Last line, on the same scale as start: 0 is the top of the visible " +
              "screen and negative reaches back into history. It does not count " +
              "back from the bottom, so end:-1 is one line above the screen top, " +
              "not the last line of output.",
          ),
        joinWrapped: z.boolean().optional().describe("Rejoin lines tmux wrapped."),
        maxLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Keep at most this many lines, from the end. Defaults to the server limit."),
        paneId: paneIdSchema,
        start: z
          .number()
          .int()
          .optional()
          .describe("First line; negative reaches into scrollback."),
      },
      outputSchema: {
        byteClamped: z.boolean().describe("Whether the byte ceiling shortened the capture."),
        droppedLines: z.number().int().describe("Lines cut from the front to fit maxLines."),
        effectiveEnd: z.number().int().nullable(),
        effectiveStart: z.number().int().nullable(),
        omittedBytes: z.number().int(),
        paneId: paneIdSchema,
        rangeClamped: z.boolean().describe("Whether a result ceiling shortened the range."),
        returnedBytes: z.number().int(),
        text: z.string(),
        totalLines: z.number().int().describe("How many lines the capture held before trimming."),
      },
      title: "Capture pane",
    },
    async ({ end, joinWrapped, maxLines, paneId, start }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;

      const limit = effectiveResultLines(context.policy, maxLines);
      const bounded = await captureGridBounded(pane, {
        byteLimit: MAX_RESULT_BYTES,
        ...(end === undefined ? {} : { end }),
        ...(joinWrapped === undefined ? {} : { joinWrapped }),
        lineLimit: limit,
        ...(start === undefined ? {} : { start }),
      });
      const { lines: captured, range } = bounded;
      const trimmed = tailLines(captured, limit);
      const byteTrimmed = tailBytes(trimmed.lines.join("\n"), MAX_RESULT_BYTES);
      const byteClamped = bounded.byteClamped || byteTrimmed.droppedBytes > 0;
      const structured = {
        byteClamped,
        droppedLines: trimmed.droppedLines,
        effectiveEnd: range.end ?? null,
        effectiveStart: range.start ?? null,
        omittedBytes: byteTrimmed.droppedBytes,
        paneId,
        rangeClamped: range.clamped,
        returnedBytes: Buffer.byteLength(byteTrimmed.text, "utf8"),
        text: byteTrimmed.text,
        totalLines: captured.length,
      };

      const rangeNotice = range.clamped
        ? bounded.byteClamped && range.start === undefined && range.end === undefined
          ? `[capture omitted: no complete row fits the ${String(MAX_RESULT_BYTES)}-byte result ceiling]`
          : `[capture range clamped: ${String(range.start)} through ${String(range.end)}]`
        : "";
      const byteNotice =
        byteTrimmed.droppedBytes === 0
          ? ""
          : `[${String(byteTrimmed.droppedBytes)} earlier bytes omitted; narrow the requested range]`;
      const lineNotice =
        trimmed.droppedLines === 0
          ? ""
          : `[${String(trimmed.droppedLines)} earlier lines omitted; raise maxLines within the server limit]`;
      return {
        content: [
          {
            text: [rangeNotice, lineNotice, byteNotice, byteTrimmed.text]
              .filter((part) => part !== "")
              .join("\n"),
            type: "text",
          },
        ],
        structuredContent: structured,
      };
    },
  );

  mcp.registerTool(
    "capture_since",
    {
      annotations: READ_ONLY,
      description: live
        ? "What a pane has printed since you last looked. Call it once with no " +
          "cursor to start watching and get the current screen; keep the cursor it " +
          "returns and pass it back each time after that, and you are charged only " +
          "for what is new. This is the tool for watching a build, a log, or a test " +
          "run — not a capture_pane loop. Set waitMs to block until something " +
          "arrives rather than returning empty. Reports the stream in the order it " +
          "was written, so a program that draws by moving the cursor (a progress " +
          "bar, a full-screen TUI) reads jumbled here — capture_pane renders those."
        : "A bounded capture of what a pane is showing now. Live streaming is disabled, " +
          "so this does not wait or return deltas; each call reads the current screen.",
      inputSchema: {
        cursor: paneCursorSchema
          .optional()
          .describe(
            live
              ? "The cursor from your previous capture_since. Omit on the first call."
              : "Ignored while live streaming is disabled.",
          ),
        maxLines: z.number().int().positive().optional(),
        paneId: paneIdSchema,
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            live
              ? "Wait up to this long for new output before answering. Default 0."
              : "Ignored while live streaming is disabled; effectiveTimeoutMs is 0.",
          ),
      },
      outputSchema: {
        byteClamped: z.boolean().describe("Whether the byte ceiling shortened this result."),
        cursor: paneCursorSchema
          .nullable()
          .describe(
            live
              ? "Pass this to the next capture_since call; null means streaming was unavailable."
              : "Always null while live streaming is disabled.",
          ),
        droppedLines: z.number().int(),
        effectiveTimeoutMs: z
          .number()
          .int()
          .describe("The wait ceiling applied; zero when this call did not wait on a live stream."),
        missedBytes: z
          .number()
          .int()
          .describe(
            "Output that scrolled past before this read reached it. Non-zero means you fell behind.",
          ),
        paneId: paneIdSchema,
        omittedBytes: z.number().int().describe("Result bytes omitted after capture or streaming."),
        rangeClamped: z.boolean().describe("Whether result limits shortened a grid capture."),
        returnedBytes: z.number().int(),
        seeded: z
          .boolean()
          .describe(
            live
              ? "True when this call started the watch and returned the screen."
              : "Always true because each call returns a fresh screen capture.",
          ),
        streaming: z
          .boolean()
          .describe(
            live
              ? "False when no control connection was available and this fell back to capturing."
              : "Always false while live streaming is disabled.",
          ),
        text: z.string(),
      },
      title: live ? "Observe new output" : "Capture current pane",
    },
    async ({ cursor, maxLines, paneId, waitMs }, extra) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      const sessionId = pane.format.session_id;

      // Whether to seed is a question about the call, not about the server:
      // deciding it on whether a tail happened to exist handed the second
      // caller the whole retained buffer and told it it had not been seeded.
      const seeding = cursor === undefined;
      // The knob exists so an operator can stop this server opening control
      // clients at all — a constrained host, a client limit, a shared tmux.
      // run_shell_command and wait_for_text consult it; this opened one anyway, and
      // then reported streaming:true, which is accurate and so useless for
      // noticing. The capture fallback below is already written for this.
      const tail = context.policy.liveEnabled
        ? await context.hub.tail(sessionId, paneId, extra.signal)
        : undefined;
      requireActive(extra.signal);

      // No control connection: answer with a capture rather than an error, and
      // say so, so the caller knows the cursor it gets back is not a stream
      // position it can trust for deltas.
      if (tail === undefined) {
        const limit = effectiveResultLines(context.policy, maxLines);
        const captured = await captureGridBounded(pane, {
          byteLimit: MAX_RESULT_BYTES,
          lineLimit: limit,
        });
        const bounded = boundText(captured.lines, limit, MAX_RESULT_BYTES);
        return ok(
          {
            byteClamped: captured.byteClamped || bounded.omittedBytes > 0,
            cursor: null,
            droppedLines: bounded.droppedLines,
            effectiveTimeoutMs: 0,
            missedBytes: 0,
            omittedBytes: bounded.omittedBytes,
            paneId,
            rangeClamped: captured.range.clamped,
            returnedBytes: bounded.returnedBytes,
            seeded: true,
            streaming: false,
            text: bounded.text,
          },
          renderBoundedText(bounded, "use capture_pane with a narrower range"),
        );
      }

      const stale = requireLiveCursor(tail, cursor, paneId);
      if (stale !== undefined) return stale;

      if (seeding) {
        // Mark the stream before capturing. Output racing the capture may be
        // repeated on the next call, but it can never disappear between them.
        const seededCursor = tail.cursor;
        const limit = effectiveResultLines(context.policy, maxLines);
        const captured = await captureGridBounded(pane, {
          byteLimit: MAX_RESULT_BYTES,
          lineLimit: limit,
          start: -SEED_LINES,
        });
        const ended = requireLiveCursor(tail, seededCursor, paneId);
        if (ended !== undefined) return ended;
        const bounded = boundText(captured.lines, limit, MAX_RESULT_BYTES);
        return ok(
          {
            byteClamped: captured.byteClamped || bounded.omittedBytes > 0,
            cursor: seededCursor,
            droppedLines: bounded.droppedLines,
            effectiveTimeoutMs: 0,
            missedBytes: 0,
            omittedBytes: bounded.omittedBytes,
            paneId,
            rangeClamped: captured.range.clamped,
            returnedBytes: bounded.returnedBytes,
            seeded: true,
            streaming: true,
            text: bounded.text,
          },
          `${renderBoundedText(bounded, "use capture_pane with a narrower range")}\n\n[watching ${paneId}; pass cursor=${seededCursor} next time]`,
        );
      }

      const wait = Math.min(waitMs ?? 0, context.policy.blockingWaitMaxMs);
      const deadline = Date.now() + wait;
      let delta = tail.read(cursor);
      // Waits on the stream itself rather than re-reading it on a timer, so a
      // pane that stays quiet costs nothing and one that speaks is answered as
      // soon as tmux says so.
      while (delta.text === "" && Date.now() < deadline && extra.signal.aborted !== true) {
        // eslint-disable-next-line no-await-in-loop -- each read follows its wait.
        const change = await tail.changed(deadline - Date.now(), extra.signal);
        if (change === "closed") {
          return requireLiveCursor(tail, cursor, paneId) ?? fail({ reason: "Live stream ended." });
        }
        delta = tail.read(cursor);
      }

      const bounded = boundText(
        delta.text === "" ? [] : delta.text.split("\n"),
        effectiveResultLines(context.policy, maxLines),
        MAX_RESULT_BYTES,
      );
      const body =
        delta.text === ""
          ? `[nothing new on ${paneId} since cursor ${String(cursor ?? "start")}]`
          : renderBoundedText(bounded, "read more often to keep each delta smaller");
      const missed =
        delta.missedBytes === 0
          ? ""
          : `\n[${String(delta.missedBytes)} bytes scrolled past before this read; capture_pane for the whole screen]`;

      return ok(
        {
          byteClamped: bounded.omittedBytes > 0,
          cursor: delta.cursor,
          droppedLines: bounded.droppedLines,
          effectiveTimeoutMs: wait,
          missedBytes: delta.missedBytes,
          omittedBytes: bounded.omittedBytes,
          paneId,
          rangeClamped: false,
          returnedBytes: bounded.returnedBytes,
          seeded: false,
          streaming: true,
          text: bounded.text,
        },
        `${body}${missed}`,
      );
    },
  );
}
