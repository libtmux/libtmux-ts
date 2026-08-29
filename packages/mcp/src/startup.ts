/**
 * What this process decided before it started answering.
 *
 * An MCP server is configured entirely by the environment its client hands it,
 * which means every misconfiguration is silent by construction: the operator
 * who meant `readonly` and wrote `read-only` sees a server that starts, lists
 * tools, and works. Saying the effective policy once, out loud, is what turns
 * that into something a person can notice.
 */

import type { Server } from "libtmux/server";

import type { CallerEnvironment } from "./caller.js";
import type { Policy } from "./policy.js";

export interface StartupFacts {
  readonly caller: CallerEnvironment;
  readonly policy: Policy;
  readonly server: Server;
  readonly version: string;
}

/** The socket this server addresses, as an operator wrote it. */
function socketOf(server: Server): string {
  return server.socketPath ?? server.socketName ?? "default";
}

/**
 * One line naming the authority this process is running with.
 *
 * Everything here answers a question somebody asks *after* something went
 * wrong: which tmux did it choose, how much was it allowed to do, and is it
 * the pane I am typing in.
 */
export function describeStartup(facts: StartupFacts): string {
  const { caller, policy, server, version } = facts;
  const narrowed =
    policy.tools === undefined
      ? ""
      : policy.tools.size === 0
        ? ", 0 tools allowed"
        : ", tool allowlist set";
  const pane = caller.paneId === undefined ? "" : `, from pane ${caller.paneId}`;
  return `libtmux-mcp ${version} serving ${socketOf(server)} at the ${policy.safety} tier${narrowed}${pane}`;
}
