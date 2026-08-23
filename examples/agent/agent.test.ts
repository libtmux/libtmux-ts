import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { buildAndSettle, runAndWait } from "./agent.js";

describe("agent", () => {
  test("the agent example acts and waits on one connection", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const seen = await runAndWait(server, "printf 'agent-done\\n'", "agent-done");

      expect(seen).toContain("agent-done");
    });
  }, 60_000);

  test("the settling example waits for the shape it built", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const count = await buildAndSettle(server, ["build", "test"]);

      expect(count).toBeGreaterThanOrEqual(3);
    });
  }, 60_000);
});
