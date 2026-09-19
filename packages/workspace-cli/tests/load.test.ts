import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Server } from "libtmux";
import { run as runCli } from "../src/app.ts";
import { processRun } from "../src/process.ts";
import {
  assertOwnedSocketPath,
  makeTestDirectory,
  readProcessIdentity,
  runWithCleanup,
  TestServer,
  withOwnedRunRoot,
} from "../../libtmux/src/_internal/test/testkit.js";

async function fixture(
  body: (
    server: Server,
    root: string,
    command: (
      args: string[],
      env?: Record<string, string>,
    ) => Promise<{ code: number; stdout: string; stderr: string }>,
  ) => Promise<void>,
) {
  await withOwnedRunRoot(
    "ltx-workspace-cli-",
    async (runRoot) => {
      const fixture = await TestServer.create({
        runRoot,
        sessionName: "fixture",
        ...(process.env.LIBTMUX_TEST_TMUX ? { tmuxExecutable: process.env.LIBTMUX_TEST_TMUX } : {}),
      });
      assertOwnedSocketPath(fixture.socketPath);
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      const directory = await makeTestDirectory("ltx-workspace-cli-files-");
      await runWithCleanup(
        async () => {
          await body(server, directory, async (args, env) => {
            const child = Bun.spawn(
              [
                process.execPath,
                new URL("../src/main.ts", import.meta.url).pathname,
                ...args,
                // A caller that names its own socket means it, so the
                // fixture's must not be appended behind it.
                ...(args[0] === "import" || args.includes("-S") ? [] : ["-S", fixture.socketPath]),
              ],
              {
                cwd: directory,
                env: {
                  ...fixture.controllerEnvironment,
                  TMUX_BIN: fixture.tmuxExecutable,
                  HOME: directory,
                  TMUX: "",
                  TMUX_PANE: "",
                  ...env,
                },
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            const [code, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            return { code, stdout, stderr };
          });
        },
        () =>
          runWithCleanup(
            () => fixture.dispose(),
            () => rm(directory, { recursive: true, force: true }),
          ),
      );
    },
    process.env.LIBTMUX_TEST_TMUX ?? "tmux",
  );
}

test("load starts the tmux server itself when the socket has no daemon", async () => {
  const directory = await makeTestDirectory("ltx-workspace-cli-cold-");
  const socketPath = join(directory, "sock");
  assertOwnedSocketPath(socketPath);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  await runWithCleanup(
    async () => {
      const workspace = join(directory, "workspace.json");
      await writeFile(workspace, JSON.stringify({ session_name: "cold-start", windows: [{}] }));
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("../src/main.ts", import.meta.url).pathname,
          "load",
          "-d",
          "-S",
          socketPath,
          workspace,
          "--json",
        ],
        {
          cwd: directory,
          env: { ...env, HOME: directory, TMUX: "", TMUX_PANE: "" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
      const result = JSON.parse(stdout) as { status: string; results: { session_name: string }[] };
      expect(result.status).toBe("ok");
      expect(result.results[0]?.session_name).toBe("cold-start");
      const server = new Server({ socketPath, environment: env });
      const sessions = (await server.snapshot()).sessions.toArray();
      expect(sessions.map((session) => session.name)).toEqual(["cold-start"]);
    },
    async () => {
      await new Server({ socketPath, environment: env }).kill().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  );
});

test("imported command groups load after relocation with native pane order", async () => {
  await fixture(async (server, root, command) => {
    const keeper = (await server.snapshot()).sessions.one({ name: "fixture" });
    const keeperPane = keeper.panes.one().id;
    const project = join(root, "project");
    const saved = join(root, "elsewhere");
    await mkdir(project);
    await mkdir(saved);
    const source = join(root, "import-source.json");
    const target = join(saved, "imported.json");
    await writeFile(
      source,
      JSON.stringify({
        name: "imported-groups",
        root: "project",
        pre_window: ["false", "printf prefix > prefix.marker"],
        windows: [
          {
            main: {
              pre: ["false", "touch forbidden.marker"],
              panes: [["printf first > order.marker", "printf second >> order.marker"]],
            },
          },
        ],
      }),
    );
    const imported = await command([
      "import",
      "tmuxinator",
      source,
      "--save-to",
      target,
      "--workspace-format",
      "json",
      "--json",
    ]);
    expect(imported.code, imported.stderr).toBe(0);
    const loaded = await command(["load", target, "-d", "--json"]);
    expect(loaded.code, loaded.stderr).toBe(0);
    const session = (await server.snapshot()).sessions.one({ name: "imported-groups" });
    expect(session.panes.count()).toBe(1);
    const marker = join(project, "order.marker");
    const deadline = Date.now() + 3000;
    let contents = "";
    /* eslint-disable no-await-in-loop -- Wait for complete command output within the deadline. */
    while (Date.now() < deadline && contents !== "firstsecond") {
      contents = await readFile(marker, "utf8").catch(() => "");
      if (contents !== "firstsecond") await Bun.sleep(10);
    }
    /* eslint-enable no-await-in-loop */
    expect(contents).toBe("firstsecond");
    expect(await readFile(join(project, "prefix.marker"), "utf8")).toBe("prefix");
    expect(await Bun.file(join(project, "forbidden.marker")).exists()).toBe(false);
    expect((await server.snapshot()).sessions.one({ id: keeper.id }).panes.one().id).toBe(
      keeperPane,
    );
  });
});

test.each(["before", "after", "teamocil"])(
  "imported %s synchronization preserves command delivery and focus",
  async (phase) => {
    await fixture(async (server, root, command) => {
      const keeper = (await server.snapshot()).sessions.one({ name: "fixture" });
      const keeperPane = keeper.panes.one().id;
      const input = join(root, "source.json");
      const saved = join(root, "workspace.json");
      const first = 'printf first >> "$(printenv TMUX_PANE).marker"';
      const second = 'printf second >> "$(printenv TMUX_PANE).marker"';
      const document =
        phase === "teamocil"
          ? {
              name: "import-sync",
              windows: [
                {
                  name: "main",
                  options: { "synchronize-panes": true },
                  panes: [
                    { commands: ["false", first] },
                    { commands: ["false", second], focus: true },
                  ],
                },
              ],
            }
          : {
              name: "import-sync",
              windows: [{ main: { synchronize: phase, panes: [first, second] } }],
            };
      await writeFile(input, JSON.stringify(document));
      const imported = await command([
        "import",
        phase === "teamocil" ? "teamocil" : "tmuxinator",
        input,
        "--save-to",
        saved,
        "--workspace-format",
        "json",
        "--json",
      ]);
      expect(imported.code, imported.stderr).toBe(0);
      const loaded = await command(["load", saved, "-d", "--json"]);
      expect(loaded.code, loaded.stderr).toBe(0);
      const session = (await server.snapshot()).sessions.one({ name: "import-sync" });
      const panes = session.panes.toArray();
      expect(panes).toHaveLength(2);
      // Both panes exist before either receives a command, so synchronize-panes
      // set beforehand mirrors both commands to both.
      const expected = phase === "after" ? ["first", "second"] : ["firstsecond", "firstsecond"];
      const paths = panes.map((pane) => join(root, `${pane.id}.marker`));
      let observed: string[] = [];
      const deadline = Date.now() + 3000;
      /* eslint-disable no-await-in-loop -- Observe each pane's completed writes within the deadline. */
      while (Date.now() < deadline) {
        observed = await Promise.all(paths.map((path) => readFile(path, "utf8").catch(() => "")));
        if (observed.every((value, index) => value === expected[index])) break;
        await Bun.sleep(10);
      }
      /* eslint-enable no-await-in-loop */
      expect(observed).toEqual(expected);
      // The importer writes an explicit focus on the first pane unless the
      // source names one, and an explicit focus still wins over the default.
      expect(session.activePane?.id).toBe(panes[phase === "teamocil" ? 1 : 0]!.id);
      expect((await server.snapshot()).sessions.one({ id: keeper.id }).panes.one().id).toBe(
        keeperPane,
      );
    });
  },
);

const extensionTest = test.skipIf(!process.env.LIBTMUX_TEST_PYTHON);

test.each([
  ["before_scrip", { before_scrip: "touch ignored" }],
  ["shell_command_befor", { windows: [{ shell_command_befor: "touch ignored" }] }],
  ["shell_commmand", { windows: [{ panes: [{ shell_commmand: "touch ignored" }] }] }],
  [
    "entter",
    { windows: [{ panes: [{ shell_command: [{ cmd: "touch executed", entter: false }] }] }] },
  ],
])(
  "native load rejects %s in later inputs before scripts or topology change",
  async (key, fields) => {
    await fixture(async (server, root, run) => {
      const before = await server.snapshot();
      const first = join(root, "first.json");
      const second = join(root, "second.json");
      await writeFile(join(root, "before.sh"), "#!/bin/sh\ntouch bootstrap-ran\n");
      await writeFile(
        first,
        JSON.stringify({
          session_name: "first",
          before_script: "/bin/sh ./before.sh",
          windows: [{}],
        }),
      );
      await writeFile(second, JSON.stringify({ session_name: "second", windows: [{}], ...fields }));
      const child = await run(["load", first, second, "-d", "--json"]);
      expect(child.code, child.stdout + child.stderr).toBe(1);
      expect(child.stdout).toBe("");
      expect(JSON.parse(child.stderr).message).toContain(`.${key}`);
      expect(await Bun.file(join(root, "bootstrap-ran")).exists()).toBe(false);
      const after = await server.snapshot();
      expect(after.daemonIdentity).toEqual(before.daemonIdentity);
      expect(after.sessions.toArray().map((session) => session.id)).toEqual(
        before.sessions.toArray().map((session) => session.id),
      );
      expect(after.windows.toArray().map((window) => window.id)).toEqual(
        before.windows.toArray().map((window) => window.id),
      );
      expect(after.panes.toArray().map((pane) => pane.id)).toEqual(
        before.panes.toArray().map((pane) => pane.id),
      );
    });
  },
);

test("native metadata and empty extensions preserve enter false command control", async () => {
  await fixture(async (server, root, run) => {
    const before = (await server.snapshot()).sessions.one({ name: "fixture" });
    const source = join(root, "controls.json");
    const marker = join(root, "command-ran");
    const cmd = "printf executed > command-ran";
    await writeFile(
      source,
      JSON.stringify({
        session_name: "controls",
        start_directory: root,
        description: "Session description",
        plugins: [],
        workspace_builder: " ",
        workspace_builder_options: { pane_readiness: "never" },
        windows: [
          {
            description: "Window description",
            panes: [{ description: "Pane description", shell_command: [{ cmd, enter: false }] }],
          },
        ],
      }),
    );
    const child = await run(["load", source, "-d", "--json"], {
      TMUX_WORKSPACE_PYTHON: "/missing-python",
    });
    expect(child.code, child.stdout + child.stderr).toBe(0);
    const snapshot = await server.snapshot();
    const pane = snapshot.sessions.one({ name: "controls" }).windows.at(0)!.panes.at(0)!;
    expect((await pane.capture()).join("\n")).toContain(cmd);
    expect(await Bun.file(marker).exists()).toBe(false);
    await pane.sendKeys("Enter", { literal: false, enter: false });
    const deadline = Date.now() + 5000;
    // eslint-disable-next-line no-await-in-loop -- Observe the submitted command's side effect.
    while (Date.now() < deadline && !(await Bun.file(marker).exists())) await Bun.sleep(10);
    expect(await readFile(marker, "utf8")).toBe("executed");
    expect(snapshot.sessions.one({ name: "fixture" }).id).toBe(before.id);
  });
});

extensionTest("Python plugin output stays separate from native ownership records", async () => {
  await fixture(async (server, root, run) => {
    await writeFile(
      join(root, "extension.py"),
      `
from tmuxp.plugin import TmuxpPlugin
from libtmux.common import get_version
import os
class Plugin(TmuxpPlugin):
    def __init__(self):
        super().__init__(plugin_name="fixture")
        assert self.tmux_version == get_version(tmux_bin=os.environ["TMUX_BIN"])
    def before_script(self, session):
        print("plugin finished", flush=True)
`,
    );
    const config = join(root, "plugin.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "plugin",
        plugins: ["extension.Plugin"],
        workspace_builder: "   ",
        workspace_builder_paths: ["."],
        windows: [{ window_name: "main", panes: [""] }],
      }),
    );
    const child = await run(["load", config, "-d", "--ndjson"], {
      TMUX_WORKSPACE_PYTHON: process.env.LIBTMUX_TEST_PYTHON!,
    });
    expect(child.code, child.stdout + child.stderr).toBe(0);
    const events = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.some(
        (event) => event.event === "script-output" && event.text.includes("plugin finished"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.event === "pane-created")).toBe(false);
    const result = events.at(-1).results[0];
    const session = (await server.snapshot()).sessions.one({ name: "plugin" });
    expect(result).toMatchObject({
      session_id: session.id,
      effects_scope: "observed",
      effects_unknown: true,
      created_windows: [],
      created_panes: [],
      observed_windows: session.windows.toArray().map((window) => window.id),
    });
  });
});

extensionTest("extension observation outlasts a slow acquisition", async () => {
  await fixture(async (server, root, run) => {
    const wrapper = join(root, "tmux-wrapper");
    await writeFile(
      wrapper,
      `#!${process.execPath}
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (existsSync(process.env.WORKSPACE_TEST_MARKER) && args.some(argument => argument.includes("ltxI"))) {
  await new Promise(resolve => setTimeout(resolve, 1200));
}
const result = spawnSync(process.env.WORKSPACE_TEST_TMUX, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(root, "extension.py"),
      `
import os
from tmuxp.plugin import TmuxpPlugin
class Plugin(TmuxpPlugin):
    def __init__(self):
        super().__init__(plugin_name="fixture")
        open(os.environ["WORKSPACE_TEST_MARKER"], "w").close()
`,
    );
    const config = join(root, "slow.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "slow-observation",
        plugins: ["extension.Plugin"],
        workspace_builder_paths: ["."],
        windows: [{ window_name: "main", panes: [""] }],
      }),
    );
    const child = await run(["load", config, "-d", "--json"], {
      TMUX_BIN: wrapper,
      TMUX_WORKSPACE_PYTHON: process.env.LIBTMUX_TEST_PYTHON!,
      WORKSPACE_TEST_MARKER: join(root, "built"),
      WORKSPACE_TEST_TMUX: server.tmuxBin,
    });
    expect(child.code, child.stdout + child.stderr).toBe(0);
    const result = JSON.parse(child.stdout).results[0];
    expect(result.observation_error).toBeUndefined();
    expect(result.session_id).toBe(
      (await server.snapshot()).sessions.one({ name: "slow-observation" }).id,
    );
  });
});

extensionTest(
  "cancelled Python append joins descendants and observes the retained target",
  async () => {
    await fixture(async (server, root) => {
      const before = (await server.snapshot()).sessions.one({ name: "fixture" });
      await writeFile(
        join(root, "extension.py"),
        `
import json, os, subprocess, sys, time
from pathlib import Path
class Custom:
    def __init__(self, session_config, server, plugins):
        self.server, self.plugins = server, plugins
    def build(self, session=None, append=False):
        self.session = session
        session.new_window(window_name="survives", attach=False)
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        Path("processes.json").write_text(json.dumps([os.getpid(), child.pid]))
        print("extension-ready", flush=True)
        time.sleep(30)
`,
      );
      const config = join(root, "cancel.json");
      await writeFile(
        config,
        JSON.stringify({
          session_name: "unused",
          workspace_builder: "extension:Custom",
          workspace_builder_paths: ["."],
        }),
      );
      const controller = new AbortController();
      let stdout = "";
      const code = await runCli(
        ["--log-level", "info", "load", config, "--append", "--json", "-S", server.socketPath!],
        {
          cwd: root,
          env: {
            ...process.env,
            TMUX_BIN: server.tmuxBin,
            TMUX_WORKSPACE_PYTHON: process.env.LIBTMUX_TEST_PYTHON!,
            TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
            TMUX_PANE: before.windows.at(0)!.panes.at(0)!.id,
          },
          stdin: Readable.from([]),
          stdout: new Writable({
            write(chunk, _encoding, done) {
              stdout += String(chunk);
              done();
            },
          }),
          stderr: new Writable({
            write(chunk, _encoding, done) {
              if (String(chunk).includes("extension-ready")) controller.abort();
              done();
            },
          }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        },
      );
      expect(controller.signal.aborted).toBe(true);
      expect(code, stdout).toBe(130);
      const summary = JSON.parse(stdout);
      expect(summary.status).toBe("partial");
      expect(summary.errors[0].code).toBe("interrupted");
      const after = (await server.snapshot()).sessions.one({ id: before.id });
      expect(summary.results[0]).toMatchObject({
        session_id: before.id,
        effects_unknown: true,
        observed_windows: [after.windows.one({ name: "survives" }).id],
      });
      const pids: number[] = JSON.parse(await readFile(join(root, "processes.json"), "utf8"));
      expect(await Promise.all(pids.map((pid) => readProcessIdentity(pid)))).toEqual(
        pids.map(() => undefined),
      );
    });
  },
);

extensionTest(
  "custom builders may omit windows and preserve borrowed effects on failure",
  async () => {
    await fixture(async (server, root, run) => {
      const before = (await server.snapshot()).sessions.one({ name: "fixture" });
      await writeFile(
        join(root, "extension.py"),
        `
from pathlib import Path
class Custom:
    def __init__(self, session_config, server, plugins):
        assert "windows" not in session_config
        assert session_config["start_directory"] == str(Path(__file__).parent)
        self.config, self.server, self.plugins = session_config, server, plugins
    def build(self, session=None, append=False):
        assert append
        self.session = session
        session.new_window(window_name="extension", attach=False)
        raise RuntimeError("failed after window")
`,
      );
      const config = join(root, "custom.json");
      await writeFile(
        config,
        JSON.stringify({
          session_name: "unused",
          start_directory: ".",
          workspace_builder: "extension:Custom",
          workspace_builder_paths: ["."],
        }),
      );
      const child = await run(["load", config, "--append", "--json"], {
        TMUX_WORKSPACE_PYTHON: process.env.LIBTMUX_TEST_PYTHON!,
        TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
        TMUX_PANE: before.windows.at(0)!.panes.at(0)!.id,
      });
      expect(child.code, child.stdout + child.stderr).toBe(1);
      const summary = JSON.parse(child.stdout);
      expect(summary.status).toBe("partial");
      expect(summary.errors[0].code).toBe("script_failed");
      const after = (await server.snapshot()).sessions.one({ id: before.id });
      expect(summary.results[0]).toMatchObject({
        session_id: before.id,
        effects_scope: "observed",
        effects_unknown: true,
        observed_windows: [after.windows.one({ name: "extension" }).id],
        created_windows: [],
        created_panes: [],
      });
      expect(after.windows.length).toBe(before.windows.length + 1);
    });
  },
);

test.each(["off", "on"])(
  "load reserves explicit window indexes before implicit allocation with renumbering %s",
  async (renumber) => {
    await fixture(async (server, root, run) => {
      const config = join(root, "indexes.json");
      await server.setGlobalOption("session", "base-index", "3");
      await server.setGlobalOption("session", "renumber-windows", renumber);
      await writeFile(
        config,
        JSON.stringify({
          session_name: "indexes",
          windows: [
            { window_name: "implicit" },
            { window_name: "reserved", window_index: 3 },
            { window_name: "maximum", window_index: 2147483647 },
          ],
        }),
      );
      const result = await run(["load", config, "-d", "--json"]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const session = (await server.snapshot()).sessions.one({ name: "indexes" });
      expect(
        Object.fromEntries(
          session.windows.toArray().map((window) => [window.name, Number(window.index)]),
        ),
      ).toEqual({ implicit: 4, reserved: 3, maximum: 2147483647 });
      expect((await session.showOptions()).has("renumber-windows")).toBe(false);
      expect((await session.showResolvedOptions()).get("renumber-windows")).toBe(renumber);
    });
  },
);

test("ndjson events use the shared field vocabulary (inputs, session_id, *_index)", async () => {
  await fixture(async (server, root, run) => {
    const config = join(root, "ndjson-shape.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "ndjson-shape",
        windows: [
          { window_name: "one", panes: [null, null] },
          { window_name: "two", panes: [null] },
        ],
      }),
    );
    const result = await run(["load", config, "-d", "--ndjson"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Record<string, unknown>[];
    const session = (await server.snapshot()).sessions.one({ name: "ndjson-shape" });

    const workspaceStarted = events.find((event) => event.event === "workspace-started")!;
    expect(workspaceStarted).toMatchObject({ input: "~/ndjson-shape.json", input_index: 0 });
    expect(workspaceStarted.workspace).toBeUndefined();

    const started = events.find((event) => event.event === "started")!;
    expect(started.inputs).toBe(1);
    expect(started.input_count).toBeUndefined();

    const windowCreated = events.filter((event) => event.event === "window-created");
    expect(windowCreated.map((event) => event.window_index)).toEqual([1, 2]);
    expect(windowCreated.every((event) => event.session_id === session.id)).toBe(true);
    expect(windowCreated.every((event) => event.window_ordinal === undefined)).toBe(true);

    const windowCompleted = events.filter((event) => event.event === "window-completed");
    expect(windowCompleted.map((event) => event.window_index)).toEqual([1, 2]);
    expect(windowCompleted.every((event) => event.session_id === session.id)).toBe(true);

    const paneCreated = events.filter((event) => event.event === "pane-created");
    expect(paneCreated.map((event) => event.pane_index)).toEqual([1, 2, 1]);
    expect(paneCreated.every((event) => event.session_id === session.id)).toBe(true);
    expect(paneCreated.every((event) => event.pane_ordinal === undefined)).toBe(true);

    const paneCompleted = events.filter((event) => event.event === "pane-completed");
    expect(paneCompleted.map((event) => event.pane_index)).toEqual([1, 2, 1]);
    expect(paneCompleted.every((event) => event.session_id === session.id)).toBe(true);
  });
});

test("load result records name the input path `input`, not `workspace`", async () => {
  await fixture(async (_server, root, run) => {
    const config = join(root, "input-field.json");
    await writeFile(config, JSON.stringify({ session_name: "input-field", windows: [{}] }));
    // The fixture's HOME is `root`, so the reported path is privatized.
    const expected = "~/input-field.json";

    const jsonResult = await run(["load", config, "-d", "--json"]);
    expect(jsonResult.code, jsonResult.stderr).toBe(0);
    const [record] = JSON.parse(jsonResult.stdout).results as Record<string, unknown>[];
    expect(record).toMatchObject({ input: expected, input_index: 0 });
    expect(record!.workspace).toBeUndefined();

    const ndjsonResult = await run(["load", config, "-d", "--ndjson"]);
    expect(ndjsonResult.code, ndjsonResult.stderr).toBe(0);
    const events = ndjsonResult.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Record<string, unknown>[];
    const workspaceCompleted = events.find((event) => event.event === "workspace-completed")!;
    expect(workspaceCompleted).toMatchObject({ input: expected });
    expect(workspaceCompleted.workspace).toBeUndefined();
    const [completedRecord] = events.find((event) => event.event === "completed")!
      .results as Record<string, unknown>[];
    expect(completedRecord).toMatchObject({ input: expected });
    expect(completedRecord!.workspace).toBeUndefined();
  });
});

test("a window with five or more panes reclaims space between splits", async () => {
  await fixture(async (server, root, run) => {
    const config = join(root, "many-panes.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "many-panes",
        windows: [{ window_name: "many", panes: Array.from({ length: 5 }, () => "echo x") }],
      }),
    );
    const result = await run(["load", config, "-d", "--json"], { COLUMNS: "80", LINES: "24" });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const created = JSON.parse(result.stdout).results[0] as {
      created_windows: string[];
      created_panes: string[];
    };
    expect(created.created_panes.length).toBe(5);
    const window = (await server.snapshot()).windows.one({ id: created.created_windows[0]! });
    expect(window.panes.length).toBe(5);
  });
});

test("layout corpus preserves an independent keeper", async () => {
  const corpus = (await Bun.file(
    new URL("../../libtmux/tests/fixtures/layout-preflight.json", import.meta.url),
  ).json()) as {
    id: string;
    layout: string;
    pane_count: number;
    expected_valid: Record<string, boolean>;
  }[];
  await fixture(async (server, root, run) => {
    const before = await server.snapshot();
    const keeper = before.sessions.one({ name: "fixture" });
    const version = (await server.versionAtLeast("3.5"))
      ? "3.7c"
      : (await server.versionAtLeast("3.3"))
        ? "3.3a"
        : "3.2a";
    const config = join(root, "layouts.json");
    for (const item of corpus) {
      // eslint-disable-next-line no-await-in-loop -- Each case reuses the same owned endpoint and file.
      await writeFile(
        config,
        JSON.stringify({
          session_name: "layout-case",
          windows: [
            { layout: item.layout, panes: Array.from({ length: item.pane_count }, () => null) },
          ],
        }),
      );
      // eslint-disable-next-line no-await-in-loop -- Capture the result before replacing its input.
      const result = await run(["load", config, "-d", "--json"]);
      expect(result.code === 0, item.id + ": " + result.stdout + result.stderr).toBe(
        item.expected_valid[version]!,
      );
      // eslint-disable-next-line no-await-in-loop -- Authenticate the keeper after each layout.
      const after = await server.snapshot();
      expect(after.daemonIdentity, item.id).toEqual(before.daemonIdentity);
      const retained = after.sessions.one({ id: keeper.id });
      expect(
        retained.windows.toArray().map((window) => window.id),
        item.id,
      ).toEqual(keeper.windows.toArray().map((window) => window.id));
      expect(
        retained.panes.toArray().map((pane) => pane.id),
        item.id,
      ).toEqual(keeper.panes.toArray().map((pane) => pane.id));
      for (const session of after.sessions.toArray()) {
        // eslint-disable-next-line no-await-in-loop -- Only this case's owned session is removed.
        if (session.id !== keeper.id) await session.kill();
      }
    }
  });
}, 40_000);

test.each([false, true])(
  "all layouts precede scripts and borrowed mutations (append=%s)",
  async (append) => {
    await fixture(async (server, root, run) => {
      const before = await server.snapshot();
      const keeper = before.sessions.one({ name: "fixture" });
      const marker = join(root, "layout-script");
      const first = join(root, "layout-first.json");
      const second = join(root, "layout-second.json");
      await writeFile(
        first,
        JSON.stringify({
          session_name: "first",
          before_script: `/usr/bin/touch '${marker}'`,
          options: { "@changed": "yes" },
          windows: [{ window_name: "first" }],
        }),
      );
      await writeFile(
        second,
        JSON.stringify({
          session_name: "second",
          windows: [{ layout: "b25d,80x24,0,0,0", panes: [null, null] }],
        }),
      );
      const result = await run(
        ["load", first, second, append ? "--append" : "-d", "--json"],
        append
          ? {
              TMUX: `${server.socketPath},${before.daemonIdentity.pid},0`,
              TMUX_PANE: keeper.panes.at(0)!.id,
            }
          : {},
      );
      expect(result.code, result.stdout + result.stderr).not.toBe(0);
      expect(await Bun.file(marker).exists(), "no earlier input may run a script").toBe(false);
      const after = await server.snapshot();
      expect(after.daemonIdentity).toEqual(before.daemonIdentity);
      expect(after.sessions.toArray().map((session) => session.id)).toEqual(
        before.sessions.toArray().map((session) => session.id),
      );
      expect(after.windows.toArray().map((window) => window.id)).toEqual(
        before.windows.toArray().map((window) => window.id),
      );
      expect(after.panes.toArray().map((pane) => pane.id)).toEqual(
        before.panes.toArray().map((pane) => pane.id),
      );
      expect((await keeper.showOptions()).has("@changed")).toBe(false);
    });
  },
);

test("append reserves indexes requested by later workspace files", async () => {
  await fixture(async (server, root, run) => {
    const before = (await server.snapshot()).sessions.one({ name: "fixture" });
    const original = before.windows.at(0)!;
    const implicit = join(root, "implicit.json");
    const explicit = join(root, "explicit.json");
    await writeFile(
      implicit,
      JSON.stringify({ session_name: "ignored-one", windows: [{ window_name: "implicit" }] }),
    );
    await writeFile(
      explicit,
      JSON.stringify({
        session_name: "ignored-two",
        windows: [{ window_name: "reserved", window_index: 1 }],
      }),
    );
    const result = await run(["load", implicit, explicit, "--append", "--json"], {
      TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
      TMUX_PANE: original.panes.at(0)!.id,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const after = (await server.snapshot()).sessions.one({ id: before.id });
    expect(Number(after.windows.one({ name: "implicit" }).index)).toBe(2);
    expect(Number(after.windows.one({ name: "reserved" }).index)).toBe(1);
    expect(after.windows.one({ id: original.id }).panes.length).toBe(1);
  });
});

test.each(["remove", "restore", "both", "disable"])(
  "bootstrap %s failure preserves its cause and reports renumbering state",
  async (failure) => {
    await fixture(async (server, root, run) => {
      await server.setGlobalOption("session", "renumber-windows", "on");
      const wrapper = join(root, "tmux-failure");
      const remove = failure === "remove" || failure === "both";
      const restore = failure === "restore" || failure === "both";
      const actual = `'${server.tmuxBin.replaceAll("'", "'\\''")}'`;
      const rules = [
        remove ? "*kill-window*) echo removal-failed >&2; exit 1;;" : "",
        restore ? "*set-option*-u*renumber-windows*) echo restore-failed >&2; exit 1;;" : "",
        failure === "disable"
          ? `*set-option*renumber-windows*off*) ${actual} "$@"; echo disable-failed >&2; exit 1;;`
          : "",
      ].join("\n");
      await writeFile(wrapper, `#!/bin/sh\ncase "$*" in\n${rules}\nesac\nexec ${actual} "$@"\n`, {
        mode: 0o700,
      });
      const config = join(root, "cleanup.json");
      await writeFile(
        config,
        JSON.stringify({ session_name: "cleanup", windows: [{ window_index: 4 }] }),
      );
      const response = await run(["load", config, "-d", "--json"], { TMUX_BIN: wrapper });
      expect(response.code, response.stdout + response.stderr).toBe(1);
      const summary = JSON.parse(response.stdout);
      expect(summary.errors[0].message).toContain(
        failure === "disable" ? "disable-failed" : remove ? "removal-failed" : "restore-failed",
      );
      expect(summary.results[0].stage).toBe("bootstrap-removal");
      expect(summary.status).toBe("error");
      expect(summary.results[0]).toMatchObject({
        session_removed: true,
        created_windows: [],
        created_panes: [],
      });
      expect(await server.hasSession("cleanup")).toBe(false);
      if (restore) expect(summary.results[0].renumber_restore_error).toContain("restore-failed");
    });
  },
);

test("native load falls back to 80x24 when a size override is empty", async () => {
  await fixture(async (server, root, run) => {
    const config = join(root, "sized.json");
    await writeFile(
      config,
      JSON.stringify({ session_name: "sized", windows: [{ panes: ["blank"] }] }),
    );
    const result = await run(["load", config, "-d", "--json"], { COLUMNS: "", LINES: "" });
    expect(result.code, result.stderr).toBe(0);
    const window = (await server.snapshot()).sessions.one({ name: "sized" }).windows.one();
    expect([Number(window.width), Number(window.height)]).toEqual([80, 24]);
  });
});

test("an unusable terminal size is a usage error before anything is created", async () => {
  await fixture(async (server, root, run) => {
    const config = join(root, "sized.json");
    await writeFile(
      config,
      JSON.stringify({ session_name: "sized", windows: [{ panes: ["blank"] }] }),
    );
    const result = await run(["load", config, "-d", "--json"], { COLUMNS: "80", LINES: "wide" });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("usage");
    expect(await server.hasSession("sized")).toBe(false);
  });
});

test("native load sets environment before commands and preserves existing sessions", async () => {
  await fixture(async (server, root, run) => {
    const marker = join(root, "marker");
    const config = join(root, "workspace.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "local-cli",
        start_directory: root,
        environment: { WORKSPACE_TEST_VALUE: "ready" },
        windows: [
          {
            window_name: "editor",
            window_index: 4,
            panes: [{ shell_command: `printf '%s' "$WORKSPACE_TEST_VALUE" > '${marker}'` }, null],
          },
          { window_name: "logs", panes: ["blank"] },
        ],
      }),
    );
    const first = await run(["load", config, "-d", "--json"]);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toMatchObject({
      schema_version: 1,
      command: "load",
      status: "ok",
    });
    const created = (await server.snapshot()).sessions.one({ name: "local-cli" });
    expect(created.windows.length).toBe(2);
    expect(created.windows.one({ name: "editor" }).panes.length).toBe(2);
    expect(Number(created.windows.one({ name: "editor" }).index)).toBe(4);
    const deadline = Date.now() + 10_000;
    // eslint-disable-next-line no-await-in-loop -- Poll the command side effect until its deadline.
    while (Date.now() < deadline && !(await Bun.file(marker).exists())) await Bun.sleep(20);
    if (!(await Bun.file(marker).exists()))
      throw new Error(
        `Command did not run: ${JSON.stringify(await created.windows.one({ name: "editor" }).panes.at(0)!.capture())}`,
      );
    expect(await readFile(marker, "utf8")).toBe("ready");
    await created.newWindow({ name: "extra" });
    expect((await run(["load", config, "-d", "--json"])).code).toBe(0);
    expect((await server.snapshot()).sessions.one({ name: "local-cli" }).windows.length).toBe(3);
  });
});

