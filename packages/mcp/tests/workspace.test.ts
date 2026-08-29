import { expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TmuxCommandError } from "libtmux";

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

test("reports the workspace that survived a post-creation batch failure", async () => {
  const handlers = new Map<string, WorkspaceHandler>();
  const mcp = {
    registerTool(name: string, _configuration: unknown, handler: WorkspaceHandler): object {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as McpServer;

  const session = { id: "$1", name: "work" };
  const windows = [
    {
      id: "@1",
      index: 0,
      format: { session_id: "$1" },
      name: "editor",
      session,
    },
    {
      id: "@2",
      index: 1,
      format: { session_id: "$1" },
      name: "logs",
      session,
    },
  ];
  const panes = windows.map((window, index) => ({
    active: index === 0,
    currentCommand: "sh",
    currentPath: "/workspace",
    dead: false,
    format: {
      session_id: "$1",
      window_id: window.id,
      window_index: String(index),
    },
    height: 24,
    id: `%${String(index + 1)}`,
    index: 0,
    session,
    title: "shell",
    width: 80,
    window,
  }));
  const before = {
    panes: { toArray: () => [] },
    sessions: { exists: () => false },
    windows: { toArray: () => [] },
  };
  const after = {
    panes: { toArray: () => panes },
    sessions: { exists: () => true },
    windows: { toArray: () => windows },
  };
  let snapshots = 0;
  let topologyChanges = 0;
  const context = {
    identity: async () => ({
      attendedPaneIds: [],
      callerPaneId: undefined,
      callerPaneIsOnThisServer: false,
      clients: [],
      serverPid: undefined,
    }),
    policy: resolvePolicy({ LIBTMUX_SAFETY: "mutating" }),
    snapshot: async () => (snapshots++ === 0 ? before : after),
    tmux: {
      batch: async (operations: readonly { readonly argv: readonly string[] }[]) => {
        const failed = operations[1];
        if (failed === undefined) throw new Error("fixture needs a failing operation");
        throw new TmuxCommandError({
          args: failed.argv,
          exitCode: 1,
          stderr: ["third window refused"],
          stdout: [],
        });
      },
      newSession: async () => ({
        id: "$1",
        plan: {
          newWindow(options: { readonly name: string }) {
            return { argv: ["new-window", "-n", options.name] };
          },
        },
      }),
    },
    topologyChanged: () => {
      topologyChanges += 1;
    },
  } as unknown as ToolContext;

  registerWorkspace(mcp, context);
  const buildWorkspace = handlers.get("build_workspace");
  if (buildWorkspace === undefined) throw new Error("build_workspace was not registered");

  const answer = await buildWorkspace({
    session: "work",
    windows: [{ name: "editor" }, { name: "logs" }, { name: "logs" }],
  }).catch((error: unknown) => error);

  expect(answer).not.toBeInstanceOf(Error);
  expect(answer).toMatchObject({
    structuredContent: {
      complete: false,
      failure: {
        reason: "new-window failed: third window refused",
        windowIndex: null,
        windowName: null,
      },
      panes: [{ id: "%1" }, { id: "%2" }],
      sessionId: "$1",
    },
  });
  expect(snapshots).toBe(2);
  expect(topologyChanges).toBe(1);
});
