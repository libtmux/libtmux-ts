import type { CommandResult, DeliveryStatus, OperationStatus } from "../../common.js";
// One transport error type, and it is the public one: a caller deciding
// whether a timed-out mutation is safe to retry needs `delivery`, and an
// internal-only class would mean re-deriving it at the package boundary.
export { TmuxTransportError } from "../../exc.js";
import type { TmuxTransportError as TmuxTransportErrorType } from "../../exc.js";
import type { AbortLike } from "../../types.js";

export interface CommandRequest {
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly signal?: AbortLike;
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
}

export function snapshotCommandRequest(request: CommandRequest): CommandRequest {
  const stdin = request.stdin === undefined ? undefined : new Uint8Array(request.stdin);
  const snapshot: CommandRequest = {
    args: Object.freeze([...request.args]),
    ...(request.environment === undefined
      ? {}
      : { environment: Object.freeze({ ...request.environment }) }),
    executable: request.executable,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  };
  if (stdin !== undefined) {
    Object.defineProperty(snapshot, "stdin", {
      enumerable: true,
      get: () => new Uint8Array(stdin),
    });
  }
  return Object.freeze(snapshot);
}

export interface RawCommandResult {
  readonly cmd: readonly string[];
  readonly returncode: number;
  /**
   * The signal that ended the process, as a plain string.
   *
   * Not `NodeJS.Signals`: these declarations are gated to compile with no
   * ambient Node types, and this one is reachable from the package root.
   */
  readonly signal: string | null;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}

export interface CommandTransport {
  execute(request: CommandRequest): Promise<RawCommandResult>;
}

export interface BatchOutcome {
  readonly delivery: DeliveryStatus;
  readonly error?: TmuxTransportErrorType;
  readonly index: number;
  readonly rawResult?: RawCommandResult;
  readonly request: CommandRequest;
  readonly result?: CommandResult;
  readonly status: OperationStatus;
}
