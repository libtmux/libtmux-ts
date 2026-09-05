import { expect, test } from "bun:test";

import type { Pane, ServerSnapshot } from "libtmux";

import type { CallerIdentity } from "../src/caller.js";
import { activeFramedCommand, reserveFramedCommand } from "../src/command.js";
import type { ToolContext } from "../src/context.js";
import { PaneTail } from "../src/pane_tail.js";
import { resolvePolicy } from "../src/policy.js";
import type { ToolRegistrar } from "../src/register.js";
import { registerInput } from "../src/tools/input.js";

type InputHandler = (
  args: Readonly<Record<string, unknown>>,
  extra: { readonly signal?: AbortSignal },
) => Promise<{
  readonly content: readonly { readonly text?: string }[];
  readonly isError?: boolean;
}>;

const identity: CallerIdentity = {
  attendedPaneIds: [],
  callerPaneId: undefined,
  callerPaneIsOnThisServer: false,
  clients: [],
  serverPid: "42",
};

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

function snapshot(
  sent: string[],
  tail: PaneTail,
  fields: Readonly<Record<string, unknown>> = {},
  peer = false,
): ServerSnapshot {
  let panes: Pane[] = [];
  const window = {
    id: "@1",
    index: 0,
    panes: { toArray: () => panes },
  };
  const source = {
    currentCommand: "sh",
    dead: false,
    format: { session_id: "$1", window_id: "@1", window_index: "0" },
    id: "%1",
    inMode: 0,
    sendKeys: async (line: string) => {
      sent.push(line);
      const ready = /'(ltxr[0-9a-f]{10})' '_R'/u.exec(line)?.[1];
      if (ready !== undefined) tail.append(`${ready}_R\n`);
      else {
        tail.append(`${line}_S\n${line}_E 0 ${line}_D\n`);
        setTimeout(() => tail.append("\n"), 0);
      }
    },
    synchronized: false,
    window,
    ...fields,
  } as unknown as Pane;
  const other = {
    currentCommand: "sh",
    dead: false,
    format: { session_id: "$1", window_id: "@1", window_index: "0" },
    id: "%2",
    inMode: 0,
    synchronized: true,
    window,
  } as unknown as Pane;
  panes = peer ? [source, other] : [source];
  return { panes: { toArray: () => panes } } as unknown as ServerSnapshot;
}

const transitions = [
  ["mode entry", { inMode: 1 }, false, identity],
  ["pane death", { dead: true }, false, identity],
  ["foreground shell", { currentCommand: "fish" }, false, identity],
  ["supported shell identity", { currentCommand: "bash" }, false, identity],
  ["pane disappearance", { absent: true }, false, identity],
  ["configured cohort", { synchronized: true }, true, identity],
  ["daemon identity", {}, false, { ...identity, serverPid: "43" }],
  ["caller attention", {}, false, { ...identity, attendedPaneIds: ["%1"] }],
] as const;

test.each(transitions)(
  "run_shell_command refuses a %s transition before its first byte",
  async (_name, fields, peer, finalIdentity) => {
    const sent: string[] = [];
    const tail = new PaneTail("%1");
    const first = snapshot(sent, tail);
    const second =
      "absent" in fields ? snapshot(sent, tail, { id: "%9" }) : snapshot(sent, tail, fields, peer);
    const snapshots = [first, second];
    let snapshotIndex = 0;
    let identityIndex = 0;
    let setupCount = 0;
    let completionWaitCount = 0;
    const changed = tail.changed.bind(tail);
    tail.changed = (...args) => {
      completionWaitCount += 1;
      return changed(...args);
    };
    const identities = [identity, finalIdentity];
    const context = {
      hub: {
        closed: false,
        tail: async () => {
          setupCount += 1;
          return tail;
        },
      },
      identity: async () => identities[identityIndex++] ?? finalIdentity,
      policy: resolvePolicy({}),
      snapshot: async () => snapshots[snapshotIndex++] as ServerSnapshot,
      tmux: {},
    } as unknown as ToolContext;
    const handler = collectInputHandlers(context).get("run_shell_command");
    if (handler === undefined) throw new Error("run_shell_command was not registered");

    const result = await handler({ command: "printf SHOULD_NOT_RUN", paneId: "%1" }, {});
    const reason = result.content[0]?.text ?? "";

    expect(result.isError).toBe(true);
    expect(reason).toContain("changed during run_shell_command setup");
    expect(snapshotIndex).toBe(2);
    expect(setupCount).toBe(1);
    expect(completionWaitCount).toBe(0);
    expect(sent).toEqual([]);
    expect(activeFramedCommand(context, "%1")).toBeUndefined();
  },
);

test("run_shell_command dispatches after exactly two matching preflights", async () => {
  const sent: string[] = [];
  const tail = new PaneTail("%1");
  const snapshots = [snapshot(sent, tail), snapshot(sent, tail)];
  let snapshotIndex = 0;
  let identityCount = 0;
  const context = {
    hub: { closed: false, tail: async () => tail },
    identity: async () => {
      identityCount += 1;
      return identity;
    },
    policy: resolvePolicy({}),
    snapshot: async () => snapshots[snapshotIndex++] as ServerSnapshot,
    tmux: {},
  } as unknown as ToolContext;
  const handler = collectInputHandlers(context).get("run_shell_command");
  if (handler === undefined) throw new Error("run_shell_command was not registered");

  const result = await handler({ command: "true", paneId: "%1" }, {});

  expect(result.isError).toBeUndefined();
  expect(snapshotIndex).toBe(2);
  expect(identityCount).toBe(2);
  expect(sent).toHaveLength(2);
  expect(activeFramedCommand(context, "%1")).toBeUndefined();
});

test("force does not bypass the trusted foreground-shell boundary", async () => {
  const sent: string[] = [];
  const tail = new PaneTail("%1");
  let setupCount = 0;
  const context = {
    hub: {
      closed: false,
      tail: async () => {
        setupCount += 1;
        return tail;
      },
    },
    identity: async () => identity,
    policy: resolvePolicy({}),
    snapshot: async () => snapshot(sent, tail, { currentCommand: "vim" }),
    tmux: {},
  } as unknown as ToolContext;
  const handler = collectInputHandlers(context).get("run_shell_command");
  if (handler === undefined) throw new Error("run_shell_command was not registered");

  const result = await handler({ command: "printf SHOULD_NOT_RUN", force: true, paneId: "%1" }, {});

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("cannot address");
  expect(setupCount).toBe(0);
  expect(sent).toEqual([]);
});

test("run_shell_command rechecks other active writers after setup", async () => {
  const sent: string[] = [];
  const tail = new PaneTail("%1");
  const snapshots = [snapshot(sent, tail), snapshot(sent, tail)];
  let snapshotIndex = 0;
  let otherReservation: ReturnType<typeof reserveFramedCommand> | undefined;
  let context!: ToolContext;
  context = {
    hub: {
      closed: false,
      tail: async () => {
        otherReservation = reserveFramedCommand(context, "%1", "other writer");
        return tail;
      },
    },
    identity: async () => identity,
    policy: resolvePolicy({}),
    snapshot: async () => snapshots[snapshotIndex++] as ServerSnapshot,
    tmux: {},
  } as unknown as ToolContext;
  const handler = collectInputHandlers(context).get("run_shell_command");
  if (handler === undefined) throw new Error("run_shell_command was not registered");

  const result = await handler({ command: "printf SHOULD_NOT_RUN", paneId: "%1" }, {});
  otherReservation?.release();

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("changed during run_shell_command setup");
  expect(sent).toEqual([]);
  expect(activeFramedCommand(context, "%1")).toBeUndefined();
});
