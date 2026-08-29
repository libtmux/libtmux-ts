/**
 * What every tool is handed: the server, the limits, and the live connections.
 *
 * Assembled once per process. Tools take a snapshot each rather than sharing
 * one, so two concurrent calls observe their own instants instead of racing on
 * mutable state.
 */

import type { ServerSnapshot } from "libtmux";
import type { Server } from "libtmux/server";

import {
  readCallerEnvironment,
  resolveCallerIdentity,
  type CallerEnvironment,
  type CallerIdentity,
} from "./caller.js";
import { LiveHub } from "./live.js";
import type { PaneTail } from "./pane_tail.js";
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
   * Say that this call may have changed the resource catalog's topology.
   *
   * Called once after each structural mutation attempt. Coalesced by the
   * notifier, so calling it freely is the point.
   */
  topologyChanged(): void;
}

/** Notify even when tmux may have applied a mutation before rejecting its result. */
export async function runTopologyMutation<T>(
  context: Pick<ToolContext, "topologyChanged">,
  mutation: () => Promise<T>,
): Promise<T> {
  try {
    return await mutation();
  } finally {
    context.topologyChanged();
  }
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
  caller: CallerEnvironment = readCallerEnvironment(),
): ToolContext & { close(): Promise<void> } {
  const hub = new LiveHub(tmux);
  return {
    close: () => hub.close(),
    hub,
    identity: (snapshot) => resolveCallerIdentity(tmux, snapshot, caller),
    policy,
    snapshot: () => withRecovery(tmux, tmux.snapshot()),
    tmux,
    topologyChanged,
  };
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
  from: string | undefined,
  paneId: string,
): CallToolResult | undefined {
  if (tail.endReason !== undefined) {
    const lost = tail.endReason === "events_dropped";
    return fail({
      hint:
        "Omit cursor to open a fresh stream, or use capture_pane for the rendered screen. " +
        "Do not retry with this cursor.",
      reason: lost
        ? `The live stream for pane ${paneId} lost events before this read, so its output is incomplete.`
        : `The live stream for pane ${paneId} ended before this read (${tail.endReason}).`,
    });
  }
  const problem = tail.cursorProblem(from);
  if (problem === undefined) return undefined;
  const detail =
    problem.kind === "ahead"
      ? `is ${String(problem.bytes)} byte${problem.bytes === 1 ? "" : "s"} past this stream`
      : problem.kind === "different_stream"
        ? "belongs to another pane or an earlier stream"
        : "is not a cursor this server issued";
  return fail({
    hint:
      "Omit cursor to start from what the pane shows now, then pass back the cursor " +
      "you are handed. A cursor does not carry across panes, or across a dropped " +
      "control connection.",
    reason: `Cursor ${String(from)} ${detail}; pane ${paneId} is now at ${tail.cursor}.`,
  });
}
