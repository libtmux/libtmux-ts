import type { CommandOptions } from "../../common.js";
import { RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP } from "../../constants.js";
import type { MoveWindowOptions, ResizeOptions, ResizeWindowOptions } from "../../types.js";
import { VersionTooLowError } from "../../errors.js";
import type { RuntimeContext } from "../runtime/context.js";
import { parseTmuxVersion, tmuxVersionAtLeast } from "../runtime/tmux_version.js";
import { quoteCommand } from "../transport/lexer.js";
import { runCommand, runCommands } from "./command.js";
import { planRemoveWindowPlacement } from "./plans.js";
import { assertName } from "./names.js";

function destination(options: MoveWindowOptions): readonly string[] {
  if (options.session === undefined && options.index === undefined) return [];
  const session =
    typeof options.session === "string" ? options.session : (options.session?.id ?? "");
  return ["-t", `${session}:${options.index === undefined ? "" : String(options.index)}`];
}

export async function renameWindow(
  runtime: RuntimeContext,
  windowId: string | null,
  name: string,
): Promise<void> {
  await runCommand(runtime, ["rename-window", ...target(windowId), assertName("window", name)]);
}

/**
 * Move a window placement elsewhere.
 *
 * `-d` keeps the destination session from being selected as a side effect, so
 * moving a window never silently changes which session a client is looking at.
 */
export async function moveWindow(
  runtime: RuntimeContext,
  windowId: string | null,
  options: MoveWindowOptions = {},
): Promise<void> {
  await runCommand(
    runtime,
    ["move-window", "-d", ...(windowId == null ? [] : ["-s", windowId]), ...destination(options)],
    options,
  );
}

/** Link a window into another session, giving it a second placement. */
export async function linkWindow(
  runtime: RuntimeContext,
  windowId: string | null,
  options: MoveWindowOptions,
): Promise<void> {
  await runCommand(
    runtime,
    ["link-window", "-d", ...(windowId == null ? [] : ["-s", windowId]), ...destination(options)],
    options,
  );
}

/** Remove one placement of a window, leaving its other placements intact. */
export async function unlinkWindow(
  runtime: RuntimeContext,
  windowId: string | null,
): Promise<void> {
  await runCommand(runtime, ["unlink-window", ...target(windowId)]);
}

/** Unlink one placement or destroy its last ungrouped window. */
export async function removeWindowPlacement(
  runtime: RuntimeContext,
  windowId: string,
): Promise<void> {
  await runCommand(runtime, planRemoveWindowPlacement(windowId).argv);
}

/**
 * Exchange the positions of two windows.
 *
 * The destination is required: tmux resolves an absent `-t` to the current
 * window, which is never what a caller naming a source means.
 */
export async function swapWindows(
  runtime: RuntimeContext,
  source: string | null,
  destinationWindow: string,
): Promise<void> {
  await runCommand(runtime, [
    "swap-window",
    "-d",
    ...(source == null ? [] : ["-s", source]),
    "-t",
    destinationWindow,
  ]);
}

const LAYOUT_PRESETS = new Set([
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
  "tiled",
]);
const MIRRORED_LAYOUT_PRESETS = new Set(["main-horizontal-mirrored", "main-vertical-mirrored"]);
// Every name `layout_set_lookup` (tmux's layout-set.c) matches, exactly and by
// unambiguous prefix.
const LAYOUT_SET_NAMES: readonly string[] = [...LAYOUT_PRESETS, ...MIRRORED_LAYOUT_PRESETS];
// tmux CHANGES, 3.4 to 3.5: mirrored main-horizontal and main-vertical.
const MIRRORED_LAYOUTS_SINCE = parseTmuxVersion("3.5");
// tmux CHANGES, 3.7c to 3.8: layout strings use a JSON subset format.
const JSON_LAYOUTS_SINCE = parseTmuxVersion("3.8");
// A layout tmux dumped starts with its four-hex-digit checksum; sscanf reads
// it case-insensitively.
const CLASSIC_LAYOUT = /^[0-9a-fA-F]{4},/u;

type LayoutPresetLookup =
  | { readonly candidates: readonly string[]; readonly kind: "ambiguous" }
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly name: string };

/**
 * Resolve a preset name the way `layout_set_lookup` does: an exact name wins
 * outright (recognised whatever the running tmux is, so a value naming a
 * preset it predates gets `VersionTooLowError` rather than a generic
 * refusal), else a prefix naming exactly one of `prefixCandidates` resolves
 * to it, else an empty or ambiguous prefix does not resolve.
 */
function lookupLayoutPreset(
  layout: string,
  prefixCandidates: readonly string[],
): LayoutPresetLookup {
  if (LAYOUT_SET_NAMES.includes(layout)) return { kind: "resolved", name: layout };
  if (layout === "") return { kind: "none" };
  const candidates = prefixCandidates.filter((name) => name.startsWith(layout));
  if (candidates.length === 1) return { kind: "resolved", name: candidates[0]! };
  if (candidates.length > 1) return { candidates, kind: "ambiguous" };
  return { kind: "none" };
}

