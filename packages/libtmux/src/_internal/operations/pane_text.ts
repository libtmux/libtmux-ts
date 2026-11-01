import type { Pane } from "../../pane.js";
import type {
  LocateTextOptions,
  TextLocation,
  TextLocatorObservation,
  TextLocatorResult,
} from "../../types.js";
import { logicalRefForHandle, runtimeForHandle } from "../runtime/live_handle.js";
import { capturePane } from "./pane_io.js";

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

/** Capture once and retain bounded literal matches with the sample that supplied them. */
export async function locatePaneText(
  pane: Pane,
  literal: string,
  options: LocateTextOptions = {},
): Promise<TextLocatorResult> {
  const config = Object.freeze({ ...options });
  const maxText = positiveLimit(config.maxTextCodeUnits ?? 1_048_576, "maxTextCodeUnits");
  const maxMatches = positiveLimit(config.maxMatches ?? 1024, "maxMatches");
  if (typeof literal !== "string" || literal.length === 0)
    throw new TypeError("literal must be a nonempty string");
  if (literal.length > maxText) throw new RangeError("literal exceeds maxTextCodeUnits");
  const target = logicalRefForHandle(pane);
  if (target.kind !== "pane") throw new TypeError("text locations require a pane handle");
  const startedMonotonicMs = performance.now();
  const captured = await capturePane(runtimeForHandle(pane), pane.id, config);
  const completedMonotonicMs = performance.now();
  let units = Math.max(0, captured.length - 1);
  for (const line of captured) {
    units += line.length;
    if (units > maxText) throw new RangeError("captured text exceeds maxTextCodeUnits");
  }
  const lines = Object.freeze([...captured]);
  const text = lines.join("\n");
  const observation: TextLocatorObservation = Object.freeze({
    kind: "sampled_text",
    target,
    lines,
    capture: Object.freeze({
      ...(config.start === undefined ? {} : { start: config.start }),
      ...(config.end === undefined ? {} : { end: config.end }),
      alternateScreen: config.alternateScreen === true,
      escapeSequences: config.escapeSequences === true,
      joinWrapped: config.joinWrapped === true,
    }),
    startedMonotonicMs,
    completedMonotonicMs,
  });
  const lineStarts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    lineStarts.push(at + 1);
  const position = (offset: number): { readonly line: number; readonly offset: number } => {
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle + 1;
      else high = middle;
    }
    const line = Math.max(0, low - 1);
    return { line, offset: offset - lineStarts[line]! };
  };
  const matches: TextLocation[] = [];
  let matchCountAtLeast = 0;
  let truncated = false;
  for (let at = text.indexOf(literal); at !== -1; at = text.indexOf(literal, at + 1)) {
    matchCountAtLeast += 1;
    if (matchCountAtLeast > maxMatches) {
      truncated = true;
      break;
    }
    const start = position(at);
    const end = position(at + literal.length);
    matches.push(
      Object.freeze({
        startUtf16: at,
        endUtf16: at + literal.length,
        startLineIndex: start.line,
        startLineOffsetUtf16: start.offset,
        endLineIndex: end.line,
        endLineOffsetUtf16: end.offset,
      }),
    );
  }
  const retained = {
    observation,
    literal,
    matches: Object.freeze(matches),
    matchCountAtLeast,
    truncated,
  };
  if (matchCountAtLeast === 0) return Object.freeze({ ...retained, status: "missing" });
  if (matchCountAtLeast === 1)
    return Object.freeze({ ...retained, status: "unique", match: matches[0]! });
  return Object.freeze({ ...retained, status: "ambiguous" });
}
