/**
 * What this process decided before it started answering.
 *
 * An MCP server is configured entirely by the environment its client hands it,
 * which means every misconfiguration is silent by construction: the operator
 * who meant `inspect` and wrote `inspection` sees a server that starts, lists
 * tools, and works. Saying the effective policy once, out loud, is what turns
 * that into something a person can notice.
 */

import { TmuxTransportError } from "libtmux/errors";
import type { Server } from "libtmux/server";
import { isAbsolute, join } from "node:path";

import type { CallerEnvironment } from "./caller.js";
import type { Policy } from "./policy.js";

export interface StartupFacts {
  readonly caller: CallerEnvironment;
  /** The environment tmux followed when it was given no socket; the process's by default. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly policy: Policy;
  readonly server: Server;
  /** Whether a tmux server was already running on that socket. */
  readonly serverState: ServerState;
  readonly version: string;
}

export type ConfigurationProvenance = "unknown" | "user-configured";
export type ServerState = "absent" | "existing" | "unprobed";

/** Socket facts observed once, before the MCP surface is exposed. */
export interface ServerStartup {
  readonly attachCommand?: string;
  readonly configurationProvenance: ConfigurationProvenance;
  readonly resolvedSocketPath?: string | null;
  readonly serverState: ServerState;
}

/** Single-quote a value for POSIX shell, escaping any embedded `'`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The socket path tmux takes from `TMUX` when it is given no socket.
 *
 * tmux reads everything before the first comma, so a path holding one is cut
 * there, and a value that is not absolute names nothing.
 */
export function socketFromTmuxVariable(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const [path] = (environment.TMUX ?? "").split(",");
  return path !== undefined && isAbsolute(path) ? path : undefined;
}

/** Resolve the socket tmux would use without starting a daemon. */
export function resolvedSocketPath(
  server: Server,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (server.socketPath !== undefined) return server.socketPath;
  if (server.socketName === undefined) {
    const current = socketFromTmuxVariable(environment);
    if (current !== undefined) return current;
  }
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
 * An already-running daemon may have been started by anybody, so its
 * configuration is unknown. One that is absent gets whatever configuration tmux
 * loads when something starts it, which is the user's own.
 */
export async function inspectServerStartup(
  server: Server,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ServerStartup> {
  const selectedPath = resolvedSocketPath(server, environment);
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
  // An empty socket is a fact about the server. A tmux that cannot run at all is
  // a fact about this launch, and ends it with the executable named.
  await server.checkAlive().catch((error: unknown) => {
    if (error instanceof TmuxTransportError && error.kind === "spawn") throw error;
  });
  return Object.freeze({
    attachCommand: attachCommand(server, selectedPath),
    configurationProvenance: "user-configured",
    resolvedSocketPath: selectedPath,
    serverState: "absent",
  });
}

/**
 * The socket this server addresses, as an operator wrote it, or the one tmux
 * picked: the socket `TMUX` names inside tmux, otherwise `default`.
 */
function socketOf(
  server: Server,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return server.socketPath ?? server.socketName ?? socketFromTmuxVariable(environment) ?? "default";
}

/**
 * Whether a tmux server was already on the socket, which is the only notice
 * that an agent is sharing a daemon with whoever else is on it.
 */
const REACHED: Readonly<Record<ServerState, string>> = Object.freeze({
  absent: "serving",
  existing: "serving existing",
  unprobed: "serving",
});

/**
 * One line naming the authority this process is running with.
 *
 * Everything here answers a question somebody asks *after* something went
 * wrong: which tmux did it choose, had somebody else already started it, how
 * much was it allowed to do, and is it the pane I am typing in. A pane id means
 * nothing without its server, so the pane is named with the socket it lives on.
 */
export function describeStartup(facts: StartupFacts): string {
  const { caller, policy, server, serverState, version } = facts;
  const toolsets = [...policy.toolsets].sort().join(",") || "none";
  const narrowed = `, toolsets ${toolsets}, ${String(policy.tools.size)} named inclusions, ${String(policy.excludeTools.size)} exclusions`;
  const pane =
    caller.paneId === undefined
      ? ""
      : `, from pane ${caller.paneId}${caller.socketPath === undefined ? "" : ` on ${caller.socketPath}`}`;
  return `libtmux-mcp ${version} ${REACHED[serverState]} ${socketOf(server, facts.environment ?? process.env)}${narrowed}${pane}`;
}
