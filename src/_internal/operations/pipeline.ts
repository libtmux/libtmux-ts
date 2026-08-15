import type { CommandOptions } from "../../common.js";
import type { RuntimeContext } from "../runtime/context.js";
import { TmuxCommandError } from "../../exc.js";
import { runCommand } from "./command.js";

/**
 * Run several tmux commands in one invocation.
 *
 * tmux takes a sequence of commands separated by `;`, which is the difference
 * between building a ten-window workspace with one process and doing it with
 * ten. The cost being saved is the spawn, so this matters on the spawning
 * transport and not on a control connection, where the commands are already
 * writes on a socket that is open.
 *
 * A sequence is not atomic. tmux runs the commands in order and stops at the
 * first failure, leaving everything before it applied, and its error names the
 * command that failed without saying where in the sequence it was.
 */

/** Bytes of randomness in the marker, as hex characters. */
const MARKER_LENGTH = 16;

/**
 * How many argv elements one tmux invocation carries.
 *
 * tmux refuses a command whose argument vector runs past 1000 elements —
 * `cmd_unpack_argv` in cmd.c, reported as "command too long". A sequence is one
 * invocation sharing one vector, so a long enough sequence hits that wall, and
 * the message names whichever command the count landed on rather than saying
 * the sequence was too big.
 *
 * The budget leaves room for the connection flags this code does not see.
 * Sequences are split to fit instead of failing; a split still beats one
 * invocation per command by the same ratio.
 */
const ARGUMENT_BUDGET = 900;

/**
 * Split a sequence into runs that each fit one invocation.
 *
 * A command over the budget on its own still goes out alone: tmux will refuse
 * it, and refusing it here would only replace tmux's reason with a worse one.
 */
function chunkToBudget(
  commands: readonly (readonly string[])[],
  perCommandOverhead: number,
): readonly (readonly (readonly string[])[])[] {
  const chunks: (readonly string[])[][] = [];
  let current: (readonly string[])[] = [];
  let used = 0;
  for (const command of commands) {
    const cost = command.length + perCommandOverhead;
    if (current.length > 0 && used + cost > ARGUMENT_BUDGET) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(command);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * A separator no command is going to print by accident.
 *
 * tmux does not delimit one command's output from the next, so a sequence of
 * three commands comes back as one run of lines. Asking tmux to echo a marker
 * after each command frames them, which is the same device the format codec
 * uses for the same reason.
 */
function makeMarker(): string {
  const bytes = new Uint8Array(MARKER_LENGTH / 2);
  crypto.getRandomValues(bytes);
  return `ltx-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function chainedArguments(
  commands: readonly (readonly string[])[],
  marker: string,
): readonly string[] {
  const args: string[] = [];
  for (const command of commands) {
    if (args.length > 0) args.push(";");
    args.push(...command, ";", "display-message", "-p", marker);
  }
  return args;
}

/**
 * Split one run of output back into a result per command.
 *
 * A failing sequence still delivers what the commands before it printed, so a
 * short result is not a parsing problem — it says how far tmux got.
 */
function splitOnMarker(lines: readonly string[], marker: string): readonly (readonly string[])[] {
  const results: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === marker) {
      // Every command's output is trimmed the way a single command's is, so a
      // command that printed one blank line reads as having printed nothing —
      // the same answer `cmd` gives, and the same answer this returns when a
      // connection sends the commands separately.
      while (current.at(-1) === "") current.pop();
      results.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  return results;
}

function validatePipeline(commands: readonly (readonly string[])[]): void {
  for (const command of commands) {
    if (command.length === 0 || command[0] === undefined || command[0] === "") {
      throw new TypeError("every command in a pipeline needs a tmux command name");
    }
    if (command.includes(";")) {
      // A caller who wants two commands passes two commands; a bare `;` inside
      // one would silently split it and shift every result after it.
      throw new TypeError("a pipeline command cannot contain a bare `;` separator");
    }
  }
}

/**
 * Run `commands` as one tmux invocation, returning each command's output.
 *
 * The result is positional: `results[i]` holds the lines `commands[i]` printed,
 * empty for a command that printed nothing.
 */
export async function runPipeline(
  runtime: RuntimeContext,
  commands: readonly (readonly string[])[],
  options: CommandOptions = {},
): Promise<readonly (readonly string[])[]> {
  validatePipeline(commands);
  if (commands.length === 0) return [];

  const marker = makeMarker();
  // `; display-message -p <marker>` rides along with every command, plus the
  // `;` that joins it to the next one.
  const overhead = 5;
  const results: (readonly string[])[] = [];

  for (const chunk of chunkToBudget(commands, overhead)) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a later run must not start if an earlier one failed.
      const lines = await runCommand(runtime, chainedArguments(chunk, marker), options);
      results.push(...splitOnMarker(lines, marker));
    } catch (error) {
      if (!(error instanceof TmuxCommandError)) throw error;
      // Every command that ran echoed the marker, so what survived says how
      // many finished — which is the one thing tmux's own message leaves out.
      const failed = chunk[splitOnMarker(error.stdout, marker).length];
      if (failed === undefined) throw error;
      throw new TmuxCommandError({
        cause: error,
        exitCode: error.exitCode,
        stderr: error.stderr,
        stdout: error.stdout,
        // Reported as the command that failed rather than the whole sequence,
        // so the error names what to fix. Everything before it stayed applied.
        args: failed,
      });
    }
  }
  return results;
}

/**
 * Run `commands` one at a time, stopping at the first failure.
 *
 * What a control connection does instead of chaining: tmux answers a chained
 * line with one response block per command, and this connection correlates one
 * block to one request, so a chain sent down it would hand each command's reply
 * to the one behind it. Sending them separately costs the same there — they are
 * writes on a socket already open — and keeps the semantics identical.
 */
export async function runPipelineSequentially(
  runtime: RuntimeContext,
  commands: readonly (readonly string[])[],
  options: CommandOptions = {},
): Promise<readonly (readonly string[])[]> {
  validatePipeline(commands);
  const results: (readonly string[])[] = [];
  for (const command of commands) {
    // eslint-disable-next-line no-await-in-loop -- stopping at the first failure requires order.
    results.push(await runCommand(runtime, command, options));
  }
  return results;
}
