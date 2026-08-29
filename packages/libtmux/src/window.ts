import type { CmdOptions, PlannedOperation } from "./types.js";
import { runRawCommand } from "./_internal/operations/raw.js";
import type { SetHookOptions, SetOptionOptions } from "./types.js";
import type {
  MoveWindowOptions,
  ResizeWindowOptions,
  RespawnOptions,
  SplitOptions,
} from "./types.js";
import { WINDOW_ALIASES } from "./_generated/field_aliases.js";
import type { AliasedFields, RowWithIdentities, WindowAliasMap } from "./field_types.js";
import {
  linkedSessionsOfWindow,
  panesOfPlacement,
  sessionOf,
} from "./_internal/operations/relations.js";
import { killTarget, splitWindow } from "./_internal/operations/mutations.js";
import {
  planKill,
  planRemoveWindowPlacement,
  planSplitWindow,
} from "./_internal/operations/plans.js";
import { setHook, showHooks, unsetHook } from "./_internal/operations/hooks.js";
import {
  setOption,
  showOptions,
  showResolvedOptions,
  unsetOption,
} from "./_internal/operations/options.js";
import {
  linkWindow,
  cycleLayout,
  moveWindow,
  renameWindow,
  resizeWindow,
  removeWindowPlacement,
  rotateWindow,
  selectLayout,
  selectTarget,
  swapWindows,
  unlinkWindow,
} from "./_internal/operations/topology.js";
import { respawnWindow } from "./_internal/operations/shell.js";
import { refreshedHandle } from "./_internal/operations/refreshed.js";
import { originGraphForHandle } from "./_internal/runtime/live_handle.js";
import type { Pane } from "./pane.js";
import type { Selection } from "./selection.js";
import type { Session } from "./session.js";
import {
  installLiveHandlePrototype,
  liveHandlesEqual,
  liveHandlesShareTmuxId,
  runtimeForHandle,
} from "./_internal/runtime/live_handle.js";
import type { Server } from "./server.js";

/** What {@link Window.plan} offers, one entry per mutation it can describe. */
export interface WindowPlans {
  readonly kill: () => PlannedOperation<void>;
  readonly removePlacement: () => PlannedOperation<void>;
  readonly split: (options?: SplitOptions) => PlannedOperation<Pane>;
}

/**
 * This placement, as tmux addresses one.
 *
 * A window linked into two sessions is one window with two placements sharing
 * an id, and a bare `@id` leaves tmux to choose between them — which it does
 * consistently, and consistently without regard for which placement the handle
 * came from. Qualifying with the session is what makes an operation act on the
 * placement it was reached through.
 *
 * Only the operations that address a placement take this. `kill`, `rename`,
 * `selectLayout` and `resize` act on the window itself, wherever it is linked,
 * and naming a session there would suggest a choice that does not exist.
 */
/**
 * Fill in the destination session the caller left out.
 *
 * tmux reads a destination of `:3` as index 3 of the *current* session, which
 * is whichever one it happens to consider current — not this window's. Naming
 * the window's own is what makes "the window stays in its own session when
 * omitted" true, and it is the only reading under which omitting the session is
 * a smaller request rather than a different one.
 */
function inThisSession(window: Window, options: MoveWindowOptions): MoveWindowOptions {
  return { ...options, session: options.session ?? window.format.session_id };
}

function placementTarget(window: Window): string {
  return `${window.format.session_id}:${window.format.window_index}`;
}

// eslint-disable-next-line typescript/no-unsafe-declaration-merging -- CompleteFormatRow declaration merging exposes the frozen scalar snapshot on the nominal handle.
export class Window {
  declare private readonly windowBrand: undefined;
  /**
   * The server this handle addresses.
   *
   * ```ts
   * window.server.socketPath;
   * ```
   */
  declare readonly server: Server;

  private constructor() {
    throw new Error("Window cannot be constructed directly");
  }

