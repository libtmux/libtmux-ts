import { expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../src/context.js";
import { resolvePolicy } from "../src/policy.js";
import { registerWorkspace } from "../src/tools/workspace.js";

interface WindowSpec {
  readonly name: string;
  readonly startDirectory?: string;
}

interface WorkspaceArguments {
  readonly session: string;
  readonly startDirectory?: string;
  readonly windows: readonly WindowSpec[];
}

type WorkspaceHandler = (arguments_: WorkspaceArguments) => Promise<unknown>;

test("each workspace window keeps its own start directory", async () => {
  const handlers = new Map<string, WorkspaceHandler>();
  const mcp = {
    registerTool(name: string, _configuration: unknown, handler: WorkspaceHandler): object {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as McpServer;

  const sessionOptions: unknown[] = [];
  const windowOptions: unknown[] = [];
  const snapshot = {
    panes: { toArray: () => [] },
    sessions: { exists: () => false },
    windows: { toArray: () => [] },
  };
  const context = {
    identity: async () => ({}),
    policy: resolvePolicy({ LIBTMUX_SAFETY: "mutating" }),
    snapshot: async () => snapshot,
    tmux: {
      batch: async () => [],
      newSession: async (options: unknown) => {
        sessionOptions.push(options);
        return {
          id: "$1",
          plan: {
            newWindow(options: unknown): object {
              windowOptions.push(options);
              return {};
            },
          },
        };
      },
    },
    topologyChanged: () => undefined,
  } as unknown as ToolContext;

  registerWorkspace(mcp, context);
  const buildWorkspace = handlers.get("build_workspace");
  if (buildWorkspace === undefined) throw new Error("build_workspace was not registered");

  await buildWorkspace({
    session: "work",
    startDirectory: "/workspace",
    windows: [
      { name: "editor", startDirectory: "/editor" },
      { name: "logs", startDirectory: "/logs" },
      { name: "shell" },
    ],
  });

  expect(sessionOptions).toEqual([
    { name: "work", startDirectory: "/editor", windowName: "editor" },
  ]);
  expect(windowOptions).toEqual([
    { name: "logs", startDirectory: "/logs" },
    { name: "shell", startDirectory: "/workspace" },
  ]);
});
