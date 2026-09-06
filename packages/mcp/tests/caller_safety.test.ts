import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pane, ServerSnapshot } from "libtmux";
import type { Server } from "libtmux/server";

import {
  readCallerEnvironment,
  readServerAuthority,
  resolveCallerIdentity,
  type CallerEnvironment,
  type ServerAuthority,
} from "../src/caller.js";
import { createContext } from "../src/context.js";
import { resolvePolicy } from "../src/policy.js";
import { isFailure, requirePaneInputTarget } from "../src/target_resolution.js";

function snapshot(
  options: {
    readonly clients?: readonly unknown[];
    readonly paneSession?: string;
    readonly sessions?: readonly string[];
  } = {},
): ServerSnapshot {
  const paneSession = options.paneSession ?? "$3";
  let panes: Pane[] = [];
  const window = {
    id: "@1",
    panes: { toArray: () => panes },
    zoomedFlag: false,
  };
  const pane = {
    currentCommand: "sh",
    dead: false,
    format: { session_id: paneSession, window_id: "@1", window_index: "0" },
    id: "%7",
    inMode: 0,
    inputOff: false,
    synchronized: false,
    window,
  } as unknown as Pane;
  panes = [pane];
  return {
    clients: { toArray: () => [...(options.clients ?? [])] },
    panes: { toArray: () => panes },
    sessions: {
      toArray: () => (options.sessions ?? ["$3"]).map((id) => ({ id })),
    },
  } as unknown as ServerSnapshot;
}

function server(pid = "42", socketPath = "/tmp/libtmux-caller-selected"): Server {
  return {
    cmd: async () => [`${socketPath}\t${pid}\t700`],
    daemonIdentity: async () => ({ pid, startTime: "700" }),
    socketPath,
  } as unknown as Server;
}

function authority(pid = "42", socketPath = "/tmp/libtmux-caller-selected"): ServerAuthority {
  return {
    endpointDevice: "2096",
    endpointInode: "9408963",
    pid,
    socketPath,
    startTime: "700",
  };
}

function attached(overrides: Readonly<Record<string, string | undefined>> = {}): CallerEnvironment {
  return readCallerEnvironment({
    TMUX: "/tmp/libtmux-caller-selected,42,3",
    TMUX_PANE: "%7",
    ...overrides,
  });
}

async function withSocket<T>(body: (socketPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ltx-mcp-endpoint-"));
  const socketPath = join(directory, "server.sock");
  const listener = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(socketPath, resolve);
    });
    return await body(socketPath);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  }
}

test("caller environment distinguishes detached, invalid, and attached context", () => {
  expect(readCallerEnvironment({}).status).toBe("detached");

  for (const environment of [
    { TMUX: "/tmp/libtmux-caller-selected,42,3" },
    { TMUX_PANE: "%7" },
    { TMUX: "", TMUX_PANE: "" },
    { TMUX: "relative,42,3", TMUX_PANE: "%7" },
    { TMUX: "/tmp/libtmux\u0000caller,42,3", TMUX_PANE: "%7" },
    { TMUX: "/tmp/libtmux\ncaller,42,3", TMUX_PANE: "%7" },
    { TMUX: "/tmp/libtmux\u007fcaller,42,3", TMUX_PANE: "%7" },
    { TMUX: "/tmp/libtmux-caller-selected,0,3", TMUX_PANE: "%7" },
    { TMUX: "/tmp/libtmux-caller-selected,042,3", TMUX_PANE: "%7" },
    { TMUX: "/tmp/libtmux-caller-selected,42,03", TMUX_PANE: "%7" },
    { TMUX: "/tmp/libtmux-caller-selected,42,3", TMUX_PANE: "%07" },
  ]) {
    expect(readCallerEnvironment(environment).status, JSON.stringify(environment)).toBe("invalid");
  }

  const caller = attached();
  expect(caller.status).toBe("attached");
  expect(caller).toMatchObject({
    paneId: "%7",
    serverPid: "42",
    sessionId: "$3",
    socketPath: "/tmp/libtmux-caller-selected",
  });

  expect(
    readCallerEnvironment({ TMUX: "/tmp/libtmux,caller,42,3", TMUX_PANE: "%7" }),
  ).toMatchObject({ socketPath: "/tmp/libtmux,caller", status: "attached" });
});

test("server authority rejects control bytes in its reported socket", async () => {
  await expect(
    readServerAuthority({
      cmd: async () => ["/tmp/libtmux\ncaller\t42\t700"],
      socketPath: "/tmp/libtmux-caller-selected",
    } as unknown as Server),
  ).rejects.toThrow("control");
});

test("caller selection authenticates its socket, pid, pane, and session", async () => {
  const selected = await resolveCallerIdentity(server(), snapshot(), attached(), authority());
  expect(selected.inputProblem).toBeUndefined();
  expect(selected.callerPaneIsOnThisServer).toBe(true);

  const foreign = await resolveCallerIdentity(
    server(),
    snapshot(),
    attached({ TMUX: "/tmp/libtmux-caller-foreign,43,3" }),
    authority(),
  );
  expect(foreign.inputProblem).toBeUndefined();
  expect(foreign.callerPaneIsOnThisServer).toBe(false);

  await Promise.all(
    (
      [
        [attached({ TMUX: "/tmp/libtmux-caller-selected,42,9" }), snapshot()],
        [attached(), snapshot({ paneSession: "$4" })],
        [attached({ TMUX: "/tmp/libtmux-caller-selected,43,3" }), snapshot()],
        [readCallerEnvironment({ TMUX_PANE: "%7" }), snapshot()],
      ] as const
    ).map(async ([caller, observed]) => {
      const invalid = await resolveCallerIdentity(server(), observed, caller, authority());
      expect(invalid.inputProblem).toContain("caller");
      expect(isFailure(requirePaneInputTarget(observed, invalid, "%7", true, "type into"))).toBe(
        true,
      );
    }),
  );
});