  /**
   * Panes of this window placement; a linked window keeps each set apart.
   *
   * ```ts
   * window.panes.count();
   * window.panes.at(0)?.id;
   * ```
   */
  get panes(): Selection<Pane> {
    return panesOfPlacement(originGraphForHandle(this), this);
  }

  /**
   * The session this placement belongs to.
   *
   * ```ts
   * window.session?.name;
   * ```
   */
  get session(): Session | undefined {
    return sessionOf(originGraphForHandle(this), this.format.session_id);
  }

  /**
   * The pane tmux marks active in this window.
   *
   * `pane_active` is scoped to a window, so filtering a session's panes on it
   * yields one per window rather than one overall. Reaching the active pane
   * through the window it belongs to is what makes the answer singular.
   *
   * ```ts
   * await window.activePane?.sendKeys("echo hello");
   * ```
   */
  get activePane(): Pane | undefined {
    return this.panes.where({ active: "1" }).first();
  }

  /**
   * Every session this window is linked into.
   *
   * ```ts
   * window.linkedSessions.map((entry) => entry.name);
   * ```
   */
  get linkedSessions(): Selection<Session> {
    return linkedSessionsOfWindow(originGraphForHandle(this), this.id);
  }

  /**
   * Read hooks set on this window itself.
   *
   * ```ts
   * const hooks = await window.showHooks();
   * hooks.get("window-renamed")?.[0];
   * ```
   */
  showHooks(): Promise<ReadonlyMap<string, readonly string[]>> {
    return showHooks(runtimeForHandle(this), "window", this.id);
  }

  /**
   * Bind a tmux command to a window-scoped hook.
   *
   * ```ts
   * await window.setHook("window-renamed", "display-message 'renamed'");
   * ```
   */
  setHook(name: string, command: string, options?: SetHookOptions): Promise<void> {
    return setHook(runtimeForHandle(this), "window", this.id, name, command, options);
  }

  /**
   * Remove every command bound to a window-scoped hook.
   *
   * ```ts
   * await window.unsetHook("window-renamed");
   * ```
   */
  unsetHook(name: string): Promise<void> {
    return unsetHook(runtimeForHandle(this), "window", this.id, name);
  }

  /**
   * Every option set on this window itself, not the ones it inherits.
   *
   * A fresh window usually has none, so an empty map here means nothing was
   * set on this window — not that the option has no value. `showResolvedOptions`
   * answers what actually governs it.
   *
   * ```ts
   * const options = await window.showOptions();
   * options.get("automatic-rename");
   * ```
   */
  showOptions(): Promise<ReadonlyMap<string, string>> {
    return showOptions(runtimeForHandle(this), "window", this.id);
  }

  /**
   * The option values that govern this window, own and inherited together.
   *
   * `showOptions` reports only what was set here, which for a fresh window is
   * often nothing. This resolves what it inherits as well, so an option has an
   * answer wherever it was actually set.
   *
   * ```ts
   * (await window.showResolvedOptions()).get("main-pane-width");
   * ```
   */
  showResolvedOptions(): Promise<ReadonlyMap<string, string>> {
    return showResolvedOptions(runtimeForHandle(this), "window", this.id);
  }

  /**
   * Set an option on this window.
   *
   * ```ts
   * await window.setOption("automatic-rename", "off");
   * ```
   */
  setOption(name: string, value: string, options?: SetOptionOptions): Promise<void> {
    return setOption(runtimeForHandle(this), "window", this.id, name, value, options);
  }

  /**
   * Remove an option from this window.
   *
   * ```ts
   * await window.unsetOption("automatic-rename");
   * ```
   */
  unsetOption(name: string): Promise<void> {
    return unsetOption(runtimeForHandle(this), "window", this.id, name);
  }

  /**
   * Split this window and resolve the created pane.
   *
   * ```ts
   * const created = await window.split({ vertical: true });
   * created.id;
   * ```
   */
  split(options?: SplitOptions): Promise<Pane> {
    return splitWindow(this.server, runtimeForHandle(this), this.id, options);
  }

