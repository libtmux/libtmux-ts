import { v, type Validator } from "../validate.js";

import { FORMAT_IDENTITY_FIELDS } from "../../_generated/field_types.js";
import { FORMAT_FIELD_TOKENS } from "../../_generated/format_fields.js";
import type { FormatFieldName, RawFormatValue } from "../../field_types.js";
import { parsePaneId, parseSessionId, parseWindowId } from "../runtime/ids.js";
import type { ListCommand } from "./format_types.js";

export type RawCompleteFormatRow = Readonly<Record<FormatFieldName, string | null>>;

export type CompleteFormatRow = {
  readonly [Key in FormatFieldName]: RawFormatValue<Key> | null;
};

const completeFormatRowShape = Object.fromEntries(
  FORMAT_FIELD_TOKENS.map((token) => [token, v.string().nullable()]),
) as Record<FormatFieldName, Validator<string | null>>;
const completeFormatRowSchema = v.strictObject(completeFormatRowShape);
const identitySchemas: Readonly<Record<ListCommand, Validator<string>>> = Object.freeze({
  "list-clients": v
    .string()
    .min(1)
    .refine((value) => !/^[%$@]/u.test(value), "a client name without a tmux id sigil"),
  "list-panes": v.string().regex(/^%\d+$/u, "a pane id like %0"),
  "list-sessions": v.string().regex(/^\$\d+$/u, "a session id like $0"),
  "list-windows": v.string().regex(/^@\d+$/u, "a window id like @0"),
});

function primaryIdentity(listCommand: ListCommand): FormatFieldName {
  switch (listCommand) {
    case "list-clients":
      return "client_name";
    case "list-panes":
      return "pane_id";
    case "list-sessions":
      return "session_id";
    case "list-windows":
      return "window_id";
  }
}

export function parseCompleteFormatRow(
  listCommand: ListCommand,
  row: RawCompleteFormatRow,
): CompleteFormatRow {
  const parsed = completeFormatRowSchema.parse(row) as RawCompleteFormatRow;
  validatePopulatedFormatIdentities(parsed);
  parseFormatIdentity(listCommand, parsed[primaryIdentity(listCommand)]);
  return Object.freeze(parsed) as CompleteFormatRow;
}

function parseFormatIdentity(listCommand: ListCommand, value: unknown): string {
  return identitySchemas[listCommand].parse(value);
}

export function validatePopulatedFormatIdentities(row: RawCompleteFormatRow): void {
  for (const { token, type } of FORMAT_IDENTITY_FIELDS) {
    const value = row[token];
    if (value === null || value === "") continue;
    switch (type) {
      case "pane-id":
        parsePaneId(value);
        break;
      case "session-id":
        parseSessionId(value);
        break;
      case "window-id":
        parseWindowId(value);
        break;
      default:
        break;
    }
  }
}
