import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { executeGuardedListGroup } from "../../src/_internal/codec/guarded_listing.js";
import { acquireServerGraph, daemonIdentityOf } from "../../src/_internal/operations/acquire.js";
import { prepareInvocationRequest } from "../../src/_internal/operations/request.js";
import { createRuntimeContext, lastObservedDaemon } from "../../src/_internal/runtime/context.js";
import type { RuntimeContext } from "../../src/_internal/runtime/context.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import { parseSessionId, parseWindowId } from "../../src/_internal/runtime/ids.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { NodeSpawnTransport } from "../../src/_internal/transport/node_spawn_transport.js";
import type { CommandRequest, CommandTransport } from "../../src/_internal/transport/types.js";
import type { ConnectionAlias, DaemonEpoch, WindowId } from "../../src/common.js";

import { Server } from "../../src/server.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class GatedTransport implements CommandTransport {
  readonly #raw = new NodeSpawnTransport({ terminationGraceMs: 100 });
  #afterCapabilityProbe: ((probe: number) => Promise<void>) | undefined;
  #holdNext:
    | {
        readonly captured: ReturnType<typeof deferred>;
        readonly release: ReturnType<typeof deferred>;
      }
    | undefined;
  capabilityProbes = 0;
  invocations = 0;

  async execute(request: CommandRequest) {
    if (request.commands.length === 1) {
      const result = await this.#raw.execute(request);
      this.capabilityProbes += 1;
      await this.#afterCapabilityProbe?.(this.capabilityProbes);
      return result;
    }
    this.invocations += 1;
    const result = await this.#raw.execute(request);
    const hold = this.#holdNext;
    if (hold !== undefined) {
      this.#holdNext = undefined;
      hold.captured.resolve();
      await hold.release.promise;
    }
    return result;
  }

  afterCapabilityProbe(callback: (probe: number) => Promise<void>): void {
    this.#afterCapabilityProbe = callback;
  }

  holdNextInvocation(): { readonly captured: Promise<void>; readonly release: () => void } {
    const captured = deferred();
    const release = deferred();
    this.#holdNext = { captured, release };
    return { captured: captured.promise, release: release.resolve };
  }
}

async function restartServer(controller: Server, sessionName: string): Promise<void> {
  await controller.cmd("kill-server").catch(() => undefined);
  const deadline = Date.now() + 5_000;
  // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature.
  while (await controller.isAlive()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for tmux to exit");
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await controller.cmd("new-session", ["-d", "-s", sessionName], { target: null });
}

async function withRestartableServer(
  body: (fixture: {
    readonly controller: Server;
    readonly runtime: RuntimeContext;
    readonly transport: GatedTransport;
  }) => Promise<void>,
): Promise<void> {
  const directory = await makeTestDirectory("ltx-acquire-order-");
  const socketPath = join(directory, "s");
  const tmuxBin = process.env.LIBTMUX_TMUX_BIN ?? "tmux";
  const environment = Object.freeze({ ...process.env });
  const controller = new Server({
    engine: new NodeSpawnTransport(),
    environment,
    socketPath,
    tmuxBin,
  });
  const transport = new GatedTransport();
  const runtime = createRuntimeContext({
    connection: new TmuxConnection({ environment, executable: tmuxBin, socketPath }),
    connectionAlias: "acquisition-order" as ConnectionAlias,
    daemonEpoch: 0 as DaemonEpoch,
    transport,
  });
  try {
    await controller.cmd("new-session", ["-d", "-s", "before"], { target: null });
    await body({ controller, runtime, transport });
  } finally {
    await controller.cmd("kill-server").catch(() => undefined);
    await rm(directory, { force: true, recursive: true });
  }
}

function runtimeFor(
  server: TestServer,
  observe: (request: CommandRequest) => void = () => undefined,
): RuntimeContext {
  const raw = new NodeSpawnTransport({ terminationGraceMs: 100 });
  const transport: CommandTransport = {
    execute(request) {
      observe(request);
      return raw.execute(request);
    },
  };
  return createRuntimeContext({
    connection: new TmuxConnection({
      environment: server.controllerEnvironment,
      executable: server.tmuxExecutable,
      socketPath: server.socketPath,
    }),
    connectionAlias: server.logicalSocketName as ConnectionAlias,
    daemonEpoch: 0 as DaemonEpoch,
    transport,
  });
}

async function withServer(body: (server: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-acquire-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const server = await TestServer.create({ runRoot, sessionName: "acquire" });
        await runWithCleanup(
          () => body(server),
          () => server.dispose(),
        );
      },
      async () => {
        if (published === undefined) await reapOwnedRunRoot(runRoot);
        done = true;
      },
    );
  } finally {
    if (done) await rm(parent, { force: true, recursive: true });
  }
}

