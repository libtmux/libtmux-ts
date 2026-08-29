import type { CommandResult, DeliveryStatus, OperationStatus } from "../../common.js";
import type { TmuxCommandRequest, TmuxCommandResult, TmuxEngine } from "../../engine.js";
// One transport error type, and it is the public one: a caller deciding
// whether a timed-out mutation is safe to retry needs `delivery`, and an
// internal-only class would mean re-deriving it at the package boundary.
export { TmuxTransportError } from "../../exc.js";
import type { TmuxTransportError as TmuxTransportErrorType } from "../../exc.js";

export type CommandRequest = TmuxCommandRequest;
export type RawCommandResult = TmuxCommandResult;
export type CommandTransport = TmuxEngine;

export function snapshotCommandRequest(request: CommandRequest): CommandRequest {
  const stdin = request.stdin === undefined ? undefined : new Uint8Array(request.stdin);
  const snapshot: CommandRequest = {
    args: Object.freeze([...request.args]),
    ...(request.daemonGuard === undefined
      ? {}
      : {
          daemonGuard: Object.freeze({
            pid: request.daemonGuard.pid,
            startTime: request.daemonGuard.startTime,
          }),
        }),
    ...(request.environment === undefined
      ? {}
      : { environment: Object.freeze({ ...request.environment }) }),
    executable: request.executable,
    ...(request.rawOutput === undefined ? {} : { rawOutput: request.rawOutput }),
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

export interface BatchOutcome {
  readonly delivery: DeliveryStatus;
  readonly error?: TmuxTransportErrorType;
  readonly index: number;
  readonly rawResult?: RawCommandResult;
  readonly request: CommandRequest;
  readonly result?: CommandResult;
  readonly status: OperationStatus;
}
