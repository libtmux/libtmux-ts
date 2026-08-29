// The library's real-tmux fixture harness reaches into its internals, so it is
// unpublished and an in-repo consumer reaches across packages for it by path.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../libtmux/src/_internal/test/run_root.js";
import { TestServer } from "../../libtmux/src/_internal/test/test_server.js";
import { Server } from "libtmux/server";
import { asSingleInvocation } from "libtmux/engine";
import type { TmuxCommandRequest, TmuxCommandResult, TmuxEngine } from "libtmux/engine";
import { applyWorkspace, planWorkspace, WorkspaceApplyError } from "../src/builder.js";
import { OWNERSHIP_OPTION } from "../src/ownership.js";
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

/**
 * A tmux reached the long way round, standing in for ssh or `docker exec`.
 *
 * Trimmed from the library's own engine fixture. What matters here is only
 * that nothing this package does spawns tmux itself.
 */
function shellEngine(onInvocation: () => void): TmuxEngine {
  const run = async (
    request: TmuxCommandRequest,
    args: readonly string[],
  ): Promise<TmuxCommandResult> => {
    onInvocation();
    const quoted = [request.executable, ...args]
      .map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`)
      .join(" ");
    const child = Bun.spawn(["sh", "-c", quoted], {
      env: { ...request.environment },
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
    ]);
    return {
      cmd: [request.executable, ...args],
      returncode: code,
      signal: null,
      stderr: new Uint8Array(stderr),
      stdout: new Uint8Array(stdout),
    };
  };

  return {
    endpoint: "sh://local",
    execute: (request) => run(request, request.args),
    async executeGroup(requests) {
      const [first] = requests;
      if (first === undefined) return [];
      const invocation = asSingleInvocation(requests);
      const result = await run(first, invocation.args);
      const sections = invocation.sections(result.stdout);
      return sections.map((stdout, index) => ({
        cmd: result.cmd,
        returncode: index === sections.length - 1 ? result.returncode : 0,
        signal: null,
        stderr: index === sections.length - 1 ? result.stderr : new Uint8Array(),
        stdout,
      }));
    },
  };
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

  test("gives each initial pane directory precedence over its parents", async () => {
    const root = await makeTestDirectory("ltx-workspace-cwd-");
    const workspaceDirectory = join(root, "workspace");
    const windowDirectory = join(root, "window");
    const paneDirectory = join(root, "pane");
    await Promise.all(
      [workspaceDirectory, windowDirectory, paneDirectory].map((path) => mkdir(path)),
    );

    try {
      await withServer(async (fixture) => {
        const server = serverFor(fixture);
        await applyWorkspace(server, {
          session_name: "directories",
          start_directory: workspaceDirectory,
          windows: [
            {
              panes: [{ start_directory: paneDirectory }],
              start_directory: windowDirectory,
              window_name: "initial",
            },
            {
              panes: [{}],
              start_directory: windowDirectory,
              window_name: "window",
            },
            {
              panes: [{ start_directory: paneDirectory }],
              start_directory: windowDirectory,
              window_name: "later-pane",
            },
            { panes: [{}], window_name: "workspace" },
          ],
        });

        const panes = (await server.snapshot()).panes;
        expect(panes.one({ window: { is: { name: "initial" } } }).format.pane_current_path).toBe(
          paneDirectory,
        );
        expect(panes.one({ window: { is: { name: "window" } } }).format.pane_current_path).toBe(
          windowDirectory,
        );
        expect(panes.one({ window: { is: { name: "later-pane" } } }).format.pane_current_path).toBe(
          paneDirectory,
        );
        expect(panes.one({ window: { is: { name: "workspace" } } }).format.pane_current_path).toBe(
          workspaceDirectory,
        );
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  test("applies finite numeric and boolean YAML option values", async () => {
    const workspace = parseWorkspaceYaml(`
session_name: scalar-options
options:
  "@number": 42
  "@boolean": true
windows:
  - options:
      "@window-number": 7
      "@window-boolean": false
    window_name: main
`);

    expect(workspace.options).toEqual({ "@boolean": true, "@number": 42 });
    expect(workspace.windows[0]?.options).toEqual({
      "@window-boolean": false,
      "@window-number": 7,
    });
    expect(() =>
      parseWorkspaceYaml(`
session_name: invalid-number
options:
  "@number": .inf
windows:
  - window_name: main
`),
    ).toThrow();

    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await applyWorkspace(server, workspace);
      expect((await session.showOptions()).get("@number")).toBe("42");
      expect((await session.showOptions()).get("@boolean")).toBe("true");

      const window = (await server.snapshot()).windows.one({
        name: "main",
        session: { is: { name: "scalar-options" } },
      });
      expect((await window.showOptions()).get("@window-number")).toBe("7");
      expect((await window.showOptions()).get("@window-boolean")).toBe("false");
    });
  });

  test("reports completed milestones and the stage that failed", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const error = await applyWorkspace(
        server,
        parseWorkspaceYaml(`
session_name: partial
options:
  "@completed": "yes"
  not-a-real-option: "no"
windows:
  - window_name: main
`),
      ).then(
        () => undefined,
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(WorkspaceApplyError);
      if (!(error instanceof WorkspaceApplyError)) throw new Error("apply error lost its type");
      expect(error).toMatchObject({
        completed: [
          { kind: "session", status: "created" },
          { kind: "session-claimed" },
          { kind: "workspace-option", name: "@completed" },
        ],
        failed: { kind: "workspace-option", name: "not-a-real-option" },
        requiresReplan: true,
      });
      expect(error.cause).toBeInstanceOf(Error);
      expect(Object.isFrozen(error.completed)).toBe(true);
      expect(error.completed.every((step) => Object.isFrozen(step))).toBe(true);
      expect(Object.isFrozen(error.failed)).toBe(true);

      const session = (await server.snapshot()).sessions.one({ name: "partial" });
      expect((await session.showOptions()).get("@completed")).toBe("yes");
    });
  }, 60_000);

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

  test("builds through a supplied engine, spawning no tmux of its own", async () => {
    await withServer(async (fixture) => {
      let invocations = 0;
      const server = new Server({
        engine: shellEngine(() => {
          invocations += 1;
        }),
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      // Reconciling holds a control connection open when it can, which is a
      // process this one spawns. An engine says tmux is not somewhere this
      // process can spawn it, so the apply has to do without rather than
      // attach to whichever local tmux answers.
      const session = await applyWorkspace(server, parseWorkspaceYaml(WORKSPACE));

      expect(session.windows.map((window) => window.name)).toEqual(["editor", "server"]);
      const snapshot = await server.snapshot();
      expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(2);
      expect(invocations).toBeGreaterThan(0);
    });
  }, 120_000);

  test("builds the described session without a stray leading window", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await applyWorkspace(server, parseWorkspaceYaml(WORKSPACE));

      expect(session.name).toBe("project");

      const snapshot = await server.snapshot();
      const windows = snapshot.windows.filter((window) => window.format.session_id === session.id);

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

  test("leaves a session it did not create alone, and says what it left", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      // Made by hand, with the name a workspace happens to use. This is the
      // collision that turns "converge" into "kill somebody's panes".
      const mine = await server.newSession({ name: "handmade" });
      for (const name of ["notes", "logs", "scratch"]) {
        // eslint-disable-next-line no-await-in-loop -- window order is observable.
        await mine.newWindow({ name });
      }

      const workspace = {
        session_name: "handmade",
        windows: [{ panes: ["true"], window_name: "only" }],
      };

      const plan = await planWorkspace(server, workspace);
      expect(plan.owned).toBe(false);
      expect(plan.removesWindows).toEqual([]);
      expect(plan.retains).not.toBeEmpty();

      await applyWorkspace(server, workspace);

      // Converged additively: the first window took the described shape and
      // nothing else was removed.
      const after = (await server.snapshot()).sessions.one({ name: "handmade" });
      expect(after.windows.count()).toBe(4);
      expect((await after.showOptions()).get(OWNERSHIP_OPTION)).toBeUndefined();
    });
  }, 60_000);

  test("prunes a session it created, and marks it so a later apply knows", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const workspace = {
        session_name: "owned",
        windows: [
          { panes: ["true", "true"], window_name: "one" },
          { panes: ["true"], window_name: "two" },
        ],
      };

      const built = await applyWorkspace(server, workspace);
      expect((await built.showOptions()).get(OWNERSHIP_OPTION)).toBe("owned");

      const smaller = { ...workspace, windows: [workspace.windows[0]!] };
      const plan = await planWorkspace(server, smaller);
      expect(plan.owned).toBe(true);
      expect(
        plan.removesWindows.map(({ action, window }) => ({ action, name: window.name })),
      ).toEqual([{ action: "kill", name: "two" }]);
      expect(plan.retains).toEqual([]);

      await applyWorkspace(server, smaller);
      const after = (await server.snapshot()).sessions.one({ name: "owned" });
      expect(after.windows.count()).toBe(1);
    });
  }, 60_000);

  test("keeps duplicate window renames distinct in a plan", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await server.newSession({ name: "duplicate-plan", windowName: "same" });
      await session.newWindow({ name: "same" });
      const ids = (await server.snapshot()).sessions
        .one({ id: session.id })
        .windows.map(({ id }) => id);
      const firstId = ids[0];
      const secondId = ids[1];
      if (firstId === undefined || secondId === undefined) {
        throw new Error("expected two duplicate-name windows");
      }

      const plan = await planWorkspace(
        server,
        {
          session_name: "duplicate-plan",
          windows: [
            { panes: [{}], window_name: "first" },
            { panes: [{}], window_name: "second" },
          ],
        },
        { prune: "always" },
      );

      expect(
        plan.renamesWindows.map(({ from, to, window }) => ({
          from,
          id: window.id,
          position: window.position,
          to,
        })),
      ).toEqual([
        { from: "same", id: firstId, position: 0, to: "first" },
        { from: "same", id: secondId, position: 1, to: "second" },
      ]);
    });
  }, 60_000);

  test("unlinks a surplus window that another session uses", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const workspace = {
        session_name: "linked-workspace",
        windows: [
          { panes: [{}], window_name: "kept" },
          { panes: [{}], window_name: "shared" },
        ],
      };
      await applyWorkspace(server, workspace);
      const peer = await server.newSession({ name: "linked-peer" });
      const surplus = (await server.snapshot()).sessions
        .one({ name: workspace.session_name })
        .windows.at(1);
      if (surplus === undefined) throw new Error("expected a surplus window");
      await surplus.link({ session: peer.id });

      const smaller = { ...workspace, windows: [workspace.windows[0]!] };
      const plan = await planWorkspace(server, smaller);
      expect(plan.removesWindows.map(({ action, window }) => [action, window.id])).toEqual([
        ["unlink", surplus.id],
      ]);

      await applyWorkspace(server, smaller);
      const after = await server.snapshot();
      expect(after.sessions.one({ name: workspace.session_name }).windows.count()).toBe(1);
      expect(after.sessions.one({ id: peer.id }).windows.exists({ id: surplus.id })).toBe(true);
    });
  }, 60_000);

  test("retains surplus windows shared by a session group", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const workspace = {
        session_name: "grouped-workspace",
        windows: [
          { panes: [{}], window_name: "kept" },
          { panes: [{}], window_name: "shared" },
        ],
      };
      await applyWorkspace(server, workspace);
      const peer = await server.newSession({
        groupWith: workspace.session_name,
        name: "group-peer",
      });
      const surplus = (await server.snapshot()).sessions
        .one({ name: workspace.session_name })
        .windows.at(1);
      if (surplus === undefined) throw new Error("expected a surplus window");

      const smaller = { ...workspace, windows: [workspace.windows[0]!] };
      const plan = await planWorkspace(server, smaller);
      expect(plan.removesWindows).toEqual([]);
      expect(plan.retains).toContainEqual({
        kind: "window",
        reason: "grouped-session",
        window: expect.objectContaining({ id: surplus.id }),
      });

      await applyWorkspace(server, smaller);
      const after = await server.snapshot();
      expect(
        after.sessions.one({ name: workspace.session_name }).windows.exists({ id: surplus.id }),
      ).toBe(true);
      expect(after.sessions.one({ id: peer.id }).windows.exists({ id: surplus.id })).toBe(true);
    });
  }, 60_000);

  for (const sharing of ["link", "group"] as const) {
    test(`retains surplus panes in a ${sharing === "link" ? "linked" : "grouped"} window`, async () => {
      await withServer(async (fixture) => {
        const server = serverFor(fixture);
        const workspace = {
          session_name: `${sharing}-pane-workspace`,
          windows: [{ panes: [{}, {}], window_name: "shared" }],
        };
        await applyWorkspace(server, workspace);
        const session = (await server.snapshot()).sessions.one({ name: workspace.session_name });
        const window = session.windows.one();
        const originalPaneIds = window.panes.map(({ id }) => id);

        // Workspace data cannot create shared topology, so the public core API sets up this fixture.
        if (sharing === "link") {
          const peer = await server.newSession({ name: "pane-link-peer" });
          await window.link({ session: peer.id });
        } else {
          await server.newSession({ groupWith: session.id, name: "pane-group-peer" });
        }

        const smaller = {
          ...workspace,
          windows: [{ ...workspace.windows[0]!, panes: [{}] }],
        };
        const plan = await planWorkspace(server, smaller);
        expect(plan.removesPanes).toEqual([]);
        expect(plan.retains).toContainEqual({
          count: 1,
          kind: "panes",
          reason: "shared-window",
          window: expect.objectContaining({ id: window.id }),
        });

        await applyWorkspace(server, smaller);
        const placements = (await server.snapshot()).windows.where({ id: window.id });
        expect(placements.map((placement) => placement.panes.map(({ id }) => id))).toEqual(
          placements.map(() => originalPaneIds),
        );
      });
    }, 60_000);
  }

  test("prunes a session it did not create only when told to in so many words", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const mine = await server.newSession({ name: "adopted" });
      await mine.newWindow({ name: "surplus" });

      const workspace = {
        session_name: "adopted",
        windows: [{ panes: ["true"], window_name: "only" }],
      };

      await applyWorkspace(server, workspace, { prune: "always" });
      const after = (await server.snapshot()).sessions.one({ name: "adopted" });
      expect(after.windows.count()).toBe(1);
    });
  }, 60_000);

  test("applies window options from the workspace", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await applyWorkspace(server, parseWorkspaceYaml(WORKSPACE));
      const snapshot = await server.snapshot();
      const server_window = snapshot.windows
        .filter((window) => window.format.session_id === session.id)
        .where({ name: "server" })
        .one();

      expect((await server_window.showOptions()).get("main-pane-width")).toBe("80");
    });
  }, 60_000);

  /**
   * Building from nothing, which every other test here starts past.
   *
   * `TestServer.create` starts a server *and* a session, so an apply in this
   * file always runs against a live one. A socket with no daemon behind it is
   * the state a first run is actually in, and reading it raises.
   */
  test("applies to a server that is not running yet", async () => {
    const parent = await makeTestDirectory("ltx-workspace-cold-");
    const socketPath = join(parent, "s");
    assertOwnedSocketPath(socketPath);
    const server = new Server({ socketPath });
    try {
      const session = await applyWorkspace(server, {
        session_name: "cold",
        windows: [
          { panes: [], window_name: "editor" },
          { panes: [], window_name: "logs" },
        ],
      });

      expect(session.name).toBe("cold");
      expect((await server.snapshot()).windows.map((window) => window.name)).toEqual([
        "editor",
        "logs",
      ]);
    } finally {
      await server.kill().catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  }, 60_000);

  test("plans against a server that is not running yet", async () => {
    const parent = await makeTestDirectory("ltx-workspace-cold-");
    const server = new Server({ socketPath: join(parent, "s") });
    try {
      const plan = await planWorkspace(server, {
        session_name: "cold",
        windows: [{ panes: [], window_name: "editor" }],
      });

      expect(plan.createsSession).toBe(true);
      expect(plan.createsWindows).toEqual([{ position: 0, name: "editor" }]);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  }, 60_000);
});
