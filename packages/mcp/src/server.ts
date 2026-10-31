#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { TmuxTransportError } from "libtmux/errors";
import { Server } from "libtmux/server";

import { readCallerEnvironment } from "./caller.js";
import { createContext } from "./context.js";
import { buildInstructions } from "./instructions.js";
import { resolvePolicy, snapshotPolicy, type Policy } from "./policy.js";
import { boundRequestIds } from "./protocol_transport.js";
import { assertKnownPolicyTools, ToolRegistry } from "./register.js";
import { assertSafeRouteValue } from "./route.js";
import { registerCapture } from "./tools/capture.js";
import { registerDiscovery } from "./tools/discovery.js";
import { registerInput } from "./tools/input.js";
import { registerPrograms } from "./tools/programs.js";
import { registerLayout } from "./tools/layout.js";
import { registerLifecycle } from "./tools/lifecycle.js";
import { registerSearch } from "./tools/search.js";
import { registerSettings } from "./tools/settings.js";
import { registerWait } from "./tools/wait.js";
import { registerTargetTools } from "./tools/target.js";
import { registerResources } from "./resources.js";
import {
  attachCommand,
  describeStartup,
  inspectServerStartup,
  type ServerStartup,
} from "./startup.js";

import manifest from "../package.json" with { type: "json" };

export type { Policy, Toolset } from "./policy.js";

/** The version this server reports, taken from the manifest so it cannot drift. */
const PACKAGE_VERSION: string = manifest.version;

/**
 * An MCP server exposing a tmux server through libtmux.
 *
 * Instructions are built at construction rather than at handshake because they
 * carry where this process is running, which cannot change while it runs.
 */
export function createTmuxMcpServer(
  tmux: Server,
  options: {
    /** Complete environment identifying the host process's tmux pane. */
    readonly callerEnvironment?: Readonly<Record<string, string | undefined>>;
    /** Complete environment from which to resolve MCP tool policy. */
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly policy?: Policy;
    /** Socket state and configuration provenance pinned before registration. */
    readonly startup?: ServerStartup;
  } = {},
): McpServer {
  const caller = readCallerEnvironment(options.callerEnvironment ?? process.env);
  const startup: ServerStartup = Object.freeze(
    options.startup ?? {
      configurationProvenance: "unknown",
      serverState: "unprobed",
    },
  );
  const policy = snapshotPolicy(
    options.policy ?? resolvePolicy(options.environment ?? process.env),
  );
  const context = createContext(tmux, policy, caller);
  const catalog = new ToolRegistry();
  registerDiscovery(catalog, context);
  registerCapture(catalog, context);
  registerSearch(catalog, context);
  registerInput(catalog, context);
  const programs = registerPrograms(catalog, context);
  registerLifecycle(catalog, context);
  registerLayout(catalog, context);
  registerSettings(catalog, context);
  registerWait(catalog, context);
  registerTargetTools(catalog, context);
  const resolved = catalog.resolve(policy);

  // Resolution and validation finish before the SDK core exists, and before a
  // lazy libtmux Server has any reason to open its selected socket.
  const mcp = new McpServer(
    { name: "libtmux", title: "tmux", version: PACKAGE_VERSION },
    { instructions: buildInstructions(policy, caller, resolved.names) },
  );
  resolved.register(mcp);
  if (resolved.definitions.length === 0) {
    mcp.server.registerCapabilities({ tools: {} });
    mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }
  const socketSelector = context.route.selector;
  const selectionProvenance =
    context.route.socketPath !== undefined
      ? "socket-path"
      : context.route.socketName !== undefined
        ? "socket-name"
        : "tmux-choice";
  const disclosedSocketPath = startup.resolvedSocketPath ?? context.route.socketPath ?? null;
  const capabilityReport = Object.freeze({
    boundary: Object.freeze({
      dynamicResources: false,
      hostCommandExecution: false,
      oneSocketPerProcess: true,
      perCallSocketSelection: false,
    }),
    connection: Object.freeze({
      attachCommand: startup.attachCommand ?? attachCommand(tmux, disclosedSocketPath),
      configurationProvenance: startup.configurationProvenance,
      resolvedSocketPath: disclosedSocketPath,
      serverState: startup.serverState,
      socketProvenance: selectionProvenance,
      socketSelector,
    }),
    contractVersion: 1,
    executionAuthority: "tmux-user",
    excludeTools: Object.freeze([...policy.excludeTools].sort()),
    hostCommandTools: 0,
    frozen: true,
    operatingSystemBoundary: "none",
    schemaVersion: 1,
    selectedToolsets: Object.freeze([...policy.toolsets].sort()),
    socket: Object.freeze({
      configurationProvenance: startup.configurationProvenance,
      namespaceBoundary: "tmux-objects-only",
      selectionProvenance,
      selector: socketSelector,
      serverState: startup.serverState,
    }),
    toolCount: resolved.definitions.length,
    toolFilteringBoundary: "interface-shaping-not-authorization",
    ...resolved.report(),
  });
  const disposeResources = registerResources(mcp, capabilityReport);

  let backendClose: Promise<void> | undefined;
  const closeBackend = (): Promise<void> => {
    backendClose ??= (async () => {
      try {
        await programs.close();
        await disposeResources();
      } finally {
        await context.close();
      }
    })();
    return backendClose;
  };
  mcp.server.onclose = (): void => {
    void closeBackend().catch(() => undefined);
  };

  // The protocol close callback is synchronous. Embedded callers still need
  // `close()` to mean every control process has actually left.
  const closeProtocol = mcp.close.bind(mcp);
  let serverClose: Promise<void> | undefined;
  mcp.close = (): Promise<void> => {
    serverClose ??= closeProtocol().then(
      () => closeBackend(),
      async (error: unknown) => {
        await closeBackend();
        throw error;
      },
    );
    return serverClose;
  };

  return mcp;
}