test.each(["snapshot", "options"])(
  "freeze cancellation during %s preserves the destination",
  async (stage) => {
    await fixture(async (server, root) => {
      const destination = join(root, "capture.json");
      const marker = join(root, "reading");
      const wrapper = join(root, "tmux-wrapper");
      await writeFile(destination, "original");
      await writeFile(
        wrapper,
        `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (!existsSync(process.env.WORKSPACE_TEST_MARKER) &&
    (process.env.WORKSPACE_TEST_STAGE === "snapshot" || args.some(arg => arg.includes("show-options")))) {
  writeFileSync(process.env.WORKSPACE_TEST_MARKER, String(process.pid));
  await new Promise(resolve => setTimeout(resolve, 150));
  writeFileSync(process.env.WORKSPACE_TEST_MARKER + "-continued", "yes");
}
const result = spawnSync(process.env.WORKSPACE_TEST_TMUX, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
      );
      const controller = new AbortController();
      const discard = () =>
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        });
      const pending = runCli(
        [
          "freeze",
          "fixture",
          "--json",
          "--save-to",
          destination,
          "--force",
          "-S",
          server.socketPath!,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            TMUX: "",
            TMUX_PANE: "",
            TMUX_BIN: wrapper,
            WORKSPACE_TEST_MARKER: marker,
            WORKSPACE_TEST_STAGE: stage,
            WORKSPACE_TEST_TMUX: server.tmuxBin,
          },
          stdin: Readable.from([]),
          stdout: discard(),
          stderr: discard(),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        },
      );
      try {
        /* eslint-disable no-await-in-loop -- Observe the owned client's read before interrupting it. */
        for (
          let attempt = 0;
          !/^[1-9][0-9]*$/.test(
            await Bun.file(marker)
              .text()
              .catch(() => ""),
          );
          attempt++
        ) {
          if (attempt >= 400) throw new Error("freeze did not reach its backend read");
          await Bun.sleep(5);
        }
        /* eslint-enable no-await-in-loop */
        const clientPid = Number(await readFile(marker, "utf8"));
        controller.abort();
        expect(await pending).toBe(130);
        expect(await readProcessIdentity(clientPid)).toBeUndefined();
        expect(await readFile(destination, "utf8")).toBe("original");
        expect(await Bun.file(marker + "-continued").exists()).toBe(false);
        expect(await server.hasSession("fixture")).toBe(true);
      } finally {
        controller.abort();
        await pending;
      }
    });
  },
);

test.each([0, 1])("load cancellation interrupts acquisition %i", async (skip) => {
  await fixture(async (server, root) => {
    const config = join(root, "cancelled.json");
    const marker = join(root, "reading");
    const wrapper = join(root, "tmux-wrapper");
    await writeFile(
      config,
      JSON.stringify({ session_name: "cancelled", windows: [{ panes: ["blank"] }] }),
    );
    await writeFile(
      wrapper,
      `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const counter = process.env.WORKSPACE_TEST_MARKER + "-seen";
if (args.includes("list-sessions")) {
  const seen = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(seen + 1));
  if (seen === Number(process.env.WORKSPACE_TEST_SKIP)) {
    writeFileSync(process.env.WORKSPACE_TEST_MARKER, String(process.pid));
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(process.env.WORKSPACE_TEST_MARKER + "-continued", "yes");
  }
}
const result = spawnSync(process.env.WORKSPACE_TEST_TMUX, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const discard = () =>
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
    const pending = runCli(["load", config, "-d", "--json", "-S", server.socketPath!], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        TMUX: "",
        TMUX_PANE: "",
        TMUX_BIN: wrapper,
        WORKSPACE_TEST_MARKER: marker,
        WORKSPACE_TEST_SKIP: String(skip),
        WORKSPACE_TEST_TMUX: server.tmuxBin,
      },
      stdin: Readable.from([]),
      stdout: discard(),
      stderr: discard(),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
    });
    try {
      /* eslint-disable no-await-in-loop -- Observe the owned client's read before interrupting it. */
      for (
        let attempt = 0;
        !/^[1-9][0-9]*$/.test(
          await Bun.file(marker)
            .text()
            .catch(() => ""),
        );
        attempt++
      ) {
        if (attempt >= 400) throw new Error(`load did not reach acquisition ${String(skip)}`);
        await Bun.sleep(5);
      }
      /* eslint-enable no-await-in-loop */
      const clientPid = Number(await readFile(marker, "utf8"));
      controller.abort();
      expect(await pending).toBe(130);
      expect(await readProcessIdentity(clientPid)).toBeUndefined();
      expect(await Bun.file(marker + "-continued").exists()).toBe(false);
    } finally {
      controller.abort();
      await pending;
    }
  });
});

