import { describe, expect, test } from "bun:test";

import { WaitTimeout } from "../../packages/libtmux/src/exc.js";
import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { buildAndSettle, runAndWait } from "./agent.js";

function serverFor(fixture: {
  controllerEnvironment: NodeJS.ProcessEnv;
  socketPath: string;
  tmuxExecutable: string;
}): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

describe("agent", () => {
  test("runAndWait completes on printed output, not a decoy that appears only in the keys", async () => {
    await withServer(async (fixture) => {
      const seen = await runAndWait(
        serverFor(fixture),
        "printf 'ltx-printed-ok\\n' # ltx-decoy-echo",
        "ltx-printed-ok",
      );

      expect(seen).toContain("ltx-printed-ok");
      expect(seen).not.toContain("ltx-decoy-echo");
    });
  }, 60_000);

  test("a marker that appears only in the keys does not complete the wait", async () => {
    await withServer(async (fixture) => {
      await expect(
        runAndWait(serverFor(fixture), "true # ltx-decoy-echo", "ltx-decoy-echo", {
          timeoutMs: 2_000,
        }),
      ).rejects.toBeInstanceOf(WaitTimeout);
    });
  }, 60_000);

  test("cancelling Pane.run leaves no control client on the fixture daemon", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await server.newSession({ name: "cancel" });
      const pane = session.activePane;
      if (pane === undefined) throw new Error("a new session always has one pane");
      const abort = new AbortController();

      const running = pane.run("sleep 30", {
        until: "ltx-never",
        signal: abort.signal,
        timeoutMs: 30_000,
      });
      abort.abort();
      await running.catch(() => undefined);

      const clients = (await server.snapshot()).clients;
      expect(clients.count({ controlMode: true })).toBe(0);
      await server.kill();
      expect(await server.isAlive()).toBe(false);
    });
  }, 60_000);

  test("the settling example waits for the shape it built", async () => {
    await withServer(async (fixture) => {
      const count = await buildAndSettle(serverFor(fixture), ["build", "test"]);

      expect(count).toBeGreaterThanOrEqual(3);
    });
  }, 60_000);
});
