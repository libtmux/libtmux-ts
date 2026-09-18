/**
 * Reading a version 1 layout string the way tmux reads it.
 *
 * tmux 3.7 through 3.7d exit the whole server on a layout whose cell text is
 * unparseable at a point where a terminator follows. `layout_construct`
 * (layout-custom.c) answers such a cell with `NULL` and then returns success
 * anyway, its caller links that `NULL` into the cell list, and
 * `layout_free_cell` walks onto it. Upstream restructured the function as
 * `layout_construct_v1` with an explicit null check and a nesting cap, so the
 * releases on either side of that range refuse the same input safely.
 *
 * A prefix test cannot separate those inputs from a layout tmux itself
 * dumped: both carry the checksum, and tmux rejects a wrong checksum before
 * it parses anything. So this is a parser rather than a pattern, and it
 * accepts exactly the grammar `layout_construct` accepts, minus the null cell
 * that is the bug.
 */

/** Deepest nesting accepted, matching tmux's own `LAYOUT_V1_MAX_DEPTH`. */
const MAX_DEPTH = 1000;

/** The four lowercase hex digits and comma that open a dumped layout. */
const CHECKSUM_PREFIX = /^[0-9a-fA-F]{4},/u;

export type LayoutRejection =
  | "checksum"
  /** Nested deeper than tmux parses. */
  | "depth"
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
 * Consume one cell header, as `layout_construct_cell` does.
 *
 * Two details decide what is accepted. tmux gates on
 * `sscanf("%ux%u,%d,%d")` matching four fields but advances with a
 * digits-only walk, so every field needs a digit and none may carry a sign —
 * `80x24,-1,0` matches the scan and fails the walk. And a comma after the
 * fourth field is this cell's pane id only when what follows is not another
 * cell, which tmux decides by looking for the `x` of a size.
 */
function cell(body: string, from: number): number | null {
  let cursor = from;
  for (const separator of ["x", ",", ","]) {
    const next = digits(body, cursor);
    if (next === null || body[next] !== separator) return null;
    cursor = next + 1;
  }
  const afterOffset = digits(body, cursor);
  if (afterOffset === null) return null;
  cursor = afterOffset;
  if (body[cursor] !== ",") return cursor;
  const withPaneId = digits(body, cursor + 1);
  return withPaneId !== null && body[withPaneId] === "x" ? cursor : (withPaneId ?? cursor);
}

const CLOSERS: Readonly<Record<string, string>> = Object.freeze({ "[": "]", "{": "}" });

/** Consume one cell and, when it opens a container, its whole child list. */
function container(body: string, from: number, depth: number): number | LayoutRejection {
  if (depth > MAX_DEPTH) return "depth";
  const afterCell = cell(body, from);
  if (afterCell === null) return "structure";
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
