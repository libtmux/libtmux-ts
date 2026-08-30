import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { buildSimpleWorkspace, buildWorkspace, removeWorkspace } from "./workspace.js";

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
});
