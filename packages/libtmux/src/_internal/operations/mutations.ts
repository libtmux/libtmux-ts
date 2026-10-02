import type {
  NewSessionOptions,
  NewWindowOptions,
  PlannedOperation,
  SplitOptions,
} from "../../types.js";
import type { CommandOptions } from "../../common.js";
import type { Pane } from "../../pane.js";
import type { Server } from "../../server.js";
import type { Session } from "../../session.js";
import type { Window } from "../../window.js";
import type { RuntimeContext } from "../runtime/context.js";
import { ObjectNotFoundError, TmuxCommandError } from "../../errors.js";
import { isColdEndpoint, runCommand } from "./command.js";
import {
  planKill,
  planKillPaneIfUnshared,
  planNewSession,
  planNewWindow,
  planSplitWindow,
} from "./plans.js";
import { buildServerSnapshot } from "./snapshot.js";

/**
 * Run one planned operation on its own, resolving what it made into a handle.
 *
 * The same description a batch would carry, spent on a single command: the
 * arguments go out, a snapshot comes back, and the plan reads its result from
 * it. Running one this way costs the snapshot that a batch would have shared,
 * which is the whole of the difference between the two.
 *
 * `options` reaches the command; its `signal` reaches that snapshot too,
 * because a caller who passed one means it for the create as a whole. A
 * snapshot takes no `timeoutMs` of its own — the server's applies. Dropping
 * either typed exactly like honouring it: `newSession({ signal })` ran
 * against an already-aborted signal and reported success.
 */
async function runPlan<T>(
  server: Server,
  runtime: RuntimeContext,
  plan: PlannedOperation<T>,
  options: CommandOptions = {},
): Promise<T> {
  const lines = await runCommand(runtime, plan.argv, options);
  return plan.resolve(await buildServerSnapshot(server, runtime, options.signal), lines);
}

export function newSession(
  server: Server,
  runtime: RuntimeContext,
  options: NewSessionOptions = {},
): Promise<Session> {
  return runPlan(server, runtime, planNewSession(options), options);
}

export function newWindow(
  server: Server,
  runtime: RuntimeContext,
  sessionId: string | null,
  options: NewWindowOptions = {},
): Promise<Window> {
  return runPlan(server, runtime, planNewWindow(sessionId, options), options);
}

export function splitWindow(
  server: Server,
  runtime: RuntimeContext,
  target: string | null,
  options: SplitOptions = {},
): Promise<Pane> {
  return runPlan(server, runtime, planSplitWindow(target, options), options);
}

export async function killTarget(
  runtime: RuntimeContext,
  command: "kill-pane" | "kill-session" | "kill-window",
  target: string | null,
): Promise<void> {
  await runCommand(runtime, planKill(command, target).argv);
}

/** Destroy a pane only while no other placement exposes its window. */
export async function killPaneIfWindowUnshared(
  runtime: RuntimeContext,
  target: string,
): Promise<void> {
  await runCommand(runtime, planKillPaneIfUnshared(target).argv);
}

export async function killServer(runtime: RuntimeContext): Promise<void> {
  await runCommand(runtime, ["kill-server"]);
}

const SESSION_ID = /^\$\d+$/u;

/**
 * Turn a session name into its id by exact comparison, for `new-session -t`.
 *
 * tmux resolves a bare `-t foo` as a unique prefix of a session name, so
 * grouping with `foo` silently joined `foobar`, and its `=foo` exact form
 * starts a group named `=foo` when no session has the name. The id is the one
 * spelling tmux cannot read as anything else; a name is looked up exactly.
 */
export async function exactSessionId(
  runtime: RuntimeContext,
  name: string,
  options: CommandOptions = {},
): Promise<string> {
  if (SESSION_ID.test(name)) return name;
  const rows = await runCommand(
    runtime,
    ["list-sessions", "-F", "#{session_id};#{session_name}"],
    options,
  );
  for (const row of rows) {
    const split = row.indexOf(";");
    if (split !== -1 && row.slice(split + 1) === name) return row.slice(0, split);
  }
  throw new ObjectNotFoundError({
    message: `No session named ${JSON.stringify(name)} to group with`,
    query: { name },
  });
}

/**
 * The session with this exact name, created when none exists.
 *
 * Two callers that both find none race to create it, and tmux refuses the
 * second with `duplicate session`; that caller returns the winner's session
 * instead of failing. A socket with no server is the ordinary first call, so
 * it creates one.
 */
export async function ensureSession(
  server: Server,
  runtime: RuntimeContext,
  options: NewSessionOptions & { readonly name: string },
): Promise<Session> {
  const find = async (): Promise<Session | undefined> => {
    let id: string;
    try {
      id = await exactSessionId(runtime, options.name, options);
    } catch (error) {
      if (error instanceof ObjectNotFoundError || isColdEndpoint(error)) return undefined;
      throw error;
    }
    return (await server.sessions()).first({ id });
  };
  const existing = await find();
  if (existing !== undefined) return existing;
  try {
    return await newSession(server, runtime, options);
  } catch (error) {
    if (
      error instanceof TmuxCommandError &&
      error.stderr.join("\n").includes("duplicate session")
    ) {
      const winner = await find();
      if (winner !== undefined) return winner;
    }
    throw error;
  }
}
