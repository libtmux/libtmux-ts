import { runRawCommand } from "./_internal/operations/raw.js";
import type {
  CaptureOptions,
  ChooseTreeOptions,
  CmdOptions,
  CommandWaitOptions,
  JoinOptions,
  MenuItem,
  PopupOptions,
  ProgramExit,
  ProgramWaitOptions,
  ResizeOptions,
  RespawnOptions,
  SendKeysOptions,
  SetHookOptions,
  SetOptionOptions,
  PlannedOperation,
  SplitOptions,
} from "./types.js";
import type { CommandOptions } from "./common.js";
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
import {
  killPaneIfWindowUnshared,
  killTarget,
  splitWindow,
} from "./_internal/operations/mutations.js";
import { setHook, showHooks, unsetHook } from "./_internal/operations/hooks.js";
import { capturePane, clearHistory, pipePane, sendKeys } from "./_internal/operations/pane_io.js";
import {
  waitForPaneCommand,
  waitForPaneExit,
  waitForPaneText,
} from "./_internal/operations/pane_wait.js";
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
  unzoomTarget,
  zoomPane,
  swapPanes,
} from "./_internal/operations/topology.js";
import { planKill, planKillPaneIfUnshared, planSplitWindow } from "./_internal/operations/plans.js";
import { refreshedHandle } from "./_internal/operations/refreshed.js";
import { originGraphForHandle } from "./_internal/runtime/live_handle.js";
import type { Session } from "./session.js";
import type { Window } from "./window.js";
import {
  installLiveHandlePrototype,
  liveHandlesEqual,
  liveHandlesShareTmuxId,
  requireSameServer,
  runtimeForHandle,
  targetOf,
} from "./_internal/runtime/live_handle.js";
import type { Server } from "./server.js";

/** What {@link Pane.plan} offers, one entry per mutation it can describe. */
export interface PanePlans {
  readonly kill: () => PlannedOperation<void>;
  readonly killIfWindowUnshared: () => PlannedOperation<void>;
  /** @throws TypeError when `options` combines `direction` with `vertical`. */
  readonly split: (options?: SplitOptions) => PlannedOperation<Pane>;
}

