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
type _ClientFormatFirst = Expect<Equal<(typeof CLIENT_FORMATS)[0], "client_cwd">>;
type _PaneFormatFirst = Expect<Equal<(typeof PANE_FORMATS)[0], "history_size">>;
type _SessionFormatFirst = Expect<Equal<(typeof SESSION_FORMATS)[0], "session_name">>;
type _WindowFormatFirst = Expect<Equal<(typeof WINDOW_FORMATS)[0], "window_id">>;

type _ClientFormatCount = Expect<Equal<typeof CLIENT_FORMATS.length, 14>>;
type _PaneFormatCount = Expect<Equal<typeof PANE_FORMATS.length, 47>>;
type _SessionFormatCount = Expect<Equal<typeof SESSION_FORMATS.length, 9>>;
type _WindowFormatCount = Expect<Equal<typeof WINDOW_FORMATS.length, 12>>;

type _PanePidValueType = Expect<Equal<typeof FORMAT_VALUE_TYPES.pane_pid, "number">>;
// @ts-expect-error generated value types expose only known format tokens.
void FORMAT_VALUE_TYPES.not_a_tmux_field;
