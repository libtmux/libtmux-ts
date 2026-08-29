import { runRawCommand } from "./_internal/operations/raw.js";
import type {
  CaptureOptions,
  ChooseTreeOptions,
  CmdOptions,
  JoinOptions,
  MenuItem,
  PopupOptions,
  ResizeOptions,
  RespawnOptions,
  SendKeysOptions,
  SetHookOptions,
  SetOptionOptions,
  PlannedOperation,
  SplitOptions,
} from "./types.js";
import { PANE_ALIASES } from "./_generated/field_aliases.js";
import type { AliasedFields, PaneAliasMap, RowWithIdentities } from "./field_types.js";
import {
  chooseBuffer,
  chooseTree,
  customizeMode,
  displayMenu,
  displayPopup,
  findWindow,
  sendPrefix,
} from "./_internal/operations/interactive.js";
import { sessionOf, windowOfPlacement } from "./_internal/operations/relations.js";
import { killTarget, splitWindow } from "./_internal/operations/mutations.js";
import { setHook, showHooks, unsetHook } from "./_internal/operations/hooks.js";
import { capturePane, clearHistory, pipePane, sendKeys } from "./_internal/operations/pane_io.js";
import {
  setOption,
  showOptions,
  showResolvedOptions,
  unsetOption,
} from "./_internal/operations/options.js";
import {
  breakPane,
  displayMessage,
  joinPane,
  respawnPane,
  setCopyMode,
} from "./_internal/operations/shell.js";
import {
  pasteBuffer,
  resizePane,
  selectTarget,
  setPaneTitle,
  swapPanes,
} from "./_internal/operations/topology.js";
import { planKill, planSplitWindow } from "./_internal/operations/plans.js";
import { refreshedHandle } from "./_internal/operations/refreshed.js";
import { originGraphForHandle } from "./_internal/runtime/live_handle.js";
import type { Session } from "./session.js";
import type { Window } from "./window.js";
import {
  installLiveHandlePrototype,
  liveHandlesEqual,
  liveHandlesShareTmuxId,
  runtimeForHandle,
} from "./_internal/runtime/live_handle.js";
import type { Server } from "./server.js";

/** What {@link Pane.plan} offers, one entry per mutation it can describe. */
export interface PanePlans {
  readonly kill: () => PlannedOperation<void>;
  readonly split: (options?: SplitOptions) => PlannedOperation<Pane>;
}

// eslint-disable-next-line typescript/no-unsafe-declaration-merging -- CompleteFormatRow declaration merging exposes the frozen scalar snapshot on the nominal handle.
export class Pane {
  declare private readonly paneBrand: undefined;
  /**
   * The server this pane belongs to.
   *
   * ```ts
   * pane.server.socketPath;
   * ```
   */
  declare readonly server: Server;

  private constructor() {
    throw new Error("Pane cannot be constructed directly");
  }

  /**
   * The window placement containing this pane.
   *
   * ```ts
   * pane.window?.name;
   * ```
   */
  get window(): Window | undefined {
    return windowOfPlacement(originGraphForHandle(this), this);
  }

  /**
   * The session containing this pane.
   *
   * ```ts
   * pane.session?.name;
   * ```
   */
  get session(): Session | undefined {
    return sessionOf(originGraphForHandle(this), this.format.session_id);
  }

  /** Read hooks set on this pane itself. */
  showHooks(): Promise<ReadonlyMap<string, readonly string[]>> {
    return showHooks(runtimeForHandle(this), "pane", this.id);
  }

  /** Bind a tmux command to a pane-scoped hook. */
  setHook(name: string, command: string, options?: SetHookOptions): Promise<void> {
    return setHook(runtimeForHandle(this), "pane", this.id, name, command, options);
  }

  /** Remove every command bound to a pane-scoped hook. */
  unsetHook(name: string): Promise<void> {
    return unsetHook(runtimeForHandle(this), "pane", this.id, name);
  }

