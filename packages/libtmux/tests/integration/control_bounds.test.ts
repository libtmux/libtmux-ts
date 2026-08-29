import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/testkit.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import { Server } from "../../src/server.js";
import { LibTmuxException, TmuxTransportError } from "../../src/exc.js";

import { assertOwnedSocketPath, makeTestDirectory } from "../../src/_internal/test/temp_root.js";

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

describe("control-mode event bounds", () => {
  test("names a connection that broke under a command in its own terms", async () => {
    const directory = await makeTestDirectory("ltx-broken-");
    const socketPath = join(directory, "s");
    assertOwnedSocketPath(socketPath);
    const server = new Server({ socketPath, tmuxBin: process.env.LIBTMUX_TMUX_BIN ?? "tmux" });
    try {
      const session = await server.newSession({ name: "breaking" });
      const live = await server.connect({ target: session.id });

      // Armed on a condition that never comes true, so the connection breaking
      // under it is what settles this — the other side of the same race as a
      // command issued after the connection is known closed.
      const armed = live.waitFor((snapshot) => snapshot.windows.exists({ name: "never" }), {
        timeoutMs: 30_000,
      });
      const killed = server.cmd("kill-server").catch(() => undefined);

      const failure = await armed.then(
        () => undefined,
        (error: unknown) => error,
      );
      await killed;
      await live.close().catch(() => undefined);

      // Which of the three racing outcomes wins is not this test's business.
      // What has to hold is that the caller is told in this package's terms:
      // Node's own EPIPE is not something a `LibTmuxException` handler sees.
      expect(failure).toBeInstanceOf(LibTmuxException);
      if (failure instanceof TmuxTransportError) expect(failure.delivery).not.toBe("replied");
    } finally {
      await server.cmd("kill-server").catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }, 40_000);

  test("rejects invalid observer options before spawning", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await expect(server.connect({ pauseAfterSeconds: 1 } as never)).rejects.toThrow(
        /pauseAfterSeconds belongs to Server\.watch/u,
      );
      const inherited = Object.create({ pauseAfterSeconds: 1 }) as never;
      await expect(server.connect(inherited)).rejects.toThrow(
        /pauseAfterSeconds belongs to Server\.watch/u,
      );
      await Promise.all(
        (["maxCommandBytes", "maxPendingCommands"] as const).map((removed) =>
          expect(server.connect({ [removed]: 1 } as never)).rejects.toThrow(
            new RegExp(`${removed} was removed`, "u"),
          ),
        ),
      );
      expect(() => server.watch({ pauseAfterSeconds: 0 })).toThrow(/pauseAfterSeconds/u);
      expect(() => server.watch({ pauseAfterSeconds: 1.5 })).toThrow(/pauseAfterSeconds/u);
    });
  }, 40_000);

  test("asks tmux to pause a pane rather than drop the client behind it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using events = server.watch({ pauseAfterSeconds: 1 });
      await events.ready();

      // tmux reports the flags it holds for this client.
      const flags = await server.cmd("list-clients", ["-F", "#{client_flags}"]);
      expect(flags.some((value) => value.includes("pause-after=1"))).toBe(true);
    });
  }, 40_000);

  test("reports a pane's output as output with pause-after enabled", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await server.newSession({ name: "aged" });
      await using events = server.watch({ pauseAfterSeconds: 5, target: session.id });
      await events.ready();

      const pane = (await server.snapshot()).sessions.one({ id: session.id }).panes.one();
      const printed = events.find(
        (event) => event.kind === "output" && event.data.includes("aged-marker"),
        { timeoutMs: 20_000 },
      );
      await pane.sendKeys("echo aged-marker-here");
      const event = await printed;
      await events.close();

      // tmux writes `%extended-output` for every pane once pause-after is set,
      // so a consumer filtering on "output" would stop seeing anything at the
      // moment backpressure began — which is when it most needs to see it.
      expect(event?.kind).toBe("output");
      // The age tmux reported comes with it rather than instead of it.
      expect(typeof (event as { readonly age?: number }).age).toBe("number");
    });
  }, 40_000);

  test("resumes a paused pane instead of leaving it stopped", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using events = server.watch({ pauseAfterSeconds: 1 });
      await events.ready();

      const paneId = (await server.snapshot()).panes.toArray()[0]?.id;
      expect(paneId).toBeDefined();

      // Waiting for a real backlog races the socket buffer and tmux's timer.
      // Address the observer explicitly so its notification stream remains
      // separate from this spawned command's response.
      const client = (await server.cmd("list-clients", ["-F", "#{client_name}\t#{client_flags}"]))
        .find((value) => value.includes("control-mode") && value.includes("pause-after=1"))
        ?.split("\t")[0];
      expect(client).toBeDefined();
      await server.cmd("refresh-client", ["-t", client!, "-A", `${paneId!}:pause`]);

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
