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
import { TmuxTransportError } from "../../src/exc.js";

import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-bounds-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "bounds" });
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

describe("control-mode resource bounds", () => {
  test("refuses a command past the pending bound, and says nothing was sent", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect({ maxPendingCommands: 1 });

      // Two commands, neither awaited: tmux answers one at a time, so the
      // second finds the queue already at its bound.
      const first = live.cmd("display-message", ["-p", "#{version}"]);
      const second = live.cmd("display-message", ["-p", "#{version}"]);

      const outcome = await second.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(TmuxTransportError);
      const failure = outcome as TmuxTransportError;
      // The whole point of the bound is that this one is safe to retry.
      expect(failure.delivery).toBe("not_started");
      expect(failure.kind).toBe("protocol");

      // The queue is still a queue: the command that got in still answers.
      expect((await first)[0]).toContain(".");
    });
  }, 40_000);

  test("fails an oversized response without breaking the connection", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect({ maxCommandBytes: 1 });

      const outcome = await live.cmd("display-message", ["-p", "#{version}"]).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(TmuxTransportError);
      const failure = outcome as TmuxTransportError;
      // tmux ran it; the response is what could not be held. Retrying it is a
      // caller's decision to make with that in hand.
      expect(failure.delivery).toBe("replied");
      expect(failure.kind).toBe("protocol");

      // Consuming the whole block is what keeps the next command aligned with
      // its own response rather than reading this one's.
      const after = await live.cmd("display-message", ["-p", "#{version}"]).then(
        (lines) => lines,
        () => undefined,
      );
      expect(after).toBeUndefined();
    });
  }, 40_000);

  test("rejects a bound that is not a positive integer, before spawning", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await expect(server.connect({ maxPendingCommands: 0 })).rejects.toThrow(
        /maxPendingCommands/u,
      );
      await expect(server.connect({ maxCommandBytes: -1 })).rejects.toThrow(/maxCommandBytes/u);
    });
  }, 40_000);
});