test("freeze selects the sole session or an explicit session ID", async () => {
  await fixture(async (server, _root, run) => {
    const session = (await server.snapshot()).sessions.one({ name: "fixture" });
    const captures = await Promise.all(
      [[], [session.id]].map((target) => run(["freeze", ...target, "--json"])),
    );
    for (const result of captures) {
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).session_name).toBe("fixture");
    }
    await server.newSession({ name: "second" });
    const ambiguous = await run(["freeze", "--json"]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stdout).toBe("");
    expect(JSON.parse(ambiguous.stderr).code).toBe("usage");
  });
});

test("freeze authenticates its current pane context and permits an explicit target", async () => {
  await fixture(async (server, _root, run) => {
    const second = await server.newSession({ name: "second" });
    const pane = (await server.snapshot()).sessions
      .one({ id: second.id })
      .windows.at(0)!
      .panes.at(0)!;
    const env = {
      TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
      TMUX_PANE: pane.id,
    };
    const current = await run(["freeze", "--json"], env);
    expect(current.code, current.stderr).toBe(0);
    expect(JSON.parse(current.stdout).session_name).toBe("second");
    const stale = { ...env, TMUX: `${server.socketPath},1,0` };
    const rejected = await run(["freeze", "--json"], stale);
    expect(rejected.code).toBe(2);
    expect(rejected.stdout).toBe("");
    expect(JSON.parse(rejected.stderr).code).toBe("usage");
    const explicit = await run(["freeze", "fixture", "--json"], stale);
    expect(explicit.code, explicit.stderr).toBe(0);
    expect(JSON.parse(explicit.stdout).session_name).toBe("fixture");
  });
});

