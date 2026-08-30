import type { CommandOptions } from "../../common.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand } from "./command.js";

function validatePipeline(commands: readonly (readonly string[])[]): void {
  for (const command of commands) {
    if (command.length === 0 || command[0] === undefined || command[0] === "") {
      throw new TypeError("every command in a pipeline needs a tmux command name");
    }
    if (command.includes(";")) {
      throw new TypeError("a pipeline command cannot contain a bare `;` separator");
    }
  }
}

/** Run commands in order and stop at the first failure. */
export async function runPipeline(
  runtime: RuntimeContext,
  commands: readonly (readonly string[])[],
  options: CommandOptions = {},
): Promise<readonly (readonly string[])[]> {
  validatePipeline(commands);
  const results: (readonly string[])[] = [];
  for (const command of commands) {
    // eslint-disable-next-line no-await-in-loop -- later commands must not run after a failure.
    results.push(await runCommand(runtime, command, options));
  }
  return results;
}
