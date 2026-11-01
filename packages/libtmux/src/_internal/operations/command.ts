import { LibTmuxError, TmuxCommandError, TmuxServerRestartedError } from "../../errors.js";
import type { CommandOptions, CommandResult } from "../../common.js";
import type { DaemonGuard } from "../../engine.js";
import { invalidateRuntimeEpoch, lastObservedDaemon } from "../runtime/context.js";
import type { RuntimeContext } from "../runtime/context.js";
import { reachesUnboundedCommand } from "../transport/bounded_transport.js";
import { carriesTmuxId } from "../transport/daemon_guard.js";
import type { RawCommandResult } from "../transport/types.js";
import type { TmuxVersion } from "../../types.js";
import { parseTmuxVersion } from "../runtime/tmux_version.js";
import { executableProbe, executableVersion, requireCoreVersion } from "../support/versions.js";
import { adaptRawResult, prepareCommandRequest, prepareInvocationRequest } from "./request.js";

/**
 * The deadline one invocation runs under.
 *
 * The call's own wins, `null` meaning none. Otherwise the server's applies,
 * unless a command in the invocation waits on a person: a default would cut
 * them off mid-prompt. One such command exempts the whole invocation, where
 * the `maxInFlight` rule needs the invocation to end in one — a deadline kills
 * the process, which ends every command in it.
 */
function deadlineFor(
  runtime: RuntimeContext,
  commands: readonly (readonly string[])[],
  timeoutMs: number | null | undefined,
): number | undefined {
  if (timeoutMs !== undefined) return timeoutMs ?? undefined;
  const waitsOnPerson = commands.some(
    ([name]) => name !== undefined && reachesUnboundedCommand(name),
  );
  return waitsOnPerson ? undefined : runtime.timeoutMs;
}

interface ExecutedCommand {
  readonly raw: RawCommandResult;
  readonly result: CommandResult;
}

/** Options for a command meant for one daemon, whichever this runtime last reached. */
export interface PinnedCommandOptions extends CommandOptions {
  /**
   * The daemon the command's targets belong to: tmux refuses it on any other,
   * whether or not it names them by id. Without it, a command naming a raw id
   * is guarded by the daemon this runtime last observed.
   */
  readonly daemon?: DaemonGuard | undefined;
}

/** The daemon a command must run on, if any. */
function guardFor(
  runtime: RuntimeContext,
  args: readonly string[],
  pinned: DaemonGuard | undefined,
): DaemonGuard | undefined {
  return pinned ?? (carriesTmuxId(args) ? lastObservedDaemon(runtime) : undefined);
}

async function executeCommand(
  runtime: RuntimeContext,
  args: readonly string[],
  options: PinnedCommandOptions,
  rawOutput = false,
): Promise<ExecutedCommand> {
  const { timeoutMs, ...rest } = options;
  const deadline = deadlineFor(runtime, [args], timeoutMs);
  const daemon = guardFor(runtime, args, options.daemon);
  let raw: RawCommandResult;
  try {
    raw = await runtime.transport.execute(
      prepareCommandRequest(runtime.connection, args, {
        ...rest,
        ...(daemon === undefined ? {} : { daemonGuard: daemon }),
        ...(deadline === undefined ? {} : { timeoutMs: deadline }),
        ...(rawOutput ? { rawOutput: true as const } : {}),
      }),
    );
  } catch (error) {
    // The daemon this runtime believed in is gone. Moving the epoch on is what
    // makes every other handle from it refuse locally, instead of each one
    // learning the same thing from tmux one command at a time.
    if (error instanceof TmuxServerRestartedError) invalidateRuntimeEpoch(runtime);
    throw error;
  }
  const result = adaptRawResult(raw);
  if (result.exitCode !== 0) {
    const target = args.indexOf("-t");
    throw new TmuxCommandError({
      args,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      ...(target === -1 ? {} : { target: args[target + 1] }),
    });
  }
  return { raw, result };
}

/**
 * Run one tmux command and return its stdout lines, raising on failure.
 *
 * Operations that only care about success ignore the return value. Reporting
 * tmux's own stderr rather than a synthesized message keeps the cause visible;
 * tmux is far more specific about why a target or option was rejected than any
 * wrapper could be.
 *
 * A command addressing an object by its raw id carries the daemon that id was
 * read from, so tmux refuses it after a restart rather than applying it to
 * whatever now holds that id. The check is inside tmux's command queue, which
 * is the only place with no gap between asking and acting.
 */
