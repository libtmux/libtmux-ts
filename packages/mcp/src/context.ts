/**
 * What every tool is handed: the server, the limits, and the live connections.
 *
 * Assembled once per process. Tools take a snapshot each rather than sharing
 * one, so two concurrent calls observe their own instants instead of racing on
 * mutable state.
 */

import type { Pane, ServerSnapshot, Session, Window } from "libtmux";
import type { Server } from "libtmux/server";

import { isAttended, isCallerPane, resolveCallerIdentity, type CallerIdentity } from "./caller.js";
import { LiveHub, type PaneTail } from "./live.js";
import type { Policy } from "./policy.js";
import { fail } from "./results.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolContext {
  readonly hub: LiveHub;
  identity(snapshot: ServerSnapshot): Promise<CallerIdentity>;
  readonly policy: Policy;
  snapshot(): Promise<ServerSnapshot>;
  readonly tmux: Server;
  /**
   * Say that this call changed which sessions, windows or panes exist.
   *
   * Called from the success path of every tool that adds, removes or renames
   * one. Coalesced by the notifier, so calling it freely is the point.
   */
  topologyChanged(): void;
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
  // Name the knob that is actually wrong. A bad executable and a bad socket
  // both surface as "cannot reach tmux", and sending an operator to check the
  // socket when the binary is missing sends them to a healthy thing — this
  // text exists because nobody but a human can fix a launch-time setting, so
  // pointing at the wrong one wastes the only channel that could.
  const configured = [
    ...(tmux.tmuxBin === "tmux" ? [] : [`LIBTMUX_TMUX_BIN=${tmux.tmuxBin}`]),
    ...(tmux.socketPath === undefined
      ? tmux.socketName === undefined
        ? []
        : [`LIBTMUX_SOCKET_NAME=${tmux.socketName}`]
      : [`LIBTMUX_SOCKET_PATH=${tmux.socketPath}`]),
  ];
  const launched =
    configured.length === 0
      ? "nothing configured, so tmux's own defaults were used"
      : configured.join(" and ");
  return (
    `${reason}\n\nThis server was launched with ${launched}. That is set by whoever ` +
    `configured this MCP server, not by you — report it rather than retrying. ` +
    `Start a server there with new_session if creating one is what was wanted.`
  );
}

function withRecovery<T>(tmux: Server, work: Promise<T>): Promise<T> {
  return work.catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    // A version probe that comes back with nothing is the same class of
    // problem: something was configured that is not a usable tmux, and no
    // amount of retrying by an agent will change it. It reached here without
    // the guidance because it does not share the wording.
    const unreachable =
      reason.startsWith("cannot reach tmux") ||
      reason.includes("version probe returned no version");
    if (!unreachable) throw error;
    throw new Error(describeUnreachable(tmux, reason), { cause: error });
  });
}

export function createContext(
  tmux: Server,
  policy: Policy,
  topologyChanged: () => void = () => undefined,
): ToolContext & { close(): Promise<void> } {
  const hub = new LiveHub(tmux);
  return {
    close: () => hub.close(),
    hub,
    identity: (snapshot) => resolveCallerIdentity(tmux, snapshot),
    policy,
    snapshot: () => withRecovery(tmux, tmux.snapshot()),
    tmux,
    topologyChanged,
  };
}

/** How many alternatives an error lists before the list stops helping. */
const SUGGESTION_LIMIT = 12;

/**
 * Name some of what exists, and say when that is not all of it.
 *
 * A list that stops at twelve with no marker reads as the whole list, so an
 * agent that does not find what it asked for concludes it is not there — and
 * on a busy server the twelve shown are rarely the twelve it wants. Naming the
 * remainder and the tool that lists it costs one clause.
 */
function suggest(all: readonly string[], listing: string): string {
  const shown = all.slice(0, SUGGESTION_LIMIT);
  const rest = all.length - shown.length;
  return rest === 0
    ? shown.join(", ")
    : `${shown.join(", ")}, and ${String(rest)} more — ${listing} lists them all`;
}

/**
 * The pane operations that put input into a pane, or end what runs in it.
 *
 * Named so the type system can withhold them. Resizing and retitling are not
 * here: they rearrange a pane without reaching the program inside it.
 */
type PaneWrite = "kill" | "pasteBuffer" | "respawn" | "sendKeys";

/**
 * A pane resolved for reading and arranging, but not for writing into.
 *
 * `requirePane` hands this back so that a tool which goes on to type into the
 * pane does not compile. The guard used to be a per-tool convention, and three
 * write tools were shipped without it; withholding the methods is what makes
 * the next one impossible rather than merely discouraged.
 */
