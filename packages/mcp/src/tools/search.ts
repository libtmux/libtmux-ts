import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TmuxCommandError } from "libtmux";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { boundedCaptureRange, captureRowLimit } from "../grid_capture.js";
import { effectiveResultLines, MAX_RESULT_BYTES } from "../policy.js";
import { offers, READ_ONLY } from "../register.js";
import { fail, mapConcurrent, ok } from "../results.js";
import { paneIdSchema, requestText } from "../schemas.js";
import { isFailure, paneEntities, panePlacements, requireSession } from "../target_resolution.js";
import { panePlacementView, placementViewSchema, type PlacementView } from "../views.js";

const SEARCH_CONCURRENCY = 8;

export function registerSearch(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "readonly")) return;

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
        pattern: requestText("pattern").min(1).describe("Non-empty literal text to find."),
        regex: z
          .literal(false)
          .optional()
          .describe(
            "Regular expressions are disabled because native matching can block the server.",
          ),
        scrollbackLines: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("How far above the visible screen to search. Default 0."),
        session: requestText("session")
          .optional()
          .describe("Restrict to one session by id or name."),
      },
      outputSchema: {
        capturesByteClamped: z.boolean(),
        effectiveScrollbackLines: z.number().int(),
        matches: z.array(
          z.object({
            lineNumber: z.number().int(),
            paneId: paneIdSchema,
            placements: z.array(placementViewSchema),
            text: z.string(),
            windowName: z.string(),
          }),
        ),
        matchesTruncated: z.boolean(),
        panesFailed: z.number().int(),
        panesSearched: z.number().int(),
        scrollbackClamped: z.boolean(),
      },
      title: "Search pane contents",
    },
    async ({ maxMatchesPerPane, pattern, scrollbackLines, session }) => {
      const matcher = (line: string): boolean => line.includes(pattern);

      const snapshot = await context.snapshot();
      const target = session === undefined ? undefined : requireSession(snapshot, session);
      if (target !== undefined && isFailure(target)) return target;
      const panes = paneEntities(
        snapshot.panes
          .toArray()
          .filter((pane) => target === undefined || pane.format.session_id === target.id),
      );
      const perPane = effectiveResultLines(context.policy, maxMatchesPerPane ?? 5);
      const resultLimit = effectiveResultLines(context.policy, undefined);
      const requestedScrollback = scrollbackLines ?? 0;
      const effectiveScrollback = Math.min(requestedScrollback, resultLimit);
      const scrollbackClamped = effectiveScrollback !== requestedScrollback;
      const start = effectiveScrollback === 0 ? undefined : -effectiveScrollback;

      const matches: {
        lineNumber: number;
        paneId: string;
        placements: readonly PlacementView[];
        text: string;
        windowName: string;
      }[] = [];
      let capturesByteClamped = false;
      let matchesTruncated = false;
      let panesFailed = 0;
      let panesSearched = 0;
      let structuredBytes = 2;
      let textBytes = 0;
      searchLoop: for (let offset = 0; offset < panes.length; offset += SEARCH_CONCURRENCY) {
        const batch = panes.slice(offset, offset + SEARCH_CONCURRENCY);
        // eslint-disable-next-line no-await-in-loop -- each bounded batch is released before the next.
        const captures = await mapConcurrent(batch, SEARCH_CONCURRENCY, async (pane) => {
          const visibleRows =
            pane.height === null || !Number.isSafeInteger(pane.height) || pane.height <= 0
              ? 1
              : pane.height;
          const requestedRows = Math.min(
            Number.MAX_SAFE_INTEGER,
            visibleRows + effectiveScrollback,
          );
          const rowLimit = captureRowLimit(pane.width, requestedRows, MAX_RESULT_BYTES);
          const range =
            rowLimit === 0
              ? { clamped: true, end: undefined, start: undefined }
              : boundedCaptureRange(pane.height, start, undefined, rowLimit);
          try {
            const lines =
              rowLimit === 0
                ? []
                : await pane.capture({
                    ...(range.end === undefined ? {} : { end: range.end }),
                    ...(range.start === undefined ? {} : { start: range.start }),
                  });
            return {
              byteClamped: rowLimit === 0 || range.clamped,
              captured: true as const,
              lines,
              pane,
              placements: panePlacements(snapshot, pane.id).map(panePlacementView),
            };
          } catch (error) {
            if (!(error instanceof TmuxCommandError) || error.target !== pane.id) throw error;
            return { captured: false as const };
          }
        });

        for (const capture of captures) {
          if (!capture.captured) {
            panesFailed += 1;
            continue;
          }
          panesSearched += 1;
          const { byteClamped, lines, pane, placements } = capture;
          capturesByteClamped ||= byteClamped;
          let foundForPane = 0;
          for (const [index, line] of lines.entries()) {
            if (!matcher(line)) continue;
            if (foundForPane >= perPane) {
              matchesTruncated = true;
              break;
            }
            if (matches.length >= resultLimit) {
              matchesTruncated = true;
              break searchLoop;
            }
            const placementNames = placements
              .map(
                ({ index: placementIndex, sessionName }) =>
                  `${sessionName}:${String(placementIndex)}`,
              )
              .join(",");
            const prefix = `${pane.id} ${placementNames} ${pane.window?.name ?? ""}:${String(index + 1)}  `;
            const match = {
              lineNumber: index + 1,
              paneId: pane.id,
              placements,
              text: line,
              windowName: pane.window?.name ?? "",
            };
            const nextStructured =
              structuredBytes +
              Buffer.byteLength(JSON.stringify(match), "utf8") +
              (matches.length === 0 ? 0 : 1);
            const nextText =
              textBytes +
              Buffer.byteLength(`${prefix}${line}`, "utf8") +
              (matches.length === 0 ? 0 : 1);
            if (nextStructured > MAX_RESULT_BYTES || nextText > MAX_RESULT_BYTES) {
              matchesTruncated = true;
              break searchLoop;
            }
            matches.push(match);
            foundForPane += 1;
            structuredBytes = nextStructured;
            textBytes = nextText;
          }
        }
      }

      if (panesFailed > 0 && panesSearched === 0) {
        return fail({
          hint: "Refresh the pane list and retry search_panes.",
          reason:
            panesFailed === 1
              ? "No pane could be searched because its capture failed."
              : `No pane could be searched because all ${String(panesFailed)} captures failed.`,
        });
      }

      const answer =
        matches.length === 0
          ? matchesTruncated
            ? `Matches for ${pattern} were omitted because no complete result fit the byte ceiling.`
            : `No pane of ${String(panesSearched)} searched is showing ${pattern}. Try scrollbackLines to look above the visible screen.`
          : matches
              .map((match) => {
                const placements = match.placements
                  .map(({ index, sessionName }) => `${sessionName}:${String(index)}`)
                  .join(",");
                return `${match.paneId} ${placements} ${match.windowName}:${String(match.lineNumber)}  ${match.text}`;
              })
              .join("\n");
      const notices = [
        ...(scrollbackClamped
          ? [`[scrollbackLines clamped to ${String(effectiveScrollback)}]`]
          : []),
        ...(capturesByteClamped ? ["[pane captures shortened to fit the byte ceiling]"] : []),
        ...(panesFailed === 0
          ? []
          : [
              `[${String(panesFailed)} pane capture${panesFailed === 1 ? "" : "s"} failed; those panes were not searched]`,
            ]),
        ...(matchesTruncated ? [`[matches truncated at ${String(resultLimit)} lines]`] : []),
      ];
      return ok(
        {
          capturesByteClamped,
          effectiveScrollbackLines: effectiveScrollback,
          matches,
          matchesTruncated,
          panesFailed,
          panesSearched,
          scrollbackClamped,
        },
        [answer, ...notices].join("\n\n"),
      );
    },
  );
}