/**
 * The tmux server this process was pointed at.
 *
 * An MCP client launches this with an environment and a command line, and
 * nothing else, so the environment is the only place a socket can come from.
 * The library reads `LIBTMUX_SOCKET_PATH`, else `LIBTMUX_SOCKET`, from it; with
 * neither set no socket is passed and tmux picks the server, which inside tmux
 * is the one `TMUX` names. What the library chose is checked here, at the edge
 * that has a process to answer for it.
 */
export function serverFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Server {
  if (Object.prototype.hasOwnProperty.call(environment, "LIBTMUX_SOCKET_NAME")) {
    throw new TypeError("LIBTMUX_SOCKET_NAME is retired; use LIBTMUX_SOCKET");
  }
  const tmuxBin = environment.LIBTMUX_TMUX_BIN;
  const policy = resolvePolicy(environment);
  assertKnownPolicyTools(policy);
  assertSafeRouteValue(
    "LIBTMUX_TMUX_BIN",
    tmuxBin === undefined || tmuxBin === "" ? "tmux" : tmuxBin,
  );
  const configFile = environment.LIBTMUX_TMUX_CONFIG;
  if (configFile !== undefined && !isAbsolute(configFile)) {
    throw new TypeError("LIBTMUX_TMUX_CONFIG must be a nonempty absolute path");
  }
  const server = new Server({
    // Bounded here rather than in the library: this process answers a client
    // that is waiting, so "wait as long as tmux takes" is not an option it has.
    timeoutMs: policy.commandTimeoutMs,
    ...(configFile === undefined ? {} : { configFile }),
    environment,
    ...(tmuxBin === undefined || tmuxBin === "" ? {} : { tmuxBin }),
  });
  if (server.socketPath !== undefined) {
    assertSafeRouteValue("LIBTMUX_SOCKET_PATH", server.socketPath);
    if (!isAbsolute(server.socketPath)) {
      throw new TypeError("LIBTMUX_SOCKET_PATH must be absolute");
    }
  } else if (server.socketName !== undefined) {
    assertSafeRouteValue("LIBTMUX_SOCKET", server.socketName);
  }
  return server;
}

/** Serve until stdin or the protocol closes, then join the backend. */
export async function main(): Promise<void> {
  // Resolved once and handed to both, so the line cannot describe a policy
  // other than the one the tools were registered under.
  const tmux = serverFromEnvironment(process.env);
  const startup = await inspectServerStartup(tmux, process.env);
  const policy = resolvePolicy(process.env);
  const mcp = createTmuxMcpServer(tmux, { policy, startup });
  // stderr, because stdout is the protocol: a byte written there that is not
  // a JSON-RPC frame ends the session. Once, before serving, so a later
  // question about which tmux this process chose and how much it was allowed
  // to do has an answer that does not depend on reproducing the launch.
  process.stderr.write(
    `${describeStartup({
      caller: readCallerEnvironment(),
      environment: process.env,
      policy,
      server: tmux,
      serverState: startup.serverState,
      version: PACKAGE_VERSION,
    })}\n`,
  );
  const closed = Promise.withResolvers<void>();
  const onClose = mcp.server.onclose;
  mcp.server.onclose = (): void => {
    onClose?.();
    closed.resolve();
  };
  const onEnd = (): void => {
    closed.resolve();
  };
  // A signal shuts down as stdin's end does and exits with that signal's status;
  // a second signal kills at once.
  const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
  const stopHandling = (): void => {
    for (const signal of signals) process.off(signal, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    stopHandling();
    process.exitCode = 128 + osConstants.signals[signal];
    closed.resolve();
  };
  process.stdin.once("end", onEnd);
  for (const signal of signals) process.on(signal, onSignal);
  try {
    await mcp.connect(boundRequestIds(new StdioServerTransport()));
    if (!process.stdin.readableEnded && !process.stdin.destroyed) await closed.promise;
  } finally {
    process.stdin.off("end", onEnd);
    stopHandling();
    await mcp.close();
  }
}

/**
 * Run when this file is the program, not when it is imported.
 *
 * Compared by URL rather than by `import.meta.main`, which Node does not have,
 * so the same file serves under both runtimes.
 *
 * Through the real path on both sides, because npm installs a `bin` as a
 * symlink: invoked that way `process.argv[1]` is the link and `import.meta.url`
 * is what it points at, so comparing them raw is always false and the server
 * exits without serving. Silently, and with status 0 — a client sees a server
 * that starts and offers nothing.
 */
function isProgram(entry: string | undefined): boolean {
  if (entry === undefined) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/**
 * One actionable line for a failure that happened before serving began.
 *
 * stdout is the protocol, so stderr is the whole diagnostic channel, and an MCP
 * client surfaces it as the reason a server would not start. `spawn`/`ENOENT`
 * is separated because Node reports it as `spawn tmux ENOENT`, which reads as
 * tmux refusing rather than tmux being absent.
 */
export function describeStartupFailure(
  error: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (error instanceof TmuxTransportError && error.kind === "spawn") {
    const cause: unknown = error.cause;
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      const configured = environment.LIBTMUX_TMUX_BIN;
      const named = configured === undefined || configured === "" ? "tmux" : configured;
      return `cannot execute ${named}: install tmux, or set LIBTMUX_TMUX_BIN to its path`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

if (isProgram(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`libtmux-mcp: ${describeStartupFailure(error)}\n`);
    process.exitCode = 1;
  }
}