test.each([
  ["captured.json", [], true],
  ["captured.JSON", [], true],
  ["captured.yml", [], false],
  ["captured.json", ["-f", "yaml"], false],
  ["~/captured.json", [], true],
] as const)("quiet freeze saves %s with format options %j", async (target, format, json) => {
  await fixture(async (_server, root, run) => {
    const name = target.replace("~/", "");
    const destination = target === name ? join(root, target) : target;
    const result = await run(["freeze", "fixture", "--quiet", "--save-to", destination, ...format]);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const saved = await readFile(join(root, name), "utf8");
    if (json) expect(JSON.parse(saved).session_name).toBe("fixture");
    else expect(saved).toStartWith("session_name: fixture\n");
  });
});

test("freeze --save-to an existing file without --force reports destination_exists", async () => {
  await fixture(async (_server, root, run) => {
    const destination = join(root, "captured.yaml");
    await writeFile(destination, "already here\n");
    const result = await run(["freeze", "fixture", "--json", "--save-to", destination]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe("destination_exists");
    expect(await readFile(destination, "utf8")).toBe("already here\n");
  });
});

test("freeze names the missing session when the socket has no server", async () => {
  await fixture(async (_server, root, run) => {
    const result = await run([
      "freeze",
      "cold",
      "--json",
      "--save-to",
      join(root, "cold.yaml"),
      "-S",
      join(root, "cold.sock"),
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe("session_not_found");
    expect(result.stderr).not.toContain("error connecting to");
  });
});

test("freeze with no --save-to and no machine flag is a usage error, not a stdout dump", async () => {
  await fixture(async (_server, _root, run) => {
    const result = await run(["freeze", "fixture"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--save-to");
  });
});

test.each(["json", "ndjson"])("quiet freeze retains its %s result", async (mode) => {
  await fixture(async (_server, root, run) => {
    const destination = join(root, "captured.json");
    const result = await run([
      "freeze",
      "fixture",
      "--quiet",
      "--save-to",
      destination,
      `--${mode}`,
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      command: "freeze",
      format: "json",
    });
    expect(JSON.parse(await readFile(destination, "utf8")).session_name).toBe("fixture");
  });
});

test("freeze machine output reloads window and pane topology", async () => {
  await fixture(async (server, root, run) => {
    const source = join(root, "input.json");
    await writeFile(
      source,
      JSON.stringify({
        session_name: "capture-cli",
        windows: [
          { window_name: "edit", panes: [null, null] },
          { window_name: "logs", panes: [null] },
        ],
      }),
    );
    expect((await run(["load", source, "-d", "--json"])).code).toBe(0);
    const frozen = await run(["freeze", "capture-cli", "--json"]);
    expect(frozen.code).toBe(0);
    const document = JSON.parse(frozen.stdout);
    document.session_name = "replayed-cli";
    const replay = join(root, "replay.json");
    await writeFile(replay, JSON.stringify(document));
    expect((await run(["load", replay, "-d", "--json"])).code).toBe(0);
    expect(
      (await server.snapshot()).sessions
        .one({ name: "replayed-cli" })
        .windows.toArray()
        .map((window) => window.panes.length),
    ).toEqual([2, 1]);
  });
});

test("freeze puts window options under options_after and omits the default pane shell", async () => {
  await fixture(async (server, root, run) => {
    const source = join(root, "input.json");
    await writeFile(
      source,
      JSON.stringify({
        session_name: "freeze-shape",
        windows: [
          {
            window_name: "main",
            options: { "automatic-rename": false },
            panes: [null, "sleep 60"],
          },
        ],
      }),
    );
    expect((await run(["load", source, "-d", "--json"])).code).toBe(0);
    const session = (await server.snapshot()).sessions.one({ name: "freeze-shape" });
    const busyPaneId = session.windows.at(0)!.panes.at(1)!.id;
    const deadline = performance.now() + 2000;
    let command: string | null = null;
    /* eslint-disable no-await-in-loop -- Watch the pane until it reports the command, within the deadline. */
    while (performance.now() < deadline) {
      command = (await server.snapshot()).panes.one({ id: busyPaneId }).currentCommand;
      if (command === "sleep") break;
      await sleep(25);
    }
    /* eslint-enable no-await-in-loop */
    expect(command).toBe("sleep");
    const frozen = await run(["freeze", "freeze-shape", "--json"]);
    expect(frozen.code, frozen.stdout + frozen.stderr).toBe(0);
    const window = JSON.parse(frozen.stdout).windows[0];
    expect(window.options).toBeUndefined();
    expect(window.options_after).toMatchObject({ "automatic-rename": "off" });
    expect(window.panes[0].shell_command).toBeUndefined();
    expect(window.panes[1].shell_command).toEqual(["sleep"]);
  });
});

test("freeze does not name an ordinary shell that is not the literal default-shell", async () => {
  // Reproduces macOS on Linux, where /bin/sh is bash: default-shell reads
  // "sh" and the pane reports "bash".
  await fixture(async (server, root, run) => {
    await server.setGlobalOption("session", "default-shell", "/bin/sh");
    await server.setGlobalOption("session", "default-command", "/bin/bash -i");
    const source = join(root, "input.json");
    await writeFile(source, JSON.stringify({ session_name: "freeze-shell-alias", windows: [{}] }));
    expect((await run(["load", source, "-d", "--json"])).code).toBe(0);
    const session = (await server.snapshot()).sessions.one({ name: "freeze-shell-alias" });
    const paneId = session.windows.at(0)!.panes.at(0)!.id;
    const deadline = performance.now() + 2000;
    let command: string | null = null;
    /* eslint-disable no-await-in-loop -- Watch the pane until it reports the command, within the deadline. */
    while (performance.now() < deadline) {
      command = (await server.snapshot()).panes.one({ id: paneId }).currentCommand;
      if (command === "bash") break;
      await sleep(25);
    }
    /* eslint-enable no-await-in-loop */
    expect(command).toBe("bash");
    const frozen = await run(["freeze", "freeze-shell-alias", "--json"]);
    expect(frozen.code, frozen.stdout + frozen.stderr).toBe(0);
    const pane = JSON.parse(frozen.stdout).windows[0].panes[0];
    expect(pane.shell_command).toBeUndefined();
  });
});

test("freeze omits default-size so a reload is not pinned to the capturing terminal", async () => {
  // default-size describes the terminal freeze happened to run in, not
  // anything the workspace declared. create() always passes an explicit
  // width/height derived from COLUMNS/LINES (falling back to 80x24, matching
  // tmuxp), so a fresh session's own size does not by itself reveal the leak
  // -- the leaked option only bites when it overrides a *different* size a
  // later reload would otherwise get, which is the scenario this reproduces.
  await fixture(async (server, root, run) => {
    const source = join(root, "input.json");
    await writeFile(source, JSON.stringify({ session_name: "freeze-size", windows: [{}] }));
    expect((await run(["load", source, "-d", "--json"], { COLUMNS: "80", LINES: "24" })).code).toBe(
      0,
    );
    const frozen = await run(["freeze", "freeze-size", "--json"]);
    expect(frozen.code, frozen.stdout + frozen.stderr).toBe(0);
    const document = JSON.parse(frozen.stdout) as {
      options?: Record<string, unknown>;
      windows: { layout?: string }[];
    };
    expect(document.options?.["default-size"]).toBeUndefined();

    const replay = join(root, "replay.json");
    // A captured layout string bakes in freeze's own dimensions and forces
    // the window back to them on reload, on tmux 3.3a-3.6 only (found while
    // writing this test, not the bug under test here). Drop it so this test
    // isolates default-size.
    const { layout: _capturedLayout, ...windowWithoutLayout } = document.windows[0]!;
    await writeFile(
      replay,
      JSON.stringify({
        ...document,
        session_name: "freeze-size-replay",
        windows: [windowWithoutLayout],
      }),
    );
    // A larger terminal at reload time. Without the fix, the 80x24 freeze
    // captured above would override this and pin the window regardless.
    const reload = await run(["load", replay, "-d", "--json"], { COLUMNS: "200", LINES: "50" });
    expect(reload.code, reload.stdout + reload.stderr).toBe(0);
    const window = (await server.snapshot()).sessions
      .one({ name: "freeze-size-replay" })
      .windows.at(0)!;
    expect(`${window.width}x${window.height}`).toBe("200x50");
  });
});

test("pane readiness reads one pane, not the whole server", async () => {
  await fixture(async (server, root, run) => {
    await server.setGlobalOption("session", "default-command", "printf ready; sleep 30");
    const wrapper = join(root, "tmux-wrapper");
    await writeFile(
      wrapper,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.some(argument => argument.includes("ltxI"))) {
  appendFileSync(process.env.WORKSPACE_TEST_LOG, "acquisition\\n");
}
const result = spawnSync(process.env.WORKSPACE_TEST_TMUX, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    const acquisitions = async (readiness: string): Promise<number> => {
      const file = join(root, `${readiness}.json`);
      const log = join(root, `${readiness}.log`);
      await writeFile(
        file,
        JSON.stringify({
          session_name: `readiness-${readiness}`,
          workspace_builder_options: { pane_readiness: readiness },
          windows: [{ panes: ["true"] }],
        }),
      );
      const result = await run(["load", file, "-d", "--json"], {
        TMUX_BIN: wrapper,
        WORKSPACE_TEST_LOG: log,
        WORKSPACE_TEST_TMUX: server.tmuxBin,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      return (await readFile(log, "utf8")).trim().split("\n").length;
    };
    const never = await acquisitions("never");
    const always = await acquisitions("always");
    expect(always).toBe(never);
  });
});

test("blank panes with empty plugins load natively without a prompt", async () => {
  await fixture(async (server, root) => {
    await server.setGlobalOption("session", "default-command", "sleep 30");
    const file = join(root, "blank.json");
    await writeFile(
      file,
      JSON.stringify({
        session_name: "blank-cli",
        plugins: [],
        workspace_builder: null,
        workspace_builder_options: { pane_readiness: "always" },
        windows: [{ panes: [null, null] }, { panes: [null] }],
      }),
    );
    const result = await processRun(
      [
        process.execPath,
        new URL("../src/main.ts", import.meta.url).pathname,
        "load",
        file,
        "-d",
        "--json",
        "-S",
        server.socketPath!,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TMUX: "",
          TMUX_PANE: "",
          TMUX_BIN: server.tmuxBin,
          TMUX_WORKSPACE_PYTHON: join(root, "missing-python"),
        },
        signal: AbortSignal.timeout(1000),
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("ok");
    expect((await server.snapshot()).sessions.one({ name: "blank-cli" }).windows.length).toBe(2);
  });
});

test("machine load requires a detached choice before creating anything", async () => {
  await fixture(async (server, root, run) => {
    const source = join(root, "input.json");
    await writeFile(source, JSON.stringify({ session_name: "refused-cli", windows: [{}] }));
    const result = await run(["load", source, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).code).toBe("usage");
    expect(
      (await server.snapshot()).sessions
        .toArray()
        .some((session) => session.name === "refused-cli"),
    ).toBe(false);
  });
});

test("an unusable log destination fails before creating a session", async () => {
  await fixture(async (server, root, run) => {
    const source = join(root, "input.json");
    await writeFile(source, JSON.stringify({ session_name: "log-refused", windows: [{}] }));
    const result = await run(["load", source, "-d", "--json", "--log-file", root]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(await server.hasSession("log-refused")).toBe(false);
  });
});

test("relative bootstrap paths preserve spaces and literal arguments", async () => {
  await fixture(async (_server, root, run) => {
    const directory = join(root, "workspace files");
    await mkdir(directory);
    await writeFile(join(directory, "before script.sh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o700,
    });
    const config = join(directory, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "relative-bootstrap",
        before_script: "'./before script.sh' 'a b' '' '$(printf literal)'",
        windows: [{}],
      }),
    );
    const result = await run(["load", config, "-d", "--json"]);
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).results[0].script_output.stdout).toBe(
      "a b\n\n$(printf literal)\n",
    );
  });
});

test("bootstrap uses argv and config cwd, with output encoded before pane creation", async () => {
  await fixture(async (_server, root, run) => {
    const script = join(root, "before script.js");
    await writeFile(
      script,
      'process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));process.stderr.write("diagnostic\\n");',
    );
    const config = join(root, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "bootstrap-cli",
        before_script: `'${process.execPath}' '${script}' 'a b' '$HOME'`,
        windows: [{}],
      }),
    );
    const result = await run(["load", config, "-d", "--ndjson"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const text = events
      .filter((event) => event.event === "script-output" && event.stream === "stdout")
      .map((event) => event.text)
      .join("");
    expect(JSON.parse(text)).toEqual({ cwd: root, args: ["a b", root] });
    expect(events.findIndex((event) => event.event === "script-output")).toBeLessThan(
      events.findIndex((event) => event.event === "pane-created"),
    );
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event.event === "completed")).toHaveLength(1);
    const json = await run(["load", config, "-s", "bootstrap-json-cli", "-d", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(JSON.parse(json.stdout).results[0].script_output.stdout)).toEqual({
      cwd: root,
      args: ["a b", root],
    });
    const log = join(root, "load.ndjson");
    const logged = await run([
      "--log-level",
      "info",
      "load",
      config,
      "-s",
      "bootstrap-log-cli",
      "-d",
      "--json",
      "--log-file",
      log,
    ]);
    expect(logged.code).toBe(0);
    expect(JSON.parse(logged.stdout).status).toBe("ok");
    const records = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      new Set(
        records.filter((record) => record.event === "script-output").map((record) => record.stream),
      ),
    ).toEqual(new Set(["stderr", "stdout"]));
    expect(records.at(-1)).toMatchObject({ event: "completed", level: "info", status: "ok" });
    expect(logged.stderr).toBe(await readFile(log, "utf8"));
  });
});

test("before_script brackets its output with script-started and script-completed", async () => {
  await fixture(async (_server, root, run) => {
    const config = join(root, "bracket.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "script-brackets",
        before_script: `'${process.execPath}' -e 'process.stdout.write("hi\\n")'`,
        windows: [{}],
      }),
    );
    const result = await run(["load", config, "-d", "--ndjson"]);
    expect(result.code, result.stderr).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Record<string, unknown>[];
    const names = events.map((event) => event.event);
    const started = names.indexOf("script-started");
    const output = names.indexOf("script-output");
    const completed = names.indexOf("script-completed");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(output);
    expect(output).toBeLessThan(completed);
    expect(events[started]).toMatchObject({ input_index: 0 });
    expect(events[completed]).toMatchObject({ input_index: 0, child_status: 0, truncated: false });
  });
});

test("a failed bootstrap removes its newly created session and reports the failed stage", async () => {
  await fixture(async (server, root, run) => {
    const config = join(root, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "failed-bootstrap-cli",
        before_script: `'${process.execPath}' -e 'process.exit(7)'`,
        windows: [{}],
      }),
    );
    const result = await run(["load", config, "-d", "--json"]);
    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.status).toBe("error");
    expect(summary.errors[0]).toMatchObject({
      code: "script_failed",
      input_index: 0,
      failed_stage: "before-script",
    });
    expect(summary.results[0]).toMatchObject({
      session_removed: true,
      completed_stages: ["session-created", "session-removed"],
    });
    expect(await server.hasSession("failed-bootstrap-cli")).toBe(false);
    if (process.platform === "linux") {
      const limited = await processRun(
        [
          "/bin/sh",
          "-c",
          'trap "" XFSZ; ulimit -f 0; exec "$@"',
          "log-limit",
          process.execPath,
          new URL("../src/main.ts", import.meta.url).pathname,
          "load",
          config,
          "-d",
          "--json",
          "-S",
          server.socketPath!,
          "--log-file",
          join(root, "full.ndjson"),
        ],
        {
          cwd: root,
          env: { ...process.env, TMUX: "", TMUX_PANE: "", TMUX_BIN: server.tmuxBin },
          signal: AbortSignal.timeout(2000),
        },
      );
      expect(limited.code).toBe(1);
      const logged = JSON.parse(limited.stdout);
      expect(logged.errors).toEqual(summary.errors);
      expect(logged.results[0].session_removed).toBe(true);
      expect(
        limited.stderr
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .some((record) => record.code === "log_error"),
      ).toBe(true);
    }
  });
});

