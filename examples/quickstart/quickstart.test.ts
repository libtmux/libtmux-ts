import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { quickstart } from "./quickstart.js";

describe("quickstart", () => {
  test("runs end to end against real tmux", async () => {
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
