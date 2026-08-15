import type { PaneDirection, ResizeAdjustmentDirection, WindowDirection } from "./constants.js";
import type { Client } from "./client.js";
import type { CommandOptions } from "./common.js";
import type { Server } from "./server.js";
import type { Pane } from "./pane.js";
import type { Selection } from "./selection.js";
import type { Session } from "./session.js";
import type { Window } from "./window.js";

/**
 * Option shapes for the public operations.
 *
 * These live beside the classes rather than beside the internal operations that
 * consume them, so emitted public declarations never name an internal module.
 * The dependency points inward: internals import these, not the reverse.
 */

/** An immutable view of the server at one instant. */
export interface ServerSnapshot {
  readonly clients: Selection<Client>;
  readonly panes: Selection<Pane>;
  readonly sessions: Selection<Session>;
  readonly windows: Selection<Window>;
}

export interface NewSessionOptions extends CommandOptions {
  readonly name?: string;
  /**
   * A command for tmux to run in place of the default shell.
   *
   * tmux hands this to a shell, so a whole command line works, and the process
   * replaces the shell rather than running inside it — when it exits the window
   * closes, unless `remain-on-exit` says otherwise.
   */
  readonly shellCommand?: string;
  readonly startDirectory?: string;
  readonly windowName?: string;
}

export interface NewWindowOptions extends CommandOptions {
  /**
   * Place the window before or after the session's current window.
   *
   * Relative to whichever window the session has selected, not to a window
   * named here — the command addresses the session, so that is the anchor tmux
   * measures from. Without this the window goes at the first free index.
   */
  readonly direction?: WindowDirection;
  readonly name?: string;
  /**
   * A command for tmux to run in place of the default shell.
   *
   * tmux hands this to a shell, so a whole command line works, and the process
   * replaces the shell rather than running inside it — when it exits the window
   * closes, unless `remain-on-exit` says otherwise.
   */
  readonly shellCommand?: string;
  readonly startDirectory?: string;
}

export interface SplitOptions extends CommandOptions {
  /**
   * Which side of this pane the new one takes.
   *
   * tmux splits below by default and offers no other way to say "above" or
   * "left" than pairing the axis with `-b`, so a boolean cannot express half of
   * the choices. When both this and `vertical` are given, this one decides.
   */
  readonly direction?: PaneDirection;
  readonly startDirectory?: string;
  /**
   * A command for tmux to run in place of the default shell.
   *
   * tmux hands this to a shell, so a whole command line works, and the process
   * replaces the shell rather than running inside it — when it exits the pane
   * closes, unless `remain-on-exit` says otherwise.
   */
  readonly shellCommand?: string;
  readonly vertical?: boolean;
}

export interface SendKeysOptions extends CommandOptions {
  /** Append Enter after the keys. Defaults to true. */
  readonly enter?: boolean;
  /** Send the string literally instead of letting tmux resolve key names. */
  readonly literal?: boolean;
}

/** Options for {@link Server.cmd} and the handle-level `cmd`. */
export interface CmdOptions extends CommandOptions {
  /**
   * Address a different target than the handle's own, or `null` for none.
   *
   * A handle sends its own id by default, so `pane.cmd("clock-mode")` addresses
   * that pane. A few tmux commands take no target and reject one.
   */
  readonly target?: string | null;
}

/** Options for joining a pane into another window. */
export interface JoinOptions extends CommandOptions {
  /** Join as a horizontal split rather than the default vertical one. */
  readonly vertical?: boolean;
}

/** Options for writing a tmux option. */
export interface SetOptionOptions extends CommandOptions {
  /** Append to the option's current value rather than replacing it. */
  readonly append?: boolean;
}

export interface CaptureOptions extends CommandOptions {
  /** Last line to capture; negative counts back from the visible bottom. */
  readonly end?: number;
  /** Join wrapped lines, matching tmux's `-J`. */
  readonly joinWrapped?: boolean;
  /** First line to capture; negative reaches into scrollback history. */
  readonly start?: number;
}

export interface MoveWindowOptions extends CommandOptions {
  /** Destination index; tmux picks the next free one when omitted. */
  readonly index?: number;
  /** Destination session; the window stays in its own session when omitted. */
  readonly session?: string;
}

export interface ResizeOptions extends CommandOptions {
  /**
   * Adjust by `amount` cells in this direction instead of setting a size.
   *
   * The relative form tmux offers as `-U`, `-D`, `-L`, and `-R`. Give it with
   * `amount`; `width` and `height` set an absolute size and are separate.
   */
  readonly direction?: ResizeAdjustmentDirection;
  /** How many cells to adjust by. Defaults to one. Needs `direction`. */
  readonly amount?: number;
  readonly height?: number;
  readonly width?: number;
}