test("a mid-load failure in human mode prints the sentence, not the machine record", async () => {
  await fixture(async (_server, root, run) => {
    const config = join(root, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "failed-bootstrap-human",
        before_script: `'${process.execPath}' -e 'process.exit(7)'`,
        windows: [{}],
      }),
    );
    const result = await run(["load", config, "-d"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain('"status"');
    expect(result.stderr).not.toContain('"completed_stages"');
    expect(result.stderr).toContain("tmux-workspace: before_script exited with status 7");
  });
});

test("a silent before_script failure drops the empty ': ' separator", async () => {
  await fixture(async (_server, root, run) => {
    const config = join(root, "silent-bootstrap.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "silent-bootstrap",
        before_script: `'${process.execPath}' -e 'process.exit(3)'`,
        windows: [{}],
      }),
    );
    const result = await run(["load", config, "-d", "--json"]);
    expect(result.code).toBe(1);
    const message = JSON.parse(result.stdout).errors[0].message as string;
    expect(message).toBe("before_script exited with status 3");
  });
});

test("a before_script that cannot start reports script_failed, not tmux_failed", async () => {
  await fixture(async (server, root, run) => {
    const missing = join(root, "missing-script");
    const config = join(root, "cannot-start.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "cannot-start-bootstrap",
        before_script: missing,
        windows: [{}],
      }),
    );
    const result = await run(["load", config, "-d", "--json"]);
    expect(result.code).toBe(1);
    const body = JSON.parse(result.stdout) as {
      results: { input?: string; session_removed?: boolean }[];
      errors: { code: string; message: string }[];
    };
    expect(body.errors[0]!.code).toBe("script_failed");
    expect(body.errors[0]!.message).not.toContain("spawn");
    expect(body.errors[0]!.message).not.toContain("ENOENT");
    expect(body.errors[0]!.message).toContain(missing);
    expect(body.results[0]!.input).toBeDefined();
    expect(body.results[0]!.session_removed).toBe(true);
    expect(await server.hasSession("cannot-start-bootstrap")).toBe(false);
    const stderrRecords = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // Exactly one record per failure, and it carries `code`.
    expect(stderrRecords.length).toBe(1);
    expect(stderrRecords[0]).toMatchObject({
      schema_version: 1,
      code: "script_failed",
    });
  });
});

