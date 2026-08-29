import type { DaemonGuard } from "../../engine.js";
import { subcommandOf } from "./group.js";
import { quoteCommand } from "./lexer.js";
import type { CommandRequest } from "./types.js";

export type { DaemonGuard } from "../../engine.js";

/**
 * The branch taken when the daemon changed.
 *
 * Read-only and impossible: no session may be named this, so it always fails and
 * never touches anything. The name is the diagnostic — tmux prints
 * `can't find session: libtmux-daemon-restarted`, which reads correctly even
 * where nothing translated it.
 */
const RESTART_MARKER = "libtmux-daemon-restarted";
const ELSE_BRANCH: readonly string[] = Object.freeze(["list-windows", "-t", RESTART_MARKER]);

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
): readonly string[] {
  return Object.freeze([...connectionArgs, ...guardedChain(quoteCommand(subcommand), daemon)]);
}

/**
 * Wrap an already-serialized command list so tmux runs all of it or none.
 *
 * The list stays one list inside the branch, so a failure part-way through
 * still removes what follows it — the semantics a sequence documents. Guarding
 * each command separately would lose that: an error inside an `if-shell` branch
 * does not reach commands outside it.
 */
export function guardedChain(chain: string, daemon: DaemonGuard): readonly string[] {
  return Object.freeze([
    "if-shell",
    "-F",
    daemonCondition(daemon),
    chain,
    quoteCommand(ELSE_BRANCH),
  ]);
}

/**
 * Rebuild a request so tmux itself refuses it on the wrong daemon.
 *
 * The request form of {@link guardedArgv}, which is what a transport is handed.
 * Returned unchanged when there is nothing to guard: no guard was asked for,
 * or the command carries stdin — `load-buffer -` reads the client's stdin and
 * an `if-shell` branch is a command tmux runs for itself, and no command that
 * takes stdin addresses an object by id anyway.
 */
export function guardRequest(request: CommandRequest): CommandRequest {
  const daemon = request.daemonGuard;
  if (daemon === undefined || request.stdin !== undefined) return request;
  const subcommand = subcommandOf(request.args);
  if (subcommand.length === 0) return request;
  const connectionArgs = request.args.slice(0, request.args.length - subcommand.length);
  return { ...request, args: guardedArgv(connectionArgs, subcommand, daemon) };
}

/** Whether a failed result is the guard refusing rather than the command failing. */
export function refusedByGuard(returncode: number, stderr: Uint8Array): boolean {
  if (returncode === 0) return false;
  return new TextDecoder("utf-8", { fatal: false }).decode(stderr).includes(RESTART_MARKER);
}

/** The same question against one already-decoded stderr line. */
export function refusedByGuardLine(line: string): boolean {
  return line.includes(RESTART_MARKER);
}
