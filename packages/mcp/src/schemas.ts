import { z } from "zod";

import { PANE_CURSOR_PATTERN } from "./pane_tail.js";
import {
  MAX_FRAMED_COMMAND_BYTES,
  MAX_INLINE_REQUEST_BYTES,
  MAX_REQUEST_BYTES,
  MAX_REQUEST_ITEMS,
} from "./policy.js";

/** Bytes the daemon guard needs after quoting one argument. */
export function inlineRequestBytes(value: string): number {
  let quotes = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "'") quotes += 1;
  }
  return Buffer.byteLength(value, "utf8") + 3 * quotes + 2;
}

/** Whether quoted values leave half of a tmux invocation for fixed arguments. */
export function fitsInlineRequest(values: readonly (string | undefined)[]): boolean {
  let bytes = 0;
  for (const value of values) {
    if (value !== undefined) bytes += inlineRequestBytes(value);
  }
  return bytes <= MAX_INLINE_REQUEST_BYTES;
}

/** Validate text quoted into a tmux invocation without copying it into the diagnostic. */
export function inlineRequestText(label: string) {
  return z.string().refine((value) => inlineRequestBytes(value) <= MAX_INLINE_REQUEST_BYTES, {
    message: `${label} is too large after tmux quoting; the limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
  });
}

/** Validate a command before the shell wrapper expands every byte fivefold. */
export function framedCommandText(label: string) {
  return z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_FRAMED_COMMAND_BYTES, {
      message: `${label} must not exceed ${String(MAX_FRAMED_COMMAND_BYTES)} UTF-8 bytes.`,
    });
}

/** Validate request text kept out of argv. */
export function requestText(label: string) {
  return z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_REQUEST_BYTES, {
    message: `${label} must not exceed ${String(MAX_REQUEST_BYTES)} UTF-8 bytes.`,
  });
}

/** Bound the count and combined encoded size of repeated request text. */
export function requestTextArray(itemLabel: string, listLabel: string) {
  return z
    .array(requestText(itemLabel).min(1))
    .max(MAX_REQUEST_ITEMS, `${listLabel} must contain at most ${String(MAX_REQUEST_ITEMS)} items.`)
    .refine(
      (values) =>
        values.reduce((bytes, value) => bytes + Buffer.byteLength(value, "utf8"), 0) <=
        MAX_REQUEST_BYTES,
      {
        message: `${listLabel} must not exceed ${String(MAX_REQUEST_BYTES)} UTF-8 bytes in total.`,
      },
    );
}

/** Shared wire contracts for identifiers accepted by MCP tools. */
export const paneIdSchema = inlineRequestText("paneId")
  .regex(/^%\d+$/u, "Expected a pane id such as %1.")
  .describe("Stable pane id, e.g. %1.");

export const windowIdSchema = inlineRequestText("windowId")
  .regex(/^@\d+$/u, "Expected a window id such as @1.")
  .describe("Stable window id, e.g. @1.");

export const sessionIdSchema = inlineRequestText("sessionId")
  .regex(/^\$\d+$/u, "Expected a session id such as $1.")
  .describe("Stable session id, e.g. $1.");

export const paneCursorSchema = requestText("cursor").regex(
  PANE_CURSOR_PATTERN,
  "Expected a cursor returned by observe or wait_for_text.",
);
