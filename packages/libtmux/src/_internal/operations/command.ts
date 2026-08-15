import { TmuxCommandError } from "../../exc.js";
import type { CommandOptions } from "../../common.js";
import type { RuntimeContext } from "../runtime/context.js";
import { adaptRawResult, prepareCommandRequest } from "./request.js";

/**
 * Run one tmux command and return its stdout lines, raising on failure.
 *
 * Operations that only care about success ignore the return value. Reporting
 * tmux's own stderr rather than a synthesized message keeps the cause visible;
 * tmux is far more specific about why a target or option was rejected than any
 * wrapper could be.
 */
export async function runCommand(
  runtime: RuntimeContext,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<readonly string[]> {
  // A command with no deadline of its own inherits the server's. Without
  // either it waits as long as tmux takes, which for a wedged daemon is
  // forever.
  const deadline = options.timeoutMs ?? runtime.timeoutMs;
  const result = adaptRawResult(
    await runtime.transport.execute(
      prepareCommandRequest(runtime.connection, args, {
        ...options,
        ...(deadline === undefined ? {} : { timeoutMs: deadline }),
      }),
    ),
  );
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
  return result.stdout;
}
