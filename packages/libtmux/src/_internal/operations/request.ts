import type { CommandOptions, CommandResult, OperationStatus } from "../../common.js";
import type { TmuxCommand } from "../../engine.js";
import { decodeBackslashReplace } from "../codec/backslash_replace.js";
import type { TmuxConnection } from "../runtime/connection.js";
import type { DaemonGuard } from "../transport/daemon_guard.js";
import type {
  BatchOutcome,
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../transport/types.js";
import { snapshotInvocationRequest, TmuxTransportError } from "../transport/types.js";

export function connectionArguments(connection: TmuxConnection): string[] {
  const args: string[] = [];
  if (connection.colors === 256) args.push("-2");
  if (connection.colors === 88) args.push("-8");
  if (connection.configFile !== undefined) args.push(`-f${connection.configFile}`);
  if (connection.socketName !== undefined) args.push(`-L${connection.socketName}`);
  if (connection.socketPath !== undefined) args.push(`-S${connection.socketPath}`);
  return args;
}

export function prepareCommandRequest(
  connection: TmuxConnection,
  args: readonly string[],
  options: CommandOptions & { readonly daemonGuard?: DaemonGuard; readonly rawOutput?: true } = {},
): CommandRequest {
  return prepareInvocationRequest(connection, [args], options);
}

function prepareCommand(args: readonly string[]): TmuxCommand {
  const [name, ...rest] = args;
  if (name === undefined || name === "") throw new TypeError("tmux command must not be empty");
  return Object.freeze([name, ...rest]);
}

export function prepareInvocationRequest(
  connection: TmuxConnection,
  commands: readonly (readonly string[])[],
  options: CommandOptions & { readonly daemonGuard?: DaemonGuard; readonly rawOutput?: true } = {},
): CommandRequest {
  const [first, ...rest] = commands;
  if (first === undefined) throw new TypeError("tmux invocation must contain a command");
  const prepared: readonly [TmuxCommand, ...TmuxCommand[]] = Object.freeze([
    prepareCommand(first),
    ...rest.map(prepareCommand),
  ]);
  if (
    options.stdin !== undefined &&
    !(prepared.length === 1 && prepared[0][0] === "load-buffer" && prepared[0].at(-1) === "-")
  ) {
    throw new TypeError(`${prepared[0][0]} does not accept stdin`);
  }
  if (options.stdin !== undefined && options.daemonGuard !== undefined) {
    throw new TypeError("a daemon-guarded invocation cannot carry stdin");
  }
  return snapshotInvocationRequest({
    commands: prepared,
    ...(options.daemonGuard === undefined ? {} : { daemonGuard: options.daemonGuard }),
    environment: connection.environment,
    executable: connection.executable,
    globalArgs: connectionArguments(connection),
    ...(options.rawOutput === undefined ? {} : { rawOutput: options.rawOutput }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.stdin === undefined
      ? {}
      : {
          stdin:
            typeof options.stdin === "string"
              ? new TextEncoder().encode(options.stdin)
              : new Uint8Array(options.stdin),
        }),
  });
}

export function adaptRawResult(raw: RawCommandResult): CommandResult {
  const stdout = decodeBackslashReplace(raw.stdout).split("\n");
  if (stdout.at(-1) === "") stdout.pop();
  const stderr = decodeBackslashReplace(raw.stderr)
    .split("\n")
    .filter((line) => line !== "");
  const adaptedStdout =
    raw.cmd.includes("has-session") && stderr.length > 0 && stdout.length === 0
      ? [stderr[0]!]
      : stdout;

  return Object.freeze({
    cmd: Object.freeze([...raw.cmd]),
    returncode: raw.returncode,
    stderr: Object.freeze(stderr),
    stdout: Object.freeze(adaptedStdout),
  });
}

export async function executeBatch(
  transport: CommandTransport,
  requests: readonly CommandRequest[],
): Promise<readonly BatchOutcome[]> {
  const queuedRequests = requests.map((request) => snapshotInvocationRequest(request));
  const outcomes: BatchOutcome[] = [];
  for (const [index, request] of queuedRequests.entries()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- independent batches execute sequentially by contract.
      const rawResult = await transport.execute(request);
      const result = adaptRawResult(rawResult);
      const status: OperationStatus = rawResult.returncode === 0 ? "complete" : "failed";
      outcomes.push(
        Object.freeze({
          delivery: "replied" as const,
          index,
          rawResult,
          request,
          result,
          status,
        }),
      );
    } catch (error) {
      if (!(error instanceof TmuxTransportError)) throw error;
      outcomes.push(
        Object.freeze({
          delivery: error.delivery,
          error,
          index,
          request,
          status: error.delivery === "not_started" ? ("failed" as const) : ("unknown" as const),
        }),
      );
    }
  }
  return Object.freeze(outcomes);
}