test("caller selection accepts the matching linked-pane placement", async () => {
  const observed = snapshot();
  const pane = observed.panes.toArray()[0] as Pane;
  const linked = {
    clients: observed.clients,
    panes: {
      toArray: () => [{ format: { ...pane.format, session_id: "$4" }, id: pane.id }, pane],
    },
    sessions: observed.sessions,
  } as unknown as ServerSnapshot;

  const selected = await resolveCallerIdentity(server(), linked, attached(), authority());

  expect(selected.inputProblem).toBeUndefined();
  expect(selected.callerPaneIsOnThisServer).toBe(true);
});

test("non-control client pane and zoom state fail closed", async () => {
  const validWindow = { id: "@1", panes: { toArray: () => [] }, zoomedFlag: false };
  const cases = [
    { controlMode: undefined, pane: { id: "%7" }, window: validWindow },
    { controlMode: false, pane: undefined, window: validWindow },
    {
      controlMode: false,
      pane: { id: "%7" },
      window: { ...validWindow, zoomedFlag: undefined },
    },
    { controlMode: false, pane: { id: "7" }, window: validWindow },
    {
      controlMode: false,
      pane: { id: "%7" },
      window: { ...validWindow, zoomedFlag: "false" },
    },
    {
      controlMode: false,
      pane: { id: "%7" },
      window: { id: "@1", panes: { toArray: () => [{ id: "7" }] }, zoomedFlag: false },
    },
    { controlMode: false, pane: { id: "%7" }, window: validWindow },
  ];

  await Promise.all(
    cases.map(async (client) => {
      const observed = snapshot({ clients: [client] });
      const identity = await resolveCallerIdentity(
        server(),
        observed,
        readCallerEnvironment({}),
        authority(),
      );
      expect(identity.inputProblem).toContain("client");
      expect(isFailure(requirePaneInputTarget(observed, identity, "%7", true, "type into"))).toBe(
        true,
      );
    }),
  );
});

test("zoomed clients must name a pane placement in their claimed session and window", async () => {
  const cases = [
    {
      controlMode: false,
      pane: { id: "%9" },
      session: { id: "$3" },
      window: { id: "@1", panes: { toArray: () => [{ id: "%9" }] }, zoomedFlag: true },
    },
    {
      controlMode: false,
      pane: { id: "%7" },
      session: { id: "$4" },
      window: { id: "@1", panes: { toArray: () => [{ id: "%7" }] }, zoomedFlag: true },
    },
    {
      controlMode: false,
      pane: { id: "%7" },
      session: { id: "$3" },
      window: { id: "@2", panes: { toArray: () => [{ id: "%7" }] }, zoomedFlag: true },
    },
  ];

  await Promise.all(
    cases.map(async (client) => {
      const observed = snapshot({ clients: [client] });
      const identity = await resolveCallerIdentity(
        server(),
        observed,
        readCallerEnvironment({}),
        authority(),
      );
      expect(identity.inputProblem).toContain("client");
      expect(identity.attendedPaneIds).toEqual([]);
    }),
  );
});

test("terminal client topology accepts the matching linked-pane placement", async () => {
  const observed = snapshot();
  const pane = observed.panes.toArray()[0] as Pane;
  const linkedWindow = { id: "@2", panes: { toArray: () => [pane] }, zoomedFlag: true };
  const clientWindow = { id: "@1", panes: { toArray: () => [pane] }, zoomedFlag: true };
  const linked = {
    clients: {
      toArray: () => [
        {
          controlMode: false,
          pane: { id: pane.id },
          session: { id: "$3", name: "three" },
          window: clientWindow,
        },
      ],
    },
    panes: {
      toArray: () => [
        {
          currentCommand: pane.currentCommand,
          dead: pane.dead,
          format: { ...pane.format, session_id: "$4", window_id: "@2" },
          id: pane.id,
          inMode: pane.inMode,
          inputOff: pane.inputOff,
          synchronized: pane.synchronized,
          window: linkedWindow,
        },
        pane,
      ],
    },
    sessions: observed.sessions,
  } as unknown as ServerSnapshot;

  const identity = await resolveCallerIdentity(
    server(),
    linked,
    readCallerEnvironment({}),
    authority(),
  );

  expect(identity.inputProblem).toBeUndefined();
  expect(identity.attendedPaneIds).toEqual([pane.id]);
});

test("input observation rejects a daemon transition around its snapshot", async () => {
  await withSocket(async (base) => {
    const events: string[] = [];
    const authorities = [`${base}\t42\t700`, `${base}\t42\t701`];
    const tmux = {
      cmd: async () => {
        events.push("authority");
        return [authorities.shift() ?? ""];
      },
      snapshot: async () => {
        events.push("snapshot");
        return snapshot();
      },
      socketName: undefined,
      socketPath: base,
      tmuxBin: "tmux",
    } as unknown as Server;
    const context = createContext(tmux, resolvePolicy({}), attached({ TMUX: `${base},42,3` }));

    await expect(context.observeInput()).rejects.toThrow("changed while observing");
    expect(events).toEqual(["authority", "snapshot", "authority"]);
    await context.close();
  });
});
