/**
 * Text that is not protocol, on a connection that could read it as protocol.
 *
 * Control mode is lines in both directions, and neither direction escapes them.
 * tmux writes a command's output to a control client unescaped, so what a pane
 * printed arrives looking like a guard; a caller's argument is written onto the
 * line tmux parses as a command, so a newline in one ends the command. These
 * read and write the same values over both transports, because the answers have
 * to agree — the transport is meant not to be observable.
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
  "%pause %1",
  "%continue %1",
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

describe("an argument cannot become a command", () => {
  test("carries a newline in a value, and injects nothing", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      // tmux reads a control client's input one line at a time and parses each
      // as a command list, so this value's second line would be `new-session`.
      const value = `line1\nnew-session -d -s injected\nline3`;
      await server.setBuffer("spawned", value);
      await live.setBuffer("connected", value);

      expect(await live.showBuffer("connected")).toEqual(await server.showBuffer("spawned"));
      expect((await server.snapshot()).sessions.exists({ name: "injected" })).toBe(false);
    });
  }, 60_000);

  test("answers a name holding a newline the same way over both transports", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      // What tmux answers here is version-dependent — 3.7 rejects a window
      // name holding a newline and earlier versions store it — which is the
      // reason this compares the two transports rather than naming an answer.
      const name = `a\nnew-session -d -s injected`;
      const outcome = async (target: Server): Promise<string> =>
        target.cmd("new-window", ["-d", "-n", name]).then(
          () => "resolved",
          (error: unknown) => (error as Error).message,
        );

      const spawned = await outcome(server);
      const connected = await outcome(live);

      expect(connected).toBe(spawned);
      // Whichever answer tmux gave, the second line was never a command.
      expect((await server.snapshot()).sessions.exists({ name: "injected" })).toBe(false);
    });
  }, 60_000);

  test("keeps a command list one instant when a value in it holds a newline", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      const results = await live.pipeline([
        ["set-buffer", "-b", "one", "a\nnew-session -d -s injected"],
        ["set-buffer", "-b", "two", "plain"],
        ["show-buffer", "-b", "one"],
      ]);

      expect(results[2]).toEqual(["a", "new-session -d -s injected"]);
      expect((await server.snapshot()).sessions.exists({ name: "injected" })).toBe(false);
    });
  }, 60_000);
});
