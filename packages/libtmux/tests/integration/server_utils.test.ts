import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { waitForProcessExit } from "../support/converge.js";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { TmuxCommandError } from "../../src/errors.js";
import { Server } from "../../src/server.js";

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

      await server.newSession({ name: "prefix-long" });
      expect(await server.hasSession("prefix")).toBe(false);

      // "." is a target separator with no `-t` spelling that is both exact
      // and correct, so hasSession lists sessions and compares directly --
      // verified here against a session actually named with one. tmux keeps
      // the name verbatim only from 3.7a on (earlier releases rewrite the
      // delimiter, and 3.7 itself refuses the name), so that is the one era
      // this can be exercised. newSession refuses such a name before tmux
      // ever sees it, so this spawns tmux directly instead.
      if (await server.versionAtLeast("3.7a")) {
        await fixture.executeText(["new-session", "-d", "-s", "my.proj"]);
        expect(await server.hasSession("my.proj")).toBe(true);
      }
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

  test("keeps a dash-prefixed buffer payload literal", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // `-a` is set-buffer's own append flag; without the guard this data
      // would be refused as one instead of stored as the buffer's contents.
      await server.setBuffer("dashed", "-a");

      expect(await server.showBuffer("dashed")).toEqual(["-a"]);
    });
  }, 40_000);

  test("guards a save-buffer path starting with a dash", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await server.setBuffer("savedash", "payload");

      // Neither `-n` nor any other save-buffer flag matches this whole
      // token; which error tmux gives is what proves the path arrived
      // whole: refused as an unrecognized flag without the guard, "no such
      // file" with it, once the path itself is what tmux tried to open.
      const failure = await server
        .saveBuffer("savedash", "-nonexistent-ltx-dir/out")
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);

      expect(failure).toBeInstanceOf(TmuxCommandError);
      expect((failure as TmuxCommandError).stderrIncludes("-nonexistent-ltx-dir")).toBe(true);
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

  test("guards a source-file path starting with a dash", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // Reaching tmux's own "no such file" reader, rather than being
      // refused as an unrecognized flag, is what proves the path arrived
      // whole.
      const failure = await server
        .sourceFile("-nonexistent-ltx-source")
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);

      expect(failure).toBeInstanceOf(TmuxCommandError);
      expect((failure as TmuxCommandError).stderrIncludes("-nonexistent-ltx-source")).toBe(true);
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
      const active = (await server.snapshot()).windows.filter((window) => window.active === true);
      expect(active.length).toBe(1);
    });
  }, 40_000);

  test("guards a session name starting with a dash", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();

      // rename-session takes no flag besides `-t`; without the guard this
      // name would be refused as an unrecognized one instead of applied.
      await session.rename("-dashed-name");

      expect((await server.snapshot()).sessions.count({ name: "-dashed-name" })).toBe(1);
    });
  }, 40_000);

  test("reports a reachable server as alive and a missing one as not", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      expect(await server.isAlive()).toBe(true);
      await expect(server.checkAlive()).resolves.toBeUndefined();
      await expect(server.raiseIfDead()).resolves.toBeUndefined();

      const absent = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: `${fixture.socketPath}-absent`,
        tmuxBin: fixture.tmuxExecutable,
      });

      // A socket that was never created is a negative answer, not a failure.
      expect(await absent.isAlive()).toBe(false);
      await expect(absent.checkAlive()).rejects.toThrow(/list-sessions failed/);
      await expect(absent.raiseIfDead()).rejects.toThrow(/list-sessions failed/);
    });
  }, 40_000);

  test("terminates the exact server it drives", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      await server.kill();
      await waitForProcessExit(fixture.daemonIdentity.pid);

      expect(await server.isAlive()).toBe(false);
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

  test("keeps a paste buffer's final blank line", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await server.loadBuffer("trailing-lines", "one\n\n");

      expect(await server.showBuffer("trailing-lines")).toEqual(["one", ""]);
    });
  }, 30_000);

  const exactBufferCases: readonly {
    readonly name: string;
    readonly data: Uint8Array;
  }[] = [
    { data: new Uint8Array([0x61, 0x00, 0x62]), name: "NUL" },
    { data: new Uint8Array([0xc3, 0x28, 0x80, 0xff]), name: "invalid UTF-8" },
    { data: new TextEncoder().encode("left\r\nright\r\n"), name: "CRLF" },
    { data: new TextEncoder().encode("one\n\n"), name: "trailing LF pair" },
    { data: new TextEncoder().encode("last line"), name: "no trailing LF" },
  ];

  for (const { data, name } of exactBufferCases) {
    test(`reads exact paste-buffer bytes with ${name}`, async () => {
      await withServer(async (fixture) => {
        const server = serverFor(fixture);
        const buffer = `exact-${name.replaceAll(" ", "-")}`;
        await server.loadBuffer(buffer, data);
        await using live = await server.connect();

        await expect(
          Promise.all([server.showBufferBytes(buffer), live.showBufferBytes(buffer)]),
        ).resolves.toEqual([data, data]);
      });
    }, 40_000);
  }
});
