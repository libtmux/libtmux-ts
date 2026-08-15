import type { CmdOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand } from "./command.js";

/**
 * Run a tmux command this package does not model.
 *
 * tmux has far more commands than any wrapper types, and a caller who needs
 * `bind-key`, `clock-mode`, or a command from a tmux newer than this release
 * would otherwise have to build their own subprocess and reproduce the socket,
 * environment, deadline, and error handling to do it. This is the seam that
 * makes that unnecessary.
 *
 * A handle supplies its own id as the target, so `pane.cmd("clock-mode")`
 * addresses that pane. Pass `target: null` to send no `-t` at all — a few
 * commands reject one.
 */
export function runRawCommand(
  runtime: RuntimeContext,
  ownTarget: string | null,
  command: string,
  args: readonly string[],
  options: CmdOptions = {},
): Promise<readonly string[]> {
  if (command === "") throw new TypeError("cmd requires a tmux command name");
  const target = options.target === undefined ? ownTarget : options.target;
  return runCommand(
    runtime,
    // The target belongs to the subcommand, so it goes directly after it and
    // before whatever else the caller passed.
    [command, ...(target === null ? [] : ["-t", target]), ...args],
    options,
  );
}
