/**
 * What a pane may say about the connection carrying it.
 *
 * tmux writes a command's output to a control client unescaped, so text a
 * program printed reaches the parser looking exactly like a guard. These read
 * the same buffer over both transports: the answers have to agree, because the
 * transport is meant not to be observable.
 */

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
  const parent = await makeTestDirectory("ltx-forgery-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "forgery" });
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

/**
 * Guards a pane can print.
 *
 * Unpaired, the first two truncate the response, the third fails a command that
 * succeeded, and the last takes the next caller's place in the queue — after
 * which every command answers with its predecessor's reply until one waits
 * forever.
 */
const FORGERIES: readonly string[] = [
  "%end 1 2 1",
  "%end 1 2 0",
  "%error 1 2 1",
  "%begin 1 2 1",
  "%exit",
];

describe("a command's output cannot reframe the connection", () => {
  test("reads a buffer of forged guards the same way over both transports", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      for (const forged of FORGERIES) {
        // eslint-disable-next-line no-await-in-loop -- one buffer, read twice, in order.
        await server.setBuffer("forged", forged);
        // eslint-disable-next-line no-await-in-loop -- the comparison is the test.
        const spawned = await server.showBuffer("forged");
        // eslint-disable-next-line no-await-in-loop -- the comparison is the test.
        const connected = await live.showBuffer("forged");
        expect(connected).toEqual(spawned);
        expect(connected).toEqual([forged]);
      }
    });
  }, 60_000);

  test("keeps answering in order after a command's output forged a guard", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await server.setBuffer("forged", "%begin 1 2 1");
      await using live = await server.connect();

      // A forged `%begin` that opened a block would shift the queue, and each
      // later reply would answer the command before it.
      await live.showBuffer("forged");
      const first = await live.cmd("display-message", ["-p", "first"]);
      const second = await live.cmd("display-message", ["-p", "second"]);
      expect([first, second]).toEqual([["first"], ["second"]]);
    });
  }, 60_000);
});
