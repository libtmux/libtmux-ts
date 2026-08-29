import { expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerSnapshot } from "libtmux";

import type { ToolContext } from "../src/context.js";
import { resolvePolicy } from "../src/policy.js";
import { registerLayout } from "../src/tools/layout.js";
import { registerLifecycle } from "../src/tools/lifecycle.js";
import { registerWorkspace } from "../src/tools/workspace.js";

type Handler = (arguments_: unknown) => Promise<unknown>;
type RegisterTools = (mcp: McpServer, context: ToolContext) => void;

const CASES = [
  ["new_session", registerLifecycle, { name: "work" }],
  ["new_window", registerLifecycle, { session: "$1" }],
  ["split_pane", registerLifecycle, { paneId: "%1" }],
  ["rename_session", registerLifecycle, { name: "renamed", session: "$1" }],
  ["rename_window", registerLifecycle, { name: "renamed", windowId: "@1" }],
  ["move_window", registerLayout, { windowId: "@1" }],
  ["move_pane", registerLayout, { paneId: "%1" }],
  ["swap_window", registerLayout, { otherWindowId: "@2", windowId: "@1" }],
  ["build_workspace", registerWorkspace, { session: "work", windows: [{ name: "editor" }] }],
] as const;

function collection(values: readonly { readonly id: string; readonly name?: string }[]) {
  const match = (where: unknown) => {
    const filter = where as { readonly id?: string; readonly name?: string };
    return values.find(
      (value) =>
        (filter.id === undefined || value.id === filter.id) &&
        (filter.name === undefined || value.name === filter.name),
    );
  };
  return {
    count: () => values.length,
    exists: (where: unknown) => match(where) !== undefined,
    first: () => values[0],
    one: (where: unknown) => {
      const value = match(where);
      if (value === undefined) throw new Error("fixture lookup failed");
      return value;
    },
    oneOrUndefined: match,
    toArray: () => values,
  };
}

function snapshotOf(options?: {
  readonly panes?: readonly object[];
  readonly sessions?: readonly object[];
  readonly windows?: readonly object[];
}): ServerSnapshot {
  return {
    panes: collection((options?.panes ?? []) as readonly { readonly id: string }[]),
    sessions: collection(
      (options?.sessions ?? []) as readonly { readonly id: string; readonly name?: string }[],
    ),
    windows: collection((options?.windows ?? []) as readonly { readonly id: string }[]),
  } as unknown as ServerSnapshot;
}

function handlerFor(name: string, register: RegisterTools, context: ToolContext): Handler {
  const handlers = new Map<string, Handler>();
  const mcp = {
    registerTool(toolName: string, _configuration: unknown, handler: Handler): object {
      handlers.set(toolName, handler);
      return {};
    },
  } as unknown as McpServer;
  register(mcp, context);
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`${name} was not registered`);
  return handler;
}

function failingReadBackFixture(name: string) {
  let mutations = 0;
  let topologyChanges = 0;
  let snapshots = 0;
  const failure = new Error("post-mutation boundary failed");
  const mutate = async <T>(value: T): Promise<T> => {
    mutations += 1;
    if (name === "build_workspace") throw failure;
    return value;
  };

  const session = {
    id: "$1",
    name: "work",
    newWindow: () => mutate(windowOne),
    rename: () => mutate(undefined),
  };
  const windowOne = {
    format: { session_id: "$1", window_index: "0" },
    id: "@1",
    index: 0,
    move: () => mutate(undefined),
    name: "one",
    rename: () => mutate(undefined),
    session,
    swapWith: () => mutate(undefined),
  };
  const windowTwo = {
    format: { session_id: "$1", window_index: "1" },
    id: "@2",
    index: 1,
    name: "two",
    session,
  };
  const createdPane = { id: "%2" };
  const pane = {
    breakOut: () => mutate(undefined),
    currentPath: "/workspace",
    format: { session_id: "$1", window_id: "@1", window_index: "0" },
    id: "%1",
    session,
    split: () => mutate(createdPane),
    window: windowOne,
  };
  const before =
    name === "build_workspace"
      ? snapshotOf()
      : snapshotOf({ panes: [pane], sessions: [session], windows: [windowOne, windowTwo] });
  const context = {
    identity: async () => ({}),
    policy: resolvePolicy({ LIBTMUX_SAFETY: "destructive" }),
    snapshot: async () => {
      if (name !== "new_session" && snapshots++ === 0) return before;
      throw failure;
    },
    tmux: {
      batch: async () => [],
      newSession: () => mutate(session),
    },
    topologyChanged: () => {
      topologyChanges += 1;
    },
  } as unknown as ToolContext;

  return {
    context,
    failure,
    mutations: () => mutations,
    topologyChanges: () => topologyChanges,
  };
}

test.each(CASES)("%s loses invalidation when read-back fails", async (name, register, args) => {
  const fixture = failingReadBackFixture(name);
  const handler = handlerFor(name, register, fixture.context);

  const answer = await handler(args).catch((error: unknown) => error);

  expect(answer).toBe(fixture.failure);
  expect(fixture.mutations()).toBe(1);
  expect(() => expect(fixture.topologyChanges()).toBe(1)).toThrow();
});

test("a failed preflight does not invalidate topology", async () => {
  let topologyChanges = 0;
  const context = {
    policy: resolvePolicy({ LIBTMUX_SAFETY: "mutating" }),
    snapshot: async () => snapshotOf(),
    topologyChanged: () => {
      topologyChanges += 1;
    },
  } as unknown as ToolContext;
  const renameWindow = handlerFor("rename_window", registerLifecycle, context);

  const answer = await renameWindow({ name: "renamed", windowId: "@404" });

  expect(answer).toMatchObject({ isError: true });
  expect(topologyChanges).toBe(0);
});
