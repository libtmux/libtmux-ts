import type { AbortLike } from "./types.js";

declare const tmuxIdBrand: unique symbol;
declare const connectionAliasBrand: unique symbol;
declare const daemonEpochBrand: unique symbol;
declare const safeIntegerBrand: unique symbol;

/**
 * Which of tmux's three id spaces an id belongs to.
 *
 * The three are numbered independently, so `$1`, `@1` and `%1` can all exist
 * at once and name unrelated objects. The kind is what keeps a pane id from
 * being passed where a window id belongs.
 */
export type TmuxIdKind = "session" | "window" | "pane";

/** A tmux object ID authenticated for one object kind. */
export type TmuxId<Kind extends TmuxIdKind> = string & {
  readonly [tmuxIdBrand]: Kind;
};

/** A session ID in tmux's `$n` form. */
export type SessionId = TmuxId<"session">;
/** A window ID in tmux's `@n` form. */
export type WindowId = TmuxId<"window">;
/** A pane ID in tmux's `%n` form. */
export type PaneId = TmuxId<"pane">;
/** Raw text or an already-authenticated ID of the expected kind. */
export type TmuxIdInput<Kind extends TmuxIdKind> = string & {
  readonly [tmuxIdBrand]?: Kind;
};
/** Raw session-ID text or an authenticated session ID. */
export type SessionIdInput = TmuxIdInput<"session">;
/** Raw window-ID text or an authenticated window ID. */
export type WindowIdInput = TmuxIdInput<"window">;
/** Raw pane-ID text or an authenticated pane ID. */
export type PaneIdInput = TmuxIdInput<"pane">;

/**
 * A finite whole number within JavaScript's safe integer range.
 *
 * ```ts
 * import { safeInteger } from "libtmux";
 * import type { SafeInteger } from "libtmux";
 * const count: SafeInteger = safeInteger(3);
 * ```
 */
export type SafeInteger = number & { readonly [safeIntegerBrand]: "safe-integer" };

/**
 * Test whether a value is an exact JavaScript integer.
 *
 * ```ts
 * import { isSafeInteger } from "libtmux";
 * const value: unknown = 3;
 * if (isSafeInteger(value)) snapshot.sessions.where({ attached: value });
 * ```
 */