  /**
   * The same mutations, described instead of run.
   *
   * Takes what the direct calls take and resolves to what they resolve to,
   * for {@link Server.batch} to spend one invocation and one snapshot on.
   *
   * ```ts
   * const [created] = await server.batch([window.plan.split({})]);
   * created.id;
   * ```
   */
  get plan(): WindowPlans {
    return {
      kill: () => planKill("kill-window", this.id),
      removePlacement: () => planRemoveWindowPlacement(placementTarget(this)),
      split: (options?: SplitOptions) => planSplitWindow(this.id, options),
    };
  }

  /**
   * Apply this window's next layout preset.
   *
   * tmux cycles a fixed list — even-horizontal, even-vertical, main-horizontal,
   * main-vertical, tiled — rearranging the panes already there.
   *
   * ```ts
   * await window.nextLayout();
   * ```
   */
  nextLayout(): Promise<void> {
    return cycleLayout(runtimeForHandle(this), this.id, "next");
  }

  /**
   * Apply this window's previous layout preset.
   *
   * ```ts
   * await window.previousLayout();
   * ```
   */
  previousLayout(): Promise<void> {
    return cycleLayout(runtimeForHandle(this), this.id, "previous");
  }

  /**
   * Rotate the panes within this window.
   *
   * The layout stays put and the panes move through it, so this reorders what
   * occupies each position rather than trading two panes.
   *
   * ```ts
   * await window.rotate("forward");
   * ```
   */
  rotate(direction: "forward" | "backward" = "forward"): Promise<void> {
    return rotateWindow(runtimeForHandle(this), this.id, direction);
  }

  /**
   * Resize this window, by a direction, to a size, or to what its clients allow.
   *
   * Under tmux's default `window-size` a window tracks its attached clients,
   * which will overwrite this the next time they change; `window-size manual`
   * is what makes a size of your own stick.
   *
   * ```ts
   * await window.resize({ height: 30, width: 100 });
   * ```
   */
  resize(options: ResizeWindowOptions): Promise<void> {
    return resizeWindow(runtimeForHandle(this), this.id, options);
  }

  /**
   * Restart the command running in this window's active pane.
   *
   * tmux refuses a window that is still running something unless `kill` says
   * to replace it.
   *
   * ```ts
   * await window.respawn("sh", { kill: true });
   * ```
   */
  respawn(command?: string, options?: RespawnOptions): Promise<void> {
    return respawnWindow(runtimeForHandle(this), this.id, command, options);
  }

  /**
   * Destroy this window, unlinking it from every session it is in.
   *
   * ```ts
   * await window.kill();
   * ```
   */
  kill(): Promise<void> {
    return killTarget(runtimeForHandle(this), "kill-window", this.id);
  }

  /**
   * Rename this window.
   *
   * ```ts
   * await window.rename("editor");
   * ```
   */
  rename(name: string): Promise<void> {
    return renameWindow(runtimeForHandle(this), this.id, name);
  }

  /**
   * Move this window to another session or index without selecting it.
   *
   * Moves this placement. Sessions that are grouped share one window list, so
   * moving a window they share moves it in all of them; sessions that merely
   * link the same window keep their own lists, and only this one moves.
   *
   * ```ts
   * await window.move({ index: 3 });
   * ```
   */
  move(options: MoveWindowOptions = {}): Promise<void> {
    return moveWindow(runtimeForHandle(this), placementTarget(this), inThisSession(this, options));
  }

  /**
   * Link this window into another session, giving it a second placement.
   *
   * ```ts
   * await window.link({ session: "other" });
   * ```
   */
  link(options: MoveWindowOptions): Promise<void> {
    return linkWindow(runtimeForHandle(this), this.id, inThisSession(this, options));
  }

