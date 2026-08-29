import type { CommandResult, DeliveryStatus, OperationStatus } from "../../common.js";
// One transport error type, and it is the public one: a caller deciding
// whether a timed-out mutation is safe to retry needs `delivery`, and an
// internal-only class would mean re-deriving it at the package boundary.
export { TmuxTransportError } from "../../exc.js";
import type { TmuxTransportError as TmuxTransportErrorType } from "../../exc.js";
import type { AbortLike } from "../../types.js";
import type { DaemonGuard } from "./daemon_guard.js";

export interface CommandRequest {
  readonly args: readonly string[];
  /**
   * Refuse this command unless tmux is still the daemon named here.
   *
   * Set when the argv carries a raw tmux id, which a restarted daemon reissues
   * to something else. A spawning transport honours it by wrapping the command
   * in `if-shell -F`; a control connection ignores it, because it is bound to
   * one daemon for its lifetime and a restart drops it — and because
   * `if-shell` emits one `%begin`/`%end` block when its condition is false and
   * two when it is true, which a response queue correlating by order cannot
   * survive.
   */
  readonly daemonGuard?: DaemonGuard;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  /**
   * Require the transport to return stdout without a text protocol changing it.
   *
   * A control connection falls back to a spawned command for this: control
   * responses cannot represent every paste-buffer byte.
   */
  readonly rawOutput?: true;
  readonly signal?: AbortLike;
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
}

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

/**
 * What runs a tmux command for a server.
 *
 * Two obligations beyond returning bytes, and both are what the layers above
 * assume rather than check:
 *
 * `executeGroup` must run its requests as **one** tmux command list. Running
 * them separately returns the same data and quietly stops a snapshot being one:
 * tmux serializes a client's command queue and nothing else, so separate
 * invocations can observe different topologies. {@link asSingleInvocation}
 * assembles and splits that list, and the built-in engine uses it.
 *
 * `daemonGuard`, when a request carries one, must reach tmux — or the engine
 * must be bound to one daemon for its lifetime, the way a control connection
 * is. Ignoring it on a reconnecting engine means a handle read before a restart
 * addressing whatever now holds its id. `guardRequest` is what the built-in
 * engine calls to honour it, published so an implementer does not reproduce
 * the wrapper, its else branch, and the stderr that tells refusal from failure.
 */
export interface CommandTransport {
  /**
   * Where this engine reaches tmux, as one comparable string.
   *
   * The socket is not the address when an engine is in play: `/tmp/tmux-1000/x`
   * on two machines is two daemons, and comparing servers by socket alone
   * reports them as one. Anything stable and distinct will do — `ssh://host`,
   * a container id, a URL.
   *
   * Optional because only comparison needs it. An engine that leaves it unset
   * is never reported equal to another engine, which is the answer that cannot
   * be wrong when the reach is unknown.
   */
  readonly endpoint?: string;
  execute(request: CommandRequest): Promise<RawCommandResult>;
  /**
   * Run these commands as one tmux command list.
   *
   * tmux drains one client's command queue without returning to its event loop,
   * so a list submitted together is serialized against every other client and
   * the results describe one instant. That is what makes a multi-listing
   * acquisition a snapshot rather than four readings taken near each other.
   *
   * A failing command removes the rest of the list, so this resolves with the
   * results of the commands tmux actually ran: a shorter array than `requests`
   * means an earlier one failed, and the last entry is that failure. Only the
   * first request's server-selecting flags are used; the rest contribute their
   * subcommands.
   */
  executeGroup(requests: readonly CommandRequest[]): Promise<readonly RawCommandResult[]>;
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