export function isSafeInteger(value: unknown): value is SafeInteger {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Authenticate an exact JavaScript integer or throw.
 *
 * @throws TypeError when `value` is fractional, infinite, `NaN`, or outside
 * JavaScript's safe integer range.
 *
 * ```ts
 * import { safeInteger } from "libtmux";
 * const pid = safeInteger(42);
 * ```
 */
export function safeInteger(value: number): SafeInteger {
  if (!isSafeInteger(value)) throw new TypeError("value must be a safe integer");
  return value;
}

/**
 * Which connection a handle came through.
 *
 * Two servers on different sockets number their objects from the same place,
 * so an id alone does not identify anything. This is the other half.
 */
export type ConnectionAlias = string & { readonly [connectionAliasBrand]: "connection" };
/**
 * Which run of the daemon a handle came from, counted from zero.
 *
 * A restarted tmux on the same socket issues `%0` again to a different pane,
 * so an id from the previous run names nothing. Comparing epochs is what
 * catches that, and it is why {@link SessionRef} and friends carry one.
 */
export type DaemonEpoch = number & { readonly [daemonEpochBrand]: "daemon" };

/**
 * What every command accepts, whichever handle it is called on.
 *
 * Both fields bound how long a caller waits, from opposite ends: the deadline
 * is set when the command starts, the signal can arrive at any time.
 */
export interface CommandOptions {
  /**
   * Abandon the command when this signal fires.
   *
   * Typed structurally rather than as the DOM's `AbortSignal` so the published
   * declarations need no browser or Node type library; a real one satisfies it.
   */
  readonly signal?: AbortLike;
  readonly stdin?: string | Uint8Array;
  /**
   * Give up on the command after this many milliseconds.
   *
   * Must be a positive timer-safe integer.
   *
   * Overrides the server's default, which is 30 seconds unless the server was
   * built with another. `null` removes the deadline for this call alone.
   *
   * Bounds only this call's own wait. On `["wait-for", "-L", name]` in
   * particular, tmux queues a lock request and hands it to the first queued
   * locker regardless of whether that locker is still around to claim it
   * (`cmd-wait-for.c`) — so a caller whose bounded wait timed out or was
   * cancelled can still be the one tmux is holding the lock for, wedging that
   * channel for every future locker until the process that requested it
   * unlocks it, which a caller that gave up on the wait will never do.
   */
  readonly timeoutMs?: number | null;
}

/**
 * A finished `tmux` invocation, as the process left it.
 *
 * `cmd` is the argument vector as run, so it includes the connection flags
 * this library adds. A non-zero `exitCode` is not an exception here — the
 * callers that raise are the ones that promised a value.
 */
export interface CommandResult {
  readonly cmd: readonly string[];
  /** The completed command's exit status, including nonzero tmux refusals. */
  readonly exitCode: number;
  readonly stderr: readonly string[];
  readonly stdout: readonly string[];
}

/**
 * How far a command got before something interrupted it.
 *
 * This is what a caller needs to decide whether retrying is safe: a command
 * that was never written changed nothing, and one that was written but not
 * answered may have done its work already. `indeterminate` is the honest
 * answer, not a missing one.
 */
export type DeliveryStatus = "not_started" | "written" | "replied" | "indeterminate";
/**
 * What became of one step of a multi-step operation.
 *
 * `skipped` is not a failure: a step whose precondition no longer holds is
 * reported rather than retried, so the caller sees why the whole did less
 * than it asked for.
 */
export type OperationStatus = "complete" | "failed" | "skipped" | "unknown";

/**
 * One command's result together with how far it got.
 *
 * The two are separate because they can disagree: a command can be delivered
 * and still fail, and one that failed to deliver has no result at all.
 */
export interface CommandOutcome {
  readonly delivery: DeliveryStatus;
  readonly result?: CommandResult;
  readonly status: OperationStatus;
}

/**
 * What one tmux invocation cost and how it ended.
 *
 * Every command this package runs produces one of these, including the four
 * listings behind a snapshot and the probe that reads the version, and
 * including commands a custom engine executed.
 */
export interface TmuxInvocationReport {
  /** The commands tmux received, without the connection flags. */
  readonly commands: readonly (readonly string[])[];
  /** How far the command got. `replied` for one that finished either way. */
  readonly delivery: DeliveryStatus;
  /** Wall time from dispatch to answer, excluding any wait for a slot. */
  readonly durationMs: number;
  /** What the invocation threw, when it did not answer. */
  readonly error?: unknown;
  /** tmux's own status, when there was one. Nonzero is a refusal, not a fault. */
  readonly exitCode?: number;
  /** Time spent waiting for a slot under `maxInFlight`. */
  readonly queuedMs: number;
}

/**
 * Called once per tmux invocation, after it answers or fails.
 *
 * This is the seam for logs, traces and metrics: a caller that wants to see
 * what the library is doing has otherwise to supply a whole engine. It runs
 * after the invocation is decided and cannot change its outcome — anything it
 * throws is swallowed, because a command must not fail on account of the code
 * watching it.
 *
 * Returning a promise is allowed and never awaited: the invocation has already
 * been decided, so waiting would only delay it. A rejection is swallowed on
 * the same grounds as a throw, rather than left to the host's unhandled
 * rejection policy.
 */
export type TmuxInvocationObserver = (report: TmuxInvocationReport) => void;

/**
 * The three parts that together name one tmux object for certain.
 *
 * An id alone is ambiguous across servers and across restarts of one server,
 * so a reference carries the connection it came through and the daemon run it
 * came from as well.
 */
interface LogicalRefBase<Kind extends TmuxIdKind, Id extends TmuxId<Kind>> {
  readonly connection: ConnectionAlias;
  readonly epoch: DaemonEpoch;
  readonly id: Id;
  readonly kind: Kind;
}

/** One session, named unambiguously across servers and daemon restarts. */
export type SessionRef = LogicalRefBase<"session", SessionId>;
/** One window, named unambiguously across servers and daemon restarts. */
export type WindowRef = LogicalRefBase<"window", WindowId>;
/** One pane, named unambiguously across servers and daemon restarts. */
export type PaneRef = LogicalRefBase<"pane", PaneId>;
/**
 * Any of the three, discriminated by `kind`.
 *
 * Clients are absent on purpose: a client has a name rather than an id, and
 * nothing numbers it.
 */
export type LogicalRef = SessionRef | WindowRef | PaneRef;