/**
 * The preset names the running tmux's own table holds.
 *
 * `layout_set_lookup` gains mirrored presets only from tmux 3.5 (CHANGES, 3.4
 * to 3.5), so `main-v` is a unique prefix of `main-vertical` below that
 * release and ambiguous from it on.
 */
async function versionedLayoutPresetNames(runtime: RuntimeContext): Promise<readonly string[]> {
  const { tmuxVersion } = await runtime.capabilities.bind();
  return tmuxVersionAtLeast(tmuxVersion, MIRRORED_LAYOUTS_SINCE)
    ? LAYOUT_SET_NAMES
    : [...LAYOUT_PRESETS];
}

/**
 * Refuse a layout value tmux cannot safely be handed.
 *
 * tmux 3.3 and 3.3a exit the whole server on a layout string whose checksum
 * prefix they cannot read - an unknown preset name, `garbage`, a JSON layout,
 * or `-o` once `--` forces it to be read as a layout - instead of refusing it.
 * A preset the running tmux knows, an unambiguous prefix of one (`tile` for
 * `tiled`; `layout_set_lookup` never falls through to `layout_parse`, the
 * 3.3a crash path, for those), or a string carrying the checksum prefix (even
 * one tmux then rejects), is safe everywhere, so only those reach tmux
 * unconditionally; mirrored presets and JSON wait for the release that
 * learned them. Decided before dispatch, so it holds on every version.
 *
 * A prefix is resolved against every preset name first, with no version
 * probe: unless that resolves to one of the mirrored names, or ambiguously
 * between two, the answer cannot change with the running tmux's own
 * (possibly smaller) table, so the common case never pays for one.
 */
async function assertLayoutValue(runtime: RuntimeContext, layout: string): Promise<void> {
  const broad = lookupLayoutPreset(layout, LAYOUT_SET_NAMES);
  const preset =
    broad.kind === "ambiguous" ||
    (broad.kind === "resolved" && MIRRORED_LAYOUT_PRESETS.has(broad.name))
      ? lookupLayoutPreset(layout, await versionedLayoutPresetNames(runtime))
      : broad;
  if (preset.kind === "ambiguous") {
    throw new TypeError(
      `${JSON.stringify(layout)} matches more than one tmux layout preset: ` +
        preset.candidates.join(", "),
    );
  }
  const resolved = preset.kind === "resolved" ? preset.name : undefined;
  if (resolved !== undefined && LAYOUT_PRESETS.has(resolved)) return;
  if (resolved === undefined && CLASSIC_LAYOUT.test(layout)) return;
  const since =
    resolved !== undefined && MIRRORED_LAYOUT_PRESETS.has(resolved)
      ? MIRRORED_LAYOUTS_SINCE
      : resolved === undefined && layout.startsWith("{")
        ? JSON_LAYOUTS_SINCE
        : undefined;
  if (since === undefined) {
    throw new TypeError(
      `${JSON.stringify(layout)} is neither a tmux layout preset nor a layout string tmux reported`,
    );
  }
  const { tmuxVersion } = await runtime.capabilities.bind();
  if (!tmuxVersionAtLeast(tmuxVersion, since)) {
    throw new VersionTooLowError({
      criteriaName: resolved !== undefined ? `the ${resolved} layout` : "a JSON layout string",
      serverVersion: tmuxVersion.raw,
      since: since.raw,
    });
  }
}

/**
 * Apply a named or custom layout to a window.
 *
 * The value is checked before tmux sees it (see `assertLayoutValue`): tmux
 * 3.3 and 3.3a crash the server on a layout they cannot parse, and a bare `-o`
 * would otherwise run as tmux's own undo flag. `--` stays as defence in depth
 * for a value that reaches tmux some other way.
 */
export async function selectLayout(
  runtime: RuntimeContext,
  windowId: string | null,
  layout: string,
): Promise<void> {
  await assertLayoutValue(runtime, layout);
  await runCommand(runtime, ["select-layout", ...target(windowId), "--", layout]);
}

/**
 * Zoom a pane, whatever the window was showing before.
 *
 * Three facts decide this shape. `resize-pane -Z` toggles rather than sets, so
 * a state read here and acted on there races anyone else resizing the window.
 * `window_zoomed_flag` is the window's, not the pane's, so it says a pane is
 * zoomed when a sibling is the zoomed one — and `pane_zoomed_flag` arrived in
 * tmux 3.7, above this package's floor. And `if-shell -t` sets the context its
 * condition expands in, not the target its branch acts on, so the branch
 * carries its own `-t` or it toggles whatever tmux currently points at.
 *
 * So: select the pane, which makes it active and drops a sibling's zoom, then
 * zoom unless the window already is. One invocation, because tmux runs an
 * invocation's commands in order on its own queue and a half-applied zoom is
 * not a state anything should be able to observe.
 */
export async function zoomPane(
  runtime: RuntimeContext,
  paneId: string | null,
  options: CommandOptions = {},
): Promise<void> {
  const at = target(paneId);
  await runCommands(
    runtime,
    [
      ["select-pane", ...at],
      [
        "if-shell",
        "-F",
        ...at,
        "#{?window_zoomed_flag,0,1}",
        quoteCommand(["resize-pane", "-Z", ...at]),
      ],
    ],
    options,
  );
}

