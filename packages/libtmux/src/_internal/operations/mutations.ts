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
import { runCommand } from "./command.js";
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
