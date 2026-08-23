import { RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP } from "../../constants.js";
import type { MoveWindowOptions, ResizeOptions, ResizeWindowOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand } from "./command.js";

function destination(options: MoveWindowOptions): readonly string[] {
  if (options.session === undefined && options.index === undefined) return [];
  const session = options.session ?? "";
  return ["-t", `${session}:${options.index === undefined ? "" : String(options.index)}`];
}

export async function renameWindow(
  runtime: RuntimeContext,
  windowId: string | null,
  name: string,
): Promise<void> {
  await runCommand(runtime, ["rename-window", ...target(windowId), name]);
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

/** Apply a named or custom layout to a window. */
export async function selectLayout(
  runtime: RuntimeContext,
  windowId: string | null,
  layout: string,
): Promise<void> {
  await runCommand(runtime, ["select-layout", ...target(windowId), layout]);
}

/** Resize a pane; tmux ignores a dimension its layout cannot honour. */
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