  /**
   * Every option set on this pane itself, not the ones it inherits.
   *
   * A fresh pane usually has none, so an empty map here means nothing was
   * set on this pane — not that the option has no value. `showResolvedOptions`
   * answers what actually governs it.
   *
   * ```ts
   * const options = await pane.showOptions();
   * options.get("remain-on-exit");
   * ```
   */
  showOptions(): Promise<ReadonlyMap<string, string>> {
    return showOptions(runtimeForHandle(this), "pane", this.id);
  }

  /**
   * The option values that govern this pane, own and inherited together.
   *
   * `showOptions` reports only what was set here, which for a fresh pane is
   * often nothing. This resolves what it inherits as well, so an option has an
   * answer wherever it was actually set.
   *
   * ```ts
   * (await pane.showResolvedOptions()).get("allow-rename");
   * ```
   */
  showResolvedOptions(): Promise<ReadonlyMap<string, string>> {
    return showResolvedOptions(runtimeForHandle(this), "pane", this.id);
  }

  /**
   * Set an option on this pane.
   *
   * ```ts
   * await pane.setOption("remain-on-exit", "on");
   * ```
   */
  setOption(name: string, value: string, options?: SetOptionOptions): Promise<void> {
    return setOption(runtimeForHandle(this), "pane", this.id, name, value, options);
  }

  /**
   * Remove an option from this pane.
   *
   * ```ts
   * await pane.unsetOption("remain-on-exit");
   * ```
   */
  unsetOption(name: string): Promise<void> {
    return unsetOption(runtimeForHandle(this), "pane", this.id, name);
  }

  /**
   * Split this pane and resolve the created pane.
   *
   * ```ts
   * const created = await pane.split({ vertical: true });
   * created.id;
   * ```
   */
  split(options?: SplitOptions): Promise<Pane> {
    return splitWindow(this.server, runtimeForHandle(this), this.id, options);
  }

  /**
   * Destroy this pane.
   *
   * ```ts
   * await pane.kill();
   * ```
   */
  kill(): Promise<void> {
    return killTarget(runtimeForHandle(this), "kill-pane", this.id);
  }

  /**
   * The same mutations, described instead of run.
   *
   * Takes what the direct calls take and resolves to what they resolve to,
   * for {@link Server.batch} to spend one invocation and one snapshot on.
   *
   * ```ts
   * const [created] = await server.batch([pane.plan.split({})]);
   * created.id;
   * ```
   */
  get plan(): PanePlans {
    return {
      kill: () => planKill("kill-pane", this.id),
      split: (options?: SplitOptions) => planSplitWindow(this.id, options),
    };
  }

  /**
   * Send keys to this pane, following them with Enter unless told not to.
   *
   * ```ts
   * await pane.sendKeys("echo hello");
   * await pane.sendKeys("C-c", { literal: false });
   * ```
   */
  sendKeys(keys: string, options?: SendKeysOptions): Promise<void> {
    return sendKeys(runtimeForHandle(this), this.id, keys, options);
  }

  /**
   * Capture this pane's contents as lines.
   *
   * ```ts
   * const lines = await pane.capture();
   * lines.at(-1);
   * ```
   */
  capture(options?: CaptureOptions): Promise<readonly string[]> {
    return capturePane(runtimeForHandle(this), this.id, options);
  }

  /**
   * Discard this pane's scrollback history.
   *
   * ```ts
   * await pane.clearHistory();
   * ```
   */
  clearHistory(): Promise<void> {
    return clearHistory(runtimeForHandle(this), this.id);
  }

  /**
   * Resize this pane; tmux ignores a dimension its layout cannot honour.
   *
   * ```ts
   * await pane.resize({ height: 20 });
   * ```
   */
  resize(options: ResizeOptions): Promise<void> {
    return resizePane(runtimeForHandle(this), this.id, options);
  }

  /**
   * Exchange positions with another pane.
   *
   * ```ts
   * await pane.swapWith(otherPane);
   * ```
   */
  swapWith(other: Pane): Promise<void> {
    return swapPanes(runtimeForHandle(this), this.id, other.id);
  }

  /**
   * Make this pane active in its window.
   *
   * ```ts
   * await pane.select();
   * ```
   */
  select(): Promise<void> {
    return selectTarget(runtimeForHandle(this), "select-pane", this.id);
  }

