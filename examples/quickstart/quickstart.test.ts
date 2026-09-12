import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { arenaEvidence, arenaReset, arenaRoute, arenaServer } from "../test-support/arena.js";
import { withServer } from "../test-support/with-server.js";
import { quickstart } from "./quickstart.js";

const ARTIFACT = "typescript-quickstart";
const SESSION_NAMES = ["quickstart"];

async function exerciseQuickstart(server: Server): Promise<void> {
  const snapshot = await quickstart(server);

  expect(snapshot.sessions.count({ name: "quickstart" })).toBe(1);
  expect(snapshot.windows.count({ name: "editor" })).toBe(1);
  expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(2);
}

describe("quickstart", () => {
  test("runs the quickstart against a borrowed arena endpoint and records evidence", async () => {
    await withServer(async (fixture) => {
      const challenge = "quickstart-arena";
      await fixture.executeText(["set-option", "-g", "@libtmux_arena_challenge", challenge]);
      const route = arenaRoute(ARTIFACT, {
        ...fixture.controllerEnvironment,
        LIBTMUX_ARENA_DESCRIPTOR: "arena",
        LIBTMUX_ARENA_ARTIFACT: ARTIFACT,
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
      await arenaReset(server, SESSION_NAMES);
      await exerciseQuickstart(server);

      const evidence = JSON.parse(await arenaEvidence(ARTIFACT, server, fixture.socketPath)) as {
        artifact: string;
        challenge: string;
        schema: number;
        server_pid: number;
        socket_path: string;
      };
      expect(evidence).toEqual({
        artifact: ARTIFACT,
        challenge,
        schema: 1,
        server_pid: fixture.daemonIdentity.pid,
        socket_path: fixture.socketPath,
      });
      expect(await server.isAlive()).toBe(true);

      // The second run this same test proves is possible: a fixed session
      // name left over from the run above must not sink a rerun against the
      // same still-warm endpoint.
      await arenaReset(server, SESSION_NAMES);
      await exerciseQuickstart(server);
    });
  }, 60_000);

  test("runs end to end against real tmux", async () => {
    const route = arenaRoute(ARTIFACT, process.env);
    if (route.kind === "arena") {
      const arena = arenaServer(route, process.env);
      if (arena === undefined) throw new Error("arena server missing");
      await arenaReset(arena, SESSION_NAMES);
      await exerciseQuickstart(arena);
      console.log(
        `LIBTMUX_ARENA_EVIDENCE=${await arenaEvidence(ARTIFACT, arena, route.socketPath)}`,
      );
      return;
    }

    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      await exerciseQuickstart(server);
    });
  }, 60_000);
});