/**
 * Restore a window's layout, whichever of its panes was zoomed.
 *
 * Unzooming names no pane, so this needs no selection: the condition and the
 * toggle both address the window the target names.
 */
export async function unzoomTarget(
  runtime: RuntimeContext,
  id: string | null,
  options: CommandOptions = {},
): Promise<void> {
  const at = target(id);
  await runCommand(
    runtime,
    ["if-shell", "-F", ...at, "#{window_zoomed_flag}", quoteCommand(["resize-pane", "-Z", ...at])],
    options,
  );
}

/**
 * Resize a pane; tmux ignores a dimension its layout cannot honour.
 *
 * Every form here unzooms the window first — `cmd_resize_pane_exec` calls
 * `server_unzoom_window` before it reads any size — so a resize on a zoomed
 * window both restores the layout and applies the new size.
 */
export async function resizePane(
  runtime: RuntimeContext,
  paneId: string | null,
  options: ResizeOptions,
): Promise<void> {
  await runCommand(
    runtime,
    [
      "resize-pane",
      ...target(paneId),
      // The relative form is a direction and a cell count; the absolute one is
      // a size. tmux accepts both in one call, and applies each to its own
      // axis.
      ...(options.direction === undefined
        ? []
        : [RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP[options.direction]]),
      ...(options.width === undefined ? [] : ["-x", String(options.width)]),
      ...(options.height === undefined ? [] : ["-y", String(options.height)]),
      // The cell count is a positional argument, so it follows every flag.
      // tmux stops reading flags at the first word that is not one and then
      // counts what is left, so a count written next to its direction turns
      // `-x` and its value into two more arguments than the command accepts.
      ...(options.direction === undefined ? [] : [String(options.amount ?? 1)]),
    ],
    options,
  );
}

/**
 * Resize a window, in the same three forms a pane offers plus the client ones.
 *
 * A window's size is normally tmux's to choose: under the default
 * `window-size` it tracks the attached clients, and a resize here is
 * overwritten the next time they change. Setting `window-size manual` is what
 * makes an explicit size stick.
 */
export async function resizeWindow(
  runtime: RuntimeContext,
  windowId: string | null,
  options: ResizeWindowOptions,
): Promise<void> {
  await runCommand(
    runtime,
    [
      "resize-window",
      ...target(windowId),
      ...(options.direction === undefined
        ? []
        : [RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP[options.direction]]),
      ...(options.width === undefined ? [] : ["-x", String(options.width)]),
      ...(options.height === undefined ? [] : ["-y", String(options.height)]),
      ...(options.largest === true ? ["-A"] : []),
      ...(options.smallest === true ? ["-a"] : []),
      // Positional, so it follows every flag — see `resizePane`.
      ...(options.direction === undefined ? [] : [String(options.amount ?? 1)]),
    ],
    options,
  );
}

/**
 * Exchange the positions of two panes.
 *
 * The destination is required, for the reason `swapWindows` gives.
 */
export async function swapPanes(
  runtime: RuntimeContext,
  source: string | null,
  destinationPane: string,
): Promise<void> {
  await runCommand(runtime, [
    "swap-pane",
    "-d",
    ...(source == null ? [] : ["-s", source]),
    "-t",
    destinationPane,
  ]);
}

/** Make a window or pane the active one in its parent. */
export async function selectTarget(
  runtime: RuntimeContext,
  command: "select-pane" | "select-window",
  id: string | null,
): Promise<void> {
  await runCommand(runtime, [command, ...target(id)]);
}

/** Set a pane's title, which is what `#{pane_title}` reports. */
export async function setPaneTitle(
  runtime: RuntimeContext,
  id: string | null,
  title: string,
): Promise<void> {
  await runCommand(runtime, ["select-pane", ...target(id), "-T", title]);
}

/** Step a window through its layouts, in either direction. */
export async function cycleLayout(
  runtime: RuntimeContext,
  id: string | null,
  step: "next" | "previous",
): Promise<void> {
  await runCommand(runtime, [`${step}-layout`, ...target(id)]);
}

/**
 * Rotate the panes within a window.
 *
 * Each pane takes its neighbour's place, keeping the layout and moving what
 * sits in it — which is not the same as swapping two panes.
 */
export async function rotateWindow(
  runtime: RuntimeContext,
  id: string | null,
  direction: "forward" | "backward",
): Promise<void> {
  await runCommand(runtime, [
    "rotate-window",
    ...(direction === "backward" ? ["-D"] : ["-U"]),
    ...target(id),
  ]);
}

/** Paste a named buffer's contents into a pane, as if typed. */
export async function pasteBuffer(
  runtime: RuntimeContext,
  paneId: string | null,
  name: string,
): Promise<void> {
  await runCommand(runtime, ["paste-buffer", "-b", name, ...target(paneId)]);
}

function target(id: string | null): readonly string[] {
  return id == null ? [] : ["-t", id];
}
