import type { TmuxCommand, TmuxInvocationRequest } from "../../engine.js";
import { TmuxTransportError } from "../../exc.js";

/**
 * The most command bytes tmux will pack into one client message.
 *
 * The frame is 16384 bytes including a 16-byte header and the four-byte
 * argument count, which leaves this. Measured rather than derived: a packed
 * command of 16364 bytes is accepted by 3.2a and 3.7c alike, 16365 through
 * 16380 report `failed to send command`, and more reports `command too long`.
 *
 * What counts is the command alone. tmux parses its own global flags and the
 * executable is the process, so neither reaches the packed payload — charging
 * a caller for a long socket path refused commands tmux would have run.
 */
export const MAX_PACKED_ARGV_BYTES = 16_364;

/** What tmux counts: every argument plus its terminating NUL. */
function packedArgvBytes(argv: readonly string[]): number {
  let total = 0;
  for (const argument of argv) total += Buffer.byteLength(argument, "utf8") + 1;
  return total;
}

function protocolError(message: string): TmuxTransportError {
  return new TmuxTransportError(message, { delivery: "not_started", kind: "protocol" });
}

/** Snapshot a dynamically built command after proving its nonempty shape. */
export function tmuxCommand(args: readonly string[]): TmuxCommand {
  const [name, ...rest] = args;
  if (name === undefined || name === "") {
    throw protocolError("tmux invocation contains an empty command");
  }
  return Object.freeze([name, ...rest]);
}

/** Validate the string and whole-invocation invariants of an engine request. */
export function validateInvocation(request: TmuxInvocationRequest): void {
  if (request.commands.length === 0) throw protocolError("tmux invocation has no commands");
  for (const command of request.commands) {
    if (command.length === 0 || command[0] === "") {
      throw protocolError("tmux invocation contains an empty command");
    }
  }
  if (request.stdin !== undefined && request.commands.length !== 1) {
    throw protocolError("a tmux command list cannot carry stdin");
  }
  if (request.stdin !== undefined && request.daemonGuard !== undefined) {
    throw protocolError("a daemon-guarded invocation cannot carry stdin");
  }

  const environment = Object.entries(request.environment ?? {}).flatMap(([name, value]) =>
    value === undefined ? [name] : [name, value],
  );
  const daemon =
    request.daemonGuard === undefined
      ? []
      : [request.daemonGuard.pid, request.daemonGuard.startTime];
  const strings = [
    request.executable,
    ...request.globalArgs,
    ...request.commands.flat(),
    ...environment,
    ...daemon,
  ];
  if (strings.some((value) => value.includes("\0"))) {
    throw protocolError("tmux invocation contains NUL");
  }
}

function flattenCommand(command: TmuxCommand): readonly string[] {
  return command.map((argument) =>
    argument.endsWith(";") ? `${argument.slice(0, -1)}\\;` : argument,
  );
}

/** Flatten a structured request while keeping literal and structural semicolons distinct. */
export function flattenInvocation(request: TmuxInvocationRequest): readonly string[] {
  validateInvocation(request);
  return Object.freeze([...request.globalArgs, ...flattenCommands(request.commands)]);
}

/** The command portion, with the separators tmux packs between commands. */
function flattenCommands(commands: TmuxInvocationRequest["commands"]): string[] {
  const argv: string[] = [];
  for (const [index, command] of commands.entries()) {
    if (index > 0) argv.push(";");
    argv.push(...flattenCommand(command));
  }
  return argv;
}

/** What one invocation costs against {@link MAX_PACKED_ARGV_BYTES}. */
export function packedCommandBytes(request: TmuxInvocationRequest): number {
  return packedArgvBytes(flattenCommands(request.commands));
}
