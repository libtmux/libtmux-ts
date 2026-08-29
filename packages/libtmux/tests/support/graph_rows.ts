import { FORMAT_FIELD_TOKENS } from "../../src/_generated/format_fields.js";
import type { FormatFieldName } from "../../src/_generated/format_field_names.js";
import type { RawCompleteFormatRow } from "../../src/_internal/codec/schemas.js";

export type MutableCompleteFormatRow = {
  -readonly [Field in FormatFieldName]: RawCompleteFormatRow[Field];
};

export function completeFormatRow(
  overrides: Readonly<Partial<Record<FormatFieldName, string | null>>> = {},
): MutableCompleteFormatRow {
  return Object.assign(
    Object.fromEntries(
      FORMAT_FIELD_TOKENS.map((token) => [token, null]),
    ) as MutableCompleteFormatRow,
    overrides,
  );
}
