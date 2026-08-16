import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import type { Pane } from "../../src/pane.js";
import { TmuxCommandError } from "../../src/exc.js";
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
  const parent = await makeTestDirectory("ltx-mutate-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "mutate" });
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

/** Poll a pane until its contents satisfy a predicate or the deadline passes. */
async function captureUntil(
  pane: Pane,
  matches: (lines: readonly string[]) => boolean,
  attempts = 100,
): Promise<readonly string[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- Polling is inherently sequential.
    const lines = await pane.capture();
    if (matches(lines)) return lines;
    // eslint-disable-next-line no-await-in-loop -- Each wait follows the capture before it.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pane never reached the expected contents");
}

describe("lifecycle mutations", () => {
  test("creates a session, window, and pane, resolving each as a handle", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      const session = await server.newSession({ name: "created" });
      expect(session.name).toBe("created");

      const window = await session.newWindow({ name: "editor" });
      expect(window.name).toBe("editor");
      expect(window.sessionId).toBe(session.id);

      const pane = await window.split();
      expect(pane.windowId).toBe(window.id);
      // The returned pane is live; the window handle predates the split and
      // still reports the instant it was created at.
      expect(window.panes.length).toBe(1);
      expect((await server.snapshot()).panes.count({ window: { is: { name: "editor" } } })).toBe(2);
    });
  }, 40_000);

  test("a snapshot taken before a mutation keeps reporting its own instant", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const before = await server.snapshot();

      await server.newSession({ name: "later" });

      expect(before.sessions.length).toBe(1);
      expect((await server.snapshot()).sessions.length).toBe(2);
    });
  }, 40_000);

  test("kills a pane, window, and session", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await server.newSession({ name: "doomed" });
      const window = await session.newWindow({ name: "temp" });
      const pane = await window.split();

      await pane.kill();
      // The window handle predates the split, so it keeps reporting its own
      // instant rather than tracking later mutations.
      expect(window.panes.length).toBe(1);
      // A fresh snapshot shows the split pane was really removed.
      expect((await server.snapshot()).panes.count({ window: { is: { name: "temp" } } })).toBe(1);

      await window.kill();
      expect((await server.snapshot()).windows.count({ name: "temp" })).toBe(0);

      await session.kill();
      expect((await server.snapshot()).sessions.count({ name: "doomed" })).toBe(0);
    });
  }, 40_000);

  test("reports a tmux failure rather than inventing a handle", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await server.newSession({ name: "duplicate" });

      await expect(server.newSession({ name: "duplicate" })).rejects.toThrow(/new-session failed/);
    });
  }, 40_000);

  test("refresh advances one handle without unfreezing selections", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const snapshot = await server.snapshot();
      const window = snapshot.windows.one();
      expect(window.panes.length).toBe(1);

      await window.split();

      // The selection stays frozen at its own instant.
      expect(snapshot.windows.length).toBe(1);
      expect(window.panes.length).toBe(1);

      const later = await window.refreshed();

      // The later reading advances; the original stays where it was.
      expect(later.panes.length).toBe(2);
      expect(window.panes.length).toBe(1);
      expect(snapshot.panes.length).toBe(1);
    });
  }, 40_000);

  test("refreshed keeps a linked window on its own placement", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await server.newSession({ name: "other" });
      const window = (await server.snapshot()).windows
        .filter((candidate) => candidate.sessionName === fixture.sessionName)
        .one();
      await window.link({ index: 9, session: "other" });

      const originalIndex = window.index;
      const later = await window.refreshed();

      // Refreshing resolves the placement it was created at, not the new one.
      expect(later.index).toBe(originalIndex);
      expect(later.sessionName).toBe(fixture.sessionName);
    });
  }, 40_000);

  test("refreshing a killed object reports it rather than going quiet", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await server.newSession({ name: "transient" });

      await session.kill();

      await expect(session.refreshed()).rejects.toThrow(/no longer exists/);
    });
  }, 40_000);

  test("runs a command in a new window instead of a shell", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();

      const window = await session.newWindow({
        name: "runner",
        shellCommand: "echo window-command-ran; sleep 30",
      });

      const pane = window.panes.one();
      const lines = await captureUntil(pane, (captured) =>
        captured.some((line) => line.includes("window-command-ran")),
      );
      expect(lines.some((line) => line.trim() === "window-command-ran")).toBe(true);
    });
  }, 40_000);

  test("runs a command in a split pane", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();

      const split = await pane.split({ shellCommand: "echo split-command-ran; sleep 30" });

      const lines = await captureUntil(split, (captured) =>
        captured.some((line) => line.includes("split-command-ran")),
      );
      expect(lines.some((line) => line.trim() === "split-command-ran")).toBe(true);
    });
  }, 40_000);

  test("runs a command in a new session's first window", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      const session = await server.newSession({
        name: "with-command",
        shellCommand: "echo session-command-ran; sleep 30",
      });

      const pane = session.panes.one();
      const lines = await captureUntil(pane, (captured) =>
        captured.some((line) => line.includes("session-command-ran")),
      );
      expect(lines.some((line) => line.trim() === "session-command-ran")).toBe(true);
    });
  }, 40_000);

  test("resolves planned mutations to the same handles the direct calls give", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();

      const [editor, logs] = await server.batch([
        session.plan.newWindow({ name: "editor" }),
        session.plan.newWindow({ name: "logs" }),
      ]);

      // Handles, not lines: what a direct call resolves to, positionally and
      // individually typed, which is the whole difference from `pipeline`.
      expect(editor.name).toBe("editor");
      expect(logs.name).toBe("logs");
      expect(editor.id).toMatch(/^@\d+$/u);
      expect(editor.id).not.toBe(logs.id);
      expect(editor.sessionId).toBe(session.id);

      // A mixed batch stays typed per element rather than collapsing to a
      // union, so the pane keeps its own methods.
      const [pane] = await server.batch([editor.plan.split({})]);
      expect(pane.id).toMatch(/^%\d+$/u);
      expect(pane.windowId).toBe(editor.id);
      expect(await pane.capture()).toBeDefined();

      const named = (await server.snapshot()).windows.where({
        name: { in: ["editor", "logs"] },
      });
      expect(named.count()).toBe(2);
    });
  }, 40_000);

  test("plans a pane's own mutations, so trimming panes costs one round trip", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const window = (await server.snapshot()).windows.one();
      const origin = window.panes.one();

      // Splitting from the pane rather than the window, described rather than
      // run: three splits, one invocation and one snapshot.
      const created = await server.batch([
        origin.plan.split({}),
        origin.plan.split({}),
        origin.plan.split({}),
      ]);
      expect(created.map((pane) => pane.id)).toHaveLength(3);
      expect(new Set(created.map((pane) => pane.id)).size).toBe(3);

      // Trimming back down is the shape a workspace builder needs, and the
      // reason a pane needs a plan of its own: killing one at a time costs a
      // process and a snapshot each.
      const extra = (await server.snapshot()).windows.one({ id: window.id }).panes.toArray();
      await server.batch(extra.slice(1).map((pane) => pane.plan.kill()));

      const left = (await server.snapshot()).windows.one({ id: window.id }).panes;
      expect(left.count()).toBe(1);
      expect(left.one().id).toBe(origin.id);
    });
  }, 40_000);

  test("stops a batch at the first failure, leaving what ran applied", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();

      // A batch is a sequence, so it inherits the sequence's semantics rather
      // than gaining transactional ones it cannot have: tmux applies what it
      // reached and stops.
      await expect(
        server.batch([
          session.plan.newWindow({ name: "survives" }),
          // `-t` naming a session that is not there is refused by tmux.
          { argv: ["new-window", "-t", "$999999"], resolve: () => undefined },
          session.plan.newWindow({ name: "never-runs" }),
        ]),
      ).rejects.toThrow();

      const windows = (await server.snapshot()).windows;
      expect(windows.count({ name: "survives" })).toBe(1);
      expect(windows.count({ name: "never-runs" })).toBe(0);
    });
  }, 40_000);

  test("runs a sequence in one invocation, framed per command", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      const results = await server.pipeline([
        ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", "one"],
        ["set-option", "-g", "status", "off"],
        ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", "two"],
      ]);

      // Positional: the silent command frames as empty rather than shifting
      // the creator behind it, which is the whole reason for the framing.
      expect(results).toHaveLength(3);
      expect(results[0]?.[0]).toMatch(/^@\d+$/u);
      expect(results[1]).toEqual([]);
      expect(results[2]?.[0]).toMatch(/^@\d+$/u);

      const windows = (await server.snapshot()).windows;
      expect(windows.exists({ name: "one" })).toBe(true);
      expect(windows.exists({ name: "two" })).toBe(true);
    });
  }, 40_000);

  test("stops at the first failure, naming the command and keeping what ran", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // tmux applies what came before and stops; nothing rolls back.
      const failing = server.pipeline([
        ["new-window", "-d", "-n", "applied"],
        ["kill-window", "-t", "no-such-window-9999"],
        ["new-window", "-d", "-n", "never"],
      ]);

      const thrown = await failing.then(
        () => undefined,
        (error: unknown) => error,
      );

      // The error names the command that failed, not the whole sequence.
      expect(thrown).toBeInstanceOf(TmuxCommandError);
      expect((thrown as TmuxCommandError).args).toEqual([
        "kill-window",
        "-t",
        "no-such-window-9999",
      ]);

      const windows = (await server.snapshot()).windows;
      expect(windows.exists({ name: "applied" })).toBe(true);
      expect(windows.exists({ name: "never" })).toBe(false);
    });
  }, 40_000);

  test("refuses a command carrying its own separator", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // A bare `;` would split the command and shift every result after it.
      await expect(server.pipeline([["new-window", ";", "kill-server"]])).rejects.toThrow(
        TypeError,
      );
      await expect(server.pipeline([[]])).rejects.toThrow(TypeError);
      expect(await server.pipeline([])).toEqual([]);
    });
  }, 40_000);

  test("splits a sequence past tmux's argument limit rather than failing", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      // tmux refuses an argument vector past 1000 elements (cmd_unpack_argv in
      // cmd.c, "command too long"), and a sequence shares one vector. 400
      // commands of three arguments each, plus the framing, is well past it.
      const commands = Array.from({ length: 400 }, (_, index) => [
        "display-message",
        "-p",
        `line-${String(index)}`,
      ]);

      const results = await server.pipeline(commands);

      // Split across invocations, but the result is one sequence in order.
      expect(results).toHaveLength(400);
      expect(results[0]).toEqual(["line-0"]);
      expect(results[399]).toEqual(["line-399"]);
    });
  }, 40_000);

  test("names the failing command wherever it sits in the sequence", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const failing = ["kill-window", "-t", "no-such-window-9999"];
      const echo = (value: string): string[] => ["display-message", "-p", value];

      for (const commands of [
        [failing, echo("b")],
        [echo("a"), failing, echo("c")],
        [echo("a"), failing],
        // Past the chunk boundary, so the failure lands in a later invocation.
        [...Array.from({ length: 300 }, (_, index) => echo(`x${String(index)}`)), failing],
      ]) {
        // eslint-disable-next-line no-await-in-loop -- one sequence at a time.
        const thrown = await server.pipeline(commands).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(thrown).toBeInstanceOf(TmuxCommandError);
        expect((thrown as TmuxCommandError).args).toEqual(failing);
      }
    });
  }, 60_000);
});