test("a tmux command failure while building reports tmux_failed, with a flat stderr record", async () => {
  await fixture(async (_server, root, run) => {
    const config = join(root, "bad-option.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "bad-option",
        windows: [{ options: { "no-such-option-xyz": 1 } }],
      }),
    );
    const result = await run(["load", config, "-d", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).errors[0]).toMatchObject({ code: "tmux_failed" });
    const stderrRecords = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // Exactly one record per failure, and it carries `code`.
    expect(stderrRecords.length).toBe(1);
    expect(stderrRecords[0]).toMatchObject({
      schema_version: 1,
      code: "tmux_failed",
    });
  });
});

test("append resolves the explicit current pane and preserves existing windows", async () => {
  await fixture(async (server, root, run) => {
    const before = (await server.snapshot()).sessions.one({ name: "fixture" });
    const original = before.windows.at(0)!;
    const config = join(root, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "append-cli",
        windows: [{ window_name: "added", panes: [null, null] }],
      }),
    );
    const result = await run(["load", config, "--append", "--json"], {
      TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
      TMUX_PANE: original.panes.at(0)!.id,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({
      session_id: before.id,
      appended: true,
    });
    const after = (await server.snapshot()).sessions.one({ id: before.id });
    expect(after.windows.length).toBe(2);
    expect(after.windows.one({ id: original.id }).panes.length).toBe(1);
    expect(after.windows.one({ name: "added" }).panes.length).toBe(2);
    expect(await server.hasSession("append-cli")).toBe(false);
  });
});

