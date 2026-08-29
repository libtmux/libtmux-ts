#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Server } from "libtmux/server";

import { readCallerEnvironment } from "./caller.js";
import { createContext } from "./context.js";
import { buildInstructions } from "./instructions.js";
import { resolvePolicy, snapshotPolicy, type Policy } from "./policy.js";
import { offeredTools } from "./register.js";
import { registerBuffers } from "./tools/buffers.js";
import { registerCapture } from "./tools/capture.js";
import { registerDiscovery } from "./tools/discovery.js";
import { registerInput } from "./tools/input.js";
import { registerLayout } from "./tools/layout.js";
import { registerLifecycle } from "./tools/lifecycle.js";
import { registerSearch } from "./tools/search.js";
import { registerSettings } from "./tools/settings.js";
import { registerWait } from "./tools/wait.js";
import { registerWorkspace } from "./tools/workspace.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { createListChangedNotifier } from "./resource_watch.js";
import { describeStartup } from "./startup.js";

import manifest from "../package.json" with { type: "json" };

export type { Policy, SafetyTier } from "./policy.js";

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
  } = {},
): McpServer {
  const caller = readCallerEnvironment(options.callerEnvironment ?? process.env);
  const policy = snapshotPolicy(
    options.policy ?? resolvePolicy(options.environment ?? process.env),
  );
  const mcp = new McpServer(
    { name: "libtmux", title: "tmux", version: PACKAGE_VERSION },
    {
      instructions: buildInstructions(policy, caller),
    },
  );

  // Built after the server so a tool can say the resource list changed; the
  // notifier needs somewhere to send it.
  const context = createContext(tmux, policy, createListChangedNotifier(mcp), caller);

  // Every tool registers against the filtered view, so the allowlist cannot be
  // half-applied by a module that forgot it.
  const registeredTools = new Set<string>();
  const offered = offeredTools(mcp, policy, registeredTools);
  registerDiscovery(offered, context);
  registerCapture(offered, context);
  registerSearch(offered, context);
  registerBuffers(offered, context);
  registerInput(offered, context);
  registerLifecycle(offered, context);
  registerLayout(offered, context);
  registerSettings(offered, context);
  registerWait(offered, context);
  registerWorkspace(offered, context);
  const disposeResources = registerResources(mcp, context);
  registerPrompts(mcp, context, registeredTools);

  let backendClose: Promise<void> | undefined;
  const closeBackend = (): Promise<void> => {
    backendClose ??= (async () => {
      try {
        disposeResources();
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
  const socketPath = environment.LIBTMUX_SOCKET_PATH;
  const socketName = environment.LIBTMUX_SOCKET_NAME;
  const tmuxBin = environment.LIBTMUX_TMUX_BIN;
  const policy = resolvePolicy(environment);
  return new Server({
    // Bounded here rather than in the library: this process answers a client
    // that is waiting, so "wait as long as tmux takes" is not an option it has.
    timeoutMs: policy.commandTimeoutMs,
    ...(socketPath === undefined || socketPath === "" ? {} : { socketPath }),
    ...(socketName === undefined || socketName === "" ? {} : { socketName }),
    ...(tmuxBin === undefined || tmuxBin === "" ? {} : { tmuxBin }),
  });
}

/** Serve over stdio when run directly. */
export async function main(): Promise<void> {
  // Resolved once and handed to both, so the line cannot describe a policy
  // other than the one the tools were registered under.
  const policy = resolvePolicy();
  const tmux = serverFromEnvironment();
  const mcp = createTmuxMcpServer(tmux, { policy });
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
