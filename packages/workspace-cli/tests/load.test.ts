import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
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
      const session = (await server.snapshot()).sessions.one({ name: "cleanup" });
      expect(new Set(summary.results[0].created_windows)).toEqual(
        new Set(session.windows.toArray().map((window) => window.id)),
      );
      expect(new Set(summary.results[0].created_panes)).toEqual(
        new Set(session.panes.toArray().map((pane) => pane.id)),
      );
      if (restore) {
        expect(summary.results[0].renumber_restore_error).toContain("restore-failed");
        expect((await session.showResolvedOptions()).get("renumber-windows")).toBe("off");
      } else expect((await session.showOptions()).has("renumber-windows")).toBe(false);
    });
  },
);

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

test("blank panes load without waiting for a prompt", async () => {
  await fixture(async (server, root) => {
    await server.setGlobalOption("session", "default-command", "sleep 30");
    const file = join(root, "blank.json");
    await writeFile(
      file,
      JSON.stringify({
        session_name: "blank-cli",
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
        env: { ...process.env, TMUX: "", TMUX_PANE: "", TMUX_BIN: server.tmuxBin },
        signal: AbortSignal.timeout(1000),
      },
    );
    expect(result.code).toBe(0);
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