/**
 * One pane on one tmux server, as a handle rather than a copy of it.
 *
 * Reached from {@link Window.panes}, {@link Session.activePane} or a split;
 * the constructor throws. The tmux format row the handle was built from reads
 * back through {@link Pane.format}, and by tmux's own field names directly on
 * the handle. Those values are a snapshot taken when the handle was made and
 * do not follow the pane — {@link Pane.refreshed} takes a new one.
 *
 * Identity is the socket, the daemon that answered on it, and `%n` together,
 * because a restarted server issues `%0` again to a different pane.
 * {@link Pane.equals} asks that question; {@link Pane.sameTmuxIdAs} asks the
 * weaker one.
 */
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

  /**
   * Read hooks set on this pane itself.
   *
   * ```ts
   * const hooks = await pane.showHooks();
   * hooks.get("pane-title-changed")?.[0];
   * ```
   */
  showHooks(): Promise<ReadonlyMap<string, readonly string[]>> {
    return showHooks(runtimeForHandle(this), "pane", this.id);
  }

  /**
   * Bind a tmux command to a pane-scoped hook.
   *
   * ```ts
   * await pane.setHook("pane-title-changed", "display-message 'title changed'");
   * ```
   */
  setHook(name: string, command: string, options?: SetHookOptions): Promise<void> {
    return setHook(runtimeForHandle(this), "pane", this.id, name, command, options);
  }

  /**
   * Remove every command bound to a pane-scoped hook.
   *
   * ```ts
   * await pane.unsetHook("pane-title-changed");
   * ```
   */
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
  showOptions(options?: CommandOptions): Promise<ReadonlyMap<string, string>> {
    return showOptions(runtimeForHandle(this), "pane", this.id, options);
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
  showResolvedOptions(options?: CommandOptions): Promise<ReadonlyMap<string, string>> {
    return showResolvedOptions(runtimeForHandle(this), "pane", this.id, options);
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
   * import { PaneDirection } from "libtmux";
   * const created = await pane.split({ direction: PaneDirection.Below });
   * created.id;
   * ```
   *
   * @throws TypeError when `options` combines `direction` with `vertical`.
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
   * Destroy this pane only if its window has one placement.
   *
   * ```ts
   * await pane.killIfWindowUnshared();
   * ```
   */
  killIfWindowUnshared(): Promise<void> {
    return killPaneIfWindowUnshared(runtimeForHandle(this), this.id);
  }

  /**
   * The same mutations, described instead of run.
   *
   * Takes what the direct calls take and resolves to what they resolve to,
   * for {@link Server.batch} to share one final snapshot.
   *
   * ```ts
   * const [created] = await server.batch([pane.plan.split({})]);
   * created.id;
   * ```
   */
  get plan(): PanePlans {
    return {
      kill: () => planKill("kill-pane", this.id),
      killIfWindowUnshared: () => planKillPaneIfUnshared(this.id),
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
   * Save this complete program as `capture.ts`. With Bun 1.4.2 or newer,
   * tmux 3.3a or newer, and `libtmux` installed, run `bun run capture.ts`.
   * It creates and stops a private tmux server. A failed operation or cleanup
   * exits with an error; a cleanup error names the retained socket directory.
   *
   * ```ts
   * import { mkdtemp, readdir, rm } from "node:fs/promises";
   * import { tmpdir } from "node:os";
   * import { join } from "node:path";
   * import { setTimeout as delay } from "node:timers/promises";
   * import { Server } from "libtmux";
   *
   * const directory = await mkdtemp(join(tmpdir(), "ltx-capture-"));
   * const server = new Server({
   *   socketPath: join(directory, "tmux.sock"),
   *   configFile: "/dev/null",
   *   timeoutMs: 5_000,
   * });
   * const failures: unknown[] = [];
   * try {
   *   const signal = AbortSignal.timeout(5_000);
   *   const session = await server.newSession({
   *     name: "capture",
   *     shellCommand: "sh",
   *     signal,
   *     environment: { ENV: "/dev/null" },
   *   });
   *   const pane = session.activePane;
   *   if (!pane) throw new Error("The session has no active pane");
   *   await pane.sendKeys("printf '\\nlibtmux capture ready\\n'", { signal });
   *   for (;;) {
   *     const lines = await pane.capture({ signal });
   *     const line = lines.find((line) => line === "libtmux capture ready");
   *     if (line !== undefined) {
   *       console.log(line);
   *       break;
   *     }
   *     await delay(20, undefined, { signal });
   *   }
   * } catch (error) {
   *   failures.push(error);
   * } finally {
   *   try {
   *     if ((await readdir(directory)).includes("tmux.sock")) await server.kill();
   *     await rm(directory, { recursive: true });
   *   } catch (error) {
   *     failures.push(new Error(`Cleanup failed; inspect ${directory}`, { cause: error }));
   *   }
   * }
   * if (failures.length > 0) throw new AggregateError(failures, "Capture failed");
   * ```
   */
  capture(options?: CaptureOptions): Promise<readonly string[]> {
    return capturePane(runtimeForHandle(this), this.id, options);
  }

  /**
   * Resolve with how this pane's program ended, whoever started it.
   *
   * At once for a pane already dead under `remain-on-exit`; otherwise when
   * tmux reports the exit, with the status a closing pane takes with it.
   * A signal that ended the pane's process shows as `signalCode` with `exitCode`
   * null.
   * Giving up leaves the program running: a timeout throws
   * {@link WaitTimeoutError} and an abort throws {@link TmuxTransportError} of
   * kind `cancelled`; with neither it waits as long as the program runs. A
   * pane killed from outside, which fires no event, raises
   * {@link ObjectNotFoundError} within about two seconds of the kill. A read every
   * second notices the pane gone, and the wait gives the event a closing pane
   * fires up to a second to arrive.
   *
   * Requires tmux 3.8 or newer.
   *
   * ```ts
   * const build = await window.split({ shellCommand: "sleep 1; exit 3" });
   * const exit = await build.waitForExit({ timeoutMs: 10_000 });
   * exit.exitCode; // 3
   * ```
   */
  waitForExit(options?: ProgramWaitOptions): Promise<ProgramExit> {
    return waitForPaneExit(runtimeForHandle(this), this.id, options);
  }

  /**
   * Resolve with the exit status of the next command this pane's shell
   * finishes.
   *
   * Needs a shell that marks each command's end with OSC 133 (`ESC ] 133 ; D ;
   * status`) from its prompt; tmux turns the mark into a
   * `pane-command-finished` event. `send` types a command line once the wait
   * is listening, so a command that ends at once is not missed. A shell's
   * first prompt marks an end too, before any command ran, so a wait armed
   * while the shell starts can resolve with 0. A shell without the marks never
   * resolves this: give it a `timeoutMs`, whose {@link WaitTimeoutError} names
   * the marks as the likely cause. A pane whose program has exited
   * rejects with {@link LibTmuxError}. The mark carries a status alone; what
   * the command printed is on the pane, for {@link Pane.capture}.
   *
   * Requires tmux 3.8 or newer.
   *
   * ```ts
   * const status = await pane.waitForCommand({ send: "make test", timeoutMs: 600_000 });
   * status; // 0 when the tests passed
   * ```
   */
  waitForCommand(options?: CommandWaitOptions): Promise<number> {
    return waitForPaneCommand(runtimeForHandle(this), this.id, options);
  }

  /**
   * Resolve with the first line of this pane's screen that `pattern` matches:
   * a substring, or a regular expression tested against each line. A line the
   * pane's width wrapped is one line here, matched and returned whole, so the
   * result can be wider than the pane.
   *
   * The screen is read at once, then again each time tmux reports that the
   * pane printed, at most every 50 ms, and once a second besides. Use it to
   * wait for a prompt, or for a full-screen program's first screen before
   * typing into it. Giving up leaves the pane as it was: a timeout throws
   * {@link WaitTimeoutError} and an abort throws {@link TmuxTransportError}
   * of kind `cancelled`. A pane whose program has exited without the text
   * rejects with {@link LibTmuxError}, and a pane that is gone, or goes during
   * the wait, with {@link ObjectNotFoundError}.
   *
   * Requires tmux 3.8 or newer.
   *
   * ```ts
   * await using top = await server.spawn(["sh", "-c", "echo ready; exec cat"]);
   * await top.pane.waitForText("ready", { timeoutMs: 10_000 }); // "ready"
   * ```
   */
  waitForText(pattern: string | RegExp, options?: ProgramWaitOptions): Promise<string> {
    return waitForPaneText(runtimeForHandle(this), this.id, pattern, options);
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
   * Unzooms the window first, so a resize on a zoomed window restores the
   * layout as well as applying the size.
   *
   * ```ts
   * await pane.resize({ height: 20 });
   * ```
   */
  resize(options: ResizeOptions): Promise<void> {
    return resizePane(runtimeForHandle(this), this.id, options);
  }

  /**
   * Make this pane fill its window, whatever it was doing before.
   *
   * Idempotent, and one tmux command: tmux offers only a toggle, so this asks
   * tmux to evaluate `#{window_zoomed_flag}` and toggle in the same
   * invocation rather than reading the flag here and racing the answer.
   * `window.zoomedFlag` reports the state a snapshot saw.
   *
   * ```ts
   * await pane.zoom();
   * ```
   */
  zoom(options?: CommandOptions): Promise<void> {
    return zoomPane(runtimeForHandle(this), this.id, options);
  }

  /**
   * Restore this pane's window to its layout, whatever it was doing before.
   *
   * Idempotent in the same way {@link Pane.zoom} is, and unzooms the window
   * even when a different pane in it is the zoomed one.
   *
   * ```ts
   * await pane.unzoom();
   * ```
   */
  unzoom(options?: CommandOptions): Promise<void> {
    return unzoomTarget(runtimeForHandle(this), this.id, options);
  }

  /**
   * Exchange positions with another pane.
   *
   * ```ts
   * await pane.swapWith(otherPane);
   * ```
   */
  swapWith(other: Pane): Promise<void> {
    requireSameServer(this, other, "swapWith");
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
   * On tmux 3.7 exactly, a break with no name crashes the server, so a
   * `breakOut()` without a `windowName` is refused there before anything is sent.
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
   * import { PaneDirection } from "libtmux";
   * await pane.joinTo(window.id, { direction: PaneDirection.Below });
   * ```
   */
  joinTo(target: Pane | Window | string, options?: JoinOptions): Promise<void> {
    return joinPane(runtimeForHandle(this), this.id, targetOf(this, target, "joinTo"), options);
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
   * The promise resolves once the chooser is on screen, not once someone
   * has chosen: tmux answers this command as soon as it opens the mode.
   * Bind a tmux command to the selection to act on what was picked.
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
   * The promise resolves once the chooser is on screen, not once someone
   * has chosen: tmux answers this command as soon as it opens the mode.
   * Bind a tmux command to the selection to act on what was picked.
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
   * The promise resolves once the mode is on screen, not once someone has
   * chosen: tmux answers this command as soon as it opens the mode. Bind a
   * tmux command to the selection to act on what was picked.
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
   * The promise resolves once the mode is on screen, not once someone has
   * chosen: tmux answers this command as soon as it opens the mode. Bind a
   * tmux command to the selection to act on what was picked.
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

/**
 * The tmux format fields a pane handle is built from, by tmux's own names.
 *
 * Read through `format` when the aliased property names on the handle are not
 * what a caller wants — a field tmux added in a later version has a token
 * here whether or not this library has given it a name.
 */
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
