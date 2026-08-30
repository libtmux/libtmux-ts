import type { CommandResult, DeliveryStatus, OperationStatus } from "../../common.js";
import type {
  TmuxCommand,
  TmuxCommandResult,
  TmuxEngine,
  TmuxInvocationRequest,
} from "../../engine.js";
import { timerDuration } from "../timing.js";
// One transport error type, and it is the public one: a caller deciding
// whether a timed-out mutation is safe to retry needs `delivery`, and an
// internal-only class would mean re-deriving it at the package boundary.
export { TmuxTransportError } from "../../exc.js";
import type { TmuxTransportError as TmuxTransportErrorType } from "../../exc.js";
import { validateInvocation } from "./invocation.js";

export type CommandRequest = TmuxInvocationRequest;
export type RawCommandResult = TmuxCommandResult;
export type CommandTransport = TmuxEngine;

function snapshotCommand(command: TmuxCommand): TmuxCommand {
  const [name, ...args] = command;
  return Object.freeze([name, ...args]);
}

export function snapshotInvocationRequest(request: CommandRequest): CommandRequest {
  validateInvocation(request);
  const timeoutMs =
    request.timeoutMs === undefined ? undefined : timerDuration("timeoutMs", request.timeoutMs);
  const [first, ...rest] = request.commands;
  if (first === undefined) {
    throw new TypeError("tmux invocation has no commands");
  }
  const commands: readonly [TmuxCommand, ...TmuxCommand[]] = Object.freeze([
    snapshotCommand(first),
    ...rest.map(snapshotCommand),
  ]);
  const stdin = request.stdin === undefined ? undefined : new Uint8Array(request.stdin);
  const snapshot: CommandRequest = {
    commands,
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
    globalArgs: Object.freeze([...request.globalArgs]),
    ...(request.rawOutput === undefined ? {} : { rawOutput: request.rawOutput }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
