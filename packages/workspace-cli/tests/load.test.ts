import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "libtmux";
import {
  assertOwnedSocketPath,
  makeTestDirectory,
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
                "-S",
                fixture.socketPath,
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
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).code).toBe("tmux_context");
      expect((await selected.snapshot()).windows.length).toBe(1);
      expect((await current.snapshot()).windows.length).toBe(1);
    });
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

test("a tmux failure reports created objects and its unfinished stage", async () => {
  await fixture(async (server, root, run) => {
    const config = join(root, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        session_name: "partial-cli",
        windows: [{ options: { "workspace-cli-invalid-option": true } }],
      }),
    );
    const result = await run(["load", config, "-d", "--json"]);
    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.status).toBe("partial");
    expect(summary.errors[0].failed_stage).toBe("window-options");
    const session = (await server.snapshot()).sessions.one({ name: "partial-cli" });
    expect(summary.results[0].session_id).toBe(session.id);
    expect(summary.results[0].created_windows).toEqual(
      session.windows.toArray().map((window) => window.id),
    );
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
