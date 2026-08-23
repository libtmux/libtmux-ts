import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { throughACustomEngine } from "./engine.js";

describe("engine", () => {
  test("the engine example drives tmux through a supplied transport", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      await server.newSession({ name: "reachable" });

      // A Server built with an engine has no socket of its own: everything it
      // knows arrives through the one operation the engine implements. Seeing
      // the same sessions is what says the seam carries the whole API.
      const throughEngine = await throughACustomEngine(server);

      expect(throughEngine).toBe((await server.snapshot()).sessions.count());
      expect(throughEngine).toBeGreaterThan(0);
    });
  }, 60_000);
});