  /**
   * Set this pane's title.
   *
   * The title is what `#{pane_title}` reports and what a `pane-border-format`
   * draws; a program running in the pane can also set it through the terminal,
   * so it is not solely the caller's to own.
   *
   * ```ts
   * await pane.setTitle("build");
   * ```
   */
  setTitle(title: string): Promise<void> {
    return setPaneTitle(runtimeForHandle(this), this.id, title);
  }

  /**
   * Paste a named buffer into this pane, as if it were typed.
   *
   * The program running in the pane sees ordinary input, so a shell runs what
   * arrives. {@link Server.loadBuffer} fills the buffer beforehand.
   *
   * ```ts
   * await pane.pasteBuffer("greeting");
   * ```
   */
  pasteBuffer(name: string): Promise<void> {
    return pasteBuffer(runtimeForHandle(this), this.id, name);
  }

  /**
   * This pane, read again at a new instant.
   *
   * ```ts
   * const later = await pane.refreshed();
   * later.currentCommand;
   * ```
   */
  refreshed(): Promise<Pane> {
    return refreshedHandle(this, runtimeForHandle(this));
  }

  /**
   * Expand a tmux format string against this pane.
   *
   * ```ts
   * const shown = await pane.displayMessage("#{pane_index}");
   * shown[0];
   * ```
   */
  displayMessage(message: string): Promise<readonly string[]> {
    return displayMessage(runtimeForHandle(this), message, this.id);
  }

  /**
   * Restart this pane's command in place.
   *
   * ```ts
   * await pane.respawn("htop", { kill: true });
   * ```
   */
  respawn(command?: string, options?: RespawnOptions): Promise<void> {
    return respawnPane(runtimeForHandle(this), this.id, command, options);
  }

  /**
   * Send everything this pane writes to a shell command as well as its screen.
   *
   * A pane keeps `history-limit` lines and a stream reader keeps a bounded
   * buffer, so output larger than either is gone before anything asks for it.
   * The command runs for as long as the pipe is open, which is how a long
   * build is captured whole. Pass no command to stop one.
   *
   * ```ts
   * await pane.pipeTo("cat >> /tmp/build.log");
   * ```
   */
  pipeTo(command?: string, options?: { readonly toggle?: boolean }): Promise<void> {
    return pipePane(runtimeForHandle(this), this.id, command, options);
  }

  /**
   * Move this pane out into a window of its own, in the session it is in.
   *
   * tmux places a break with no destination in whichever session is current,
   * which is the attached one rather than this pane's.
   *
   * ```ts
   * await pane.breakOut("extracted");
   * ```
   */
  breakOut(windowName?: string): Promise<void> {
    return breakPane(runtimeForHandle(this), this.id, windowName, this.format.session_id);
  }

  /**
   * Move this pane into another window as a split.
   *
   * ```ts
   * await pane.joinTo(window.id, { vertical: true });
   * ```
   */
  joinTo(target: string, options?: JoinOptions): Promise<void> {
    return joinPane(runtimeForHandle(this), this.id, target, options);
  }

  /**
   * Enter this pane's copy mode.
   *
   * ```ts
   * await pane.enterCopyMode();
   * ```
   */
  enterCopyMode(): Promise<void> {
    return setCopyMode(runtimeForHandle(this), this.id, true);
  }

  /**
   * Leave this pane's copy mode.
   *
   * ```ts
   * await pane.exitCopyMode();
   * ```
   */
  exitCopyMode(): Promise<void> {
    return setCopyMode(runtimeForHandle(this), this.id, false);
  }

  /**
   * Open a popup over the client showing this pane.
   *
   * ```ts
   * await pane.displayPopup("htop", { width: "80%" });
   * ```
   */
  displayPopup(command?: string, options?: PopupOptions): Promise<void> {
    return displayPopup(runtimeForHandle(this), this.id, command, options);
  }