export type ReadablePane = Omit<Pane, PaneWrite>;

function paneNotFound(snapshot: ServerSnapshot, paneId: string): CallToolResult {
  const available = snapshot.panes
    .toArray()
    .map(
      (entry) =>
        `${entry.id} (${entry.session?.name ?? "?"}:${entry.window?.name ?? "?"} ${entry.currentCommand ?? "?"})`,
    );
  return fail({
    hint:
      available.length === 0
        ? "This server has no panes. Create one with new_session."
        : `Panes on this server: ${suggest(available, "list_panes")}`,
    reason: `No pane ${paneId} on this server.`,
  });
}

/**
 * Find a pane, or say what exists instead.
 *
 * A bare "no such pane" costs the agent a turn to discover what it should have
 * asked for. Naming the panes that do exist makes the failed call the last one.
 */
export function requirePane(
  snapshot: ServerSnapshot,
  paneId: string,
): CallToolResult | ReadablePane {
  return snapshot.panes.oneOrUndefined({ id: paneId }) ?? paneNotFound(snapshot, paneId);
}

/**
 * Find a pane this caller is cleared to write into.
 *
 * Refuses the terminal this server is running in and panes a person is
 * watching: typing into either puts irreversible input in front of a person.
 * `force` is how a caller says it meant that pane. `verb` names the act in the
 * refusal, because "refusing to restart" and "refusing to type into" send a
 * caller to different remedies.
 */
export function requireWritablePane(
  snapshot: ServerSnapshot,
  identity: CallerIdentity,
  paneId: string,
  force: boolean | undefined,
  verb = "write into",
): CallToolResult | Pane {
  const pane = snapshot.panes.oneOrUndefined({ id: paneId });
  if (pane === undefined) return paneNotFound(snapshot, paneId);
  if (force !== true && isCallerPane(identity, paneId)) {
    return fail({
      hint: "That is this server's own terminal. Pick another pane, or pass force to mean it.",
      reason: `Refusing to ${verb} ${paneId}: it is the pane this MCP server runs in.`,
    });
  }
  if (force !== true && isAttended(identity, paneId)) {
    return fail({
      hint: "whoami lists who is attached. Pick another pane, or pass force to mean it.",
      reason: `Refusing to ${verb} ${paneId}: a person is watching that pane.`,
    });
  }
  return pane;
}

/**
 * Refuse a cursor that belongs to a different stream.
 *
 * The alternative is the worst answer this server can give: "nothing new",
 * forever, about a pane that is printing. Saying where the stream actually is
 * makes the next call the right one.
 */
export function requireLiveCursor(
  tail: PaneTail,
  from: number | undefined,
  paneId: string,
): CallToolResult | undefined {
  const ahead = tail.ahead(from);
  if (ahead === 0) return undefined;
  return fail({
    hint:
      "Omit cursor to start from what the pane shows now, then pass back the cursor " +
      "you are handed. A cursor does not carry across panes, or across a dropped " +
      "control connection.",
    reason:
      `Cursor ${String(from)} is ${String(ahead)} byte${ahead === 1 ? "" : "s"} past everything ` +
      `pane ${paneId} has ` +
      `streamed, which is now at ${String(tail.cursor)}.`,
  });
}

export function requireSession(snapshot: ServerSnapshot, target: string): CallToolResult | Session {
  const byId = snapshot.sessions.oneOrUndefined({ id: target });
  if (byId !== undefined) return byId;
  const byName = snapshot.sessions.oneOrUndefined({ name: target });
  if (byName !== undefined) return byName;
  const available = snapshot.sessions
    .toArray()
    .map((entry) => `${entry.id} (${entry.name ?? "?"})`);
  return fail({
    hint:
      available.length === 0
        ? "This server has no sessions. Create one with new_session."
        : `Sessions on this server: ${suggest(available, "list_sessions")}`,
    reason: `No session ${target} on this server.`,
  });
}

export function requireWindow(snapshot: ServerSnapshot, target: string): CallToolResult | Window {
  const byId = snapshot.windows.oneOrUndefined({ id: target });
  if (byId !== undefined) return byId;
  const available = snapshot.windows
    .toArray()
    .map((entry) => `${entry.id} (${entry.session?.name ?? "?"}:${entry.name ?? "?"})`);
  return fail({
    hint:
      available.length === 0
        ? "This server has no windows."
        : `Windows on this server: ${suggest(available, "list_windows")}`,
    reason: `No window ${target} on this server.`,
  });
}

/** Whether `requirePane` and its kin returned a failure rather than a handle. */
export function isFailure(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && "isError" in value;
}
