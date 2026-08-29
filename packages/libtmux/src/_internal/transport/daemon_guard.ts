import type { DaemonGuard, GuardedTmuxRequest, TmuxCommand } from "../../engine.js";
import { TmuxTransportError } from "../../exc.js";
import { validateInvocation } from "./invocation.js";
import { quoteCommand } from "./lexer.js";
import { refusedUnknownCommand, uniqueUnknownCommand } from "./refusal.js";
import type { CommandRequest } from "./types.js";

export type { DaemonGuard } from "../../engine.js";

/** A raw tmux id, alone or as the session part of an exact placement. */
const TMUX_ID = /^[%@$]\d+(?::.*)?$/u;

/** Whether an argv addresses an object by an id only its own daemon can resolve. */
export function carriesTmuxId(args: readonly string[]): boolean {
  return args.some((argument) => TMUX_ID.test(argument));
}

/** The condition that is true only on the daemon a handle was read from. */
export function daemonCondition(daemon: DaemonGuard): string {
  return `#{==:#{pid}/#{start_time},${daemon.pid}/${daemon.startTime}}`;
}

/**
 * Wrap a subcommand so tmux runs it only on `daemon`.
 *
 * `connectionArgs` stay outside the wrapper: they select the server, and
 * `if-shell` is the first thing that server is asked to do.
 */
export function guardedArgv(
  connectionArgs: readonly string[],
  subcommand: readonly string[],
  daemon: DaemonGuard,
  refusal: string = uniqueUnknownCommand("daemon-restarted"),
): readonly string[] {
  return Object.freeze([
    ...connectionArgs,
    ...guardedChain(quoteCommand(subcommand), daemon, refusal),
  ]);
}

/**
 * Wrap an already-serialized command list so tmux runs all of it or none.
 *
 * The list stays one list inside the branch, so a failure part-way through
 * still removes what follows it — the semantics a sequence documents. Guarding
 * each command separately would lose that: an error inside an `if-shell` branch
 * does not reach commands outside it.
 */
export function guardedChain(
  chain: string,
  daemon: DaemonGuard,
  refusal: string = uniqueUnknownCommand("daemon-restarted"),
): TmuxCommand {
  return Object.freeze(["if-shell", "-F", daemonCondition(daemon), chain, quoteCommand([refusal])]);
}

/**
 * Prepare a request and the detector for its exact refusal command.
 *
 * The random command must stay paired with its detector. Recognising any value
 * with the same prefix would misclassify an ordinary unknown command as a
 * daemon restart.
 */
export function guardRequest(request: CommandRequest): GuardedTmuxRequest {
  validateInvocation(request);
  const daemon = request.daemonGuard;
  if (daemon === undefined) {
    return Object.freeze({ request, refusedBy: () => false });
  }
  if (request.stdin !== undefined) {
    throw new TmuxTransportError("a daemon-guarded command cannot carry stdin", {
      delivery: "not_started",
      kind: "protocol",
    });
  }
  const refusal = uniqueUnknownCommand("daemon-restarted");
  const chain = request.commands.map((command) => quoteCommand(command)).join(" ; ");
  const commands: readonly [TmuxCommand] = Object.freeze([guardedChain(chain, daemon, refusal)]);
  const guarded: CommandRequest = Object.freeze({
    ...request,
    commands,
  });
  return Object.freeze({
    request: guarded,
    refusedBy: (returncode: number, stderr: Uint8Array): boolean =>
      refusedUnknownCommand(refusal, returncode, stderr),
  });
}
