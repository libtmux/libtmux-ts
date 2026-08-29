import type { CommandOptions } from "../../common.js";
import { invalidateRuntimeEpoch, lastObservedDaemon } from "../runtime/context.js";
import type { RuntimeContext } from "../runtime/context.js";
import { TmuxCommandError, TmuxServerRestarted } from "../../exc.js";
import {
  carriesTmuxId,
  guardedChain,
  refusedByGuardLine,
  type DaemonGuard,
} from "../transport/daemon_guard.js";
import { MAX_PACKED_ARGV_BYTES } from "../transport/group.js";
import { quoteCommand } from "../transport/lexer.js";
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
interface Budget {
  readonly costOf: (command: readonly string[]) => number;
  readonly limit: number;
}

/** `; display-message -p <marker>` per command, plus the `;` joining it on. */
const elementCost: Budget = {
  costOf: (command) => command.length + 5,
  limit: ARGUMENT_BUDGET,
};

/**
 * The same sequence measured the way a guarded one is refused.
 *
 * Inside `if-shell` the chain is one argument, so what runs out is the 16KB
 * tmux packs an argv into rather than the element count. The reserve covers the
 * connection flags, the condition, and the else branch.
 */
const byteCost: Budget = {
  costOf: (command) => quoteCommand(command).length + 64,
  limit: MAX_PACKED_ARGV_BYTES - 2048,
};

function chunkToBudget(
  commands: readonly (readonly string[])[],
  budget: Budget,
): readonly (readonly (readonly string[])[])[] {
  const chunks: (readonly string[])[][] = [];
  let current: (readonly string[])[] = [];
  let used = 0;
  for (const command of commands) {
    const cost = budget.costOf(command);
    if (current.length > 0 && used + cost > budget.limit) {
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

function chainedCommands(
  commands: readonly (readonly string[])[],
  marker: string,
): readonly (readonly string[])[] {
  return commands.flatMap((command) => [command, ["display-message", "-p", marker]]);
}

function chainedArguments(commands: readonly (readonly string[])[], marker: string): string[] {
  const args: string[] = [];
  for (const command of chainedCommands(commands, marker)) {
    if (args.length > 0) args.push(";");
    args.push(...command);
  }
  return args;
}

/**
 * The whole sequence inside one daemon guard.
 *
 * Guarded once rather than per command, because a sequence stops at its first
 * failure and per-command wrappers would not: an error inside an `if-shell`
 * branch does not remove commands outside it, so a failure part-way would let
 * the rest run. One wrapper keeps the sequence one command list, which is what
 * `cmdq_remove_group` acts on.
 *
 * Safe to serialize because {@link validatePipeline} has already refused a bare
 * `;` inside any command, so every separator here is one this code put in.
 */
function guardedChainArguments(
  commands: readonly (readonly string[])[],
  marker: string,
  daemon: DaemonGuard,
): readonly string[] {
  const chain = chainedCommands(commands, marker)
    .map((command) => quoteCommand(command))
    .join(" ; ");
  return guardedChain(chain, daemon);
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
  // Guarded only when something addresses an object by an id a restarted daemon
  // would reissue. A sequence of named targets needs no daemon to be the one it
  // was read from, because it never read one.
  const daemon = commands.some((command) => carriesTmuxId(command))
    ? lastObservedDaemon(runtime)
    : undefined;
  // Unguarded, a sequence is one argv and the element count is what tmux
  // refuses; guarded, it is one quoted string and the byte count is. Two
  // budgets because they are two different limits, not two guesses at one.
  const results: (readonly string[])[] = [];

  for (const chunk of chunkToBudget(commands, daemon === undefined ? elementCost : byteCost)) {
    try {
      const args =
        daemon === undefined
          ? chainedArguments(chunk, marker)
          : guardedChainArguments(chunk, marker, daemon);
      // eslint-disable-next-line no-await-in-loop -- a later run must not start if an earlier one failed.
      const lines = await runCommand(runtime, args, options);
      results.push(...splitOnMarker(lines, marker));
    } catch (error) {
      if (!(error instanceof TmuxCommandError)) throw error;
      if (error.stderr.some((line) => refusedByGuardLine(line))) {
        // Every command in the chunk tested the same condition, so this is the
        // whole sequence refusing rather than one command failing. Nothing in
        // it applied.
        invalidateRuntimeEpoch(runtime);
        throw new TmuxServerRestarted(
          "tmux refused the sequence: the daemon on this socket is not the one these ids came from",
          { cause: error, subcommand: error.args[0] ?? "tmux" },
        );
      }
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
