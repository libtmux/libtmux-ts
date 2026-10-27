import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { arenaEvidence, arenaReset, arenaRoute, arenaServer } from "../test-support/arena.js";
import { withServer } from "../test-support/with-server.js";
import { buildSimpleWorkspace, buildWorkspace, removeWorkspace } from "./workspace.js";

const ARTIFACT = "typescript-workspace";
const SESSION_NAMES = ["work", "workspace-example"];

async function exerciseWorkspace(server: Server): Promise<void> {
  const built = await buildSimpleWorkspace(server);
  const snapshot = await server.snapshot();
  const session = snapshot.sessions.one({ id: built.id });
  expect(session.windows.map((window) => window.name)).toEqual(["editor", "logs", "shell"]);

  const workspaceSession = await buildWorkspace(server);
  const rebuilt = (await server.snapshot()).sessions.one({ name: "workspace-example" });
  expect(rebuilt.windows.map((window) => window.name)).toEqual(["editor", "server", "logs"]);
  expect(rebuilt.windows.one({ name: "editor" }).panes.length).toBe(2);
  expect(workspaceSession.id).toBe(rebuilt.id);

  expect(await removeWorkspace(server, "workspace-example")).toBe(true);
  // Removing one that is already gone is an answer, not a failure.
  expect(await removeWorkspace(server, "workspace-example")).toBe(false);
}

describe("workspace", () => {
  test("buildSimpleWorkspace builds the shape it promises", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const built = await buildSimpleWorkspace(server);

      const snapshot = await server.snapshot();
      const session = snapshot.sessions.one({ id: built.id });
      expect(session.windows.map((window) => window.name)).toEqual(["editor", "logs", "shell"]);
    });
  }, 60_000);

  test("buildWorkspace builds the layout it was given", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const session = await buildWorkspace(server);

      const built = (await server.snapshot()).sessions.one({ name: "workspace-example" });
      expect(built.windows.map((window) => window.name)).toEqual(["editor", "server", "logs"]);
      expect(built.windows.one({ name: "editor" }).panes.length).toBe(2);
      expect(session.id).toBe(built.id);

      expect(await removeWorkspace(server, "workspace-example")).toBe(true);
      // Removing one that is already gone is an answer, not a failure.
      expect(await removeWorkspace(server, "workspace-example")).toBe(false);
    });
  }, 60_000);

  test("runs end to end against real tmux", async () => {
    const route = arenaRoute(ARTIFACT, process.env);
    if (route.kind === "arena") {
      const arena = arenaServer(route, process.env);
      if (arena === undefined) throw new Error("arena server missing");
      await arenaReset(arena, SESSION_NAMES);
      await exerciseWorkspace(arena);
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

      await exerciseWorkspace(server);
    });
  }, 60_000);
});
