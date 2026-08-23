import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import { Server } from "../../src/server.js";

import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-diag-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "diag" });
        await runWithCleanup(
          () => body(fixture),
          () => fixture.dispose(),
        );
      },
      async () => {
        if (published === undefined) await reapOwnedRunRoot(runRoot);
        done = true;
      },
    );
  } finally {
    if (done) await rm(parent, { force: true, recursive: true });
  }
}

describe("diag", () => {
  test("what happens when the fixture server is killed under a find", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      const events = live.subscribe();
      await events.ready();

      const armed = events.find(() => false, { timeoutMs: 6_000 });
      const killed = await server.cmd("kill-server").then(
        () => "ok",
        (error: unknown) => `threw ${(error as Error).message.slice(0, 60)}`,
      );
      const aliveAfter = await server.isAlive();
      const outcome = await armed.then(
        (value) => `RESOLVED ${JSON.stringify(value)}`,
        (error: unknown) => `RAISED ${(error as Error).message.slice(0, 50)}`,
      );

      console.error(`DIAG kill=${killed} aliveAfter=${String(aliveAfter)} find=${outcome}`);
      await live.close().catch(() => undefined);
      expect(true).toBe(true);
    });
  }, 40_000);
});
