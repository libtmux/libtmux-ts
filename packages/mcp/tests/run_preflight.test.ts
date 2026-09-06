import { expect, test } from "bun:test";

import type { Pane, ServerSnapshot } from "libtmux";

import type { CallerIdentity } from "../src/caller.js";
import { activeFramedCommand, isPaneInputConflict, reserveFramedCommand } from "../src/command.js";
import type { InputAuthority, ToolContext } from "../src/context.js";
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

const authority: InputAuthority = {
  endpointDevice: "2096",
  endpointInode: "9408963",
  pid: "42",
  routeSelector: "path:/tmp/libtmux-run-preflight",
  socketPath: "/tmp/libtmux-run-preflight",
  startTime: "700",
};

function frameId(source: string): string {
  const octets = /command printf '%b' '((?:\\0[0-7]{3})+)'/u.exec(source)?.[1];
  if (octets === undefined) throw new Error("dispatch has no encoded frame id");
  return octets.replaceAll(/\\0([0-7]{3})/gu, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

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
    inputOff: false,
    cmd: async (_command: string, args: readonly string[]) => {
      const line = args.find((entry) => entry.includes("__ltx_")) ?? "";
      sent.push(line);
      const id = frameId(line);
      tail.append(`${id}_S\n${id}_E 0 ${id}_D\n`);
      setTimeout(() => tail.append("\n"), 0);
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
    inputOff: false,
    synchronized: true,
    window,
  } as unknown as Pane;
  panes = peer ? [source, other] : [source];
  return { panes: { toArray: () => panes } } as unknown as ServerSnapshot;
}

const transitions = [
  ["mode entry", { inMode: 1 }, false, identity, authority],
  ["pane death", { dead: true }, false, identity, authority],
  ["foreground shell", { currentCommand: "fish" }, false, identity, authority],
  ["supported shell identity", { currentCommand: "bash" }, false, identity, authority],
  ["pane disappearance", { absent: true }, false, identity, authority],
  ["configured cohort", { synchronized: true }, true, identity, authority],
  ["daemon pid", {}, false, { ...identity, serverPid: "43" }, { ...authority, pid: "43" }],
  ["daemon start time", {}, false, identity, { ...authority, startTime: "701" }],
  ["resolved socket", {}, false, identity, { ...authority, socketPath: "/tmp/replaced" }],
  ["route selector", {}, false, identity, { ...authority, routeSelector: "name:replaced" }],
  ["caller attention", {}, false, { ...identity, attendedPaneIds: ["%1"] }, authority],
] as const;

test.each(transitions)(
  "run_shell_command refuses a %s transition before its first byte",
  async (_name, fields, peer, finalIdentity, finalAuthority) => {
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
      observeInput: async () => {
        const index = snapshotIndex++;
        const observed = snapshots[index] as ServerSnapshot;
        const observedIdentity = identities[identityIndex++] ?? finalIdentity;
        return {
          authority: index === 0 ? authority : finalAuthority,
          identity: observedIdentity,
          snapshot: observed,
        };
      },
      policy: resolvePolicy({}),
      snapshot: async () =>
        snapshots[Math.min(snapshotIndex, snapshots.length - 1)] as ServerSnapshot,
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
    expect(activeFramedCommand(authority, "%1")).toBeUndefined();
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
    observeInput: async () => {
      const observed = snapshots[snapshotIndex++] as ServerSnapshot;
      identityCount += 1;
      return { authority, identity, snapshot: observed };
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
  expect(sent).toHaveLength(1);
  expect(activeFramedCommand(authority, "%1")).toBeUndefined();
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
    observeInput: async () => ({
      authority,
      identity,
      snapshot: snapshot(sent, tail, { currentCommand: "vim" }),
    }),
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

test("run_shell_command excludes another writer after reserving", async () => {
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
        otherReservation = reserveFramedCommand(authority, "%1", "other writer");
        return tail;
      },
    },
    identity: async () => identity,
    observeInput: async () => {
      const observed = snapshots[snapshotIndex++] as ServerSnapshot;
      return { authority, identity, snapshot: observed };
    },
    policy: resolvePolicy({}),
    snapshot: async () => snapshots[snapshotIndex++] as ServerSnapshot,
    tmux: {},
  } as unknown as ToolContext;
  const handler = collectInputHandlers(context).get("run_shell_command");
  if (handler === undefined) throw new Error("run_shell_command was not registered");

  const result = await handler({ command: "printf ran", paneId: "%1" }, {});

  expect(result.isError).toBeUndefined();
  expect(otherReservation).toBeDefined();
  expect(otherReservation !== undefined && isPaneInputConflict(otherReservation)).toBe(true);
  expect(sent).toHaveLength(1);
  expect(activeFramedCommand(authority, "%1")).toBeUndefined();
});

test("force never overrides an active run lease", async () => {
  const sent: string[] = [];
  const tail = new PaneTail("%1");
  const context = {
    hub: { closed: false, tail: async () => tail },
    identity: async () => identity,
    observeInput: async () => ({ authority, identity, snapshot: snapshot(sent, tail) }),
    policy: resolvePolicy({}),
    snapshot: async () => snapshot(sent, tail),
    tmux: {},
  } as unknown as ToolContext;
  const other = reserveFramedCommand(authority, "%1", "sleep 30");
  if (isPaneInputConflict(other)) throw new Error("run reservation conflicted");
  const handler = collectInputHandlers(context).get("run_shell_command");
  if (handler === undefined) throw new Error("run_shell_command was not registered");

  const result = await handler({ command: "printf SHOULD_NOT_RUN", force: true, paneId: "%1" }, {});
  other.release();

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("still active");
  expect(sent).toEqual([]);
});

test("the registry does not conflate daemon generations", () => {
  const old = reserveFramedCommand(authority, "%1", "old daemon");
  if (isPaneInputConflict(old)) throw new Error("old generation reservation conflicted");
  const replacement = reserveFramedCommand({ ...authority, startTime: "701" }, "%1", "new daemon");

  expect(isPaneInputConflict(replacement)).toBe(false);
  old.release();
  if (!isPaneInputConflict(replacement)) replacement.release();
});

test("the registry collapses selectors for one physical daemon generation", () => {
  const first = reserveFramedCommand(authority, "%1", "path selector");
  if (isPaneInputConflict(first)) throw new Error("first reservation conflicted");
  const second = reserveFramedCommand(
    { ...authority, routeSelector: "name:the-same-daemon" },
    "%1",
    "name selector",
  );

  const conflicted = isPaneInputConflict(second);
  first.release();
  if (!conflicted) second.release();
  expect(conflicted).toBe(true);
});

test("the registry collapses socket aliases for one physical daemon generation", () => {
  const first = reserveFramedCommand(authority, "%1", "original socket");
  if (isPaneInputConflict(first)) throw new Error("first reservation conflicted");
  const second = reserveFramedCommand(
    {
      ...authority,
      routeSelector: "path:/tmp/libtmux-run-preflight-alias",
      socketPath: "/tmp/libtmux-run-preflight-alias",
    },
    "%1",
    "hardlink alias",
  );

  const conflicted = isPaneInputConflict(second);
  first.release();
  if (!conflicted) second.release();
  expect(conflicted).toBe(true);
});

test("a transient send reservation blocks a run across ToolContext instances", async () => {
  const sent: string[] = [];
  const tail = new PaneTail("%1");
  const dispatch = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const observed = snapshot(sent, tail);
  const pane = observed.panes.toArray()[0] as Pane;
  const framedSend = pane.cmd.bind(pane);
  pane.cmd = async (command: string, args: readonly string[]) => {
    if (args.includes("x")) {
      sent.push("x");
      entered.resolve();
      await dispatch.promise;
      return [];
    }
    return framedSend(command, args);
  };
  const makeContext = (): ToolContext =>
    ({
      hub: { closed: false, tail: async () => tail },
      identity: async () => identity,
      observeInput: async () => ({ authority, identity, snapshot: observed }),
      policy: resolvePolicy({}),
      route: { selector: authority.routeSelector },
      snapshot: async () => observed,
      tmux: {},
    }) as unknown as ToolContext;
  const sendingContext = makeContext();
  const runningContext = makeContext();
  const sending = collectInputHandlers(sendingContext).get("send_keys");
  const running = collectInputHandlers(runningContext).get("run_shell_command");
  if (sending === undefined || running === undefined)
    throw new Error("input tools were not registered");

  const first = sending({ enter: false, keys: "x", paneId: "%1" }, {});
  await entered.promise;
  const second = await running({ command: "printf SHOULD_NOT_RUN", force: true, paneId: "%1" }, {});
  dispatch.resolve();
  await first;

  expect(second.isError).toBe(true);
  expect(second.content[0]?.text).toContain("pane input");
  expect(sent).toEqual(["x"]);
});