test("-d beats --append inside tmux: a new detached session is built, not an append", async () => {
  await fixture(async (server, root, run) => {
    const before = (await server.snapshot()).sessions.one({ name: "fixture" });
    const original = before.windows.at(0)!;
    const config = join(root, "input.json");
    await writeFile(config, JSON.stringify({ session_name: "detached-wins", windows: [{}] }));
    const result = await run(["load", config, "-d", "--append", "--json"], {
      TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
      TMUX_PANE: original.panes.at(0)!.id,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ appended: false });
    expect((await server.snapshot()).sessions.one({ id: before.id }).windows.length).toBe(1);
    expect(await server.hasSession("detached-wins")).toBe(true);
  });
});

test("-d beats --append outside tmux: the load succeeds rather than being refused", async () => {
  await fixture(async (_server, root, run) => {
    const config = join(root, "input.json");
    await writeFile(config, JSON.stringify({ session_name: "detached-wins-out", windows: [{}] }));
    const result = await run(["load", config, "-d", "--append", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ appended: false });
  });
});

test("append leaves the session's active window alone unless a window asks for focus", async () => {
  await fixture(async (server, root, run) => {
    const before = (await server.snapshot()).sessions.one({ name: "fixture" });
    const original = before.windows.at(0)!;
    const env = {
      TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
      TMUX_PANE: original.panes.at(0)!.id,
    };
    const plain = join(root, "plain.json");
    await writeFile(
      plain,
      JSON.stringify({ session_name: "ignored-plain", windows: [{ window_name: "no-focus" }] }),
    );
    expect((await run(["load", plain, "--append", "--json"], env)).code).toBe(0);
    expect((await server.snapshot()).sessions.one({ id: before.id }).activeWindow?.id).toBe(
      original.id,
    );

    const focused = join(root, "focused.json");
    await writeFile(
      focused,
      JSON.stringify({
        session_name: "ignored-focused",
        windows: [{ window_name: "wants-focus", focus: true }],
      }),
    );
    expect((await run(["load", focused, "--append", "--json"], env)).code).toBe(0);
    expect((await server.snapshot()).sessions.one({ id: before.id }).activeWindow?.name).toBe(
      "wants-focus",
    );
  });
});

test.each(["json", "ndjson"])("bootstrap cancellation retains a final %s result", async (mode) => {
  await fixture(async (server, root) => {
    const config = join(root, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "interrupted-cli",
        before_script: `'${process.execPath}' -e 'process.stdout.write("ready");setInterval(()=>{},1000)'`,
        windows: [{}],
      }),
    );
    const controller = new AbortController();
    let text = "";
    const code = await runCli(
      ["--log-level", "info", "load", config, "-d", `--${mode}`, "-S", server.socketPath!],
      {
        cwd: root,
        env: { ...process.env, HOME: root, TMUX: "", TMUX_PANE: "", TMUX_BIN: server.tmuxBin },
        stdin: Readable.from([]),
        stdout: new Writable({
          write(chunk, _encoding, done) {
            text += String(chunk);
            done();
          },
        }),
        stderr: new Writable({
          write(chunk, _encoding, done) {
            if (JSON.parse(String(chunk)).event === "script-output") controller.abort();
            done();
          },
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
      },
    );
    expect(code).toBe(130);
    const result = JSON.parse(text.trim().split("\n").at(-1)!);
    expect(result.errors[0]).toMatchObject({ code: "interrupted", failed_stage: "before-script" });
    expect(result.results[0].session_removed).toBe(true);
    expect(await server.hasSession("interrupted-cli")).toBe(false);
  });
});

test("append rejects another server even when its pane ID matches", async () => {
  await fixture(async (selected, root, run) => {
    await fixture(async (current) => {
      const selectedPane = (await selected.snapshot()).panes.at(0)!;
      const currentPane = (await current.snapshot()).panes.at(0)!;
      expect(selectedPane.id).toBe(currentPane.id);
      const config = join(root, "input.json");
      await writeFile(config, JSON.stringify({ session_name: "append-cli", windows: [{}] }));
      const result = await run(["load", config, "--append", "--json"], {
        TMUX: `${current.socketPath},${(await current.daemonIdentity()).pid},0`,
        TMUX_PANE: currentPane.id,
      });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr).code).toBe("usage");
      expect((await selected.snapshot()).windows.length).toBe(1);
      expect((await current.snapshot()).windows.length).toBe(1);
    });
  });
});

