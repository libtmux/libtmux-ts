import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { Server } from "../../src/server.js";

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-locale-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "locale" });
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

describe("capability probe", () => {
  /**
   * The probe runs before every other command, so whatever breaks it breaks
   * the library entirely. tmux sanitizes a literal tab out of
   * `display-message` output when the client's locale is not a UTF-8 one,
   * substituting `_` and running the fields together — and a stripped
   * environment is ordinary: a systemd unit, a container, cron, an MCP client
   * that curates what it passes on.
   */
  test("reads the daemon identity with no locale in the environment", async () => {
    await withServer(async (fixture) => {
      const stripped = Object.fromEntries(
        Object.entries(fixture.controllerEnvironment).filter(
          ([name]) => !name.startsWith("LC_") && name !== "LANG",
        ),
      );
      expect(Object.keys(stripped)).not.toContain("LANG");

      const server = new Server({
        environment: stripped,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      // Any command at all: the probe runs ahead of the first one.
      const snapshot = await server.snapshot();
      expect(snapshot.sessions.length).toBeGreaterThan(0);
      expect((await server.version()).raw).toMatch(/^\d|^next-/u);
    });
  }, 60_000);
});
