import {
  CLIENT_FORMATS,
  FORMAT_SEPARATOR,
  PANE_FORMATS,
  SESSION_FORMATS,
  WINDOW_FORMATS,
} from "../../src/formats.js";
import { FORMAT_VALUE_TYPES } from "../../src/_generated/field_types.js";

import type { Equal, Expect } from "./assert.js";

void FORMAT_SEPARATOR;
void CLIENT_FORMATS;
void PANE_FORMATS;
void SESSION_FORMATS;
void WINDOW_FORMATS;

// @ts-expect-error Public reference lists are readonly.
SESSION_FORMATS.push("changed");
// @ts-expect-error The import-time separator is readonly.
// eslint-disable-next-line no-import-assign -- this declaration-negative intentionally attempts import mutation.
FORMAT_SEPARATOR = "changed";

type _Separator = Expect<Equal<typeof FORMAT_SEPARATOR, string>>;
type _ClientFormats = Expect<Equal<typeof CLIENT_FORMATS, readonly string[]>>;
type _PaneFormats = Expect<Equal<typeof PANE_FORMATS, readonly string[]>>;
type _SessionFormats = Expect<Equal<typeof SESSION_FORMATS, readonly string[]>>;
type _WindowFormats = Expect<Equal<typeof WINDOW_FORMATS, readonly string[]>>;

type _PanePidValueType = Expect<Equal<typeof FORMAT_VALUE_TYPES.pane_pid, "number">>;
// @ts-expect-error generated value types expose only known format tokens.
void FORMAT_VALUE_TYPES.not_a_tmux_field;
