/**
 * What every tool is handed: the server, the limits, and the live connections.
 *
 * Assembled once per process. Tools take a snapshot each rather than sharing
 * one, so two concurrent calls observe their own instants instead of racing on
 * mutable state.
 */

import type { Pane, ServerSnapshot, Session, Window } from "libtmux";
import type { Server } from "libtmux/server";

import { resolveCallerIdentity, type CallerIdentity } from "./caller.js";
import { LiveHub } from "./live.js";
import type { Policy } from "./policy.js";
import { fail } from "./results.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolContext {
  readonly hub: LiveHub;
  identity(snapshot: ServerSnapshot): Promise<CallerIdentity>;
  readonly policy: Policy;
  snapshot(): Promise<ServerSnapshot>;
  readonly tmux: Server;
}

/**
 * Say what to do about a server that is not there.
 *
 * The library names the socket it tried, which is the whole answer for a
 * caller who chose it. An agent did not: an MCP client hands this process an
 * environment and nothing else, so the socket came from an operator and the
 * agent's only useful move is to say which one was wrong and how it is set.
 * Without that it reports "unavailable" and stops — which is what a real one
 * did, against a server that was running the whole time.
 */
export function describeUnreachable(tmux: Server, reason: string): string {
  const configured =
    tmux.socketPath !== undefined
      ? `LIBTMUX_SOCKET_PATH=${tmux.socketPath}`
      : tmux.socketName !== undefined
        ? `LIBTMUX_SOCKET_NAME=${tmux.socketName}`
        : "no socket configured, so tmux's default was used";
  return (
    `${reason}\n\nThis server was launched with ${configured}. That is set by whoever ` +
    `configured this MCP server, not by you — report it rather than retrying. ` +
    `Start a server there with new_session if creating one is what was wanted.`
  );
}

function withRecovery<T>(tmux: Server, work: Promise<T>): Promise<T> {
  return work.catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    if (!reason.startsWith("cannot reach tmux")) throw error;
    throw new Error(describeUnreachable(tmux, reason), { cause: error });
  });
}

export function createContext(
  tmux: Server,
  policy: Policy,
): ToolContext & { close(): Promise<void> } {
  const hub = new LiveHub(tmux);
  return {
    close: () => hub.close(),
    hub,
    identity: (snapshot) => resolveCallerIdentity(tmux, snapshot),
    policy,
    snapshot: () => withRecovery(tmux, tmux.snapshot()),
    tmux,
  };
}

/** How many alternatives an error lists before the list stops helping. */
const SUGGESTION_LIMIT = 12;

/**
 * Find a pane, or say what exists instead.
 *
 * A bare "no such pane" costs the agent a turn to discover what it should have
 * asked for. Naming the panes that do exist makes the failed call the last one.
 */
export function requirePane(snapshot: ServerSnapshot, paneId: string): CallToolResult | Pane {
  const pane = snapshot.panes.oneOrUndefined({ id: paneId });
  if (pane !== undefined) return pane;
  const available = snapshot.panes
    .toArray()
    .slice(0, SUGGESTION_LIMIT)
    .map(
      (entry) =>
        `${entry.id} (${entry.sessionName ?? "?"}:${entry.windowName ?? "?"} ${entry.currentCommand ?? "?"})`,
    );
  return fail({
    hint:
      available.length === 0
        ? "This server has no panes. Create one with new_session."
        : `Panes on this server: ${available.join(", ")}`,
    reason: `No pane ${paneId} on this server.`,
  });
}

export function requireSession(snapshot: ServerSnapshot, target: string): CallToolResult | Session {
  const byId = snapshot.sessions.oneOrUndefined({ id: target });
  if (byId !== undefined) return byId;
  const byName = snapshot.sessions.oneOrUndefined({ name: target });
  if (byName !== undefined) return byName;
  const available = snapshot.sessions
    .toArray()
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => `${entry.id} (${entry.name ?? "?"})`);
  return fail({
    hint:
      available.length === 0
        ? "This server has no sessions. Create one with new_session."
        : `Sessions on this server: ${available.join(", ")}`,
    reason: `No session ${target} on this server.`,
  });
}

export function requireWindow(snapshot: ServerSnapshot, target: string): CallToolResult | Window {
  const byId = snapshot.windows.oneOrUndefined({ id: target });
  if (byId !== undefined) return byId;
  const available = snapshot.windows
    .toArray()
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => `${entry.id} (${entry.sessionName ?? "?"}:${entry.name ?? "?"})`);
  return fail({
    hint:
      available.length === 0
        ? "This server has no windows."
        : `Windows on this server: ${available.join(", ")}`,
    reason: `No window ${target} on this server.`,
  });
}

/** Whether `requirePane` and its kin returned a failure rather than a handle. */
export function isFailure(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && "isError" in value;
}
