// The library's real-tmux fixture harness reaches into its internals, so it is
// unpublished and an in-repo consumer reaches across packages for it by path.
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../libtmux/src/_internal/test/run_root.js";
import { TestServer } from "../../libtmux/src/_internal/test/test_server.js";
import { Server } from "libtmux/server";
import { applyWorkspace } from "../src/builder.js";
import { parseWorkspaceYaml } from "../src/config.js";

import {
  assertOwnedSocketPath,
  makeTestDirectory,
} from "../../libtmux/src/_internal/test/temp_root.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-workspace-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "ws" });
        assertOwnedSocketPath(fixture.socketPath);
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

async function readMarker(path: string): Promise<readonly string[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await file.text()).split("\n").filter((line) => line.length > 0);
}

/**
 * Wait until every keystroke already sent to `session`'s first pane has run.
 *
 * `sendKeys` returns once tmux has delivered the keystrokes, not once the shell
 * has run them, so counting lines straight after an apply races the shell. A
 * pane runs what it is given in order, so sending a sentinel and waiting for
 * *that* proves everything queued ahead of it has already happened — which is
 * the only way to assert that something did **not** get sent.
 */
async function drain(server: Server, sessionName: string, marker: string): Promise<void> {
  const pane = (await server.snapshot()).panes.one({
    session: { is: { name: sessionName } },
    window: { is: { name: "main" } },
    index: "0",
  });
  const sentinel = `sentinel-${String(await readMarker(marker).then((lines) => lines.length))}`;
  await pane.sendKeys(`echo ${sentinel} >> ${marker}`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- Polling for an external process's effect; the whole point is one read after another.
    if ((await readMarker(marker)).includes(sentinel)) return;
    // eslint-disable-next-line no-await-in-loop -- Same: the wait is the loop.
    await Bun.sleep(50);
  }
  throw new Error(`pane never ran the ${sentinel} sentinel`);
}

function ranCount(lines: readonly string[]): number {
  return lines.filter((line) => line === "ran").length;
}

const WORKSPACE = `
session_name: project
windows:
  - window_name: editor
    panes:
      - shell_command: "true"
      - shell_command: "true"
  - window_name: server
    options:
      main-pane-width: "80"
    panes:
      - "true"
`;