  /**
   * Show a menu over the client showing this pane.
   *
   * ```ts
   * await pane.displayMenu("Actions", [{ command: "kill-pane", key: "k", name: "Kill" }]);
   * ```
   */
  displayMenu(title: string, items: readonly MenuItem[]): Promise<void> {
    return displayMenu(runtimeForHandle(this), this.id, title, items);
  }

  /**
   * Open the interactive session and window chooser in this pane.
   *
   * tmux needs a client attached to the session to draw this. With none, it
   * does nothing and reports success, so a headless run is told it worked.
   *
   * ```ts
   * await pane.chooseTree({ sessionsOnly: true });
   * ```
   */
  chooseTree(options?: ChooseTreeOptions): Promise<void> {
    return chooseTree(runtimeForHandle(this), this.id, options);
  }

  /**
   * Open the interactive buffer chooser in this pane.
   *
   * tmux needs a client attached to the session to draw this. With none, it
   * does nothing and reports success, so a headless run is told it worked.
   *
   * ```ts
   * await pane.chooseBuffer();
   * ```
   */
  chooseBuffer(): Promise<void> {
    return chooseBuffer(runtimeForHandle(this), this.id);
  }

  /**
   * Search windows interactively from this pane.
   *
   * tmux needs a client attached to the session to draw this. With none, it
   * does nothing and reports success, so a headless run is told it worked.
   *
   * ```ts
   * await pane.findWindow("editor");
   * ```
   */
  findWindow(pattern: string): Promise<void> {
    return findWindow(runtimeForHandle(this), this.id, pattern);
  }

  /**
   * Send the configured prefix key to this pane.
   *
   * tmux needs a client attached to the session to draw this. With none, it
   * does nothing and reports success, so a headless run is told it worked.
   *
   * ```ts
   * await pane.sendPrefix();
   * ```
   */
  sendPrefix(): Promise<void> {
    return sendPrefix(runtimeForHandle(this), this.id);
  }

  /**
   * Open tmux's interactive option editor in this pane.
   *
   * tmux needs a client attached to the session to draw this. With none, it
   * does nothing and reports success, so a headless run is told it worked.
   *
   * ```ts
   * await pane.customizeMode();
   * ```
   */
  customizeMode(): Promise<void> {
    return customizeMode(runtimeForHandle(this), this.id);
  }

  /**
   * Run a tmux command this package does not model, addressed at this pane.
   *
   * ```ts
   * await pane.cmd("clock-mode");
   * ```
   *
   * The pane's id is sent as the target; pass `target` to address something
   * else, or `null` for a command that takes none.
   */
  cmd(
    command: string,
    args: readonly string[] = [],
    options?: CmdOptions,
  ): Promise<readonly string[]> {
    return runRawCommand(runtimeForHandle(this), this.id, command, args, options);
  }

  /**
   * Whether `other` is this same pane on this same server.
   *
   * The socket, the daemon that answered, and `%n` all have to match — a
   * restarted server issues `%0` again to an entirely different pane, so two
   * handles can agree on socket and id and still name different panes.
   * {@link sameTmuxIdAs} asks the weaker question.
   *
   * ```ts
   * pane.equals(await pane.refreshed()); // true
   * ```
   */
  equals(other: unknown): boolean {
    return liveHandlesEqual(this, other);
  }

  /**
   * Whether `other` carries the same `%n`, wherever it came from.
   *
   * ```ts
   * pane.sameTmuxIdAs(await pane.refreshed()); // true
   * ```
   */
  sameTmuxIdAs(other: Pane): boolean {
    return liveHandlesShareTmuxId(this, other);
  }
}

type PaneRow = RowWithIdentities<"pane_id" | "session_id" | "window_id" | "window_index">;

export interface Pane extends AliasedFields<PaneRow, PaneAliasMap> {
  /**
   * How this handle renders in a log line, a template literal, or an error.
   *
   * Installed with the rest of the live-handle prototype, and declared here so
   * the emitted types advertise it and a caller's own lint does not report the
   * default `[object Object]`.
   */
  toString(): string;
  /** The raw tmux format row, addressed by tmux's own token names. */
  readonly format: PaneRow;
}

installLiveHandlePrototype(Pane.prototype, PANE_ALIASES);
