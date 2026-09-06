import { describe, expect, test } from "bun:test";

import type { ServerSnapshot } from "libtmux";

import type { CallerIdentity } from "../src/caller.js";
import { isPaneInputConflict, reserveFramedCommand } from "../src/command.js";
import type { InputAuthority, ToolContext } from "../src/context.js";
import type { ToolRegistrar, ToolRegistry } from "../src/register.js";
import { resolvePolicy } from "../src/policy.js";
import {
  isFailure,
  requirePaneInputTarget,
  resolvedPaneInputTargetIds,
} from "../src/target_resolution.js";
import { registerInput } from "../src/tools/input.js";
import { registerLifecycle } from "../src/tools/lifecycle.js";
import { registerTargetTools } from "../src/tools/target.js";

const identity: CallerIdentity = {
  attendedPaneIds: [],
  callerPaneId: undefined,
  callerPaneIsOnThisServer: false,
  clients: [],
  serverPid: "42",
};

const authority: InputAuthority = {
  endpointDevice: "2096",
  endpointInode: "9408963",
  pid: "42",
  routeSelector: "path:/tmp/libtmux-input-safety",
  socketPath: "/tmp/libtmux-input-safety",
  startTime: "700",
};

function observation(observed: ServerSnapshot, caller = identity) {
  return { authority, identity: caller, snapshot: observed };
}

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

