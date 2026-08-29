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

/** A number authenticated as an exact JavaScript integer. */
export type SafeInteger = number & { readonly [safeIntegerBrand]: "safe-integer" };

/**
 * Test whether a value is an exact JavaScript integer.
 *
 * ```ts
 * if (isSafeInteger(value)) server.sessions.where({ attached: value });
 * ```
 */
export function isSafeInteger(value: unknown): value is SafeInteger {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Authenticate an exact JavaScript integer or throw.
 *
 * ```ts
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
   * Overrides the server's default. Without either, a command waits as long as
   * tmux takes, which for a wedged daemon is forever.
   */
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly cmd: readonly string[];
  readonly returncode: number;
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

export type TmuxLogContext = Readonly<Record<string, boolean | number | string | undefined>>;

export interface TmuxLogger {
  debug(message: string, context?: TmuxLogContext): void;
  error(message: string, context?: TmuxLogContext): void;
  info(message: string, context?: TmuxLogContext): void;
  warn(message: string, context?: TmuxLogContext): void;
}

export interface TmuxWarning {
  readonly code: string;
  readonly message: string;
}

export interface TmuxWarningSink {
  warn(warning: TmuxWarning): void;
}

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
