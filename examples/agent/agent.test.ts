import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { runsPrograms, withServer } from "../test-support/with-server.js";
import { buildAndSettle, runAndWait, runMarked, waitForExit } from "./agent.js";

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

  test.skipIf(!runsPrograms || Bun.which("bash") === null)(
    "reads a command's status from a shell's OSC 133 marks",
    async () => {
      await withServer(async (fixture) => {
        const server = new Server({
          environment: fixture.controllerEnvironment,
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });
        // A prompt hook that marks each command's end with its status, from the second
        // prompt on, so a command sent before bash is ready is still the first end.
        const hook = String.raw`s=$?; [ -n "$r" ] && printf "\033]133;D;%s\007" "$s"; r=1`;
        const session = await server.newSession({
          name: "marked",
          shellCommand: `env PROMPT_COMMAND='${hook}' bash --norc --noprofile -i`,
        });
        const pane = session.activePane;
        if (pane === undefined) throw new Error("a new session has a pane");
        expect(await runMarked(pane, "(exit 4)")).toBe(false);
        expect(await runMarked(pane, "true")).toBe(true);
      });
    },
    60_000,
  );

  test.skipIf(!runsPrograms)(
    "waits for a pane's program to exit and keeps the status",
    async () => {
      await withServer(async (fixture) => {
        const server = new Server({
          environment: fixture.controllerEnvironment,
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });
        const session = await server.newSession({ name: "build", shellCommand: "sleep 1; exit 7" });
        const pane = session.activePane;
        if (pane === undefined) throw new Error("a new session has a pane");
        expect(await waitForExit(pane)).toBe(7);
      });
    },
    60_000,
  );
});