function collectTargetHandlers(context: ToolContext): ReadonlyMap<string, InputHandler> {
  const handlers = new Map<string, InputHandler>();
  const registry = {
    nativeInputShape(): object {
      return {};
    },
    registerTool(name: string, _config: unknown, handler: InputHandler): object {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as ToolRegistry;
  registerTargetTools(registry, context);
  return handlers;
}

function collectLifecycleHandlers(context: ToolContext): ReadonlyMap<string, InputHandler> {
  const handlers = new Map<string, InputHandler>();
  const registrar = {
    registerTool(name: string, _config: unknown, handler: InputHandler): object {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as ToolRegistrar;
  registerLifecycle(registrar, context);
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
    inputOff: false,
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

function lifecycleSnapshot(events: string[]): ServerSnapshot {
  const pane = {
    format: { session_id: "$1", window_id: "@1", window_index: "0" },
    id: "%1",
    kill: async () => {
      events.push("kill-pane");
    },
    respawn: async () => {
      events.push("respawn-pane");
    },
    window: { id: "@1", index: 0 },
  };
  const window = {
    format: { session_id: "$1", window_index: "0" },
    id: "@1",
    index: 0,
    kill: async () => {
      events.push("kill-window");
    },
  };
  const session = {
    id: "$1",
    kill: async () => {
      events.push("kill-session");
    },
    name: "one",
  };
  return {
    panes: { toArray: () => [pane] },
    sessions: {
      oneOrUndefined: ({ id, name }: { id?: string; name?: string }) =>
        id === session.id || name === session.name ? session : undefined,
      toArray: () => [session],
    },
    windows: { toArray: () => [window] },
  } as unknown as ServerSnapshot;
}

test.each([
  ["respawn_pane", { paneId: "%1" }, "respawn-pane"],
  ["kill_pane", { paneId: "%1" }, "kill-pane"],
  ["kill_window", { windowId: "@1" }, "kill-window"],
  ["kill_session", { session: "$1" }, "kill-session"],
] as const)("%s authenticates one observation before mutation", async (name, args, mutation) => {
  const events: string[] = [];
  const observed = lifecycleSnapshot(events);
  const context = {
    identity: async () => {
      events.push("identity");
      throw new Error("separate identity read");
    },
    observeInput: async () => {
      events.push("observe");
      return observation(observed);
    },
    snapshot: async () => {
      events.push("snapshot");
      throw new Error("post-mutation snapshot");
    },
    tmux: {},
  } as unknown as ToolContext;
  const handler = collectLifecycleHandlers(context).get(name);
  if (handler === undefined) throw new Error(`${name} was not registered`);

  if (name === "respawn_pane") {
    await expect(handler(args, {})).rejects.toThrow("post-mutation snapshot");
    expect(events).toEqual(["observe", mutation, "snapshot"]);
  } else {
    await handler(args, {});
    expect(events).toEqual(["observe", mutation]);
  }
});

describe("pane input state", () => {
  test("accepts only an exact zero pane-mode count", () => {
    expect(isFailure(requirePaneInputTarget(snapshot({ inMode: 0 }), identity, "%1", false))).toBe(
      false,
    );
    for (const inMode of [1, 2]) {
      const reason = refusal({ inMode }, true);
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
      { inputOff: undefined },
      { inputOff: null },
      { inputOff: 0 },
      { inputOff: "0" },
    ]) {
      expect(refusal(fields, true)).toContain("state");
    }
  });

  test("never lets force write to a dead pane", () => {
    expect(refusal({ dead: true }, true)).toContain("dead");
  });

  test("never lets force write when pane input is disabled", () => {
    expect(refusal({ inputOff: true }, true)).toContain("input");
    expect(refusal({ inputOff: true }, true)).toContain("disabled");
  });

  test("force applies only to an exact caller and never to attention", () => {
    const caller = {
      ...identity,
      callerPaneId: "%1",
      callerPaneIsOnThisServer: true,
    };
    expect(isFailure(requirePaneInputTarget(snapshot({}), caller, "%1", false))).toBe(true);
    expect(isFailure(requirePaneInputTarget(snapshot({}), caller, "%1", true))).toBe(false);

    const attended = { ...caller, attendedPaneIds: ["%1"] };
    const result = requirePaneInputTarget(snapshot({}), attended, "%1", true, "type into");
    expect(isFailure(result)).toBe(true);
  });

  test("rejects a synchronized cohort that omits its dispatch pane", () => {
    const pane = snapshot({
      synchronized: true,
      window: { id: "@1", panes: { toArray: () => [] } },
    }).panes.toArray()[0] as Parameters<typeof resolvedPaneInputTargetIds>[0];

    expect(isFailure(resolvedPaneInputTargetIds(pane))).toBe(true);
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
    inputOff: false,
    cmd: async (_command: string, args: readonly string[]) => {
      sent.push(args.at(-1) ?? "");
    },
    synchronized: true,
    window,
  };
  const peer = { ...source, id: "%2", sendKeys: undefined };
  panes = [source, peer];
  const context = {
    hub: {},
    observeInput: async () =>
      observation({ panes: { toArray: () => panes } } as unknown as ServerSnapshot, {
        ...identity,
        attendedPaneIds: ["%2"],
      }),
    policy: resolvePolicy({}),
    snapshot: async () => ({ panes: { toArray: () => panes } }),
    tmux: {},
  } as unknown as ToolContext;
  const handler = collectInputHandlers(context).get("send_keys");
  if (handler === undefined) throw new Error("send_keys was not registered");

  const result = (await handler({ force: true, keys: "x", paneId: "%1" }, {})) as {
    readonly content: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  };
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("%2");
  expect(result.content[0]?.text).toContain("watching");
  expect(sent).toEqual([]);
});

test.each(["send_keys", "paste_text"] as const)(
  "%s never lets force override an active run lease",
  async (name) => {
    const events: string[] = [];
    const observed = snapshot({});
    const pane = observed.panes.toArray()[0] as unknown as {
      cmd(command: string, args: readonly string[]): Promise<void>;
      pasteBuffer(name: string): Promise<void>;
    };
    pane.cmd = async () => {
      events.push("send");
    };
    pane.pasteBuffer = async () => {
      events.push("paste");
    };
    const context = {
      hub: {},
      identity: async () => identity,
      observeInput: async () => observation(observed),
      policy: {},
      snapshot: async () => observed,
      tmux: {
        deleteBuffer: async () => {
          events.push("delete");
        },
        loadBuffer: async () => {
          events.push("load");
        },
      },
    } as unknown as ToolContext;
    const reservation = reserveFramedCommand(authority, "%1", "sleep 30");
    if (isPaneInputConflict(reservation)) throw new Error("run reservation conflicted");
    const handler = collectInputHandlers(context).get(name);
    if (handler === undefined) throw new Error(`${name} was not registered`);

    const result = (await handler(
      name === "send_keys"
        ? { force: true, keys: "x", paneId: "%1" }
        : { force: true, paneId: "%1", text: "x" },
      {},
    )) as { readonly isError?: boolean };
    reservation.release();

    expect(result.isError).toBe(true);
    expect(
      (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text,
    ).not.toContain("C-c");
    expect(events).toEqual([]);
  },
);

test("send_keys_batch never lets force override an active run lease", async () => {
  const sent: string[] = [];
  const observed = snapshot({});
  const pane = observed.panes.toArray()[0] as unknown as {
    cmd(command: string, args: readonly string[]): Promise<void>;
  };
  pane.cmd = async (_command, args) => {
    sent.push(args.at(-1) ?? "");
  };
  const context = {
    hub: {},
    identity: async () => identity,
    observeInput: async () => observation(observed),
    policy: resolvePolicy({}),
    snapshot: async () => observed,
    tmux: {},
  } as unknown as ToolContext;
  const reservation = reserveFramedCommand(authority, "%1", "sleep 30");
  if (isPaneInputConflict(reservation)) throw new Error("run reservation conflicted");
  const handler = collectTargetHandlers(context).get("send_keys_batch");
  if (handler === undefined) throw new Error("send_keys_batch was not registered");

  const result = (await handler(
    { operations: [{ force: true, keys: "x", paneId: "%1" }] },
    {},
  )) as {
    readonly structuredContent?: {
      readonly completed: number;
      readonly failures: readonly { readonly reason: string }[];
    };
  };
  reservation.release();

  expect(result.structuredContent?.completed).toBe(0);
  expect(result.structuredContent?.failures[0]?.reason).toContain("still active");
  expect(sent).toEqual([]);
});

test.each(["paste_text", "send_keys_batch"] as const)(
  "%s holds a transient reservation through its final preflight",
  async (name) => {
    const checked = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const observed = snapshot({});
    const pane = observed.panes.toArray()[0] as unknown as {
      cmd(command: string, args: readonly string[]): Promise<void>;
      pasteBuffer(name: string): Promise<void>;
    };
    pane.cmd = async () => {};
    pane.pasteBuffer = async () => {};
    let observations = 0;
    const context = {
      hub: {},
      observeInput: async () => {
        observations += 1;
        if (observations === 2) {
          checked.resolve();
          await proceed.promise;
        }
        return observation(observed);
      },
      policy: resolvePolicy({}),
      tmux: { deleteBuffer: async () => {}, loadBuffer: async () => {} },
    } as unknown as ToolContext;
    const handler =
      name === "paste_text"
        ? collectInputHandlers(context).get(name)
        : collectTargetHandlers(context).get(name);
    if (handler === undefined) throw new Error(`${name} was not registered`);

    const operation = handler(
      name === "paste_text"
        ? { paneId: "%1", text: "x" }
        : { operations: [{ keys: "x", paneId: "%1" }] },
      {},
    );
    await checked.promise;
    const competing = reserveFramedCommand(authority, "%1", "should not start");
    const conflicted = isPaneInputConflict(competing);
    if (!conflicted) competing.release();
    proceed.resolve();
    await operation;
    expect(conflicted).toBe(true);
  },
);

test("paste_text rechecks state after buffer setup and always cleans up", async () => {
  const events: string[] = [];
  const snapshots = [snapshot({}), snapshot({ inMode: 1 })];
  let snapshotIndex = 0;
  const context = {
    hub: {},
    identity: async () => identity,
    observeInput: async () => observation(snapshots[snapshotIndex++] as ServerSnapshot),
    policy: {},
    snapshot: async () =>
      snapshots[Math.min(snapshotIndex, snapshots.length - 1)] as ServerSnapshot,
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
    observeInput: async () => observation(snapshot({})),
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