  /**
   * Remove this placement, leaving the window's other placements intact.
   *
   * For a window linked into several sessions. A window shared because its
   * sessions are grouped is not linked, and tmux refuses with "window only
   * linked to one session" — a group member leaves by being killed, not by
   * unlinking.
   *
   * ```ts
   * const destination = await server.newSession({ name: "unlink-example" });
   * await window.link({ session: destination.id });
   * const placement = (await server.snapshot()).windows.one({
   *   id: window.id,
   *   session: { is: { id: destination.id } },
   * });
   * await placement.unlink();
   * ```
   */
  unlink(): Promise<void> {
    return unlinkWindow(runtimeForHandle(this), placementTarget(this));
  }

  /**
   * Remove this placement, destroying an unshared window but refusing a group.
   *
   * ```ts
   * await window.removePlacement();
   * ```
   */
  removePlacement(): Promise<void> {
    return removeWindowPlacement(runtimeForHandle(this), placementTarget(this));
  }

  /**
   * Exchange positions with another window.
   *
   * ```ts
   * await window.swapWith(other);
   * ```
   */
  swapWith(other: Window): Promise<void> {
    return swapWindows(runtimeForHandle(this), placementTarget(this), placementTarget(other));
  }

  /**
   * Apply a named or custom layout.
   *
   * ```ts
   * await window.selectLayout("even-horizontal");
   * ```
   */
  selectLayout(layout: string): Promise<void> {
    return selectLayout(runtimeForHandle(this), this.id, layout);
  }

  /**
   * Make this window active in its session.
   *
   * ```ts
   * await window.select();
   * ```
   */
  select(): Promise<void> {
    return selectTarget(runtimeForHandle(this), "select-window", placementTarget(this));
  }

  /**
   * This window placement, read again at a new instant.
   *
   * The placement is kept, not just the window: a window linked into a session
   * at two indexes has two placements, and this one stays the one it was.
   * Refusing rather than silently retargeting is why the index is part of what
   * is matched.
   *
   * ```ts
   * const later = await window.refreshed();
   * later.panes.count();
   * ```
   */
  refreshed(): Promise<Window> {
    return refreshedHandle(this, runtimeForHandle(this));
  }

  /**
   * Run a tmux command this package does not model, addressed at this window.
   *
   * ```ts
   * await window.cmd("rotate-window");
   * ```
   *
   * The window's id is sent as the target; pass `target` to address something
   * else, or `null` for a command that takes none — `display-panes` takes a
   * client, so it wants `{ target: null }` and not this window's `@n`.
   */
  cmd(
    command: string,
    args: readonly string[] = [],
    options?: CmdOptions,
  ): Promise<readonly string[]> {
    return runRawCommand(runtimeForHandle(this), this.id, command, args, options);
  }

  /**
   * Whether `other` is this same window on this same server.
   *
   * The socket, the daemon that answered, and `@n` all have to match: tmux ids
   * are unique only within one running daemon, and a restart reissues them. Two
   * placements of one linked window are the same window, so this is true for
   * both. {@link sameTmuxIdAs} asks the weaker question.
   *
   * ```ts
   * window.equals(await window.refreshed()); // true
   * ```
   */
  equals(other: unknown): boolean {
    return liveHandlesEqual(this, other);
  }

  /**
   * Whether `other` carries the same `@n`, wherever it came from.
   *
   * ```ts
   * window.sameTmuxIdAs(other);
   * ```
   */
  sameTmuxIdAs(other: Window): boolean {
    return liveHandlesShareTmuxId(this, other);
  }
}

type WindowRow = RowWithIdentities<"session_id" | "window_id" | "window_index">;

export interface Window extends AliasedFields<WindowRow, WindowAliasMap> {
  /**
   * How this handle renders in a log line, a template literal, or an error.
   *
   * Installed with the rest of the live-handle prototype, and declared here so
   * the emitted types advertise it and a caller's own lint does not report the
   * default `[object Object]`.
   */
  toString(): string;
  /** The raw tmux format row, addressed by tmux's own token names. */
  readonly format: WindowRow;
}

installLiveHandlePrototype(Window.prototype, WINDOW_ALIASES);
