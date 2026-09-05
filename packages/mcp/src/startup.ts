/**
 * What this process decided before it started answering.
 *
 * An MCP server is configured entirely by the environment its client hands it,
 * which means every misconfiguration is silent by construction: the operator
 * who meant `inspect` and wrote `inspection` sees a server that starts, lists
 * tools, and works. Saying the effective policy once, out loud, is what turns
 * that into something a person can notice.
 */

import type { Server } from "libtmux/server";
import { join } from "node:path";

import type { CallerEnvironment } from "./caller.js";
import type { Policy } from "./policy.js";

export interface StartupFacts {
  readonly caller: CallerEnvironment;
  readonly policy: Policy;
  readonly server: Server;
  readonly version: string;
}

export type ConfigurationProvenance = "minimal" | "unknown" | "user-configured";
export type ServerState = "absent" | "created" | "existing" | "unprobed";

export const MINIMAL_OWNER_ENVIRONMENT = "LIBTMUX_MCP_LAUNCH_NONCE";
const MINIMAL_OWNER_OPTION = "@libtmux-mcp-owner";

/** Socket facts observed once, before the MCP surface is exposed. */
export interface ServerStartup {
  readonly attachCommand?: string;
  readonly configurationProvenance: ConfigurationProvenance;
  readonly resolvedSocketPath?: string | null;
  readonly serverState: ServerState;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Resolve a named socket the same way tmux does without starting a daemon. */
export function resolvedSocketPath(
  server: Server,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (server.socketPath !== undefined) return server.socketPath;
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const base = environment.TMUX_TMPDIR;
  return join(
    base === undefined || base === "" ? "/tmp" : base,
    `tmux-${String(uid)}`,
    server.socketName ?? "default",
  );
}

/** A shell-safe observer command that refuses to create an absent server. */
export function attachCommand(server: Server, socketPath: string | null): string {
  const selector =
    socketPath === null
      ? `-L ${shellQuote(server.socketName ?? "default")}`
      : `-S ${shellQuote(socketPath)}`;
  return `${shellQuote(server.tmuxBin)} -N ${selector} attach`;
}

/**
 * Pin the startup facts used for policy and reporting.
 *
 * A configured null file proves only what a server started by this process
 * will load. An already-running daemon may have been started by anybody, so
 * its configuration remains unknown regardless of this client's `-f` flag.
 */
export async function inspectServerStartup(
  server: Server,
  absentConfiguration: ConfigurationProvenance = "user-configured",
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ServerStartup> {
  const selectedPath = resolvedSocketPath(server, environment);
  if (absentConfiguration === "minimal") {
    const expectedOwner = environment[MINIMAL_OWNER_ENVIRONMENT];
    if (expectedOwner === undefined || expectedOwner === "") {
      throw new TypeError(`${MINIMAL_OWNER_ENVIRONMENT} must identify the minimal launch`);
    }
    await server.cmd("start-server");
    const [observedOwner] = await server.cmd("show-options", ["-gqv", MINIMAL_OWNER_OPTION]);
    let observedPath = selectedPath;
    try {
      const lines = await server.cmd("display-message", ["-p", "#{socket_path}"], {
        target: null,
      });
      if (lines[0] !== undefined && lines[0] !== "") observedPath = lines[0];
    } catch {
      // Keep the already-resolved selector if the daemon exits during disclosure.
    }
    const created = observedOwner === expectedOwner;
    return Object.freeze({
      attachCommand: attachCommand(server, observedPath),
      configurationProvenance: created ? "minimal" : "unknown",
      resolvedSocketPath: observedPath,
      serverState: created ? "created" : "existing",
    });
  }
  if (await server.isAlive()) {
    let observedPath = selectedPath;
    try {
      const lines = await server.cmd("display-message", ["-p", "#{socket_path}"], {
        target: null,
      });
      if (lines[0] !== undefined && lines[0] !== "") observedPath = lines[0];
    } catch {
      // The daemon can exit between the no-start probe and this disclosure read.
    }
    return Object.freeze({
      attachCommand: attachCommand(server, observedPath),
      configurationProvenance: "unknown",
      resolvedSocketPath: observedPath,
      serverState: "existing",
    });
  }
  return Object.freeze({
    attachCommand: attachCommand(server, selectedPath),
    configurationProvenance: absentConfiguration,
    resolvedSocketPath: selectedPath,
    serverState: "absent",
  });
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
  const toolsets = [...policy.toolsets].sort().join(",") || "none";
  const narrowed = `, toolsets ${toolsets}, ${String(policy.tools.size)} named inclusions, ${String(policy.excludeTools.size)} exclusions`;
  const pane = caller.paneId === undefined ? "" : `, from pane ${caller.paneId}`;
  return `libtmux-mcp ${version} serving ${socketOf(server)}${narrowed}${pane}`;
}
