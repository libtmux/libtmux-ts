/**
 * Reading what panes show, and reading it again cheaply.
 *
 * `capture_pane` answers what is on screen now. `observe` answers what changed,
 * which is the question an agent asks repeatedly — and the one a re-capture
 * answers by charging for the whole screen every time.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  isFailure,
  requireLiveCursor,
  requirePane,
  requireSession,
  type ToolContext,
} from "../context.js";
import { offers, OPEN_WORLD, READ_ONLY } from "../register.js";
import { fail, ok, renderOutput, resourceLink, tailLines } from "../results.js";
import { paneContentUri } from "../uris.js";

/** How much of a first observation is seeded from the pane's visible screen. */
const SEED_LINES = 100;

export function registerCapture(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "readonly")) return;

  mcp.registerTool(
    "capture_pane",
    {
      annotations: READ_ONLY,
      description:
        "The text a pane is showing, or its scrollback. Negative `start` reaches " +
        "back into history (-100 is a hundred lines above the top of the screen). " +
        "For repeated reads of the same pane use observe instead — it returns only " +
        "what is new.",
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
        paneId: z.string().describe("Pane id, e.g. %1."),
        start: z
          .number()
          .int()
          .optional()
          .describe("First line; negative reaches into scrollback."),
      },
      outputSchema: {
        droppedLines: z.number().int().describe("Lines cut from the front to fit maxLines."),
        paneId: z.string(),
        text: z.string(),
        totalLines: z.number().int().describe("How many lines the capture held before trimming."),
      },
      title: "Capture pane",
    },
    async ({ end, joinWrapped, maxLines, paneId, start }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;

      const captured = await pane.capture({
        ...(end === undefined ? {} : { end }),
        ...(joinWrapped === undefined ? {} : { joinWrapped }),
        ...(start === undefined ? {} : { start }),
      });
      const trimmed = tailLines(captured, maxLines ?? context.policy.maxResultLines);
      const structured = {
        droppedLines: trimmed.droppedLines,
        paneId,
        text: trimmed.lines.join("\n"),
        totalLines: captured.length,
      };

      const content: { text: string; type: "text" }[] = [
        { text: renderOutput(trimmed), type: "text" },
      ];
      return {
        content:
          trimmed.droppedLines === 0
            ? content
            : [
                ...content,
                resourceLink(
                  paneContentUri(paneId),
                  `pane ${paneId} contents`,
                  "The whole capture, if the trimmed tail is not enough.",
                ),
              ],
        structuredContent: structured,
      };
    },
  );

  mcp.registerTool(
    "observe",
    {
      annotations: READ_ONLY,
      description:
        "What a pane has printed since you last looked. Call it once with no " +
        "cursor to start watching and get the current screen; keep the cursor it " +
        "returns and pass it back each time after that, and you are charged only " +
        "for what is new. This is the tool for watching a build, a log, or a test " +
        "run — not a capture_pane loop. Set waitMs to block until something " +
        "arrives rather than returning empty. Reports the stream in the order it " +
        "was written, so a program that draws by moving the cursor (a progress " +
        "bar, a full-screen TUI) reads jumbled here — capture_pane renders those.",
      inputSchema: {
        cursor: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("The cursor from your previous observe. Omit on the first call."),
        maxLines: z.number().int().positive().optional(),
        paneId: z.string().describe("Pane id, e.g. %1."),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Wait up to this long for new output before answering. Default 0."),
      },
      outputSchema: {
        cursor: z.number().int().describe("Pass this to the next observe call."),
        droppedLines: z.number().int(),
        missedBytes: z
          .number()
          .int()
          .describe(
            "Output that scrolled past before this read reached it. Non-zero means you fell behind.",
          ),
        paneId: z.string(),
        seeded: z
          .boolean()
          .describe("True when this call started the watch and returned the screen."),
        streaming: z
          .boolean()
          .describe(
            "False when no control connection was available and this fell back to capturing.",
          ),
        text: z.string(),
      },
      title: "Observe new output",
    },
    async ({ cursor, maxLines, paneId, waitMs }, extra) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      const sessionId = pane.sessionId;
      if (sessionId === null) {
        return fail({
          hint: "Only a pane in a session can be observed. list_panes shows which are.",
          reason: `Pane ${paneId} belongs to no session.`,
        });
      }

      // Whether to seed is a question about the call, not about the server:
      // deciding it on whether a tail happened to exist handed the second
      // caller the whole retained buffer and told it it had not been seeded.
      const seeding = cursor === undefined;
      // The knob exists so an operator can stop this server opening control
      // clients at all — a constrained host, a client limit, a shared tmux.
      // run_command and wait_for_text consult it; this opened one anyway, and
      // then reported streaming:true, which is accurate and so useless for
      // noticing. The capture fallback below is already written for this.
      const tail = context.policy.liveEnabled
        ? await context.hub.tail(sessionId, paneId)
        : undefined;

      // No control connection: answer with a capture rather than an error, and
      // say so, so the caller knows the cursor it gets back is not a stream
      // position it can trust for deltas.
      if (tail === undefined) {
        const captured = await pane.capture();
        const trimmed = tailLines(captured, maxLines ?? context.policy.maxResultLines);
        return ok(
          {
            cursor: 0,
            droppedLines: trimmed.droppedLines,
            missedBytes: 0,
            paneId,
            seeded: true,
            streaming: false,
            text: trimmed.lines.join("\n"),
          },
          renderOutput(trimmed),
        );
      }

      const stale = requireLiveCursor(tail, cursor, paneId);
      if (stale !== undefined) return stale;

      if (seeding) {
        const captured = await pane.capture({ start: -SEED_LINES });
        const trimmed = tailLines(captured, maxLines ?? context.policy.maxResultLines);
        return ok(
          {
            cursor: tail.cursor,
            droppedLines: trimmed.droppedLines,
            missedBytes: 0,
            paneId,
            seeded: true,
            streaming: true,
            text: trimmed.lines.join("\n"),
          },
          `${renderOutput(trimmed)}\n\n[watching ${paneId}; pass cursor=${String(tail.cursor)} next time]`,
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
        await tail.changed(deadline - Date.now(), extra.signal);
        delta = tail.read(cursor);
      }

      const trimmed = tailLines(
        delta.text === "" ? [] : delta.text.split("\n"),
        maxLines ?? context.policy.maxResultLines,
      );
      const body =
        delta.text === ""
          ? `[nothing new on ${paneId} since cursor ${String(cursor ?? 0)}]`
          : renderOutput(trimmed);
      const missed =
        delta.missedBytes === 0
          ? ""
          : `\n[${String(delta.missedBytes)} bytes scrolled past before this read; capture_pane for the whole screen]`;

      return ok(
        {
          cursor: delta.cursor,
          droppedLines: trimmed.droppedLines,
          missedBytes: delta.missedBytes,
          paneId,
          seeded: false,
          streaming: true,
          text: trimmed.lines.join("\n"),
        },
        `${body}${missed}`,
      );
    },
  );

  if (offers(context.policy, "mutating")) {
    mcp.registerTool(
      "pipe_pane",
      {
        annotations: OPEN_WORLD,
        description:
          "Send everything a pane writes to a shell command, for as long as the pipe " +
          "is open. Use this for output too large to read back: a pane keeps only " +
          "history-limit lines and observe keeps a bounded buffer, so a long build " +
          "outruns both and the earliest output is gone before anyone asks. " +
          "'cat >> /tmp/build.log' captures it whole and costs nothing to leave " +
          "running. Call with no command to stop. The pipe attaches to the pane, not " +
          "to the process in it, so it survives respawn_pane and keeps running until " +
          "something stops it. The command runs on the machine tmux runs on, and does " +
          "whatever it does — this server cannot tell.",
        inputSchema: {
          toggle: z
            .boolean()
            .optional()
            .describe(
              "Start a pipe when none is open, and stop one when there is. tmux " +
                "closes the existing pipe before honouring this, so against a pane " +
                "somebody else is capturing it stops their capture rather than " +
                "leaving it alone.",
            ),
          paneId: z.string(),
          shellCommand: z
            .string()
            .optional()
            .describe("Omit to stop a pipe this pane already has open."),
        },
        outputSchema: {
          paneId: z.string(),
          piping: z
            .boolean()
            .describe(
              "Whether the pane is piped now, read back from tmux. A toggle against " +
                "a pane already being piped closes that pipe and opens none, so this " +
                "is false even though a command was given.",
            ),
        },
        title: "Pipe pane output",
      },
      async ({ paneId, shellCommand, toggle }) => {
        const snapshot = await context.snapshot();
        // This changes pane state and starts an arbitrary host command. It does
        // not become read-only merely because tmux sends output rather than input.
        const pane = requirePane(snapshot, paneId);
        if (isFailure(pane)) return pane;
        await pane.pipeTo(shellCommand, toggle === undefined ? {} : { toggle });
        // Ask the pane rather than restating the request. tmux destroys an open
        // pipe before deciding whether to open a new one, so supplying a command
        // is not the same as having a pipe afterwards — and reporting the request
        // back made a toggle that stopped somebody else's capture look identical
        // to one that started yours.
        const piping = (await pane.displayMessage("#{pane_pipe}"))[0] === "1";
        const stopped =
          shellCommand === undefined
            ? `Stopped piping ${paneId}.`
            : `Stopped piping ${paneId}: toggle closed the pipe that was open and started none.`;
        return ok(
          { paneId, piping },
          piping ? `Piping ${paneId} into: ${String(shellCommand)}` : stopped,
        );
      },
    );
  }

  mcp.registerTool(
    "search_panes",
    {
      annotations: READ_ONLY,
      description:
        "Find which panes are showing something. Searches pane contents, not their " +
        "names — use list_panes for metadata. Returns the matching lines with their " +
        "pane, so you can target one without capturing them all.",
      inputSchema: {
        maxMatchesPerPane: z.number().int().positive().optional(),
        pattern: z.string().describe("Text, or a regular expression when regex is true."),
        regex: z.boolean().optional().describe("Treat pattern as a regular expression."),
        scrollbackLines: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("How far above the visible screen to search. Default 0."),
        session: z.string().optional().describe("Restrict to one session by id or name."),
      },
      outputSchema: {
        matches: z.array(
          z.object({
            lineNumber: z.number().int(),
            paneId: z.string(),
            sessionName: z.string(),
            text: z.string(),
            windowName: z.string(),
          }),
        ),
        panesSearched: z.number().int(),
      },
      title: "Search pane contents",
    },
    async ({ maxMatchesPerPane, pattern, regex, scrollbackLines, session }) => {
      let matcher: (line: string) => boolean;
      if (regex === true) {
        try {
          const expression = new RegExp(pattern);
          matcher = (line) => expression.test(line);
        } catch (error) {
          return fail({
            hint: "Set regex to false to search for it as plain text.",
            reason: `Not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } else {
        matcher = (line) => line.includes(pattern);
      }

      const snapshot = await context.snapshot();
      const target = session === undefined ? undefined : requireSession(snapshot, session);
      if (target !== undefined && isFailure(target)) return target;
      const panes = snapshot.panes
        .toArray()
        .filter((pane) => target === undefined || pane.sessionId === target.id);
      const perPane = maxMatchesPerPane ?? 5;
      const start =
        scrollbackLines === undefined || scrollbackLines === 0 ? undefined : -scrollbackLines;

      const captures = await Promise.all(
        panes.map(async (pane) => ({
          lines: await pane.capture(start === undefined ? {} : { start }).catch(() => []),
          pane,
        })),
      );

      const matches = captures.flatMap(({ lines, pane }) => {
        const found: {
          lineNumber: number;
          paneId: string;
          sessionName: string;
          text: string;
          windowName: string;
        }[] = [];
        for (const [index, line] of lines.entries()) {
          if (found.length >= perPane) break;
          if (!matcher(line)) continue;
          found.push({
            lineNumber: index + 1,
            paneId: pane.id,
            sessionName: pane.sessionName ?? "",
            text: line,
            windowName: pane.windowName ?? "",
          });
        }
        return found;
      });

      return ok(
        { matches, panesSearched: panes.length },
        matches.length === 0
          ? `No pane of ${String(panes.length)} searched is showing ${pattern}. Try scrollbackLines to look above the visible screen.`
          : matches
              .map(
                (match) =>
                  `${match.paneId} ${match.sessionName}:${match.windowName}:${String(match.lineNumber)}  ${match.text}`,
              )
              .join("\n"),
      );
    },
  );
}
