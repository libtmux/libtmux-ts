import { compileBoundedRegex, TmuxCommandError } from "libtmux";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { boundedCaptureRange, captureRowLimit } from "../grid_capture.js";
import { effectiveResultLines, MAX_RESULT_BYTES } from "../policy.js";
import { READ_ONLY, type ToolRegistrar } from "../register.js";
import { fail, mapConcurrent, ok } from "../results.js";
import { paneIdSchema, requestText } from "../schemas.js";
import { isFailure, paneEntities, panePlacements, requireSession } from "../target_resolution.js";
import { panePlacementView, placementViewSchema, type PlacementView } from "../views.js";

const SEARCH_CONCURRENCY = 8;
const SEARCH_MATCH_BYTES = 256 * 1024;
const SEARCH_MATCH_LINES = 20_000;
const SEARCH_MATCH_MILLISECONDS = 5_000;
const SEARCH_PANES = 200;

/** Aggregate deterministic work budget for literal matching, measured in UTF-8 bytes. */
export class SearchMatchBudget {
  readonly #deadline: number;
  readonly #now: () => number;
  #remaining: number;
  #remainingLines: number;
  #exhaustedBy: "bytes" | "lines" | "time" | undefined;

  constructor(
    maximum: number = SEARCH_MATCH_BYTES,
    maximumLines: number = SEARCH_MATCH_LINES,
    maximumMilliseconds: number = SEARCH_MATCH_MILLISECONDS,
    now: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum <= 0 ||
      !Number.isSafeInteger(maximumLines) ||
      maximumLines <= 0 ||
      !Number.isSafeInteger(maximumMilliseconds) ||
      maximumMilliseconds <= 0
    ) {
      throw new TypeError("search match budget must be a positive safe integer");
    }
    this.#now = now;
    this.#deadline = now() + maximumMilliseconds;
    this.#remaining = maximum;
    this.#remainingLines = maximumLines;
  }

  get exhaustedBy(): "bytes" | "lines" | "time" | undefined {
    return this.#exhaustedBy;
  }

  active(): boolean {
    if (this.#now() < this.#deadline) return true;
    this.#exhaustedBy = "time";
    return false;
  }

  take(text: string): boolean {
    if (!this.active()) return false;
    if (this.#remainingLines === 0) {
      this.#exhaustedBy = "lines";
      return false;
    }
    // One byte per row also bounds an arbitrarily large set of empty inputs.
    const cost = Buffer.byteLength(text, "utf8") + 1;
    if (cost > this.#remaining) {
      this.#exhaustedBy = "bytes";
      return false;
    }
    this.#remaining -= cost;
    this.#remainingLines -= 1;
    return true;
  }
}

export function registerSearch(mcp: ToolRegistrar, context: ToolContext): void {
  mcp.registerTool(
    "search_panes",
    {
      annotations: READ_ONLY,
      description:
        "Find which panes are showing something. Searches pane contents, not their " +
        "names — use list_panes for metadata. Returns the matching lines with their " +
        "pane, so you can target one without capturing them all. Literal matching " +
        "stops at one 256 KiB aggregate UTF-8 byte budget.",
      inputSchema: {
        maxMatchesPerPane: z.number().int().positive().optional(),
        pattern: requestText("pattern").min(1).describe("Non-empty literal text to find."),
        regex: z
          .boolean()
          .optional()
          .describe("Interpret pattern using libtmux's bounded regular-expression grammar."),
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
        matchingByteClamped: z.boolean(),
        matchingLineClamped: z.boolean(),
        matchingTimeClamped: z.boolean(),
        matchesTruncated: z.boolean(),
        paneLimitClamped: z.boolean(),
        panesFailed: z.number().int(),
        panesSearched: z.number().int(),
        scrollbackClamped: z.boolean(),
      },
      title: "Search pane contents",
    },
    async ({ maxMatchesPerPane, pattern, regex, scrollbackLines, session }) => {
      const compiled = regex === true ? compileBoundedRegex(pattern) : undefined;
      const matcher =
        compiled === undefined
          ? (line: string): boolean => line.includes(pattern)
          : (line: string): boolean => compiled.test(line);

      const snapshot = await context.snapshot();
      const target = session === undefined ? undefined : requireSession(snapshot, session);
      if (target !== undefined && isFailure(target)) return target;
      const candidatePanes = paneEntities(
        snapshot.panes
          .toArray()
          .filter((pane) => target === undefined || pane.format.session_id === target.id),
      );
      const panes = candidatePanes.slice(0, SEARCH_PANES);
      const paneLimitClamped = panes.length !== candidatePanes.length;
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
      let matchingByteClamped = false;
      let matchingLineClamped = false;
      let matchingTimeClamped = false;
      let matchesTruncated = paneLimitClamped;
      let panesFailed = 0;
      let panesSearched = 0;
      let structuredBytes = 2;
      let textBytes = 0;
      const matchBudget = new SearchMatchBudget();
      const markMatchClamp = (): void => {
        matchingByteClamped ||= matchBudget.exhaustedBy === "bytes";
        matchingLineClamped ||= matchBudget.exhaustedBy === "lines";
        matchingTimeClamped ||= matchBudget.exhaustedBy === "time";
        matchesTruncated = true;
      };
      searchLoop: for (let offset = 0; offset < panes.length; offset += SEARCH_CONCURRENCY) {
        if (!matchBudget.active()) {
          markMatchClamp();
          break;
        }
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
            if (!matchBudget.take(line)) {
              markMatchClamp();
              break searchLoop;
            }
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
            ? `Search for ${pattern} stopped at a declared work or result ceiling.`
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
        ...(matchingByteClamped
          ? [`[search stopped at the ${String(SEARCH_MATCH_BYTES)}-byte matching ceiling]`]
          : []),
        ...(matchingLineClamped
          ? [`[search stopped at the ${String(SEARCH_MATCH_LINES)}-line matching ceiling]`]
          : []),
        ...(matchingTimeClamped
          ? [`[search stopped at the ${String(SEARCH_MATCH_MILLISECONDS)} ms matching ceiling]`]
          : []),
        ...(paneLimitClamped
          ? [`[search considered the first ${String(SEARCH_PANES)} panes]`]
          : []),
        ...(panesFailed === 0
          ? []
          : [
              `[${String(panesFailed)} pane capture${panesFailed === 1 ? "" : "s"} failed; those panes were not searched]`,
            ]),
        ...(matches.length >= resultLimit
          ? [`[matches truncated at ${String(resultLimit)} lines]`]
          : []),
      ];
      return ok(
        {
          capturesByteClamped,
          effectiveScrollbackLines: effectiveScrollback,
          matches,
          matchingByteClamped,
          matchingLineClamped,
          matchingTimeClamped,
          matchesTruncated,
          paneLimitClamped,
          panesFailed,
          panesSearched,
          scrollbackClamped,
        },
        [answer, ...notices].join("\n\n"),
      );
    },
  );
}