test("append does not adopt a replacement daemon after authenticating the current pane", async () => {
  await fixture(async (current, root, run) => {
    await fixture(async (replacement) => {
      const before = await current.snapshot();
      expect(before.panes.one().id).toBe((await replacement.snapshot()).panes.one().id);
      const config = join(root, "input.json");
      const marker = join(root, "endpoint-switched");
      const wrapper = join(root, "tmux-switch-endpoint");
      await writeFile(config, JSON.stringify({ session_name: "append-cli", windows: [{}] }));
      // Switch between real servers after both identity reads, preserving their output.
      await writeFile(
        wrapper,
        `#!${process.execPath}
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const marker = process.env.WORKSPACE_TEST_MARKER;
const switched = existsSync(marker);
let lastAuthentication = false;
if (!switched && args.includes("list-sessions") && args.includes("list-panes")) {
  try { mkdirSync(marker + "-first"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    lastAuthentication = true;
  }
}
if (switched) {
  const socket = args.findIndex(arg => arg.startsWith("-S"));
  if (socket < 0) throw new Error("missing test socket");
  if (args[socket] === "-S") args[socket + 1] = process.env.WORKSPACE_TEST_NEXT_SOCKET;
  else args[socket] = "-S" + process.env.WORKSPACE_TEST_NEXT_SOCKET;
}
const result = spawnSync(process.env.WORKSPACE_TEST_TMUX, args, { stdio: "inherit" });
if (lastAuthentication && result.status === 0) writeFileSync(marker, "switched");
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
      );
      const result = await run(["load", config, "--append", "--json"], {
        TMUX: `${current.socketPath},${before.daemonIdentity.pid},0`,
        TMUX_PANE: before.panes.one().id,
        TMUX_BIN: wrapper,
        WORKSPACE_TEST_MARKER: marker,
        WORKSPACE_TEST_NEXT_SOCKET: replacement.socketPath!,
        WORKSPACE_TEST_TMUX: current.tmuxBin,
      });
      expect(await readFile(marker, "utf8")).toBe("switched");
      expect(result.code, result.stdout + result.stderr).not.toBe(0);
      expect((await current.snapshot()).windows.length).toBe(1);
      expect((await replacement.snapshot()).windows.length).toBe(1);
    });
  });
});

test("append rejects a different tmux server that has not started yet, with the same message", async () => {
  await fixture(async (current, root) => {
    const currentPane = (await current.snapshot()).panes.at(0)!;
    const config = join(root, "input.json");
    await writeFile(config, JSON.stringify({ session_name: "append-cli", windows: [{}] }));
    const cold = join(root, "cold-socket");
    assertOwnedSocketPath(cold);
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/main.ts", import.meta.url).pathname,
        "load",
        config,
        "--append",
        "--json",
        "-S",
        cold,
      ],
      {
        cwd: root,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          TMUX_BIN: current.tmuxBin,
          HOME: root,
          TMUX: `${current.socketPath},${(await current.daemonIdentity()).pid},0`,
          TMUX_PANE: currentPane.id,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(2);
    const message = JSON.parse(stderr) as { code: string; message: string };
    expect(message.code).toBe("usage");
    expect(message.message).toBe("This operation must target the current pane's tmux server");
    expect((await current.snapshot()).windows.length).toBe(1);
  });
});

test("a failed append bootstrap preserves the borrowed session", async () => {
  await fixture(async (server, root, run) => {
    const original = (await server.snapshot()).sessions.one({ name: "fixture" });
    const config = join(root, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "ignored-append-name",
        before_script: `'${process.execPath}' -e 'process.exit(7)'`,
        windows: [{}],
      }),
    );
    const result = await run(["load", config, "--append", "--json"], {
      TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
      TMUX_PANE: original.windows.at(0)!.panes.at(0)!.id,
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).errors[0].failed_stage).toBe("before-script");
    expect((await server.snapshot()).sessions.one({ id: original.id }).windows.length).toBe(1);
  });
});

test("a tmux failure names its unfinished stage and leaves no session behind", async () => {
  await fixture(async (server, root, run) => {
    const config = join(root, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "partial-cli",
        windows: [{ options: { "workspace-cli-invalid-option": true } }],
      }),
    );
    // Re-running a document that failed is the natural response to a failure,
    // so the second answer has to be the first.
    for (const attempt of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- The second run answers about the first.
      const result = await run(["load", config, "-d", "--json"]);
      expect(result.code, `attempt ${String(attempt)}: ${result.stdout}`).toBe(1);
      const summary = JSON.parse(result.stdout);
      expect(summary.status).toBe("error");
      expect(summary.errors[0].failed_stage).toBe("window-options");
      expect(summary.results[0]).toMatchObject({
        session_removed: true,
        created_windows: [],
        created_panes: [],
      });
      // eslint-disable-next-line no-await-in-loop -- Read the server between attempts.
      expect(await server.hasSession("partial-cli")).toBe(false);
    }
  });
});

test("the version-checked Python shell uses the selected private session", async () => {
  await fixture(async (_server, _root, run) => {
    const python = process.env.TMUX_WORKSPACE_PYTHON || "python3";
    const base = Bun.spawnSync([python, "-c", "import site; print(site.USER_BASE)"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(base.exitCode).toBe(0);
    const result = await run(
      ["shell", "fixture", "-c", 'print("selected:" + session.name)', "--ndjson"],
      { PYTHONUSERBASE: base.stdout.toString().trim() },
    );
    if (result.code !== 0) throw new Error(JSON.stringify(result));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events
        .filter((event) => event.event === "script-output")
        .map((event) => event.text)
        .join(""),
    ).toContain("selected:fixture");
    expect(events.at(-1)).toMatchObject({ event: "completed", child_status: 0 });
  });
});

test("a reused session without the document's windows is reported, not rebuilt", async () => {
  await fixture(async (server, root, run) => {
    const one = join(root, "one.json");
    const two = join(root, "two.json");
    await writeFile(
      one,
      JSON.stringify({ session_name: "conv", windows: [{ window_name: "one", panes: [null] }] }),
    );
    await writeFile(
      two,
      JSON.stringify({
        session_name: "conv",
        windows: [
          { window_name: "one", panes: [null] },
          { window_name: "two", panes: [null] },
        ],
      }),
    );
    expect((await run(["load", one, "-d", "--json"])).code).toBe(0);
    const result = await run(["load", two, "-d", "--json"]);
    expect(result.code, result.stdout).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("error");
    expect(envelope.errors[0].code).toBe("session_mismatch");
    expect(envelope.results[0]).toMatchObject({ reused: true, missing_windows: ["two"] });
    expect(envelope.errors[0].message).toContain("two");
    const after = (await server.snapshot()).sessions.one({ name: "conv" });
    expect(after.windows.toArray().map((window) => window.name)).toEqual(["one"]);
  });
});

test("an append that fails partway names the windows it kept", async () => {
  await fixture(async (server, root, run) => {
    const before = (await server.snapshot()).sessions.one({ name: "fixture" });
    const config = join(root, "appendfail.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "appendfail",
        windows: [
          { window_name: "kept", panes: [null] },
          { window_name: "bad", options: { "not-a-real-option": 1 }, panes: [null] },
        ],
      }),
    );
    const result = await run(["load", config, "--append", "--json"], {
      TMUX: `${server.socketPath},${(await server.daemonIdentity()).pid},0`,
      TMUX_PANE: before.windows.at(0)!.panes.at(0)!.id,
    });
    expect(result.code, result.stdout).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("partial");
    expect(envelope.errors[0].message).toContain("Windows kept: kept, bad");
    const after = (await server.snapshot()).sessions.one({ id: before.id });
    expect(after.windows.toArray().map((window) => window.name)).toContain("kept");
  });
});

test("every broken current-pane context is one refusal, and builds nothing", async () => {
  await fixture(async (server, root, run) => {
    const identity = await server.daemonIdentity();
    const pane = (await server.snapshot()).sessions.one({ name: "fixture" }).panes.at(0)!.id;
    const config = join(root, "probe.json");
    await writeFile(
      config,
      JSON.stringify({ session_name: "probe", windows: [{ window_name: "w", panes: [null] }] }),
    );
    for (const [label, tmux, tmuxPane] of [
      ["stale daemon", `${server.socketPath},999999,0`, pane],
      ["dead socket", `${join(root, "gone.sock")},${identity.pid},0`, pane],
      ["pane not on this server", `${server.socketPath},${identity.pid},0`, "%9999"],
      ["pane is not an id", `${server.socketPath},${identity.pid},0`, "nonsense"],
      ["unparsable TMUX", server.socketPath!, pane],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- Each case reuses the same owned endpoint.
      const result = await run(["load", config, "--append", "--json"], {
        TMUX: tmux,
        TMUX_PANE: tmuxPane,
      });
      expect(result.code, `${label}: ${result.stderr}`).toBe(2);
      expect(JSON.parse(result.stderr).code, label).toBe("usage");
      for (const leak of ["No objects found", "Invalid selection query", "error connecting to"])
        expect(result.stderr, label).not.toContain(leak);
      // eslint-disable-next-line no-await-in-loop -- Read the server after each case.
      expect(await server.hasSession("probe"), label).toBe(false);
    }
  });
});

test("freeze refuses a name load would reject, and writes nothing", async () => {
  await fixture(async (server, root, run) => {
    // tmux itself accepts a dotted name; only addressing it by name is
    // ambiguous, so the session has to be made without the library's guard.
    const tmux = async (...args: string[]) => {
      const child = await processRun([server.tmuxBin, "-S", server.socketPath!, ...args], {
        cwd: root,
        env: process.env,
      });
      expect(child.code, child.stderr).toBe(0);
    };
    await tmux("new-session", "-d", "-s", "my.proj");
    const destination = join(root, "dotted.yaml");
    const result = await run(["freeze", "my.proj", "--save-to", destination, "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe("invalid_workspace");
    expect(result.stderr).toContain("my.proj");
    expect(await Bun.file(destination).exists()).toBe(false);

    await tmux("new-window", "-d", "-t", "fixture:", "-n", "a.b");
    const second = join(root, "dotted-window.yaml");
    const window = await run(["freeze", "fixture", "--save-to", second, "--json"]);
    expect(window.code, window.stdout + window.stderr).toBe(1);
    expect(JSON.parse(window.stderr).code).toBe("invalid_workspace");
    expect(await Bun.file(second).exists()).toBe(false);
  });
});

test("a pane's prompt is waited for under bash as under zsh", async () => {
  await fixture(async (server, root, run) => {
    await server.setGlobalOption("session", "default-shell", "/bin/bash");
    await server.setGlobalOption("session", "default-command", "sleep 30");
    const file = join(root, "bash.json");
    await writeFile(
      file,
      JSON.stringify({ session_name: "bash-wait", windows: [{ panes: ["echo A"] }] }),
    );
    const result = await run(["load", file, "-d", "--ndjson"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.filter((event) => event.event === "warning").map((event) => event.message),
    ).toContain("Pane readiness timed out; sending commands");
  });
});

test("an unknown builder option and a missing start_directory warn without refusing", async () => {
  await fixture(async (server, root, run) => {
    const file = join(root, "warn.json");
    await writeFile(
      file,
      JSON.stringify({
        session_name: "warned",
        start_directory: "/nonexistent/definitely/not/here",
        workspace_builder_options: { pane_readiness: "never", made_up_key: 1 },
        windows: [{ panes: ["true"] }],
      }),
    );
    const result = await run(["load", file, "-d", "--ndjson"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const warnings = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "warning")
      .map((event) => event.message);
    expect(warnings).toContain("Ignoring unknown workspace_builder_options key: made_up_key");
    expect(warnings).toContain(
      "start_directory is not a directory, tmux will fall back to $HOME: /nonexistent/definitely/not/here",
    );
    expect(await server.hasSession("warned")).toBe(true);
  });
});

test("a window option under the session's options is applied at window scope", async () => {
  await fixture(async (server, root, run) => {
    const file = join(root, "pbi.json");
    await writeFile(
      file,
      JSON.stringify({
        session_name: "pbi",
        options: { "pane-base-index": 1, "history-limit": 9999 },
        windows: [{ window_name: "w", panes: ["true", "true"] }],
      }),
    );
    const result = await run(["load", file, "-d", "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const session = (await server.snapshot()).sessions.one({ name: "pbi" });
    expect(Number(session.windows.one({ name: "w" }).panes.at(0)!.index)).toBe(1);
    expect((await session.showOptions()).get("history-limit")).toBe("9999");
  });
});

test("with no pane asking for focus, the last pane created is left active", async () => {
  await fixture(async (server, root, run) => {
    const file = join(root, "focus.json");
    await writeFile(
      file,
      JSON.stringify({
        session_name: "focus-default",
        windows: [{ window_name: "w", panes: [null, null, null] }],
      }),
    );
    const result = await run(["load", file, "-d", "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const window = (await server.snapshot()).sessions
      .one({ name: "focus-default" })
      .windows.one({ name: "w" });
    expect(window.activePane?.id).toBe(window.panes.at(-1)!.id);
  });
});
