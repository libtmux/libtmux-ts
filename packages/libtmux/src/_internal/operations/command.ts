import { TmuxCommandError, TmuxServerRestarted } from "../../exc.js";
import type { CommandOptions, CommandResult } from "../../common.js";
import { invalidateRuntimeEpoch, lastObservedDaemon } from "../runtime/context.js";
import type { RuntimeContext } from "../runtime/context.js";
import { carriesTmuxId } from "../transport/daemon_guard.js";
import type { RawCommandResult } from "../transport/types.js";
import { adaptRawResult, prepareCommandRequest } from "./request.js";

interface ExecutedCommand {
  readonly raw: RawCommandResult;
  readonly result: CommandResult;
}

async function executeCommand(
  runtime: RuntimeContext,
  args: readonly string[],
  options: CommandOptions,
  rawOutput = false,
): Promise<ExecutedCommand> {
  // A command with no deadline of its own inherits the server's. Without
  // either it waits as long as tmux takes, which for a wedged daemon is
  // forever.
  const deadline = options.timeoutMs ?? runtime.timeoutMs;
  const daemon = carriesTmuxId(args) ? lastObservedDaemon(runtime) : undefined;
  let raw: RawCommandResult;
  try {
    raw = await runtime.transport.execute(
      prepareCommandRequest(runtime.connection, args, {
        ...options,
        ...(daemon === undefined ? {} : { daemonGuard: daemon }),
        ...(deadline === undefined ? {} : { timeoutMs: deadline }),
        ...(rawOutput ? { rawOutput: true as const } : {}),
      }),
    );
  } catch (error) {
    // The daemon this runtime believed in is gone. Moving the epoch on is what
    // makes every other handle from it refuse locally, instead of each one
    // learning the same thing from tmux one command at a time.
    if (error instanceof TmuxServerRestarted) invalidateRuntimeEpoch(runtime);
    throw error;
  }
  const result = adaptRawResult(raw);
  if (result.returncode !== 0) {
    const target = args.indexOf("-t");
    throw new TmuxCommandError({
      args,
      exitCode: result.returncode,
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
  options: CommandOptions = {},
): Promise<readonly string[]> {
  return (await executeCommand(runtime, args, options)).result.stdout;
}

/** Run one tmux command and return its unmodified stdout bytes. */
export async function runCommandBytes(
  runtime: RuntimeContext,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<Uint8Array> {
  return new Uint8Array((await executeCommand(runtime, args, options, true)).raw.stdout);
}
