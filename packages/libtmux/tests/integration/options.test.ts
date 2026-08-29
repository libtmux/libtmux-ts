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
  const parent = await makeTestDirectory("ltx-options-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "opts" });
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

describe("option reads", () => {
  test("reads a server option that was just set", async () => {
    await withServer(async (fixture) => {
      await fixture.executeText(["set-option", "-s", "history-file", "/tmp/ltx history"]);

      const options = await serverFor(fixture).showOptions();

      expect(options.get("history-file")).toBe("/tmp/ltx history");
    });
  }, 30_000);

  test("reads session, window, and pane scopes independently", async () => {
    await withServer(async (fixture) => {
      await fixture.executeText(["set-option", "-t", fixture.sessionId, "status-left", "SESS"]);
      const snapshot = await serverFor(fixture).snapshot();
      const session = snapshot.sessions.one();
      const window = snapshot.windows.one();
      const pane = snapshot.panes.one();

      await fixture.executeText(["set-option", "-w", "-t", window.id, "main-pane-width", "81"]);
      await fixture.executeText(["set-option", "-p", "-t", pane.id, "remain-on-exit", "on"]);

      const [sessionOptions, windowOptions, paneOptions] = await Promise.all([
        session.showOptions(),
        window.showOptions(),
        pane.showOptions(),
      ]);

      expect(sessionOptions.get("status-left")).toBe("SESS");
      expect(windowOptions.get("main-pane-width")).toBe("81");
      // Window scope does not leak session options.
      expect(windowOptions.has("status-left")).toBe(false);
      // Pane scope lists only what was set on the pane, never inherited values.
      expect(paneOptions.get("remain-on-exit")).toBe("on");
      expect(paneOptions.has("main-pane-width")).toBe(false);
    });
  }, 30_000);

  test("preserves the index on array-valued options", async () => {
    await withServer(async (fixture) => {
      const options = await serverFor(fixture).showOptions();
      const indexed = [...options.keys()].filter((name) => name.includes("["));

      expect(indexed.length).toBeGreaterThan(0);
      expect(indexed.every((name) => /\[\d+\]$/.test(name))).toBe(true);
    });
  }, 30_000);

  test("sets, appends, and unsets options through the handle", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();

      await session.setOption("status-left", "A");
      expect((await session.showOptions()).get("status-left")).toBe("A");

      await session.setOption("status-left", "B", { append: true });
      expect((await session.showOptions()).get("status-left")).toBe("AB");

      await session.unsetOption("status-left");
      // Unset falls back to what the session inherits, not to the set value.
      expect((await session.showOptions()).get("status-left")).not.toBe("AB");
    });
  }, 30_000);

  test("sets and unsets hooks at every tmux scope", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const snapshot = await server.snapshot();
      const session = snapshot.sessions.one();
      const window = snapshot.windows.one();
      const pane = snapshot.panes.one();

      // Read back under the name it was set with: tmux prints the element as
      // `after-new-window[0]`, and keyed by that nothing here composes.
      await session.setHook("after-new-window", "display-message hooked");
      expect((await session.showHooks()).get("after-new-window")).toEqual([
        "display-message hooked",
      ]);

      await server.setHook("after-kill-pane", "display-message global");
      expect((await server.showHooks()).get("after-kill-pane")).toEqual(["display-message global"]);

      await window.setHook("window-renamed", "display-message window");
      expect((await window.showHooks()).get("window-renamed")).toEqual(["display-message window"]);

      await pane.setHook("pane-title-changed", "display-message pane");
      expect((await pane.showHooks()).get("pane-title-changed")).toEqual(["display-message pane"]);

      await session.unsetHook("after-new-window");
      expect((await session.showHooks()).has("after-new-window")).toBe(false);
      await window.unsetHook("window-renamed");
      expect((await window.showHooks()).has("window-renamed")).toBe(false);
      await pane.unsetHook("pane-title-changed");
      expect((await pane.showHooks()).has("pane-title-changed")).toBe(false);
    });
  }, 30_000);

  test("reports a hook tmux stores as several commands in its own order", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();

      await session.setHook("after-new-window", "display-message first");
      await session.setHook("after-new-window", "display-message second", { append: true });

      expect((await session.showHooks()).get("after-new-window")).toEqual([
        "display-message first",
        "display-message second",
      ]);
    });
  }, 30_000);

  test("replaces a hook's commands when appending is not asked for", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();

      await session.setHook("after-new-window", "display-message first");
      await session.setHook("after-new-window", "display-message second", { append: true });
      // A hook is a list, and a write without `append` is a write of the list.
      await session.setHook("after-new-window", "display-message only");

      expect((await session.showHooks()).get("after-new-window")).toEqual(["display-message only"]);
      void server;
    });
  }, 30_000);

  /**
   * What this package reads back, against what tmux says the value is.
   *
   * `show-options -v` prints the value with no quoting of its own, so it is
   * tmux's own answer to the question the escaped form is asking. Comparing
   * against it rather than against the value that was set keeps the test true
   * on a tmux that stores something else -- 3.4 keeps the backslash from a `$`,
   * which later versions do not.
   */
  test("reads an option value back the way tmux itself reports it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const values: readonly string[] = [
        "plain",
        "",
        `he said "hi"`,
        "$HOME/x",
        "a; b; c",
        "a #{b} c",
        "{ x }",
        "percent%pct",
        "'single'",
        "space in it",
        "trailing ",
        "#hash",
        "back\\slash",
        "tab\there",
        "~tilde",
        `"`,
        "$",
        "'",
        `a"b`,
        "#{?pane_in_mode,COPY,}",
        "#[fg=red]$USER@#H",
      ];

      for (const [index, value] of values.entries()) {
        const name = `@round-trip-${String(index)}`;
        // eslint-disable-next-line no-await-in-loop -- one option at a time is the test.
        await server.setOption(name, value);
        // eslint-disable-next-line no-await-in-loop -- same.
        const reported = (await server.cmd("show-options", ["-s", "-v", name])).join("\n");
        // eslint-disable-next-line no-await-in-loop -- same.
        const decoded = (await server.showOptions()).get(name);
        expect(decoded).toBe(reported);
      }
    });
  }, 60_000);

  test("resolves the options that govern an object, not just its own", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();
      await session.setOption("history-limit", "9999");
      const window = (await server.snapshot()).windows.one();

      const own = await window.showOptions();
      const resolved = await window.showResolvedOptions();

      // A window that has set nothing reports nothing, which is the answer to a
      // different question from the one a caller usually has.
      expect(own.size).toBe(0);
      expect(resolved.size).toBeGreaterThan(0);
      expect(resolved.get("main-pane-width")).toBeDefined();

      // tmux marks an inherited entry by suffixing the name; the name is the
      // option's, so a caller can look one up by the name they know.
      expect([...resolved.keys()].filter((name) => name.includes("*"))).toEqual([]);

      // What was set here wins over what would be inherited, and both readers
      // agree about it.
      const sessionOwn = await session.showOptions();
      const sessionResolved = await session.showResolvedOptions();
      expect(sessionOwn.get("history-limit")).toBe("9999");
      expect(sessionResolved.get("history-limit")).toBe("9999");
      // And an option the session never set still has an answer here.
      expect(sessionOwn.has("default-shell")).toBe(false);
      expect(sessionResolved.get("default-shell")).toBeDefined();
    });
  }, 30_000);

  test("rejects an unknown option with a tmux-sourced error", async () => {
    await withServer(async (fixture) => {
      await expect(serverFor(fixture).setOption("definitely-not-an-option", "1")).rejects.toThrow(
        /set-option failed/,
      );
    });
  }, 30_000);
});
