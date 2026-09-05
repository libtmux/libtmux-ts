#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Server } from "libtmux/server";

import { readCallerEnvironment } from "./caller.js";
import { createContext } from "./context.js";
import { buildInstructions } from "./instructions.js";
import { resolvePolicy, snapshotPolicy, TOOLSETS, type Policy } from "./policy.js";
import { assertKnownPolicyTools, ToolRegistry } from "./register.js";
import { registerCapture } from "./tools/capture.js";
import { registerDiscovery } from "./tools/discovery.js";
import { registerInput } from "./tools/input.js";
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
  MINIMAL_OWNER_ENVIRONMENT,
  type ServerStartup,
} from "./startup.js";

import manifest from "../package.json" with { type: "json" };

export type { Policy, Toolset } from "./policy.js";

/** The version this server reports, taken from the manifest so it cannot drift. */
const PACKAGE_VERSION: string = manifest.version;
const MINIMAL_CONFIG_PATH = fileURLToPath(new URL("../src/minimal.conf", import.meta.url));

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
  const defaultToolsets =
    startup.serverState === "created" && startup.configurationProvenance === "minimal"
      ? TOOLSETS
      : TOOLSETS.filter((toolset) => toolset !== "teardown");
  const policy = snapshotPolicy(
    options.policy ?? resolvePolicy(options.environment ?? process.env, defaultToolsets),
  );
  const context = createContext(tmux, policy, caller);
  const catalog = new ToolRegistry();
  registerDiscovery(catalog, context);
  registerCapture(catalog, context);
  registerSearch(catalog, context);
  registerInput(catalog, context);
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
  const socketSelector =
    tmux.socketPath === undefined
      ? `name:${tmux.socketName ?? "default"}`
      : `path:${tmux.socketPath}`;
  const defaultDedicated =
    tmux.socketPath === undefined &&
    tmux.socketName === "libtmux-mcp" &&
    startup.configurationProvenance === "minimal";
  const selectionProvenance = defaultDedicated ? "default-dedicated" : "operator-current";
  const disclosedSocketPath = startup.resolvedSocketPath ?? tmux.socketPath ?? null;
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
 * The library itself never reads these — a library that picks up ambient
 * configuration is a library that surprises its caller — which is why the
 * reading happens out here, at the edge that has a process to belong to.
 */
export function serverFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Server {
  if (Object.prototype.hasOwnProperty.call(environment, "LIBTMUX_SOCKET_NAME")) {
    throw new TypeError("LIBTMUX_SOCKET_NAME is retired; use LIBTMUX_SOCKET");
  }
  const hasSocketName = Object.prototype.hasOwnProperty.call(environment, "LIBTMUX_SOCKET");
  const hasSocketPath = Object.prototype.hasOwnProperty.call(environment, "LIBTMUX_SOCKET_PATH");
  if (hasSocketName && hasSocketPath) {
    throw new TypeError("set only one of LIBTMUX_SOCKET and LIBTMUX_SOCKET_PATH");
  }
  const socketName = environment.LIBTMUX_SOCKET ?? "libtmux-mcp";
  const socketPath = environment.LIBTMUX_SOCKET_PATH;
  const tmuxBin = environment.LIBTMUX_TMUX_BIN;
  const policy = resolvePolicy(environment);
  assertKnownPolicyTools(policy);
  if (hasSocketName && socketName === "") {
    throw new TypeError("LIBTMUX_SOCKET must not be empty");
  }
  if (socketPath !== undefined && !isAbsolute(socketPath)) {
    throw new TypeError("LIBTMUX_SOCKET_PATH must be absolute");
  }
  const configured = environment.LIBTMUX_TMUX_CONFIG;
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new TypeError("LIBTMUX_TMUX_CONFIG must be a nonempty absolute path");
  }
  const defaultDedicatedMinimal = !hasSocketName && !hasSocketPath && configured === undefined;
  const configFile = configured ?? (defaultDedicatedMinimal ? MINIMAL_CONFIG_PATH : undefined);
  return new Server({
    // Bounded here rather than in the library: this process answers a client
    // that is waiting, so "wait as long as tmux takes" is not an option it has.
    timeoutMs: policy.commandTimeoutMs,
    ...(configFile === undefined ? {} : { configFile }),
    ...(socketPath === undefined ? { socketName } : { socketPath }),
    environment,
    ...(tmuxBin === undefined || tmuxBin === "" ? {} : { tmuxBin }),
  });
}

/** Serve over stdio when run directly. */
export async function main(): Promise<void> {
  // Resolved once and handed to both, so the line cannot describe a policy
  // other than the one the tools were registered under.
  const explicitSelection =
    Object.prototype.hasOwnProperty.call(process.env, "LIBTMUX_SOCKET") ||
    Object.prototype.hasOwnProperty.call(process.env, "LIBTMUX_SOCKET_PATH") ||
    Object.prototype.hasOwnProperty.call(process.env, "LIBTMUX_TMUX_CONFIG");
  const launchEnvironment = explicitSelection
    ? process.env
    : { ...process.env, [MINIMAL_OWNER_ENVIRONMENT]: randomUUID() };
  const tmux = serverFromEnvironment(launchEnvironment);
  const startup = await inspectServerStartup(
    tmux,
    explicitSelection ? "user-configured" : "minimal",
    launchEnvironment,
  );
  const defaultToolsets =
    startup.serverState === "created" && startup.configurationProvenance === "minimal"
      ? TOOLSETS
      : TOOLSETS.filter((toolset) => toolset !== "teardown");
  const policy = resolvePolicy(process.env, defaultToolsets);
  const mcp = createTmuxMcpServer(tmux, { policy, startup });
  // stderr, because stdout is the protocol: a byte written there that is not
  // a JSON-RPC frame ends the session. Once, before serving, so a later
  // question about which tmux this process chose and how much it was allowed
  // to do has an answer that does not depend on reproducing the launch.
  process.stderr.write(
    `${describeStartup({
      caller: readCallerEnvironment(),
      policy,
      server: tmux,
      version: PACKAGE_VERSION,
    })}\n`,
  );
  await mcp.connect(new StdioServerTransport());
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

if (isProgram(process.argv[1])) {
  await main();
}
