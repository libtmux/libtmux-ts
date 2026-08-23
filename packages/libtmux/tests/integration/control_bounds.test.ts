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

  test("carries a command's stdin, which the protocol itself cannot", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      // tmux's control protocol has no channel for stdin, so this is the one
      // command shape the connection has to hand elsewhere. Choosing a
      // transport must not decide which commands exist.
      await live.loadBuffer("payload", new TextEncoder().encode("from-stdin"));

      // Read it back through the connection to prove it reached this server,
      // not merely that the call resolved.
      expect((await live.showBuffer("payload")).join("")).toContain("from-stdin");
    });
  }, 40_000);

  test("carries run-shell output, which tmux writes after the block", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      // tmux writes `run-shell`'s closing guard when the command returns, not
      // when the job finishes, so its output arrives as bare lines belonging to
      // no command. Answering nothing is what a connection would otherwise do.
      // No newline in the command itself: one would route it to the same
      // fallback for the other reason, and the test would prove nothing.
      const command = "echo first; echo second";
      expect(command.includes("\n")).toBe(false);
      expect(await live.runShell(command)).toEqual(await server.runShell(command));
      expect(await live.runShell(command)).toEqual(["first", "second"]);
    });
  }, 40_000);

  test("rejects a bound that is not a positive integer, before spawning", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await expect(server.connect({ maxPendingCommands: 0 })).rejects.toThrow(
        /maxPendingCommands/u,
      );
      await expect(server.connect({ maxCommandBytes: -1 })).rejects.toThrow(/maxCommandBytes/u);
      await expect(server.connect({ pauseAfterSeconds: 0 })).rejects.toThrow(/pauseAfterSeconds/u);
      await expect(server.connect({ pauseAfterSeconds: 1.5 })).rejects.toThrow(
        /pauseAfterSeconds/u,
      );
    });
  }, 40_000);

  test("asks tmux to pause a pane rather than drop the client behind it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect({ pauseAfterSeconds: 1 });

      // tmux reports the flags it holds for this client.
      const flags = await live.cmd("display-message", ["-p", "#{client_flags}"]);
      expect(flags.join("")).toContain("pause-after=1");
    });
  }, 40_000);

  test("resumes a paused pane instead of leaving it stopped", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect({ pauseAfterSeconds: 1 });
      const events = live.subscribe();
      await events.ready();

      const paneId = (await live.snapshot()).panes.toArray()[0]?.id;
      expect(paneId).toBeDefined();

      // Waiting for a real backlog races the socket buffer and tmux's timer.
      // This reaches the same state on demand, and delivers the `%pause` inside
      // the command's block — where one lands whenever a pane backs up while a
      // command is in flight, which is what `pause-after` exists for.
      await live.cmd("refresh-client", ["-A", `${paneId!}:pause`]);

      // Raced against a timer: the loop body only runs when an event arrives,
      // so a deadline tested inside it is not a deadline.
      const paused = new Set<string>();
      const resumed = new Set<string>();
      const collected = (async () => {
        for await (const event of events) {
          if (event.kind === "pause") paused.add(event.paneId);
          if (event.kind === "continue") resumed.add(event.paneId);
          if (paused.size > 0 && [...paused].every((pane) => resumed.has(pane))) return;
        }
      })();
      await Promise.race([
        collected,
        new Promise((resolve) => {
          setTimeout(resolve, 20_000).unref();
        }),
      ]);

      // tmux sends nothing further for a paused pane until asked, so a
      // connection that only listens loses it permanently.
      expect([...paused]).toEqual([paneId!]);
      expect([...resumed]).toEqual([paneId!]);
    });
  }, 90_000);
});
