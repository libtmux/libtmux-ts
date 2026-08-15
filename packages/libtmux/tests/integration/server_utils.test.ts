import { rm, writeFile } from "node:fs/promises";
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

async function withServer(
  body: (fixture: TestServer, parent: string) => Promise<void>,
): Promise<void> {
  const parent = await makeTestDirectory("ltx-srvutil-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "util" });
        await runWithCleanup(
          () => body(fixture, parent),
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

describe("server utilities", () => {
  test("answers has-session without treating absence as failure", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      expect(await server.hasSession(fixture.sessionName)).toBe(true);
      expect(await server.hasSession("definitely-absent")).toBe(false);
    });
  }, 40_000);

  test("round-trips a named paste buffer and deletes it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      await server.setBuffer("greeting", "hello buffer");
      expect(await server.showBuffer("greeting")).toEqual(["hello buffer"]);
      expect(await server.listBuffers()).toContain("greeting");

      await server.deleteBuffer("greeting");
      expect(await server.listBuffers()).not.toContain("greeting");
    });
  }, 40_000);

  test("lists tmux commands", async () => {
    await withServer(async (fixture) => {
      const commands = await serverFor(fixture).listCommands();

      expect(commands).toContain("new-session");
      expect(commands).toContain("list-panes");
    });
  }, 40_000);

  test("sources a config file that changes a server option", async () => {
    await withServer(async (fixture, parent) => {
      const server = serverFor(fixture);
      const config = join(parent, "extra.conf");
      await writeFile(config, "set-option -s history-file /tmp/ltx-sourced\n");

      await server.sourceFile(config);

      expect((await server.showOptions()).get("history-file")).toBe("/tmp/ltx-sourced");
    });
  }, 40_000);

  test("renames a session and selects windows relatively", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();
      await session.newWindow({ name: "second" });

      await session.rename("renamed");
      expect((await server.snapshot()).sessions.count({ name: "renamed" })).toBe(1);

      await session.selectWindow("next");
      await session.selectWindow("previous");
      await session.selectWindow("last");

      // Relative selection is accepted and leaves exactly one active window.
      const active = (await server.snapshot()).windows.filter((window) => window.active === "1");
      expect(active.length).toBe(1);
    });
  }, 40_000);

  test("reports a reachable server as alive and a missing one as not", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      expect(await server.isAlive()).toBe(true);
      await expect(server.raiseIfDead()).resolves.toBeUndefined();

      const absent = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: `${fixture.socketPath}-absent`,
        tmuxBin: fixture.tmuxExecutable,
      });

      // A socket that was never created is a negative answer, not a failure.
      expect(await absent.isAlive()).toBe(false);
      await expect(absent.raiseIfDead()).rejects.toThrow(/list-sessions failed/);
    });
  }, 40_000);

  test("raises from collection accessors when the server is unreachable", async () => {
    await withServer(async (fixture) => {
      const absent = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: `${fixture.socketPath}-gone`,
        tmuxBin: fixture.tmuxExecutable,
      });

      // Python answers an empty list here. This port raises instead, so an
      // unreachable server can never be mistaken for an empty one, and
      // isAlive() is the way to ask without raising.
      await expect(absent.sessions()).rejects.toThrow();
      expect(await absent.isAlive()).toBe(false);
      expect(await serverFor(fixture).isAlive()).toBe(true);
    });
  }, 40_000);

  test("answers false rather than raising when tmux itself is missing", async () => {
    await withServer(async (fixture) => {
      const noBinary = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: "/nonexistent/tmux",
      });

      expect(await noBinary.isAlive()).toBe(false);
    });
  }, 40_000);

  test("says what it could not run, and why, when tmux is missing", async () => {
    const server = new Server({ tmuxBin: "/nonexistent/tmux" });

    // The first error a new user meets. Naming the path and the errno is the
    // difference between a five-second fix and a bug report.
    await expect(server.snapshot()).rejects.toThrow(
      /could not run \/nonexistent\/tmux \(ENOENT\)/u,
    );
  }, 30_000);

  test("reports an unreachable server in tmux's own words", async () => {
    const server = new Server({ socketPath: "/tmp/libtmux-absent-socket" });

    await expect(server.snapshot()).rejects.toThrow(/cannot reach tmux: error connecting/u);
  }, 30_000);

  test("runs a tmux command this package does not model", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // tmux has far more commands than this package types. list-keys is one
      // of them, and without an escape hatch a caller would have to rebuild the
      // socket, environment, and error handling to reach it.
      const keys = await server.cmd("list-keys", ["-T", "copy-mode"]);

      expect(keys.length).toBeGreaterThan(0);
    });
  }, 30_000);

  test("addresses a command at the handle that ran it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const snapshot = await server.snapshot();
      const pane = snapshot.panes.one();
      const window = snapshot.windows.one();

      // The handle supplies its own id, so no target has to be written out.
      expect(await pane.cmd("display-message", ["-p", "#{pane_id}"])).toEqual([pane.id]);
      expect(await window.cmd("display-message", ["-p", "#{window_id}"])).toEqual([window.id]);

      // And a command that takes no target can say so.
      const version = await server.cmd("display-message", ["-p", "#{version}"], { target: null });
      expect(version[0]).not.toBe("");
    });
  }, 30_000);

  test("reports a command tmux rejects like any other failure", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      await expect(server.cmd("no-such-command")).rejects.toThrow(/unknown command/u);
      expect(() => server.cmd("")).toThrow(TypeError);
    });
  }, 30_000);

  test("reports the version of the tmux it is actually driving", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      const version = await server.version();

      // The same string tmux prints for itself, so a build that reports a
      // suffix or `master` is not flattened away by the parsed fields.
      const reported = await server.cmd("display-message", ["-p", "#{version}"], { target: null });
      expect(reported[0]).toBeDefined();
      expect(version.raw).toBe(reported[0]!);
      expect(version.major).toBeGreaterThanOrEqual(3);
    });
  }, 30_000);

  test("compares against a minimum written the way tmux writes it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // 3.2a is this package's floor, so every supported build clears it.
      expect(await server.versionAtLeast("3.2a")).toBe(true);
      expect(await server.versionAtLeast("99.0")).toBe(false);
    });
  }, 30_000);

  test("loads a buffer too large to pass as an argument", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      // Comfortably past any platform's argument limit, which is the whole
      // reason this reads from stdin instead.
      const data = "x".repeat(4_000_000);

      await server.loadBuffer("bulk", data);

      // tmux's own byte count, so the whole payload is accounted for rather
      // than merely a buffer existing under the name.
      const sizes = await server.cmd("list-buffers", ["-F", "#{buffer_name}=#{buffer_size}"]);
      expect(sizes).toContain(`bulk=${String(data.length)}`);
    });
  }, 30_000);

  test("loads bytes a command line could not carry", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      // A NUL terminates a C string, so this cannot survive as an argument.
      const data = new Uint8Array([104, 105, 0, 98, 121, 101]);

      await server.loadBuffer("binary", data);

      expect(await server.listBuffers()).toContainEqual(expect.stringContaining("binary"));
    });
  }, 30_000);
});
