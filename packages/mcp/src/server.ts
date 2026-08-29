#!/usr/bin/env node
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Server } from "libtmux/server";

import { readCallerEnvironment } from "./caller.js";
import { createContext } from "./context.js";
import { buildInstructions } from "./instructions.js";
import { resolvePolicy, type Policy } from "./policy.js";
import { offeredTools } from "./register.js";
import { registerCapture } from "./tools/capture.js";
import { registerDiscovery } from "./tools/discovery.js";
import { registerInput } from "./tools/input.js";
import { registerLayout } from "./tools/layout.js";
import { registerLifecycle } from "./tools/lifecycle.js";
import { registerSettings } from "./tools/settings.js";
import { registerWait } from "./tools/wait.js";
import { registerWorkspace } from "./tools/workspace.js";
import { registerPrompts } from "./prompts.js";
import { createListChangedNotifier, registerResources } from "./resources.js";
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
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly policy?: Policy;
  } = {},
): McpServer {
  const environment = options.environment ?? process.env;
  const policy = options.policy ?? resolvePolicy(environment);
  const mcp = new McpServer(
    { name: "libtmux", title: "tmux", version: PACKAGE_VERSION },
    {
      instructions: buildInstructions(policy, readCallerEnvironment(environment)),
      // Tasks live for one process. A wait outlives neither the connection that
      // asked for it nor the tmux server it watches, so nothing here is worth
      // the durability an external store would buy.
      taskStore: new InMemoryTaskStore(),
    },
  );

  // Built after the server so a tool can say the resource list changed; the
  // notifier needs somewhere to send it.
  const context = createContext(tmux, policy, createListChangedNotifier(mcp));

  // Every tool registers against the filtered view, so the allowlist cannot be
  // half-applied by a module that forgot it.
  const offered = offeredTools(mcp, policy);
  registerDiscovery(offered, context);
  registerCapture(offered, context);
  registerInput(offered, context);
  registerLifecycle(offered, context);
  registerLayout(offered, context);
  registerSettings(offered, context);
  registerWait(offered, context);
  registerWorkspace(offered, context);
  registerResources(mcp, context);
  registerPrompts(mcp, context);

  // Each watched session holds a `tmux -C attach` for as long as something is
  // reading it. Losing the client is the end of every reason to hold one, and
  // a control client nobody closes stays attached until the daemon does.
  const closed = mcp.server.onclose;
  mcp.server.onclose = (): void => {
    void context.close();
    closed?.();
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
