import type { CommandOptions } from "../../common.js";
import { TmuxCommandError, TmuxTransportError } from "../../errors.js";
import type { TmuxVersion } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { parseTmuxVersion, tmuxVersionAtLeast } from "../runtime/tmux_version.js";
import { runCommand } from "./command.js";

const classicNames = [
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
  "tiled",
];
const mirroredNames = [...classicNames, "main-horizontal-mirrored", "main-vertical-mirrored"];
const beforeMirrors = parseTmuxVersion("3.4");
const withMirrors = parseTmuxVersion("3.5");

/** Geometry correction and pruning remain tmux's responsibility. */
export function layoutIsValid(layout: string, panes: number, version: TmuxVersion): boolean {
  if (!Number.isSafeInteger(panes) || panes < 1 || layout.length === 0) return false;
  const names = tmuxVersionAtLeast(version, withMirrors) ? mirroredNames : classicNames;
  if (names.includes(layout) || names.filter((name) => name.startsWith(layout)).length === 1)
    return true;
  if (layout.length > 8192 || parseClassicLayout(layout).kind !== "valid") return false;
  const body = layout.slice(5);
  let checksum = 0;
  for (const character of body)
    checksum = (((checksum >>> 1) | ((checksum & 1) << 15)) + character.charCodeAt(0)) & 0xffff;
  if (checksum !== Number.parseInt(layout.slice(0, 4), 16)) return false;
  const parser = new LayoutParser(body);
  return parser.cell(0) && parser.offset === body.length && parser.leaves >= panes;
}

export async function validateLayouts(
  runtime: RuntimeContext,
  layouts: readonly { readonly layout: string; readonly panes: number }[],
  options: CommandOptions = {},
): Promise<void> {
  if (options.signal?.aborted === true)
    throw new TmuxTransportError("layout validation cancelled", {
      delivery: "not_started",
      kind: "cancelled",
      subcommand: "display-message",
    });
  const needsVersion: { layout: string; panes: number }[] = [];
  for (const { layout, panes } of layouts) {
    const before = layoutIsValid(layout, panes, beforeMirrors);
    const after = layoutIsValid(layout, panes, withMirrors);
    if (!before && !after) throw new TypeError(`invalid tmux layout or pane count: ${layout}`);
    if (before !== after) needsVersion.push({ layout, panes });
  }
  if (needsVersion.length === 0) return;
  let version: TmuxVersion;
  try {
    version = parseTmuxVersion(
      (await runCommand(runtime, ["display-message", "-p", "#{version}"], options))
        .join("\n")
        .trim(),
    );
  } catch (error) {
    if (!(error instanceof TmuxCommandError)) throw error;
    const reason = error.stderr.join("\n").trim();
    if (
      !(
        reason.startsWith("no server running on ") ||
        (reason.startsWith("error connecting to ") &&
          reason.endsWith(" (No such file or directory)"))
      )
    )
      throw error;
    const client = (await runCommand(runtime, ["-V"], options)).join("\n").trim();
    version = parseTmuxVersion(client.startsWith("tmux ") ? client.slice(5) : client);
  }
  for (const { layout, panes } of needsVersion) {
    if (!layoutIsValid(layout, panes, version))
      throw new TypeError(`invalid tmux layout for ${version.raw}: ${layout}`);
  }
}

class LayoutParser {
  offset = 0;
  leaves = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private take(character: string): boolean {
    if (this.text[this.offset] !== character) return false;
    this.offset++;
    return true;
  }

  private number(): boolean {
    const start = this.offset;
    let value = 0;
    while (this.offset < this.text.length) {
      const digit = this.text.charCodeAt(this.offset) - 48;
      if (digit < 0 || digit > 9) break;
      value = value * 10 + digit;
      if (value > 0xffff_ffff) return false;
      this.offset++;
    }
    return this.offset > start;
  }

  cell(depth: number): boolean {
    if (
      depth > 256 ||
      !this.number() ||
      !this.take("x") ||
      !this.number() ||
      !this.take(",") ||
      !this.number() ||
      !this.take(",") ||
      !this.number()
    )
      return false;
    const saved = this.offset;
    if (this.take(",") && (!this.number() || this.text[this.offset] === "x")) this.offset = saved;
    const close = this.take("{") ? "}" : this.take("[") ? "]" : undefined;
    if (close === undefined) {
      this.leaves++;
      return true;
    }
    if (!this.cell(depth + 1)) return false;
    while (this.take(",")) if (!this.cell(depth + 1)) return false;
    return this.take(close);
  }
}

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
