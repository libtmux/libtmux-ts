import { flattenInvocation, isAdmissionFence } from "../../src/_internal/transport/invocation.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";

const encoder = new TextEncoder();
const PROBE = /^(libtmux-version-[0-9a-f]{32}-)#\{version\}\/#\{pid\}\/#\{start_time\}$/u;

/** The marker a version probe carries, or `undefined` when the request is not one. */
export function probeMarker(request: CommandRequest): string | undefined {
  const [command] = request.commands;
  if (request.commands.length !== 1 || command[0] !== "run-shell" || command[1] !== "-C") {
    return undefined;
  }
  return PROBE.exec(command[2] ?? "")?.[1];
}

/** What a live daemon answers a version probe: an unknown command naming its identity. */
export function answerVersionProbe(
  request: CommandRequest,
  version: string,
  identity: { readonly pid: string; readonly startTime: string } = { pid: "101", startTime: "202" },
): RawCommandResult {
  const marker = probeMarker(request);
  if (marker === undefined) throw new Error("not a version probe");
  return {
    cmd: Object.freeze([request.executable, ...flattenInvocation(request)]),
    exitCode: 1,
    signal: null,
    stderr: encoder.encode(
      `unknown command: ${marker}${version}/${identity.pid}/${identity.startTime}\n`,
    ),
    stdout: new Uint8Array(),
  };
}

export interface AdmittedEngineOptions {
  /** Answers the version probe; by default a live daemon reporting `version`. */
  readonly probe?: (request: CommandRequest) => RawCommandResult;
  readonly version?: string;
}

/**
 * An engine for a `Server` under test.
 *
 * A `Server` asks its engine for the daemon's version before the first command
 * and puts a fence ahead of every list. This answers the first and hands the
 * handler the list as the caller wrote it, so a test keeps asserting on its own
 * commands.
 */
export function admittedEngine(
  handler: (request: CommandRequest) => Promise<RawCommandResult>,
  options: AdmittedEngineOptions = {},
): CommandTransport {
  return {
    execute(request) {
      if (probeMarker(request) !== undefined) {
        return Promise.resolve(
          options.probe === undefined
            ? answerVersionProbe(request, options.version ?? "3.7b")
            : options.probe(request),
        );
      }
      const [fence, ...commands] = request.commands;
      if (!isAdmissionFence(fence)) return handler(request);
      const [first, ...rest] = commands;
      if (first === undefined) throw new Error("a fenced request carries no commands");
      const flags =
        request.globalArgs.at(-1) === "-N" ? request.globalArgs.slice(0, -1) : request.globalArgs;
      return handler({ ...request, commands: [first, ...rest], globalArgs: flags });
    },
  };
}
