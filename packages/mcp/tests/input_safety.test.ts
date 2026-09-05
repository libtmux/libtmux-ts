import { describe, expect, test } from "bun:test";

import type { ServerSnapshot } from "libtmux";

import type { CallerIdentity } from "../src/caller.js";
import type { ToolContext } from "../src/context.js";
import type { ToolRegistrar } from "../src/register.js";
import { isFailure, requirePaneInputTarget } from "../src/target_resolution.js";
import { registerInput } from "../src/tools/input.js";

const identity: CallerIdentity = {
  attendedPaneIds: [],
  callerPaneId: undefined,
  callerPaneIsOnThisServer: false,
  clients: [],
  serverPid: "42",
};

type InputHandler = (
  args: Readonly<Record<string, unknown>>,
  extra: { readonly signal?: AbortSignal },
) => Promise<unknown>;

function collectInputHandlers(context: ToolContext): ReadonlyMap<string, InputHandler> {
  const handlers = new Map<string, InputHandler>();
  const registrar = {
    registerTool(name: string, _config: unknown, handler: InputHandler): object {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as ToolRegistrar;
  registerInput(registrar, context);
  return handlers;
}

function snapshot(fields: Readonly<Record<string, unknown>>): ServerSnapshot {
  const window = { id: "@1", index: 0 };
  const pane = {
    currentCommand: "sh",
    dead: false,
    format: { session_id: "$1", window_index: "0" },
    id: "%1",
    inMode: 0,
    synchronized: false,
    window,
    ...fields,
  };
  return { panes: { toArray: () => [pane] } } as unknown as ServerSnapshot;
}

function refusal(fields: Readonly<Record<string, unknown>>, force = false): string {
  const result = requirePaneInputTarget(snapshot(fields), identity, "%1", force, "type into");
  expect(isFailure(result)).toBe(true);
  if (!isFailure(result)) throw new Error("pane input was not refused");
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
}

describe("pane input state", () => {
  test("accepts only an exact zero pane-mode count", () => {
    expect(isFailure(requirePaneInputTarget(snapshot({ inMode: 0 }), identity, "%1", false))).toBe(
      false,
    );
    for (const inMode of [1, 2]) {
      const reason = refusal({ inMode });
      expect(reason).toContain("human-owned mode");
      expect(reason).toContain("capture_pane");
      expect(reason).toContain("snapshot_pane");
    }
  });

  test("fails closed when mode or liveness is unavailable", () => {
    for (const fields of [
      { inMode: undefined },
      { inMode: null },
      { inMode: "0" },
      { dead: undefined },
      { dead: null },
      { dead: 0 },
    ]) {
      expect(refusal(fields, true)).toContain("state");
    }
  });

  test("never lets force write to a dead pane", () => {
    expect(refusal({ dead: true }, true)).toContain("dead");
  });
});

test("send_keys applies attention policy to every configured member", async () => {
  const sent: string[] = [];
  let panes: unknown[] = [];
  const window = { id: "@1", index: 0, panes: { toArray: () => panes } };
  const source = {
    currentCommand: "sh",
    dead: false,
    format: { session_id: "$1", window_index: "0" },
    id: "%1",
    inMode: 0,
    sendKeys: async (keys: string) => {
      sent.push(keys);
    },
    synchronized: true,
    window,
  };
  const peer = { ...source, id: "%2", sendKeys: undefined };
  panes = [source, peer];
  const context = {
    hub: {},
    identity: async () => ({ ...identity, attendedPaneIds: ["%2"] }),
    policy: {},
    snapshot: async () => ({ panes: { toArray: () => panes } }),
    tmux: {},
  } as unknown as ToolContext;
  const handler = collectInputHandlers(context).get("send_keys");
  if (handler === undefined) throw new Error("send_keys was not registered");

  const result = (await handler({ keys: "x", paneId: "%1" }, {})) as {
    readonly content: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  };
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("%2");
  expect(result.content[0]?.text).toContain("watching");
  expect(sent).toEqual([]);
});

test("paste_text rechecks state after buffer setup and always cleans up", async () => {
  const events: string[] = [];
  const snapshots = [snapshot({}), snapshot({ inMode: 1 })];
  let snapshotIndex = 0;
  const context = {
    hub: {},
    identity: async () => identity,
    policy: {},
    snapshot: async () => snapshots[snapshotIndex++] as ServerSnapshot,
    tmux: {
      deleteBuffer: async () => {
        events.push("delete");
      },
      loadBuffer: async () => {
        events.push("load");
      },
    },
  } as unknown as ToolContext;
  const panes = snapshots.map((entry) => entry.panes.toArray()[0]) as unknown as {
    pasteBuffer(name: string): Promise<void>;
  }[];
  for (const pane of panes) {
    pane.pasteBuffer = async () => {
      events.push("paste");
    };
  }

  const handler = collectInputHandlers(context).get("paste_text");
  if (handler === undefined) throw new Error("paste_text was not registered");
  const result = (await handler({ paneId: "%1", text: "payload" }, {})) as {
    isError?: boolean;
  };

  expect(result.isError).toBe(true);
  expect(snapshotIndex).toBe(2);
  expect(events).toEqual(["load", "delete"]);
});

test("paste_text attempts cleanup when buffer setup fails", async () => {
  const events: string[] = [];
  const context = {
    hub: {},
    identity: async () => identity,
    policy: {},
    snapshot: async () => snapshot({}),
    tmux: {
      deleteBuffer: async () => {
        events.push("delete");
      },
      loadBuffer: async () => {
        events.push("load");
        throw new Error("load failed");
      },
    },
  } as unknown as ToolContext;

  const handler = collectInputHandlers(context).get("paste_text");
  if (handler === undefined) throw new Error("paste_text was not registered");
  await expect(handler({ paneId: "%1", text: "payload" }, {})).rejects.toThrow("load failed");
  expect(events).toEqual(["load", "delete"]);
});
