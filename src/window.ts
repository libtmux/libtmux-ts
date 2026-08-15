import type { CmdOptions, PlannedOperation } from "./types.js";
import { runRawCommand } from "./_internal/operations/raw.js";
import type { SetOptionOptions } from "./types.js";
import type {
  MoveWindowOptions,
  ResizeWindowOptions,
  RespawnOptions,
  SplitOptions,
} from "./types.js";
import { WINDOW_ALIASES, type WindowAliasMap } from "./_generated/field_aliases.js";
import type { AliasedFields, RowWithIdentities } from "./_internal/codec/schemas.js";
import {
  linkedSessionsOfWindow,
  panesOfPlacement,
  sessionOf,
} from "./_internal/operations/relations.js";
import { killTarget, splitWindow } from "./_internal/operations/mutations.js";
import { planKill, planSplitWindow } from "./_internal/operations/plans.js";
import { setOption, showOptions, unsetOption } from "./_internal/operations/options.js";
import {
  linkWindow,
  cycleLayout,
  moveWindow,
  renameWindow,
  resizeWindow,
  rotateWindow,
  selectLayout,
  selectTarget,
  swapWindows,
  unlinkWindow,
} from "./_internal/operations/topology.js";
import { respawnWindow } from "./_internal/operations/shell.js";
import { runtimeForServer } from "./_internal/runtime/context.js";
import { refreshHandle } from "./_internal/operations/refresh.js";
import { originGraphForHandle } from "./_internal/runtime/live_handle.js";
import type { Pane } from "./pane.js";
import type { Selection } from "./selection.js";
import type { Session } from "./session.js";
import { installLiveHandlePrototype, liveHandlesEqual } from "./_internal/runtime/live_handle.js";
import type { Server } from "./server.js";

/** What {@link Window.plan} offers, one entry per mutation it can describe. */
export interface WindowPlans {
  readonly kill: () => PlannedOperation<void>;
  readonly split: (options?: SplitOptions) => PlannedOperation<Pane>;
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
    return sessionOf(originGraphForHandle(this), this.sessionId);
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
   * Every option this window currently sees, including inherited values.
   *
   * ```ts
   * const options = await window.showOptions();
   * options.get("automatic-rename");
   * ```
   */
  showOptions(): Promise<ReadonlyMap<string, string>> {
    return showOptions(runtimeForServer(this.server), "window", this.id);
  }

  /**
   * Set an option on this window.
   *
   * ```ts
   * await window.setOption("automatic-rename", "off");
   * ```
   */
  setOption(name: string, value: string, options?: SetOptionOptions): Promise<void> {
    return setOption(runtimeForServer(this.server), "window", this.id, name, value, options);
  }

  /**
   * Remove an option from this window.
   *
   * ```ts
   * await window.unsetOption("automatic-rename");
   * ```
   */
  unsetOption(name: string): Promise<void> {
    return unsetOption(runtimeForServer(this.server), "window", this.id, name);
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
    return splitWindow(this.server, runtimeForServer(this.server), this.id, options);
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
    return cycleLayout(runtimeForServer(this.server), this.id, "next");
  }

  /**
   * Apply this window's previous layout preset.
   *
   * ```ts
   * await window.previousLayout();
   * ```
   */
  previousLayout(): Promise<void> {
    return cycleLayout(runtimeForServer(this.server), this.id, "previous");
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
    return rotateWindow(runtimeForServer(this.server), this.id, direction);
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
    return resizeWindow(runtimeForServer(this.server), this.id, options);
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
    return respawnWindow(runtimeForServer(this.server), this.id, command, options);
  }

  /**
   * Destroy this window, unlinking it from every session it is in.
   *
   * ```ts
   * await window.kill();
   * ```
   */
  kill(): Promise<void> {
    return killTarget(runtimeForServer(this.server), "kill-window", this.id);
  }

  /**
   * Rename this window.
   *
   * ```ts
   * await window.rename("editor");
   * ```
   */
  rename(name: string): Promise<void> {
    return renameWindow(runtimeForServer(this.server), this.id, name);
  }

  /**
   * Move this window to another session or index without selecting it.
   *
   * ```ts
   * await window.move({ index: 3 });
   * ```
   */
  move(options?: MoveWindowOptions): Promise<void> {
    return moveWindow(runtimeForServer(this.server), this.id, options);
  }

  /**
   * Link this window into another session, giving it a second placement.
   *
   * ```ts
   * await window.link({ session: "other-session" });
   * ```
   */
  link(options: MoveWindowOptions): Promise<void> {
    return linkWindow(runtimeForServer(this.server), this.id, options);
  }

  /**
   * Remove this placement, leaving the window's other placements intact.
   *
   * ```ts
   * await window.unlink();
   * ```
   */
  unlink(): Promise<void> {
    return unlinkWindow(runtimeForServer(this.server), this.id);
  }

  /**
   * Exchange positions with another window.
   *
   * ```ts
   * await window.swapWith(other);
   * ```
   */
  swapWith(other: Window): Promise<void> {
    return swapWindows(runtimeForServer(this.server), this.id, other.id);
  }

  /**
   * Apply a named or custom layout.
   *
   * ```ts
   * await window.selectLayout("even-horizontal");
   * ```
   */
  selectLayout(layout: string): Promise<void> {
    return selectLayout(runtimeForServer(this.server), this.id, layout);
  }

  /**
   * Make this window active in its session.
   *
   * ```ts
   * await window.select();
   * ```
   */
  select(): Promise<void> {
    return selectTarget(runtimeForServer(this.server), "select-window", this.id);
  }

  /**
   * Re-read this window placement at the current instant, in place.
   *
   * ```ts
   * await window.refresh();
   * window.panes.count(); // re-read
   * ```
   */
  refresh(): Promise<void> {
    return refreshHandle(this, runtimeForServer(this.server));
  }

  /**
   * Run a tmux command this package does not model, addressed at this window.
   *
   * ```ts
   * await window.cmd("display-panes");
   * ```
   *
   * The window's id is sent as the target; pass `target` to address something
   * else, or `null` for a command that takes none.
   */
  cmd(
    command: string,
    args: readonly string[] = [],
    options?: CmdOptions,
  ): Promise<readonly string[]> {
    return runRawCommand(runtimeForServer(this.server), this.id, command, args, options);
  }

  equals(other: unknown): boolean {
    return liveHandlesEqual(this, other);
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
