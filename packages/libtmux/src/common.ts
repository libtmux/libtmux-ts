import type { AbortLike } from "./types.js";

declare const tmuxIdBrand: unique symbol;
declare const connectionAliasBrand: unique symbol;
declare const daemonEpochBrand: unique symbol;
declare const safeIntegerBrand: unique symbol;

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

export type ConnectionAlias = string & { readonly [connectionAliasBrand]: "connection" };
export type DaemonEpoch = number & { readonly [daemonEpochBrand]: "daemon" };

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
   * Overrides the server's default. Without either, a command waits as long as
   * tmux takes, which for a wedged daemon is forever.
   *
   * Bounds only this call's own wait. On `["wait-for", "-L", name]` in
   * particular, tmux queues a lock request and hands it to the first queued
   * locker regardless of whether that locker is still around to claim it
   * (`cmd-wait-for.c`) — so a caller whose bounded wait timed out or was
   * cancelled can still be the one tmux is holding the lock for, wedging that
   * channel for every future locker until the process that requested it
   * unlocks it, which a caller that gave up on the wait will never do.
   */
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly cmd: readonly string[];
  /** The completed command's exit status, including nonzero tmux refusals. */
  readonly exitCode: number;
  readonly stderr: readonly string[];
  readonly stdout: readonly string[];
}

export type DeliveryStatus = "not_started" | "written" | "replied" | "indeterminate";
export type OperationStatus = "complete" | "failed" | "skipped" | "unknown";

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
 */
export type TmuxInvocationObserver = (report: TmuxInvocationReport) => void;

interface LogicalRefBase<Kind extends TmuxIdKind, Id extends TmuxId<Kind>> {
  readonly connection: ConnectionAlias;
  readonly epoch: DaemonEpoch;
  readonly id: Id;
  readonly kind: Kind;
}

export type SessionRef = LogicalRefBase<"session", SessionId>;
export type WindowRef = LogicalRefBase<"window", WindowId>;
export type PaneRef = LogicalRefBase<"pane", PaneId>;
export type LogicalRef = SessionRef | WindowRef | PaneRef;