describe("workspace builder", () => {
  test("parses a tmuxp-shaped workspace", () => {
    const workspace = parseWorkspaceYaml(WORKSPACE);

    expect(workspace.session_name).toBe("project");
    expect(workspace.windows).toHaveLength(2);
    expect(workspace.windows[0]?.window_name).toBe("editor");
    expect(workspace.windows[1]?.panes).toHaveLength(1);
  });

  test("rejects a workspace missing its session name", () => {
    expect(() => parseWorkspaceYaml("windows: []")).toThrow();
  });

  test("rejects a key it does not know, at every level", () => {
    // A dropped key is a window that quietly loses its name, so a typo has to
    // stop the apply rather than change what gets built.
    expect(() => parseWorkspaceYaml("session_name: x\nwindwos: []\n")).toThrow();
    expect(() =>
      parseWorkspaceYaml("session_name: x\nwindows:\n  - window_nam: editor\n"),
    ).toThrow();
    expect(() =>
      parseWorkspaceYaml("session_name: x\nwindows:\n  - panes:\n      - shell_commnd: 'true'\n"),
    ).toThrow();
  });

  test("rejects a workspace that describes no windows", () => {
    // A session always has a window, so this asks for a state tmux cannot hold.
    expect(() => parseWorkspaceYaml("session_name: x\nwindows: []\n")).toThrow();
  });

  test("rejects a YAML-coerced boolean where a shell command belongs", () => {
    // YAML turns bare true/yes/on into booleans, so an unquoted command is
    // rejected rather than silently coerced back into a string.
    expect(() =>
      parseWorkspaceYaml("session_name: x\nwindows:\n  - panes:\n      - true\n"),
    ).toThrow();
  });

  test("builds the described session without a stray leading window", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await applyWorkspace(server, parseWorkspaceYaml(WORKSPACE));

      expect(session.name).toBe("project");

      const snapshot = await server.snapshot();
      const windows = snapshot.windows.filter((window) => window.sessionId === session.id);

      // Exactly the two described windows: the first was adopted, not created.
      expect(windows.length).toBe(2);
      expect(windows.map((window) => window.name)).toEqual(["editor", "server"]);

      expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(2);
      expect(snapshot.panes.count({ window: { is: { name: "server" } } })).toBe(1);
    });
  }, 60_000);

  test("re-applying the same workspace converges instead of duplicating", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const workspace = parseWorkspaceYaml(WORKSPACE);
      const first = await applyWorkspace(server, workspace);
      const second = await applyWorkspace(server, workspace);

      expect(second.id).toBe(first.id);

      const snapshot = await server.snapshot();
      expect(snapshot.sessions.count({ name: "project" })).toBe(1);
      expect(snapshot.windows.count({ session: { is: { name: "project" } } })).toBe(2);
      expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(2);
      expect(snapshot.panes.count({ window: { is: { name: "server" } } })).toBe(1);
    });
  }, 90_000);

  test("converges a running session down to a smaller workspace", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await applyWorkspace(server, parseWorkspaceYaml(WORKSPACE));
      await applyWorkspace(
        server,
        parseWorkspaceYaml(
          'session_name: project\nwindows:\n  - window_name: editor\n    panes:\n      - "true"\n',
        ),
      );

      const snapshot = await server.snapshot();
      const windows = snapshot.windows.where({ session: { is: { name: "project" } } });

      expect(windows.count()).toBe(1);
      expect(windows.one().name).toBe("editor");
      expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(1);
    });
  }, 90_000);

  test("converges a running session up to a larger workspace", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await applyWorkspace(
        server,
        parseWorkspaceYaml(
          'session_name: project\nwindows:\n  - window_name: editor\n    panes:\n      - "true"\n',
        ),
      );
      await applyWorkspace(server, parseWorkspaceYaml(WORKSPACE));

      const snapshot = await server.snapshot();
      expect(snapshot.windows.count({ session: { is: { name: "project" } } })).toBe(2);
      expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(2);
    });
  }, 90_000);

  test("honours the layout the workspace names", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const source = (layout: string) =>
        parseWorkspaceYaml(
          `session_name: laid-out\nwindows:\n  - window_name: main\n    layout: ${layout}\n    panes:\n      - "true"\n      - "true"\n`,
        );

      await applyWorkspace(server, source("even-horizontal"));
      const horizontal = (await server.snapshot()).windows.one({ name: "main" }).format
        .window_layout;

      await applyWorkspace(server, source("even-vertical"));
      const vertical = (await server.snapshot()).windows.one({ name: "main" }).format.window_layout;

      expect(horizontal).not.toBeNull();
      expect(vertical).not.toBe(horizontal);
    });
  }, 90_000);

  test("focuses the window and pane the workspace marks", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await applyWorkspace(
        server,
        parseWorkspaceYaml(
          [
            "session_name: focused",
            "windows:",
            "  - window_name: first",
            "    panes:",
            '      - "true"',
            "  - window_name: second",
            "    focus: true",
            "    panes:",
            '      - "true"',
            '      - shell_command: "true"',
            "        focus: true",
          ].join("\n"),
        ),
      );

      const snapshot = await server.snapshot();
      const active = snapshot.windows.one({
        active: true,
        session: { is: { name: "focused" } },
      });
      expect(active.name).toBe("second");
      expect(active.panes.one({ active: true }).index).toBe(1);
    });
  }, 90_000);

  test("runs shell_command_before ahead of every pane's own commands", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const workspace = parseWorkspaceYaml(
        [
          "session_name: seeded",
          "windows:",
          "  - window_name: main",
          "    shell_command_before: export LIBTMUX_SEED=1",
          "    panes:",
          '      - "true"',
          '      - "true"',
        ].join("\n"),
      );

      await applyWorkspace(server, workspace);
      const snapshot = await server.snapshot();
      expect(snapshot.panes.count({ window: { is: { name: "main" } } })).toBe(2);
    });
  }, 90_000);

  test("does not retype a pane's commands into a pane it did not create", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const marker = join(await makeTestDirectory("ltx-ws-marker-"), "ran");
      const workspace = parseWorkspaceYaml(
        [
          "session_name: once",
          "windows:",
          "  - window_name: main",
          "    panes:",
          `      - "echo ran >> ${marker}"`,
        ].join("\n"),
      );

      await applyWorkspace(server, workspace);
      await drain(server, "once", marker);
      await applyWorkspace(server, workspace);
      await drain(server, "once", marker);

      // The pane survived the second apply, so its command was not sent again.
      expect(ranCount(await readMarker(marker))).toBe(1);
    });
  }, 90_000);

  test("resends a pane's commands when asked to", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const marker = join(await makeTestDirectory("ltx-ws-marker-"), "ran");
      const workspace = parseWorkspaceYaml(
        [
          "session_name: twice",
          "windows:",
          "  - window_name: main",
          "    panes:",
          `      - "echo ran >> ${marker}"`,
        ].join("\n"),
      );

      await applyWorkspace(server, workspace, { commands: "always" });
      await drain(server, "twice", marker);
      await applyWorkspace(server, workspace, { commands: "always" });
      await drain(server, "twice", marker);

      expect(ranCount(await readMarker(marker))).toBe(2);
    });
  }, 90_000);

  test("applies window options from the workspace", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await applyWorkspace(server, parseWorkspaceYaml(WORKSPACE));
      const snapshot = await server.snapshot();
      const server_window = snapshot.windows
        .filter((window) => window.sessionId === session.id)
        .where({ name: "server" })
        .one();

      expect((await server_window.showOptions()).get("main-pane-width")).toBe("80");
    });
  }, 60_000);
});
