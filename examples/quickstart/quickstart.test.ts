import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { quickstart } from "./quickstart.js";

type ArenaRoute =
  | { readonly kind: "fixture" }
  | { readonly kind: "arena"; readonly socketPath: string; readonly tmuxBin: string };

function arenaRoute(environment: Readonly<Record<string, string | undefined>>): ArenaRoute {
  if (
    environment.LIBTMUX_ARENA_DESCRIPTOR === undefined ||
    environment.LIBTMUX_ARENA_DESCRIPTOR === ""
  ) {
    return { kind: "fixture" };
  }
  const artifact = environment.LIBTMUX_ARENA_ARTIFACT;
  const socketPath = environment.LIBTMUX_SOCKET_PATH;
  const tmuxBin = environment.LIBTMUX_TMUX_BIN;
  if (
    artifact === undefined ||
    artifact === "" ||
    socketPath === undefined ||
    socketPath === "" ||
    tmuxBin === undefined ||
    tmuxBin === ""
  ) {
    throw new Error("arena contract is incomplete");
  }
  if (artifact !== "typescript-quickstart") {
    throw new Error("arena artifact does not select quickstart");
  }
  return { kind: "arena", socketPath, tmuxBin };
}

function arenaServer(
  route: ArenaRoute,
  environment: Readonly<Record<string, string | undefined>>,
): Server | undefined {
  if (route.kind === "fixture") return undefined;
  return new Server({ environment, socketPath: route.socketPath, tmuxBin: route.tmuxBin });
}

async function arenaEvidence(server: Server, socketPath: string): Promise<string> {
  const identity = await server.daemonIdentity();
  if (identity === undefined) throw new Error("arena server did not report its identity");
  const [actualSocketPath] = await server.cmd("display-message", ["-p", "#{socket_path}"]);
  const [challenge] = await server.cmd("display-message", ["-p", "#{@libtmux_arena_challenge}"]);
  const serverPid = Number(identity.pid);
  if (!Number.isSafeInteger(serverPid) || serverPid < 1) {
    throw new Error("arena server reported an invalid pid");
  }
  if (actualSocketPath !== socketPath)
    throw new Error("arena socket does not match requested endpoint");
  if (challenge === undefined || challenge === "") throw new Error("arena challenge is empty");
  return JSON.stringify({
    artifact: "typescript-quickstart",
    challenge,
    schema: 1,
    server_pid: serverPid,
    socket_path: actualSocketPath,
  });
}

async function exerciseQuickstart(server: Server): Promise<void> {
  const snapshot = await quickstart(server);

  expect(snapshot.sessions.count({ name: "quickstart" })).toBe(1);
  expect(snapshot.windows.count({ name: "editor" })).toBe(1);
  expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(2);
}

describe("quickstart", () => {
  test("keeps the fixture when arena aliases are inactive", () => {
    expect(
      arenaRoute({
        LIBTMUX_ARENA_ARTIFACT: "typescript-quickstart",
        LIBTMUX_SOCKET_PATH: "/not-an-arena-socket",
        LIBTMUX_TMUX_BIN: "/not-an-arena-tmux",
      }),
    ).toEqual({ kind: "fixture" });
  });

  test("keeps the fixture when the arena descriptor is empty", () => {
    expect(
      arenaRoute({
        LIBTMUX_ARENA_DESCRIPTOR: "",
        LIBTMUX_ARENA_ARTIFACT: "typescript-quickstart",
        LIBTMUX_SOCKET_PATH: "/not-an-arena-socket",
        LIBTMUX_TMUX_BIN: "/not-an-arena-tmux",
      }),
    ).toEqual({ kind: "fixture" });
  });

  test("rejects an activated incomplete or mismatched arena before creating a server", () => {
    for (const [environment, message] of [
      [{ LIBTMUX_ARENA_DESCRIPTOR: "arena" }, "arena contract is incomplete"],
      [
        {
          LIBTMUX_ARENA_DESCRIPTOR: "arena",
          LIBTMUX_ARENA_ARTIFACT: "",
          LIBTMUX_SOCKET_PATH: "/arena.sock",
          LIBTMUX_TMUX_BIN: "/usr/bin/tmux",
        },
        "arena contract is incomplete",
      ],
      [
        {
          LIBTMUX_ARENA_DESCRIPTOR: "arena",
          LIBTMUX_ARENA_ARTIFACT: "typescript-quickstart",
          LIBTMUX_SOCKET_PATH: "",
          LIBTMUX_TMUX_BIN: "/usr/bin/tmux",
        },
        "arena contract is incomplete",
      ],
      [
        {
          LIBTMUX_ARENA_DESCRIPTOR: "arena",
          LIBTMUX_ARENA_ARTIFACT: "typescript-quickstart",
          LIBTMUX_SOCKET_PATH: "/arena.sock",
          LIBTMUX_TMUX_BIN: "",
        },
        "arena contract is incomplete",
      ],
      [
        {
          LIBTMUX_ARENA_DESCRIPTOR: "arena",
          LIBTMUX_ARENA_ARTIFACT: "other-example",
          LIBTMUX_SOCKET_PATH: "/arena.sock",
          LIBTMUX_TMUX_BIN: "/usr/bin/tmux",
        },
        "arena artifact does not select quickstart",
      ],
    ] as const) {
      expect(() => arenaRoute(environment)).toThrow(message);
    }
  });

  test("runs the quickstart against a borrowed arena endpoint and records evidence", async () => {
    await withServer(async (fixture) => {
      const challenge = "quickstart-arena";
      await fixture.executeText(["set-option", "-g", "@libtmux_arena_challenge", challenge]);
      const route = arenaRoute({
        ...fixture.controllerEnvironment,
        LIBTMUX_ARENA_DESCRIPTOR: "arena",
        LIBTMUX_ARENA_ARTIFACT: "typescript-quickstart",
        LIBTMUX_SOCKET_PATH: fixture.socketPath,
        LIBTMUX_TMUX_BIN: fixture.tmuxExecutable,
      });
      const server = arenaServer(route, fixture.controllerEnvironment);

      expect(route).toEqual({
        kind: "arena",
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      if (server === undefined) throw new Error("arena server missing");
      expect(server.socketPath).toBe(fixture.socketPath);
      expect(server.tmuxBin).toBe(fixture.tmuxExecutable);
      await exerciseQuickstart(server);

      const evidence = JSON.parse(await arenaEvidence(server, fixture.socketPath)) as {
        artifact: string;
        challenge: string;
        schema: number;
        server_pid: number;
        socket_path: string;
      };
      expect(evidence).toEqual({
        artifact: "typescript-quickstart",
        challenge,
        schema: 1,
        server_pid: fixture.daemonIdentity.pid,
        socket_path: fixture.socketPath,
      });
      expect(await server.isAlive()).toBe(true);
    });
  }, 60_000);

  test("runs end to end against real tmux", async () => {
    const route = arenaRoute(process.env);
    if (route.kind === "arena") {
      const arena = arenaServer(route, process.env);
      if (arena === undefined) throw new Error("arena server missing");
      await exerciseQuickstart(arena);
      console.log(`LIBTMUX_ARENA_EVIDENCE=${await arenaEvidence(arena, route.socketPath)}`);
      return;
    }

    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const snapshot = await quickstart(server);

      expect(snapshot.sessions.count({ name: "quickstart" })).toBe(1);
      expect(snapshot.windows.count({ name: "editor" })).toBe(1);
      expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(2);
    });
  }, 60_000);
});
