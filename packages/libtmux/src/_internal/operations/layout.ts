/**
 * Reading a version 1 layout string the way tmux reads it.
 *
 * tmux 3.7 through 3.7d — the three releases and the 3.7 branch after them,
 * which reports 3.7d and has no release of its own — exit the whole server on
 * a layout whose cell text is
 * unparseable at a point where a terminator follows. `layout_construct`
 * (layout-custom.c) answers such a cell with `NULL` and then returns success
 * anyway, its caller links that `NULL` into the cell list, and
 * `layout_free_cell` walks onto it. Upstream restructured the function as
 * `layout_construct_v1` with an explicit null check and a nesting cap, so the
 * releases on either side of that range refuse the same input safely.
 *
 * Every supported release, and master, exits on a second class: a cell whose
 * width or height is large enough to overflow the arithmetic below it, which
 * `layout_parse` is the one place tmux does not bound. See
 * {@link MAX_DIMENSION}.
 *
 * A prefix test cannot separate either from a layout tmux itself dumped: all
 * carry the checksum, and tmux rejects a wrong checksum before it parses
 * anything. So this is a parser rather than a pattern.
 *
 * It accepts the grammar `layout_construct` accepts and is deliberately
 * stricter in one place: a size above {@link MAX_DIMENSION} is refused even
 * where the running tmux would apply it, because the value next to it on the
 * same axis exits the server and no dump can carry either. Measured against
 * every build in the matrix and master, on a window with one pane so the cell
 * count cannot refuse first, nothing this accepts kills a server.
 */

/** Deepest nesting accepted, matching tmux's own `LAYOUT_V1_MAX_DEPTH`. */
const MAX_DEPTH = 1000;

/**
 * Largest cell dimension accepted, matching tmux's `WINDOW_MAXIMUM` and
 * `PANE_MAXIMUM` (both 10000 in tmux.h).
 *
 * tmux enforces that bound everywhere a size is set — `resize-window`,
 * `resize-pane`, `refresh-client -C`, and `new-session -x` all clamp or
 * refuse above it — and nowhere in `layout_parse`. So a layout can carry a
 * size no window could ever have, and the arithmetic downstream of it
 * overflows: a width of `UINT_MAX`, or a height from `2^31` up, exits the
 * server on every supported release and on master, with the pane count
 * matching so nothing refuses it first. Unlike the 3.7 null-cell bug this has
 * no upstream fix to wait for, and a dump can never exceed it.
 */
const MAX_DIMENSION = 10_000;

/** The four lowercase hex digits and comma that open a dumped layout. */
const CHECKSUM_PREFIX = /^[0-9a-fA-F]{4},/u;

export type LayoutRejection =
  | "checksum"
  /** Nested deeper than tmux parses. */
  | "depth"
  /** A cell larger than any window tmux will make. */
  | "dimension"
  /** Well-formed prefix, but the cell text is not a layout tmux would apply. */
  | "structure";

export type ClassicLayoutParse =
  | { readonly kind: "not-classic" }
  | { readonly kind: "invalid"; readonly reason: LayoutRejection }
  | { readonly kind: "valid" };

/**
 * tmux's `layout_checksum`: rotate the running 16-bit sum right by one, then
 * add the byte. A layout body is ASCII, so the signedness of tmux's `char`
 * never comes into it.
 */
export function layoutChecksum(body: string): string {
  let checksum = 0;
  for (let index = 0; index < body.length; index += 1) {
    checksum = ((checksum >>> 1) + ((checksum & 1) << 15) + body.charCodeAt(index)) & 0xffff;
  }
  return checksum.toString(16).padStart(4, "0");
}

const isDigit = (code: number | undefined): boolean =>
  code !== undefined && code >= 0x30 && code <= 0x39;

/** Consume one or more digits, or answer `null` where tmux's `%u` fails. */
function digits(body: string, from: number): number | null {
  let cursor = from;
  while (isDigit(body.charCodeAt(cursor))) cursor += 1;
  return cursor === from ? null : cursor;
}

/**
 * Consume one field and hold it to {@link MAX_DIMENSION}.
 *
 * The digit count is checked before the value, so a field long enough to lose
 * precision as a `number` is refused rather than compared.
 */
function bounded(body: string, from: number): number | "dimension" | null {
  const end = digits(body, from);
  if (end === null) return null;
  const text = body.slice(from, end).replace(/^0+(?=\d)/u, "");
  if (text.length > 5 || Number(text) > MAX_DIMENSION) return "dimension";
  return end;
}

/**
 * Consume one cell header, as `layout_construct_cell` does.
 *
 * Two details decide what is accepted. tmux gates on
 * `sscanf("%ux%u,%d,%d")` matching four fields but advances with a
 * digits-only walk, so every field needs a digit and none may carry a sign —
 * `80x24,-1,0` matches the scan and fails the walk. And a comma after the
 * fourth field is this cell's pane id only when what follows is not another
 * cell, which tmux decides by looking for the `x` of a size.
 */
function cell(body: string, from: number): number | "dimension" | null {
  let cursor = from;
  for (const separator of ["x", ",", ","]) {
    const next = bounded(body, cursor);
    if (next === null || next === "dimension") return next;
    if (body[next] !== separator) return null;
    cursor = next + 1;
  }
  const afterOffset = bounded(body, cursor);
  if (afterOffset === null || afterOffset === "dimension") return afterOffset;
  cursor = afterOffset;
  if (body[cursor] !== ",") return cursor;
  // tmux steps past the comma, takes the digits it finds — possibly none —
  // and only steps back when an `x` says those digits opened a sibling cell.
  // So a trailing comma with nothing after it is consumed, not rejected.
  const afterComma = cursor + 1;
  const afterDigits = digits(body, afterComma) ?? afterComma;
  return body[afterDigits] === "x" ? cursor : afterDigits;
}

const CLOSERS: Readonly<Record<string, string>> = Object.freeze({ "[": "]", "{": "}" });

/** Consume one cell and, when it opens a container, its whole child list. */
function container(body: string, from: number, depth: number): number | LayoutRejection {
  if (depth > MAX_DEPTH) return "depth";
  const afterCell = cell(body, from);
  if (afterCell === null) return "structure";
  if (afterCell === "dimension") return "dimension";
  const opener = body[afterCell];
  if (opener === undefined || opener === "," || opener === "}" || opener === "]") {
    return afterCell;
  }
  const closer = CLOSERS[opener];
  if (closer === undefined) return "structure";

  let cursor = afterCell;
  do {
    const child = container(body, cursor + 1, depth + 1);
    if (typeof child !== "number") return child;
    cursor = child;
  } while (body[cursor] === ",");
  return body[cursor] === closer ? cursor + 1 : "structure";
}

/**
 * Decide whether a value is a layout string tmux would read, and would read
 * as this whole string: `layout_parse` refuses a trailing remainder, which is
 * what rejects tmux 3.7's own `<…>` floating-pane suffix on every supported
 * release, its own included.
 */
export function parseClassicLayout(layout: string): ClassicLayoutParse {
  if (!CHECKSUM_PREFIX.test(layout)) return { kind: "not-classic" };
  const body = layout.slice(5);
  if (layoutChecksum(body) !== layout.slice(0, 4).toLowerCase()) {
    return { kind: "invalid", reason: "checksum" };
  }
  const end = container(body, 0, 0);
  if (typeof end !== "number") return { kind: "invalid", reason: end };
  return end === body.length ? { kind: "valid" } : { kind: "invalid", reason: "structure" };
}
