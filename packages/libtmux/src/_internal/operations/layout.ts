import type { CommandOptions } from "../../common.js";
import { TmuxTransportError } from "../../errors.js";
import type { TmuxVersion } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { parseTmuxVersion, tmuxVersionAtLeast } from "../runtime/tmux_version.js";
import { isColdEndpoint, runCommand } from "./command.js";

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
const withJsonLayouts = parseTmuxVersion("3.8");

/** Geometry correction and pruning remain tmux's responsibility. */
export function layoutIsValid(layout: string, panes: number, version: TmuxVersion): boolean {
  if (!Number.isSafeInteger(panes) || panes < 1 || layout.length === 0) return false;
  const names = tmuxVersionAtLeast(version, withMirrors) ? mirroredNames : classicNames;
  if (names.includes(layout) || names.filter((name) => name.startsWith(layout)).length === 1)
    return true;
  if (layout.length > 8192) return false;
  if (layout.startsWith("{"))
    return tmuxVersionAtLeast(version, withJsonLayouts) && jsonLayoutIsValid(layout, panes);
  const parsed = parseClassicLayout(layout);
  return parsed.kind === "valid" && parsed.depth <= 256 && parsed.panes >= panes;
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
    const after = layoutIsValid(layout, panes, withJsonLayouts);
    if (!before && !after) throw new TypeError(`invalid tmux layout or pane count: ${layout}`);
    if (before !== after) needsVersion.push({ layout, panes });
  }
  if (needsVersion.length === 0) return;
  // A daemon already bound for this epoch has named its version, so a builder
  // checking one layout per pane pays no round trip for the ones after the first.
  const bound = runtime.capabilities.bound();
  if (bound !== undefined) {
    assertLayouts(needsVersion, bound.tmuxVersion);
    return;
  }
  let version: TmuxVersion;
  try {
    version = parseTmuxVersion(
      (await runCommand(runtime, ["display-message", "-p", "#{version}"], options))
        .join("\n")
        .trim(),
    );
  } catch (error) {
    if (!isColdEndpoint(error)) throw error;
    const client = (await runCommand(runtime, ["-V"], options)).join("\n").trim();
    version = parseTmuxVersion(client.startsWith("tmux ") ? client.slice(5) : client);
  }
  assertLayouts(needsVersion, version);
}

function assertLayouts(
  layouts: readonly { readonly layout: string; readonly panes: number }[],
  version: TmuxVersion,
): void {
  for (const { layout, panes } of layouts) {
    if (!layoutIsValid(layout, panes, version))
      throw new TypeError(`invalid tmux layout for ${version.raw}: ${layout}`);
  }
}

/** tmux validates escapes without decoding them and accepts only integer JSON. */
function parseLayoutJson(layout: string): unknown {
  const token =
    // eslint-disable-next-line no-control-regex -- JSON strings forbid literal control bytes.
    /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\dA-Fa-f]{4}))+"|-?(?:0|[1-9]\d*)|true|false|[{}[\],:]|[ \t\r\n]+/uy;
  const objects: Set<string>[] = [];
  const parts: string[] = [];
  let offset = 0;
  while (offset < layout.length) {
    token.lastIndex = offset;
    const match = token.exec(layout);
    if (match === null) return undefined;
    const text = match[0];
    offset = token.lastIndex;
    if (text === "{") {
      objects.push(new Set());
      if (objects.length > 200) return undefined;
    } else if (text === "}") objects.pop();
    if (text.startsWith('"')) {
      const raw = text.slice(1, -1);
      if (/^\s*:/u.test(layout.slice(offset))) {
        const keys = objects.at(-1);
        if (keys === undefined || keys.has(raw)) return undefined;
        keys.add(raw);
      }
      parts.push(JSON.stringify(raw));
    } else {
      if (/^-?\d/u.test(text)) {
        const value = BigInt(text);
        if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) return undefined;
      }
      parts.push(text);
    }
  }
  return JSON.parse(parts.join("")) as unknown;
}

function jsonLayoutIsValid(layout: string, panes: number): boolean {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const integer = (value: unknown, minimum: number, maximum: number): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
  let document: unknown;
  try {
    document = parseLayoutJson(layout);
  } catch {
    return false;
  }
  if (!record(document) || document.V !== 2) return false;
  const values: unknown[] = [document];
  while (values.length > 0) {
    const value = values.pop();
    if (Array.isArray(value)) {
      if (!value.every(record)) return false;
      values.push(...value);
    } else if (record(value)) values.push(...Object.values(value));
  }
  const indexes = new Set<number>();
  const last = new Set<number>();
  const floating = new Set<number>();
  let active = false;
  const pending = [{ value: document.L, depth: 0 }];
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (
      !record(value) ||
      depth > 256 ||
      !integer(value.w, 1, MAX_DIMENSION) ||
      !integer(value.h, 1, MAX_DIMENSION) ||
      !integer(value.x, -MAX_DIMENSION, MAX_DIMENSION) ||
      !integer(value.y, -MAX_DIMENSION, MAX_DIMENSION)
    )
      return false;
    if (value.t === "p") {
      if (Object.hasOwn(value, "c") || !integer(value.i, 0, 2_147_483_647) || indexes.has(value.i))
        return false;
      indexes.add(value.i);
      if (Object.hasOwn(value, "a")) {
        if (typeof value.a !== "boolean" || (active && value.a)) return false;
        active ||= value.a;
      } else if (Object.hasOwn(value, "l")) {
        if (!integer(value.l, 0, 2_147_483_647) || last.has(value.l)) return false;
        last.add(value.l);
      }
      if (Object.hasOwn(value, "z")) {
        if (!integer(value.z, 0, 2_147_483_646) || floating.has(value.z)) return false;
        floating.add(value.z);
      }
    } else if (
      (value.t === "h" || value.t === "v") &&
      Array.isArray(value.c) &&
      value.c.length >= 2
    ) {
      for (const child of value.c) pending.push({ value: child, depth: depth + 1 });
    } else return false;
  }
  return indexes.size >= panes;
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
  | { readonly kind: "valid"; readonly panes: number; readonly depth: number };

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
  if (body[afterDigits] === "x") return cursor;
  if (Number(body.slice(afterComma, afterDigits)) > 0xffff_ffff) return null;
  return afterDigits;
}

const CLOSERS: Readonly<Record<string, string>> = Object.freeze({ "[": "]", "{": "}" });

/** Consume one cell and, when it opens a container, its whole child list. */
function container(
  body: string,
  from: number,
  depth: number,
  shape: { panes: number; depth: number },
): number | LayoutRejection {
  if (depth > MAX_DEPTH) return "depth";
  shape.depth = Math.max(shape.depth, depth);
  const afterCell = cell(body, from);
  if (afterCell === null) return "structure";
  if (afterCell === "dimension") return "dimension";
  const opener = body[afterCell];
  if (opener === undefined || opener === "," || opener === "}" || opener === "]") {
    shape.panes++;
    return afterCell;
  }
  const closer = CLOSERS[opener];
  if (closer === undefined) return "structure";

  let cursor = afterCell;
  do {
    const child = container(body, cursor + 1, depth + 1, shape);
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
  const shape = { panes: 0, depth: 0 };
  const end = container(body, 0, 0, shape);
  if (typeof end !== "number") return { kind: "invalid", reason: end };
  return end === body.length
    ? { kind: "valid", ...shape }
    : { kind: "invalid", reason: "structure" };
}
