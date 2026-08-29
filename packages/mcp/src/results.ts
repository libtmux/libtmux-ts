/**
 * How a tool answers.
 *
 * Two audiences, one call. `structuredContent` is what a program reads and is
 * what the tool's `outputSchema` promises; `content` is what a model reads when
 * its client shows it text. Sending only the first strands clients that never
 * learned to look there, and only the second makes every caller re-parse prose.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { MAX_RESULT_BYTES } from "./policy.js";

/** What a failed call gives back so the next call can be a better one. */
export interface ToolFailure {
  readonly hint?: string;
  readonly reason: string;
}

function resultText(text: string): string {
  const bounded = tailBytes(text, MAX_RESULT_BYTES);
  return bounded.droppedBytes === 0
    ? text
    : `[${String(bounded.droppedBytes)} earlier bytes omitted by the result ceiling]\n${bounded.text}`;
}

export function ok<T extends Record<string, unknown>>(structured: T, text: string): CallToolResult {
  return {
    content: [{ text: resultText(text), type: "text" }],
    structuredContent: structured,
  };
}

/**
 * Report a failure the model can act on.
 *
 * `isError` rather than a thrown exception, so the reason reaches the model
 * instead of the client seeing a transport fault — and a hint alongside it,
 * because an agent told only that something failed spends its next call
 * guessing.
 *
 * No `structuredContent`, deliberately. A client validates that field against
 * the tool's `outputSchema` whether or not the result is an error, so a failure
 * carrying its own shape is rejected as a protocol violation and the model never
 * reads the reason — the one case where being helpful loses the message.
 */
export function fail(failure: ToolFailure): CallToolResult {
  const text = failure.hint === undefined ? failure.reason : `${failure.reason}\n\n${failure.hint}`;
  return {
    content: [{ text: resultText(text), type: "text" }],
    isError: true,
  };
}

export interface Trimmed {
  readonly droppedLines: number;
  readonly lines: readonly string[];
}

export interface TrimmedText {
  readonly droppedBytes: number;
  readonly text: string;
}

export interface BoundedText {
  readonly droppedLines: number;
  readonly omittedBytes: number;
  readonly returnedBytes: number;
  readonly text: string;
}

/**
 * Keep the last `limit` lines.
 *
 * The tail rather than the head: a command's verdict is at the end, and a build
 * that printed ten thousand lines is being asked about the last twenty of them.
 */
export function tailLines(lines: readonly string[], limit: number): Trimmed {
  if (limit <= 0) return { droppedLines: lines.length, lines: [] };
  if (lines.length <= limit) return { droppedLines: 0, lines };
  return { droppedLines: lines.length - limit, lines: lines.slice(lines.length - limit) };
}

/** Keep a UTF-8-safe tail whose encoded form does not exceed `limit`. */
export function tailBytes(text: string, limit: number): TrimmedText {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= limit) return { droppedBytes: 0, text };
  if (limit <= 0) return { droppedBytes: total, text: "" };

  let keptBytes = 0;
  let start = text.length;
  while (start > 0) {
    const low = text.charCodeAt(start - 1);
    const high = start > 1 ? text.charCodeAt(start - 2) : 0;
    const width = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
    const bytes = Buffer.byteLength(text.slice(start - width, start), "utf8");
    if (keptBytes + bytes > limit) break;
    keptBytes += bytes;
    start -= width;
  }
  return { droppedBytes: total - keptBytes, text: text.slice(start) };
}

/** Keep a UTF-8 text tail inside both line and byte ceilings. */
export function boundText(
  lines: readonly string[],
  lineLimit: number,
  byteLimit: number,
): BoundedText {
  const lineTrimmed = tailLines(lines, lineLimit);
  const byteTrimmed = tailBytes(lineTrimmed.lines.join("\n"), byteLimit);
  return {
    droppedLines: lineTrimmed.droppedLines,
    omittedBytes: byteTrimmed.droppedBytes,
    returnedBytes: Buffer.byteLength(byteTrimmed.text, "utf8"),
    text: byteTrimmed.text,
  };
}

/** Render bounded text without hiding either form of truncation. */
export function renderBoundedText(result: BoundedText, recovery: string): string {
  const notices = [
    result.droppedLines === 0
      ? ""
      : `[${String(result.droppedLines)} earlier lines omitted; ${recovery}]`,
    result.omittedBytes === 0
      ? ""
      : `[${String(result.omittedBytes)} earlier bytes omitted; ${recovery}]`,
  ].filter((part) => part !== "");
  return [...notices, result.text].filter((part) => part !== "").join("\n");
}

/** Map in input order while bounding work that is in flight. */
export async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  work: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const outputs = inputs.map(() => undefined as Output);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= inputs.length) return;
      const input = inputs[index] as Input;
      // eslint-disable-next-line no-await-in-loop -- each worker owns one bounded lane.
      outputs[index] = await work(input);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return outputs;
}

/** Render captured output with a note when it was cut, never silently. */
export function renderOutput(trimmed: Trimmed): string {
  const body = trimmed.lines.join("\n");
  if (trimmed.droppedLines === 0) return body;
  return `[${String(trimmed.droppedLines)} earlier lines omitted; raise maxLines or read the resource for all of it]\n${body}`;
}

/**
 * A pointer to content instead of the content.
 *
 * A capture of a long scrollback costs the agent its context whether or not it
 * needed all of it. Linking lets it pay only when it decides to.
 */
export function resourceLink(
  uri: string,
  name: string,
  description: string,
): CallToolResult["content"][number] {
  return { description, name, type: "resource_link", uri };
}
