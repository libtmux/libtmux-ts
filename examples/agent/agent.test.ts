import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { arenaEvidence, arenaReset, arenaRoute, arenaServer } from "../test-support/arena.js";
import { withServer } from "../test-support/with-server.js";
import { buildAndSettle, runAndWait } from "./agent.js";

const ARTIFACT = "typescript-agent";
const SESSION_NAMES = ["agent", "settling"];

async function exerciseAgent(server: Server): Promise<void> {
  const seen = await runAndWait(server, "printf 'agent-done\\n'", "agent-done");
  expect(seen).toContain("agent-done");

  const count = await buildAndSettle(server, ["build", "test"]);
  expect(count).toBeGreaterThanOrEqual(3);
}

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

  test("runs end to end against real tmux", async () => {
    const route = arenaRoute(ARTIFACT, process.env);
    if (route.kind === "arena") {
      const arena = arenaServer(route, process.env);
      if (arena === undefined) throw new Error("arena server missing");
      await arenaReset(arena, SESSION_NAMES);
      await exerciseAgent(arena);
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

      await exerciseAgent(server);
    });
  }, 60_000);
});
