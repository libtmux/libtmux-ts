import { formatValueType } from "../../_generated/field_types.js";

/**
 * Convert between the text tmux sends and the value it stands for.
 *
 * tmux has one wire type. Which fields are really numbers, booleans and times
 * is generated into `_generated/field_types.ts`; anything absent from it is
 * text. Decoding happens where a row becomes a handle, and the row keeps the
 * text, so `handle.format.pane_pid` is still `"2334787"`.
 */

/** A decoded field value. `null` covers both "tmux said nothing" and "unparseable". */
export type DecodedValue = boolean | number | string | Date | null;

const integer = /^-?\d+$/u;

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
      if (!integer.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    case "time": {
      if (!integer.test(value)) return null;
      const seconds = Number(value);
      // tmux writes 0 for a time that has not happened.
      if (seconds <= 0 || !Number.isSafeInteger(seconds)) return null;
      return new Date(seconds * 1000);
    }
  }
}

/**
 * The text tmux would have sent for a decoded value.
 *
 * The inverse of {@link decodeFormatValue}, so criteria compare against what a
 * row holds. A value already in wire form passes through unchanged.
 */
export function encodeFormatValue(token: string, value: unknown): unknown {
  const type = formatValueType(token);
  if (type === undefined) return value;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return value;
    return type === "time" ? String(Math.trunc(value / 1000)) : String(value);
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? String(Math.trunc(time / 1000)) : value;
  }
  return value;
}
