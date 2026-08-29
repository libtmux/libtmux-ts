import { FORMAT_FIELD_TOKENS } from "../../src/_generated/format_fields.js";
import type { FormatFieldRecord } from "../../src/_internal/codec/format_registry.js";
import type { FormatFieldName } from "../../src/_generated/format_field_names.js";

import type { Equal, Expect } from "./assert.js";

const validSnapshotDestination: FormatFieldRecord["snapshotDestination"] = "raw-row";
void validSnapshotDestination;
// @ts-expect-error Snapshot destinations are a closed policy vocabulary.
const invalidSnapshotDestination: FormatFieldRecord["snapshotDestination"] = "arbitrary";
void invalidSnapshotDestination;

type _GeneratedFormatToken = Expect<Equal<(typeof FORMAT_FIELD_TOKENS)[number], FormatFieldName>>;
// @ts-expect-error The generated format inventory is readonly.
FORMAT_FIELD_TOKENS.push("session_name");
// @ts-expect-error The generated format inventory does not permit indexed assignment.
FORMAT_FIELD_TOKENS[0] = "session_name";