describe("server graph acquisition", () => {
  test("requires one complete daemon identity across every captured row", () => {
    const daemon = { pid: "101", start_time: "202" };

    expect(daemonIdentityOf(daemon, [[], []])).toEqual({ pid: "101", startTime: "202" });
    expect(daemonIdentityOf(daemon, [[daemon], [daemon]])).toEqual({
      pid: "101",
      startTime: "202",
    });
    expect(() => daemonIdentityOf({ pid: null, start_time: null }, [[]])).toThrow(
      "incomplete daemon identity",
    );
    for (const rows of [
      [[{ pid: "101", start_time: null }]],
      [[{ pid: null, start_time: "202" }]],
      [[{ pid: null, start_time: null }]],
      [[daemon], [{ pid: "303", start_time: "202" }]],
      [[daemon, { pid: "101", start_time: "404" }]],
    ]) {
      expect(() => daemonIdentityOf(daemon, rows)).toThrow(/daemon identity/u);
    }
  });

  test("builds the whole session, window, and pane graph", async () => {
    await withServer(async (server) => {
      await server.executeText(["new-window", "-d", "-t", server.sessionName, "-n", "editor"]);
      await server.executeText(["split-window", "-d", "-t", `${server.sessionName}:editor`]);

      const graph = await acquireServerGraph(runtimeFor(server));

      expect(graph.sessions.map(({ ref }) => ref.id)).toEqual([parseSessionId(server.sessionId)]);
      expect(graph.windows.length).toBe(2);
      expect(graph.panes.length).toBe(3);
    });
  }, 30_000);

  test("captures a live daemon whose complete graph has no rows", async () => {
    await withServer(async (server) => {
      await server.executeText(["set-option", "-s", "exit-empty", "off"]);
      await server.executeText(["kill-session", "-t", server.sessionName]);

      const graph = await acquireServerGraph(runtimeFor(server));
      const daemon = graph.capture.daemon;

      expect(daemon).toBeDefined();
      if (daemon === undefined) throw new Error("zero-row capture omitted its daemon identity");
      expect(daemon.pid).toBe(String(server.daemonIdentity.pid));
      expect(daemon.startTime).toMatch(/^\d+$/u);
      expect(graph.records).toEqual([]);
    });
  }, 30_000);

  test("gives every model its own records so selections have members", async () => {
    await withServer(async (server) => {
      await server.executeText(["new-window", "-d", "-t", server.sessionName, "-n", "editor"]);

      const graph = await acquireServerGraph(runtimeFor(server));
      const models = graph.records.map(({ model }) => model);

      expect(models.filter((model) => model === "session")).toHaveLength(1);
      expect(models.filter((model) => model === "window")).toHaveLength(2);
      expect(models.filter((model) => model === "pane")).toHaveLength(2);
    });
  }, 30_000);

  test("issues one listing per model regardless of topology", async () => {
    await withServer(async (server) => {
      for (const name of ["editor", "shell", "logs"]) {
        // eslint-disable-next-line no-await-in-loop -- tmux assigns window indexes in creation order, so these cannot race.
        await server.executeText(["new-window", "-d", "-t", server.sessionName, "-n", name]);
      }

      const listed: string[] = [];
      const graph = await acquireServerGraph(
        runtimeFor(server, (request) => {
          for (const command of request.commands) {
            if (command[0].startsWith("list-")) listed.push(command[0]);
          }
        }),
      );

      expect(listed.toSorted()).toEqual([
        "list-clients",
        "list-panes",
        "list-sessions",
        "list-windows",
      ]);
      expect(graph.windows.length).toBe(4);
    });
  }, 30_000);

  test("reads every listing in one tmux invocation", async () => {
    await withServer(async (server) => {
      let singles = 0;
      let groups = 0;
      const raw = new NodeSpawnTransport({ terminationGraceMs: 100 });
      const runtime = createRuntimeContext({
        connection: new TmuxConnection({
          environment: server.controllerEnvironment,
          executable: server.tmuxExecutable,
          socketPath: server.socketPath,
        }),
        connectionAlias: server.logicalSocketName as ConnectionAlias,
        daemonEpoch: 0 as DaemonEpoch,
        transport: {
          execute(request) {
            if (request.commands.length === 1) singles += 1;
            else groups += 1;
            return raw.execute(request);
          },
        },
      });

      await acquireServerGraph(runtime);

      // One acquisition invocation, and the only single is the version probe. Four
      // separate listings would be four clients with four command queues, which
      // is what let a capture hold rows from two different topologies.
      expect({ groups, singles }).toEqual({ groups: 1, singles: 1 });
    });
  }, 30_000);

  test("carries snapshot cancellation through acquisition", async () => {
    await withServer(async (fixture) => {
      const requests: CommandRequest[] = [];
      const raw = new NodeSpawnTransport({ terminationGraceMs: 100 });
      const controller = new AbortController();
      const server = new Server({
        engine: {
          execute(request) {
            requests.push(request);
            return raw.execute(request);
          },
        },
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      await server.snapshot({ signal: controller.signal });

      expect(requests.map(({ commands }) => commands.length)).toEqual([1, 5]);
      expect(requests[0]?.signal).toBeDefined();
      expect(requests[0]?.signal).not.toBe(controller.signal);
      expect(requests[1]?.signal).toBe(controller.signal);
    });
  }, 30_000);

  test("demultiplexes a later listing after an empty middle listing", async () => {
    await withServer(async (server) => {
      const runtime = runtimeFor(server);
      const { listings } = await executeGuardedListGroup({
        capabilities: runtime.capabilities,
        connection: runtime.connection,
        listings: [
          { listCommand: "list-sessions" },
          { listCommand: "list-clients" },
          { listCommand: "list-windows", listExtraArgs: ["-a"] },
        ],
        transport: runtime.transport,
      });
      const [sessions, clients, windows] = listings;

      expect(sessions).toHaveLength(1);
      expect(clients).toEqual([]);
      expect(windows).toHaveLength(1);
    });
  }, 30_000);

  test("returns one result for structural and literal semicolons", async () => {
    await withServer(async (server) => {
      const runtime = runtimeFor(server);
      const result = await runtime.transport.execute(
        prepareInvocationRequest(runtime.connection, [
          ["display-message", "-p", "literal;"],
          ["display-message", "-p", "second"],
        ]),
      );

      expect(result.returncode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toBe("literal;\nsecond\n");
    });
  }, 30_000);

  test("discards a delayed observation from the previous daemon", async () => {
    await withRestartableServer(async ({ controller, runtime, transport }) => {
      const baseline = await acquireServerGraph(runtime);
      const oldDaemon = baseline.capture.daemon;
      const held = transport.holdNextInvocation();
      const older = acquireServerGraph(runtime).then((graph) => ({
        graph,
        runtimeEpoch: runtime.daemonEpoch,
      }));
      await held.captured;

      await restartServer(controller, "after");
      const newer = acquireServerGraph(runtime).then((graph) => ({
        graph,
        runtimeEpoch: runtime.daemonEpoch,
      }));
      const newerResult = await newer.finally(held.release);

      const olderResult = await older;
      expect(olderResult.graph.capture.epoch).toBe(olderResult.runtimeEpoch);
      expect(newerResult.graph.capture.epoch).toBe(newerResult.runtimeEpoch);
      expect(olderResult.graph.capture.daemon).toEqual(lastObservedDaemon(runtime));
      expect(newerResult.graph.capture.daemon).toEqual(lastObservedDaemon(runtime));
      expect(newerResult.graph.capture.daemon).not.toEqual(oldDaemon);
      expect(runtime.daemonEpoch).toBe(1 as DaemonEpoch);
      expect(newerResult.graph).not.toBe(olderResult.graph);
    });
  }, 30_000);

  test("rebinds first capabilities when their daemon differs from the capture", async () => {
    await withRestartableServer(async ({ controller, runtime, transport }) => {
      transport.afterCapabilityProbe(async (probe) => {
        if (probe === 1) await restartServer(controller, "after-probe");
      });

      const graph = await acquireServerGraph(runtime);

      expect(transport.capabilityProbes).toBe(2);
      expect(transport.invocations).toBe(2);
      expect(graph.capture.daemon).toEqual(lastObservedDaemon(runtime));
      expect(graph.capture.epoch).toBe(1 as DaemonEpoch);
      expect(runtime.daemonEpoch).toBe(1 as DaemonEpoch);
    });
  }, 30_000);

  test("stops after two capability and capture conflicts", async () => {
    await withRestartableServer(async ({ controller, runtime, transport }) => {
      transport.afterCapabilityProbe((probe) => restartServer(controller, `after-probe-${probe}`));

      await expect(acquireServerGraph(runtime)).rejects.toThrow(
        "daemon changed repeatedly during graph acquisition",
      );
      expect(transport.capabilityProbes).toBe(2);
      expect(transport.invocations).toBe(2);
      expect(lastObservedDaemon(runtime)).toBeUndefined();
      expect(runtime.daemonEpoch).toBe(2 as DaemonEpoch);
    });
  }, 30_000);

  test("holds one topology while the server changes under it", async () => {
    await withServer(async (server) => {
      const runtime = runtimeFor(server);
      const churnServer = new Server({
        environment: server.controllerEnvironment,
        socketPath: server.socketPath,
        tmuxBin: server.tmuxExecutable,
      });
      let churning = true;
      const churn = (async () => {
        while (churning) {
          // eslint-disable-next-line no-await-in-loop -- the churn is the point: each change must land before the next.
          await churnServer
            .cmd("new-window", ["-d", "-t", `${server.sessionName}:`])
            .catch(() => undefined);
          // eslint-disable-next-line no-await-in-loop -- as above.
          await churnServer
            .cmd("kill-window", ["-t", `${server.sessionName}:$`])
            .catch(() => undefined);
        }
      })();

      let torn = 0;
      let captures = 0;
      const until = Date.now() + 2_000;
      while (Date.now() < until) {
        captures += 1;
        // eslint-disable-next-line no-await-in-loop -- each capture races the churn on its own.
        const graph = await acquireServerGraph(runtime);
        const windows = new Set(graph.windows.map(({ ref }) => ref.id));
        const paned = new Set(
          graph.records
            .filter((record) => record.model === "pane")
            .map((record) => record.scalars.window_id)
            .filter((id): id is WindowId => id !== null && id !== ""),
        );
        const agrees = windows.size === paned.size && [...paned].every((id) => windows.has(id));
        if (!agrees) torn += 1;
      }

      churning = false;
      await churn;

      // Structural, not lucky: the listings share one command queue drain, so
      // no change can land between them. Issued separately they tore about a
      // fifth of every capture under this churn.
      expect({ enough: captures > 20, torn }).toEqual({ enough: true, torn: 0 });
    });
  }, 30_000);

  test("keeps one window entity with two winlinks when a window is linked twice", async () => {
    await withServer(async (server) => {
      await server.executeText(["new-session", "-d", "-s", "other"]);
      const created = await server.executeText([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        server.sessionName,
        "-n",
        "shared",
      ]);
      const rawWindowId = created.stdout[0];
      if (rawWindowId === undefined) throw new Error("tmux did not return the created window id");
      const windowId = parseWindowId(rawWindowId);
      await server.executeText(["link-window", "-s", windowId, "-t", "other:9"]);

      const graph = await acquireServerGraph(runtimeFor(server));

      expect(graph.windows.filter(({ ref }) => ref.id === windowId)).toHaveLength(1);
      expect(graph.winlinks.filter(({ ref }) => ref.windowId === windowId)).toHaveLength(2);
    });
  }, 30_000);
});
