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

import { assertOwnedSocketPath, makeTestDirectory } from "../../src/_internal/test/temp_root.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServers(
  count: number,
  body: (fixtures: readonly TestServer[]) => Promise<void>,
): Promise<void> {
  const parent = await makeTestDirectory("ltx-contract-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixtures: TestServer[] = [];
        const open = async (remaining: number): Promise<void> => {
          if (remaining === 0) {
            await body(fixtures);
            return;
          }
          const fixture = await TestServer.create({
            runRoot,
            sessionName: `c${String(remaining)}`,
          });
          fixtures.push(fixture);
          await runWithCleanup(
            () => open(remaining - 1),
            () => fixture.dispose(),
          );
        };
        await open(count);
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

describe("snapshot immutability", () => {
  test("a handle reached from a snapshot never changes", async () => {
    await withServers(1, async ([fixture]) => {
      const server = serverFor(fixture!);
      const snapshot = await server.snapshot();
      const window = snapshot.windows.one({ session: { is: { name: fixture!.sessionName } } });
      const before = window.name;

      await server.cmd("rename-window", ["-t", window.id, "renamed"]);
      const refreshed = await window.refreshed();

      expect(window.name).toBe(before);
      expect(refreshed.name).toBe("renamed");
      expect(refreshed).not.toBe(window);
    });
  });

  test("a snapshot's criteria and its handles never disagree", async () => {
    await withServers(1, async ([fixture]) => {
      const server = serverFor(fixture!);
      const snapshot = await server.snapshot();
      const window = snapshot.windows.one({ session: { is: { name: fixture!.sessionName } } });
      const before = window.name ?? "";

      await server.cmd("rename-window", ["-t", window.id, "renamed"]);
      await window.refreshed();

      // Whatever `.where()` matches on, the handle it hands back must agree.
      expect(snapshot.windows.first({ name: before })?.name).toBe(before);
      expect(snapshot.windows.count({ name: "renamed" })).toBe(0);
    });
  });

  test("a refreshed handle carries the whole instant it was read at", async () => {
    await withServers(1, async ([fixture]) => {
      const server = serverFor(fixture!);
      const snapshot = await server.snapshot();
      const session = snapshot.sessions.one({ name: fixture!.sessionName });

      await server.cmd("new-window", ["-t", session.id, "-n", "added"]);
      const refreshed = await session.refreshed();

      // The refreshed handle's relations come from its own instant, not from
      // the snapshot the original was read at.
      expect(session.windows.count({ name: "added" })).toBe(0);
      expect(refreshed.windows.count({ name: "added" })).toBe(1);
    });
  });
});

describe("handle identity", () => {
  test("handles from different servers are never equal", async () => {
    await withServers(2, async (fixtures) => {
      const [left, right] = fixtures;
      const leftSnapshot = await serverFor(left!).snapshot();
      const rightSnapshot = await serverFor(right!).snapshot();

      const leftPane = leftSnapshot.panes.one();
      const rightPane = rightSnapshot.panes.one();
      // Two fresh servers both start numbering at %0, which is the whole point.
      expect(leftPane.id).toBe(rightPane.id);
      expect(leftPane.equals(rightPane)).toBe(false);

      const leftSession = leftSnapshot.sessions.one();
      const rightSession = rightSnapshot.sessions.one();
      expect(leftSession.equals(rightSession)).toBe(false);
    });
  });

  test("handles from the same server compare by entity, not by object", async () => {
    await withServers(1, async ([fixture]) => {
      const server = serverFor(fixture!);
      const first = (await server.snapshot()).panes.one();
      const second = (await server.snapshot()).panes.one();

      expect(second).not.toBe(first);
      expect(first.equals(second)).toBe(true);
    });
  });

  // Owns its socket rather than borrowing the fixture's: replacing the daemon
  // at a fixture's path is exactly what that harness refuses to reap, and it is
  // right to — the socket it recorded is not the socket it would be deleting.
  test("a restarted daemon invalidates the handles the old one handed out", async () => {
    const directory = await makeTestDirectory("ltx-restart-");
    const socketPath = join(directory, "s");
    assertOwnedSocketPath(socketPath);
    const server = new Server({ socketPath, tmuxBin: process.env.LIBTMUX_TMUX_BIN ?? "tmux" });
    try {
      await server.newSession({ name: "before" });
      const before = await server.daemonIdentity();
      expect(before?.pid).toBeDefined();

      const stale = (await server.snapshot()).panes.one();
      // tmux reissues ids from the start, so this pane's `%n` will belong to a
      // different pane in a moment.
      await server.cmd("kill-server").catch(() => undefined);
      await server.newSession({ name: "successor" });

      const after = await server.daemonIdentity();
      expect(after?.pid).not.toBe(before?.pid);

      // The old handle must refuse rather than address its successor's `%0`.
      // Refused before anything is sent, so this is a throw and not a rejection
      // — the command never became one.
      expect(() => stale.refreshed()).toThrow(/restarted/u);
      expect(() => stale.kill()).toThrow(/restarted/u);
      expect(() => stale.sendKeys("echo no")).toThrow(/restarted/u);

      // Reading what it captured is still fine: that instant did happen, and
      // answering from a frozen graph reaches no server at all.
      expect(stale.id).toBe("%0");
      expect(stale.window?.name).toBeDefined();
    } finally {
      await server.cmd("kill-server").catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("sameTmuxIdAs answers the raw-id question equals no longer answers", async () => {
    await withServers(2, async (fixtures) => {
      const [left, right] = fixtures;
      const leftPane = (await serverFor(left!).snapshot()).panes.one();
      const rightPane = (await serverFor(right!).snapshot()).panes.one();

      expect(leftPane.sameTmuxIdAs(rightPane)).toBe(true);
      expect(leftPane.equals(rightPane)).toBe(false);
    });
  });
});

describe("client criteria", () => {
  test("filters clients declaratively, and reaches what they are looking at", async () => {
    await withServers(1, async ([fixture]) => {
      const server = serverFor(fixture!);
      // A control connection is a client, which is the cheapest way to have one
      // without a terminal to attach.
      await using live = await server.connect();
      const snapshot = await live.snapshot();

      const clients = snapshot.clients;
      expect(clients.count()).toBeGreaterThan(0);

      const control = clients.one({ controlMode: "1" });
      // A control client occupies no terminal, so tmux reports an empty tty for
      // it — which is exactly the sort of thing criteria are for asserting.
      expect(control.tty).toBe("");
      expect(control.name).toStartWith("client-");

      // Criteria are data, and they compose the same way every other model's do.
      expect(clients.count({ NOT: [{ controlMode: "1" }] })).toBe(clients.count() - 1);
      expect(clients.exists({ name: { startsWith: "client-" } })).toBe(true);
      expect(clients.count({ name: "no-such-client" })).toBe(0);
      expect(clients.count({ OR: [{ controlMode: "1" }, { name: "no-such-client" }] })).toBe(1);

      // A client's relations are one-to-one and reach the session it is on.
      expect(clients.count({ session: { is: { name: fixture!.sessionName } } })).toBe(
        clients.count(),
      );
      expect(clients.count({ session: { isNot: { name: fixture!.sessionName } } })).toBe(0);
    });
  });
});