export interface ResizeWindowOptions extends ResizeOptions {
  /**
   * Grow to the largest size its attached clients allow, tmux's `-A`.
   *
   * A window with no client attached has no size to grow to, so this leaves
   * it where it is rather than failing.
   */
  readonly largest?: boolean;
  /** Shrink to the smallest size its attached clients allow, tmux's `-a`. */
  readonly smallest?: boolean;
}

export interface RunShellOptions extends CommandOptions {
  /** Pane the command's `#{pane_*}` formats resolve against. */
  readonly target?: string | null;
}

export interface IfShellOptions extends CommandOptions {
  /** Command to run when the condition fails. */
  readonly otherwise?: string;
  /** Treat the condition as a tmux format rather than a shell command. */
  readonly format?: boolean;
  readonly target?: string | null;
}

export interface RespawnOptions extends CommandOptions {
  /** Replace a target that is still running rather than only a dead one. */
  readonly kill?: boolean;
  readonly startDirectory?: string;
  /**
   * Variables to set in the respawned process, tmux's `-e`.
   *
   * Each pair is passed as its own flag, so a value containing `=` arrives
   * whole rather than being split at the first one.
   */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface PopupOptions extends CommandOptions {
  readonly directory?: string;
  /** Close the popup when its command exits. */
  readonly closeOnExit?: boolean;
  readonly height?: string;
  readonly width?: string;
}

export interface MenuEntry {
  /** Single-character shortcut tmux binds to this entry. */
  readonly key: string;
  readonly command: string;
  readonly name: string;
}

/**
 * A menu entry, or a horizontal rule.
 *
 * tmux spells a separator as one empty argument rather than a name/key/command
 * triple, so modelling it as a distinct value keeps callers from fabricating
 * empty fields that tmux would reject.
 */
export type MenuItem = MenuEntry | "separator";

export interface ChooseTreeOptions extends CommandOptions {
  readonly sessionsOnly?: boolean;
  readonly windowsOnly?: boolean;
}

/** The tmux option scope a lookup is addressed to. */
export type OptionScope = "pane" | "server" | "session" | "window";

/** Hooks live at server or session scope. */
export type HookScope = "server" | "session";

/**
 * The tmux version a server is running.
 *
 * `raw` is tmux's own string, kept verbatim because a build can report things
 * like `master` or a vendor suffix that the parsed fields flatten.
 */
export interface TmuxVersion {
  readonly major: number;
  readonly minor: number;
  readonly raw: string;
  readonly suffix: string;
}

/** Environments live at server (global) or session scope, as hooks do. */
export type EnvironmentScope = "server" | "session";

/**
 * A variable's state in a tmux environment.
 *
 * `null` is tmux's `-NAME`: the variable is present and marked for removal from
 * the environment of any process tmux starts. Absent from the map is the third
 * state, and means tmux carries no entry at all.
 */
export type EnvironmentValue = string | null;

/** Options for writing a tmux environment variable. */
export interface SetEnvironmentOptions extends CommandOptions {
  /** Expand tmux format strings in the value, matching tmux's `-F`. */
  readonly expandFormat?: boolean;
  /** Keep the variable out of `show-environment` output, matching tmux's `-h`. */
  readonly hidden?: boolean;
}

/**
 * A relative direction, or any window target tmux accepts.
 *
 * The intersection keeps the three literals in autocomplete instead of letting
 * the bare `string` swallow them.
 */
export type WindowTarget = "last" | "next" | "previous" | (string & Record<never, never>);

/**
 * tmux control-mode notifications, parsed into a discriminated union.
 *
 * Event names are tmux's own, verbatim and without the leading `%`, so they
 * grep against tmux(1) and the control-mode protocol. Field names are this
 * package's, so they read like the rest of the API. That is the same line
 * `format` draws: tmux's vocabulary for tmux's data, ours for our shape.
 */

/** A pane produced output. */
export interface TmuxOutputEvent {
  readonly data: string;
  readonly kind: "output";
  readonly paneId: string;
}

/**
 * A pane produced output on a connection that asked for age reporting.
 *
 * `age` is milliseconds between tmux buffering the data and writing it, which
 * is how a consumer notices it is falling behind.
 */
export interface TmuxExtendedOutputEvent {
  readonly age: number;
  readonly data: string;
  readonly kind: "extended-output";
  readonly paneId: string;
}

/** A window was added, closed, or linked into or out of a session. */
export interface TmuxWindowLifecycleEvent {
  readonly kind: "window-add" | "window-close" | "unlinked-window-add" | "unlinked-window-close";
  readonly windowId: string;
}

/** A window was renamed. */
export interface TmuxWindowRenamedEvent {
  readonly kind: "window-renamed" | "unlinked-window-renamed";
  readonly name: string;
  readonly windowId: string;
}

/** The active pane of a window changed. */
export interface TmuxWindowPaneChangedEvent {
  readonly kind: "window-pane-changed";
  readonly paneId: string;
  readonly windowId: string;
}

/** A window's layout changed. */
export interface TmuxLayoutChangeEvent {
  readonly flags: string;
  readonly kind: "layout-change";
  readonly layout: string;
  readonly visibleLayout: string;
  readonly windowId: string;
}

/** The attached session changed, or a session was renamed. */
export interface TmuxSessionEvent {
  readonly kind: "session-changed" | "session-renamed";
  readonly name: string;
  readonly sessionId: string;
}

/** The set of sessions changed. Carries no payload; re-read the server. */
export interface TmuxSessionsChangedEvent {
  readonly kind: "sessions-changed";
}

/** A session's active window changed. */
export interface TmuxSessionWindowChangedEvent {
  readonly kind: "session-window-changed";
  readonly sessionId: string;
  readonly windowId: string;
}

/** Another client switched sessions. */
export interface TmuxClientSessionChangedEvent {
  readonly client: string;
  readonly kind: "client-session-changed";
  readonly name: string;
  readonly sessionId: string;
}

/** Another client detached. */
export interface TmuxClientDetachedEvent {
  readonly client: string;
  readonly kind: "client-detached";
}

/** A pane entered or left a mode such as copy mode. */
export interface TmuxPaneModeChangedEvent {
  readonly kind: "pane-mode-changed";
  readonly paneId: string;
}

/** A paste buffer was written or deleted. */
export interface TmuxPasteBufferEvent {
  readonly buffer: string;
  readonly kind: "paste-buffer-changed" | "paste-buffer-deleted";
}

/** tmux paused or resumed output for a pane that fell behind. */
export interface TmuxPaneFlowEvent {
  readonly kind: "continue" | "pause";
  readonly paneId: string;
}

/** tmux reported a message, or an error in its configuration. */
export interface TmuxMessageEvent {
  readonly kind: "config-error" | "message";
  readonly message: string;
}

/** The control-mode connection is ending. */
export interface TmuxExitEvent {
  readonly kind: "exit";
  readonly reason: string | undefined;
}

/**
 * A notification this version of the package does not model.
 *
 * tmux adds notifications between releases. Rather than drop them, they arrive
 * with their name and raw arguments so a consumer can handle one this package
 * has not caught up with yet.
 */
export interface TmuxUnknownEvent {
  readonly args: readonly string[];
  readonly kind: "unknown";
  readonly name: string;
}

/**
 * The connection dropped and was reopened.
 *
 * Anything tmux reported while it was down was missed; re-read the server if
 * the gap matters.
 */
export interface TmuxReconnectedEvent {
  readonly attempts: number;
  readonly kind: "reconnected";
}

export type TmuxEvent =
  | TmuxClientDetachedEvent
  | TmuxClientSessionChangedEvent
  | TmuxExitEvent
  | TmuxExtendedOutputEvent
  | TmuxLayoutChangeEvent
  | TmuxMessageEvent
  | TmuxOutputEvent
  | TmuxPaneFlowEvent
  | TmuxPaneModeChangedEvent
  | TmuxPasteBufferEvent
  | TmuxReconnectedEvent
  | TmuxSessionEvent
  | TmuxSessionWindowChangedEvent
  | TmuxSessionsChangedEvent
  | TmuxUnknownEvent
  | TmuxWindowLifecycleEvent
  | TmuxWindowPaneChangedEvent
  | TmuxWindowRenamedEvent;

/**
 * The part of `AbortSignal` this package uses.
 *
 * Typed structurally rather than as the global, because `AbortSignal` comes
 * from the DOM or Node type libraries and naming it would make these public
 * declarations require one. A real `AbortSignal` satisfies it.
 */
export interface AbortLike {
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  readonly aborted: boolean;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** Options for {@link Server.watch}. */
export interface WatchOptions {
  /**
   * How many events to hold for a consumer that has fallen behind.
   *
   * On overflow the oldest event is dropped and {@link TmuxEventStream.dropped}
   * counts it. Buffering without a bound would let a slow consumer grow the
   * heap until the process dies, which is worse than losing an event.
   */
  readonly bufferSize?: number;
  /** Abort the connection when this signal fires. */
  readonly signal?: AbortLike;
  /**
   * Reopen the connection when it drops unexpectedly.
   *
   * Off by default: a stream that silently reattaches hides a tmux server
   * going away, and a caller that wants to know cannot get the notice back.
   * When enabled, a recovered connection reports itself as a `reconnected`
   * event so a consumer can tell that it missed whatever happened in the gap.
   *
   * Commands in flight when the connection drops are failed, never replayed.
   * tmux has no idea whether it already ran one, and re-sending `new-window`
   * after it succeeded creates a second window.
   */
  readonly reconnect?: { readonly attempts: number; readonly delayMs?: number };
  /** Session to attach to. Defaults to whichever tmux considers most recent. */
  readonly target?: string;
}

/**
 * A live stream of tmux control-mode events.
 *
 * Async iterable and async disposable, so `await using` ends the connection on
 * scope exit even when the loop throws. The events are consumed, not replayed,
 * so a stream is iterated once.
 */
export interface TmuxEventStream extends AsyncIterable<TmuxEvent>, AsyncDisposable {
  /** End the connection. Safe to call more than once. */
  close(): Promise<void>;
  /**
   * Resolve with the first event `matches` accepts, or undefined if the stream
   * ends or the deadline passes first.
   *
   * This consumes the stream, which is what iterating it does anyway. It exists
   * because every caller otherwise writes the same loop, deadline, and cleanup,
   * and forgetting the deadline turns a missed event into a hang.
   */
  find(
    matches: (event: TmuxEvent) => boolean,
    options?: { readonly timeoutMs?: number },
  ): Promise<TmuxEvent | undefined>;
  /**
   * Resolve once tmux has accepted the attach, or reject with its reason.
   *
   * A control client is told nothing that happened before it attached, so a
   * change made between opening the stream and that moment is never announced
   * to it. Await this before making the change you intend to observe, or the
   * wait for it can outlive the event.
   */
  ready(): Promise<void>;
  /** Events discarded because the consumer fell behind. */
  readonly dropped: number;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * A server bound to one control-mode connection.
 *
 * Same API as {@link Server}, with its commands travelling over the open
 * connection rather than a process per call. Disposing it ends the connection.
 */
export interface ConnectedServer extends Server, AsyncDisposable {
  /** End the connection. Safe to call more than once. */
  close(): Promise<void>;
  /**
   * Open an independent view of the notifications arriving on this connection.
   *
   * Each call is its own subscription with its own buffer, so a `for await`
   * loop and a {@link waitFor} can run side by side.
   */
  subscribe(): TmuxEventStream;
  /**
   * Resolve once the server satisfies `matches`, or reject on timeout.
   *
   * This is the join between a snapshot and the stream: it subscribes first,
   * then reads, so a change landing between those two steps is still seen.
   * Doing it the other way round — read, then subscribe — waits forever on a
   * condition that already came true.
   *
   * ```ts
   * await live.waitFor((server) => server.windows.exists({ name: "build" }));
   * ```
   */
  waitFor(
    matches: (snapshot: ServerSnapshot) => boolean,
    options?: { readonly timeoutMs?: number },
  ): Promise<ServerSnapshot>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * A tmux command that has been described but not run.
 *
 * Every mutation here is two separable halves: the arguments, which are decided
 * from the options alone, and finding what they produced, which needs a
 * snapshot. Keeping them apart is what lets many mutations share one invocation
 * and one snapshot instead of paying for both per call — the difference between
 * a workspace costing one round trip and costing one per window.
 *
 * The type parameter is what the command resolves to, so a batch of mixed
 * operations still comes back typed one by one.
 */
export interface PlannedOperation<T> {
  readonly argv: readonly string[];
  /** What `argv` produced, read out of a snapshot taken after it ran. */
  readonly resolve: (snapshot: ServerSnapshot, lines: readonly string[]) => T;
}

/**
 * Which way a server's commands reach tmux.
 *
 * `spawn` runs a `tmux` process per command and holds nothing open. `control`
 * keeps one connection and writes to it, which costs no processes at all but
 * has to attach first, and so can fail where spawning would not.
 */
export type TransportMode = "control" | "spawn";

/**
 * A server whose transport was chosen for it, and which knows how to let go.
 *
 * {@link Server.open} returns this whichever transport it selected, so the
 * choice does not change the type a caller holds. `close` releases whatever the
 * server is holding, which for a spawning server is nothing — the same call is
 * correct either way, which is what lets the mode be switched by configuration
 * rather than by editing the code that uses it.
 */
export interface ManagedServer extends Server, AsyncDisposable {
  /** Release the connection, if there is one. Safe to call more than once. */
  close(): Promise<void>;
}
