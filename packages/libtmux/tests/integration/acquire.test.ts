import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { acquireServerGraph } from "../../src/_internal/operations/acquire.js";
import { createRuntimeContext } from "../../src/_internal/runtime/context.js";
import type { RuntimeContext } from "../../src/_internal/runtime/context.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import { parseSessionId, parseWindowId } from "../../src/_internal/runtime/ids.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import { NodeSpawnTransport } from "../../src/_internal/transport/node_spawn_transport.js";
import type { CommandRequest, CommandTransport } from "../../src/_internal/transport/types.js";
import type { ConnectionAlias, DaemonEpoch, WindowId } from "../../src/common.js";

import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";
import { Server } from "../../src/server.js";

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
    executeGroup(requests) {
      for (const request of requests) observe(request);
      return raw.executeGroup(requests);
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
          const subcommand = request.args.find((arg) => arg.startsWith("list-"));
          if (subcommand !== undefined) listed.push(subcommand);
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
            singles += 1;
            return raw.execute(request);
          },
          executeGroup(requests) {
            groups += 1;
            expect(requests).toHaveLength(4);
            return raw.executeGroup(requests);
          },
        },
      });

      await acquireServerGraph(runtime);

      // One group, and the only single command is the version probe. Four
      // separate listings would be four clients with four command queues, which
      // is what let a capture hold rows from two different topologies.
      expect({ groups, singles }).toEqual({ groups: 1, singles: 1 });
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
      // Churned over one control connection rather than a process per command:
      // a spawned churner is too slow to reliably catch four concurrent
      // listings mid-change, and a gate that only sometimes fires is not one.
      await using churnConnection = await churnServer.connect();
      let churning = true;
      const churn = (async () => {
        while (churning) {
          // eslint-disable-next-line no-await-in-loop -- the churn is the point: each change must land before the next.
          await churnConnection
            .cmd("new-window", ["-d", "-t", `${server.sessionName}:`])
            .catch(() => undefined);
          // eslint-disable-next-line no-await-in-loop -- as above.
          await churnConnection
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
