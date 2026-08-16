import { FORMAT_VALUE_TYPES, type FormatValueType } from "../../_generated/field_types.js";

/**
 * Turn the text tmux sends into the value it stands for, and back.
 *
 * tmux has one wire type. Everything is text: a pid is `"2334787"`, an active
 * pane is `"1"`, and a session's creation time is `"1786878571"`. Which fields
 * are really numbers, booleans and times is generated into
 * `_generated/field_types.ts` from tmux's own format.c, and held to a live
 * server by tests/integration/format_types.test.ts.
 *
 * Decoding happens where a row becomes a handle and nowhere else. The row keeps
 * the text — `handle.format.pane_pid` is still `"2334787"` — so nothing here
 * can lose information a caller might want.
 */

/**
 * A value tmux did not give, or gave in a shape its own format table disowns.
 *
 * Both answer `null`. An unparseable value is a disagreement between this
 * port's table and the tmux in front of it, and `null` is what a caller already
 * handles for a field that does not apply; `NaN` or `Invalid Date` would travel
 * silently into arithmetic and comparisons instead, and surface somewhere else
 * entirely.
 */
export type DecodedValue = boolean | number | string | Date | null;

const integer = /^-?\d+$/u;

export function decodeFormatValue(token: string, value: string | null): DecodedValue {
  if (value === null) return null;
  const type = FORMAT_VALUE_TYPES[token];
  // A string field is returned as tmux sent it, empty included: `config_files`
  // holds `""` when tmux read no configuration, which is an answer rather than
  // the absence of one, and only a typed field can say "not applicable" by
  // going blank.
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
      // tmux writes 0 for a time that has not happened — a session never
      // attached to, a pane that has not died. The epoch is not that moment.
      if (seconds <= 0 || !Number.isSafeInteger(seconds)) return null;
      return new Date(seconds * 1000);
    }
  }
}

/**
 * The text tmux would have sent for a decoded value.
 *
 * The inverse of {@link decodeFormatValue}, for criteria: a caller writing
 * `where({ active: true })` is describing a row whose `pane_active` is `"1"`,
 * and comparisons happen against the text because that is what a row holds.
 * A value already in its wire form is passed through, so `where({ active: "1" })`
 * keeps working beside it.
 */
export function encodeFormatValue(token: string, value: unknown): unknown {
  const type: FormatValueType | undefined = FORMAT_VALUE_TYPES[token];
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
