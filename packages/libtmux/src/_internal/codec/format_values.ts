import { types as nodeTypes } from "node:util";

import { formatValueType } from "../../_generated/field_types.js";
import { isPaneId, isSessionId, isWindowId } from "../runtime/ids.js";

/**
 * Convert between the text tmux sends and the value it stands for.
 *
 * tmux has one wire type. Which fields are numbers, booleans, times, or object
 * IDs is generated into `_generated/field_types.ts`; anything absent from it
 * is text. Decoding happens where a row becomes a handle, and the row keeps
 * the text, so `handle.format.pane_pid` is still `"2334787"`.
 */

/** A decoded field value. `null` covers both "tmux said nothing" and "unparseable". */
export type DecodedValue = boolean | number | string | Date | null;

const integer = /^-?\d+$/u;
const IntrinsicDate = Date;
const isDateObject = nodeTypes.isDate.bind(nodeTypes);
// Capture the intrinsic before caller code can replace the prototype method.
// oxlint-disable-next-line typescript/unbound-method
const intrinsicGetTime = Function.prototype.call.bind(Date.prototype.getTime) as (
  value: Date,
) => number;

function canonicalSafeIntegerText(value: unknown): value is string {
  if (typeof value !== "string" || !integer.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value;
}

function intrinsicDateMilliseconds(value: unknown): number | undefined {
  if (!isDateObject(value)) return undefined;
  return intrinsicGetTime(value);
}

function dateCanRepresentSeconds(value: string): boolean {
  if (!canonicalSafeIntegerText(value)) return false;
  return Number.isFinite(intrinsicGetTime(new IntrinsicDate(Number(value) * 1000)));
}

/** Whether a field can compare directly against this decoded or wire value. */
export function isFormatCriterionValue(token: string, value: unknown): boolean {
  if (value === null) return true;
  const type = formatValueType(token);
  if (type === undefined) return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean" || value === "0" || value === "1";
  if (type === "number") {
    return Number.isSafeInteger(value) || canonicalSafeIntegerText(value);
  }
  if (type === "time") {
    const milliseconds = intrinsicDateMilliseconds(value);
    return (
      (milliseconds !== undefined && Number.isFinite(milliseconds)) ||
      (typeof value === "string" && dateCanRepresentSeconds(value))
    );
  }
  if (type === "pane-id") return isPaneId(value);
  if (type === "session-id") return isSessionId(value);
  return isWindowId(value);
}

/** Describe the decoded or wire value accepted by one format field. */
export function formatCriterionExpectation(token: string): string {
  const type = formatValueType(token);
  if (type === undefined) return "expected a string";
  if (type === "boolean") return 'expected a boolean, "0", or "1"';
  if (type === "number") return "expected a safe integer or its canonical text";
  if (type === "time") return "expected a valid Date or canonical epoch seconds in Date range";
  if (type === "pane-id") return "expected a pane id";
  if (type === "session-id") return "expected a session id";
  return "expected a window id";
}

export function decodeFormatValue(token: string, value: string | null): DecodedValue {
  if (value === null) return null;
  const type = formatValueType(token);
  // Empty means "not applicable" only for a typed field. `config_files` holds
  // `""` when tmux read no configuration, which is an answer.
  if (type === undefined) return value;
  if (value === "") return null;
  switch (type) {
    case "boolean": {
      if (value === "1") return true;
      if (value === "0") return false;
      return null;
    }
    case "number": {
      return canonicalSafeIntegerText(value) ? Number(value) : null;
    }
    case "pane-id":
      return isPaneId(value) ? value : null;
    case "session-id":
      return isSessionId(value) ? value : null;
    case "time": {
      if (!canonicalSafeIntegerText(value)) return null;
      const seconds = Number(value);
      // tmux writes 0 for a time that has not happened.
      if (seconds <= 0 || !Number.isSafeInteger(seconds)) return null;
      const decoded = new IntrinsicDate(seconds * 1000);
      return Number.isFinite(intrinsicGetTime(decoded)) ? decoded : null;
    }
    case "window-id":
      return isWindowId(value) ? value : null;
  }
}

/**
 * The text tmux would have sent for a decoded value.
 *
 * Emits the canonical wire spelling for a decoded non-null value, so criteria
 * compare against what a row holds. A value already in wire form passes
 * through unchanged.
 */
export function encodeFormatValue(token: string, value: unknown): unknown {
  const type = formatValueType(token);
  if (type === undefined) return value;
  if (type === "pane-id" || type === "session-id" || type === "window-id") return value;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return value;
    return type === "time" ? String(Math.trunc(value / 1000)) : String(value);
  }
  const time = intrinsicDateMilliseconds(value);
  if (time !== undefined) {
    return Number.isFinite(time) ? String(Math.trunc(time / 1000)) : value;
  }
  return value;
}