export async function runCommand(
  runtime: RuntimeContext,
  args: readonly string[],
  options: PinnedCommandOptions = {},
): Promise<readonly string[]> {
  return (await runCommandResult(runtime, args, options)).stdout;
}

/** Run one guarded command while retaining its native result for an operation report. */
export async function runCommandResult(
  runtime: RuntimeContext,
  args: readonly string[],
  options: PinnedCommandOptions = {},
): Promise<CommandResult> {
  return (await executeCommand(runtime, args, options)).result;
}

/** Run one tmux command and return its unmodified stdout bytes. */
export async function runCommandBytes(
  runtime: RuntimeContext,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<Uint8Array> {
  return new Uint8Array((await executeCommand(runtime, args, options, true)).raw.stdout);
}

/**
 * Run several tmux commands as one invocation, raising on the first failure.
 *
 * tmux runs them in order on its own command queue, so nothing interleaves
 * between them. That is what a caller reaches for when two commands have to
 * describe one state change — the state cannot be observed halfway.
 */
export async function runCommands(
  runtime: RuntimeContext,
  commands: readonly (readonly string[])[],
  options: PinnedCommandOptions = {},
): Promise<readonly string[]> {
  return (await runCommandsResult(runtime, commands, options)).stdout;
}

/** Run one guarded invocation while retaining its native result. */
export async function runCommandsResult(
  runtime: RuntimeContext,
  commands: readonly (readonly string[])[],
  options: PinnedCommandOptions = {},
): Promise<CommandResult> {
  const { timeoutMs, ...rest } = options;
  const deadline = deadlineFor(runtime, commands, timeoutMs);
  const flat = commands.flat();
  const daemon = guardFor(runtime, flat, options.daemon);
  let raw: RawCommandResult;
  try {
    raw = await runtime.transport.execute(
      prepareInvocationRequest(runtime.connection, commands, {
        ...rest,
        ...(daemon === undefined ? {} : { daemonGuard: daemon }),
        ...(deadline === undefined ? {} : { timeoutMs: deadline }),
      }),
    );
  } catch (error) {
    if (error instanceof TmuxServerRestartedError) invalidateRuntimeEpoch(runtime);
    throw error;
  }
  const result = adaptRawResult(raw);
  if (result.exitCode !== 0) {
    const target = flat.indexOf("-t");
    throw new TmuxCommandError({
      args: flat,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      ...(target === -1 ? {} : { target: flat[target + 1] }),
    });
  }
  return result;
}

/** The configured executable's own version: the tmux a command on a cold socket starts. */
export async function executableTmuxVersion(
  runtime: RuntimeContext,
  options: CommandOptions = {},
): Promise<TmuxVersion> {
  const timeoutMs =
    options.timeoutMs === undefined ? runtime.timeoutMs : (options.timeoutMs ?? undefined);
  const own = executableVersion(
    await runtime.transport.execute(
      executableProbe({
        environment: runtime.connection.environment,
        executable: runtime.connection.executable,
        globalArgs: [],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    ),
    runtime.connection.executable,
  );
  requireCoreVersion(own);
  return parseTmuxVersion(own);
}

/**
 * Whether a command failed only because no daemon is listening on the socket,
 * as opposed to a daemon that answered and refused the command, or a socket a
 * caller has no permission to reach.
 */
export function isColdEndpoint(error: unknown): boolean {
  const reason =
    error instanceof TmuxCommandError
      ? error.stderr.join("\n").trim()
      : error instanceof LibTmuxError
        ? error.message.replace(/^cannot reach tmux: /u, "")
        : "";
  return (
    reason.startsWith("no server running on ") ||
    (reason.startsWith("error connecting to ") && reason.endsWith(" (No such file or directory)"))
  );
}

/** Whether a command failed because its daemon was gone, before it connected or after. */
export function isServerGone(error: unknown): boolean {
  return (
    isColdEndpoint(error) ||
    (error instanceof TmuxCommandError &&
      error.stderr.join("\n").trim() === "server exited unexpectedly")
  );
}
