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

test("paste_text rechecks state after buffer setup and always cleans up", async () => {
  const events: string[] = [];
  const snapshots = [snapshot({}), snapshot({ inMode: 1 })];
  let snapshotIndex = 0;
  const handlers = new Map<
    string,
    (args: Readonly<Record<string, unknown>>, extra: { signal?: AbortSignal }) => Promise<unknown>
  >();
  const registrar = {
    registerTool(
      name: string,
      _config: unknown,
      handler: (
        args: Readonly<Record<string, unknown>>,
        extra: { signal?: AbortSignal },
      ) => Promise<unknown>,
    ): object {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as ToolRegistrar;
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
  registerInput(registrar, context);

  const handler = handlers.get("paste_text");
  if (handler === undefined) throw new Error("paste_text was not registered");
  const result = (await handler({ paneId: "%1", text: "payload" }, {})) as {
    isError?: boolean;
  };

  expect(result.isError).toBe(true);
  expect(snapshotIndex).toBe(2);
  expect(events).toEqual(["load", "delete"]);
});
