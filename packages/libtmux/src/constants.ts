export const ResizeAdjustmentDirection = {
  Up: "UP",
  Down: "DOWN",
  Left: "LEFT",
  Right: "RIGHT",
} as const;
/**
 * Which edge a resize moves, in tmux's own terms.
 *
 * The direction is where the boundary travels, not which pane grows: `Up` on
 * a pane with a neighbour above it takes space from that neighbour.
 */
export type ResizeAdjustmentDirection =
  (typeof ResizeAdjustmentDirection)[keyof typeof ResizeAdjustmentDirection];

export const RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP: Readonly<
  Record<ResizeAdjustmentDirection, string>
> = {
  [ResizeAdjustmentDirection.Up]: "-U",
  [ResizeAdjustmentDirection.Down]: "-D",
  [ResizeAdjustmentDirection.Left]: "-L",
  [ResizeAdjustmentDirection.Right]: "-R",
} as const;

export const WindowDirection = {
  Before: "BEFORE",
  After: "AFTER",
} as const;
/**
 * Where a new window lands relative to the one it was created from.
 *
 * tmux inserts at the next index before or after the target and moves the
 * windows above it up to make room, so indices a caller is holding can shift.
 * Without either direction the target index *is* the new window's place.
 */
export type WindowDirection = (typeof WindowDirection)[keyof typeof WindowDirection];

export const WINDOW_DIRECTION_FLAG_MAP: Readonly<Record<WindowDirection, string>> = {
  [WindowDirection.Before]: "-b",
  [WindowDirection.After]: "-a",
} as const;

export const PaneDirection = {
  Above: "ABOVE",
  Below: "BELOW",
  Right: "RIGHT",
  Left: "LEFT",
} as const;
/**
 * Which side of the current pane a split puts the new one on.
 *
 * `Above` and `Left` are the same split as `Below` and `Right` with tmux's
 * `-b` flag, so the geometry is identical and only the occupant differs.
 */
export type PaneDirection = (typeof PaneDirection)[keyof typeof PaneDirection];

export const PANE_DIRECTION_FLAG_MAP: Readonly<Record<PaneDirection, readonly string[]>> = {
  [PaneDirection.Above]: ["-v", "-b"],
  [PaneDirection.Below]: ["-v"],
  [PaneDirection.Right]: ["-h"],
  [PaneDirection.Left]: ["-h", "-b"],
} as const;

declare const defaultOptionScopeBrand: unique symbol;
/**
 * "Whatever scope tmux would use", as a value rather than an absent argument.
 *
 * Branded so it cannot be confused with an {@link OptionScope}: passing this
 * means the call sends no scope flag, which is not the same as sending the
 * session one.
 */
export type DefaultOptionScope = { readonly [defaultOptionScopeBrand]: "default-option-scope" };
export const DEFAULT_OPTION_SCOPE: DefaultOptionScope = {} as DefaultOptionScope;

export const OptionScope = {
  Server: "server",
  Session: "session",
  Window: "window",
  Pane: "pane",
} as const;
/**
 * Which table an option is read from or written to.
 *
 * The scopes are not one chain. A pane option falls back to the window's, and
 * an unset window or pane option falls back to the global window options; a
 * session option falls back to the global session options, and server options
 * belong to no session, window or pane at all. So setting something at window
 * scope reaches every pane in it that has not set its own, and setting it at
 * session scope does not.
 */
export type OptionScope = (typeof OptionScope)[keyof typeof OptionScope];

export const OPTION_SCOPE_FLAG_MAP: Readonly<Record<OptionScope, string>> = {
  [OptionScope.Server]: "-s",
  [OptionScope.Session]: "",
  [OptionScope.Window]: "-w",
  [OptionScope.Pane]: "-p",
} as const;

export const HOOK_SCOPE_FLAG_MAP: Readonly<Record<OptionScope, string>> = {
  [OptionScope.Server]: "-g",
  [OptionScope.Session]: "",
  [OptionScope.Window]: "-w",
  [OptionScope.Pane]: "-p",
} as const;
