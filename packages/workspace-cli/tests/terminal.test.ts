/* eslint-disable no-await-in-loop -- Observe each owned terminal transition before continuing. */
import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "libtmux";
import {
  makeTestDirectory,
  runWithCleanup,
  TestServer,
  withOwnedRunRoot,
} from "../../libtmux/src/_internal/test/testkit.js";
import { processRun } from "../src/process.ts";

const runtime = process.env.LIBTMUX_WORKSPACE_CLI_RUNTIME ?? process.execPath;
const entry =
  process.env.LIBTMUX_WORKSPACE_CLI_ENTRY ?? new URL("../src/main.ts", import.meta.url).pathname;
const ptyDriver = `
import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    destination = os.environ.get("WORKSPACE_TEST_STDOUT")
    if destination:
        out = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(out, 1)
        os.close(out)
        null = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null, 0)
        os.close(null)
        err = os.open(destination + ".err", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(err, 2)
        os.close(err)
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def forward(sig, frame):
    try: os.kill(pid, sig)
    except ProcessLookupError: pass
signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)
deadline = time.monotonic() + 8
status = None
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.02)[0]:
            try: data = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO: raise
                data = b""
            if data: os.write(1, data)
        child, current = os.waitpid(pid, os.WNOHANG)
        if child:
            status = current
            break
finally:
    if status is None:
        try: os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        _, status = os.waitpid(pid, 0)
    os.close(fd)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

async function fixture(
  body: (server: Server, root: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
  await withOwnedRunRoot(
    "ltx-workspace-terminal-",
    async (root) => {
      await using owned = await TestServer.create({
        runRoot: root,
        sessionName: "fixture",
        ...(process.env.LIBTMUX_TEST_TMUX ? { tmuxExecutable: process.env.LIBTMUX_TEST_TMUX } : {}),
      });
      const directory = await makeTestDirectory("ltx-workspace-terminal-files-");
      const env = {
        ...owned.controllerEnvironment,
        TERM: "xterm-256color",
        TMUX_BIN: owned.tmuxExecutable,
        HOME: directory,
        TMUX: "",
        TMUX_PANE: "",
      };
      const server = new Server({
        socketPath: owned.socketPath,
        tmuxBin: owned.tmuxExecutable,
        environment: env,
      });
      await runWithCleanup(
        () => body(server, directory, env),
        () => rm(directory, { recursive: true, force: true }),
      );
    },
    process.env.LIBTMUX_TEST_TMUX ?? "tmux",
  );
}

async function terminal<T>(
  argv: string[],
  root: string,
  env: NodeJS.ProcessEnv,
  body: (result: ReturnType<typeof processRun>, interrupt: () => void) => Promise<T>,
) {
  const controller = new AbortController();
  const result = processRun(["python3", "-u", "-c", ptyDriver, ...argv], {
    cwd: root,
    env,
    signal: controller.signal,
  });
  try {
    return await body(result, () => controller.abort());
  } finally {
    controller.abort();
    await result;
  }
}

async function until(ready: () => Promise<boolean>) {
  const deadline = performance.now() + 3000;
  while (!(await ready())) {
    if (performance.now() >= deadline) throw new Error("Terminal transition timed out");
    await Bun.sleep(20);
  }
}

test("human load renders native progress in its terminal and clears before the result", async () => {
  await fixture(async (server, root, env) => {
    const file = join(root, "progress.json");
    await writeFile(
      file,
      JSON.stringify({
        session_name: "progress",
        before_script: "/usr/bin/printf 'ready\\n'",
        windows: [{ window_name: "first", panes: [{}, {}] }, { window_name: "last" }],
      }),
    );
    await terminal(
      [
        runtime,
        entry,
        "load",
        file,
        "-d",
        "-S",
        server.socketPath!,
        "--progress-format",
        "{session}:{window_index}/{window_total}:{session_pane_progress}",
        "--progress-lines",
        "2",
      ],
      root,
      env,
      async (result) => {
        const output = await result;
        expect(output.code).toBe(0);
        expect(output.stdout).toContain("progress:0/2:0/3");
        expect(output.stdout).toContain("ready");
        expect(output.stdout).toContain("\u001b[0J");
        expect(output.stdout.lastIndexOf("\u001b[0J")).toBeLessThan(
          output.stdout.lastIndexOf("Loaded"),
        );
        expect((await server.snapshot()).sessions.one({ name: "progress" }).windows.length).toBe(2);
      },
    );
  });
});

test.each(["json", "ndjson", "disabled"])(
  "terminal load keeps %s output free of progress controls",
  async (mode) => {
    await fixture(async (server, root, env) => {
      const file = join(root, "plain.json");
      await writeFile(file, JSON.stringify({ session_name: "plain", windows: [{}] }));
      await terminal(
        [
          runtime,
          entry,
          "load",
          file,
          "-d",
          "-S",
          server.socketPath!,
          mode === "disabled" ? "--no-progress" : `--${mode}`,
        ],
        root,
        { ...env, NO_COLOR: "1" },
        async (result) => {
          const output = await result;
          expect(output.code).toBe(0);
          expect(output.stdout).not.toContain("\u001b");
          if (mode === "disabled") expect(output.stdout).toContain("Loaded plain");
          else {
            const records = output.stdout
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            expect(records.at(-1).status).toBe("ok");
          }
        },
      );
    });
  },
);

test("raw script output starts subsequent terminal progress on a fresh line", async () => {
  await fixture(async (server, root, env) => {
    const file = join(root, "raw.json");
    await writeFile(
      file,
      JSON.stringify({
        session_name: "raw",
        before_script: "/usr/bin/printf 'partial'",
        windows: [{}],
      }),
    );
    await terminal(
      [
        runtime,
        entry,
        "load",
        file,
        "-d",
        "-S",
        server.socketPath!,
        "--progress-lines",
        "0",
        "--progress-format",
        "NEXT:{session}",
      ],
      root,
      { ...env, NO_COLOR: "1" },
      async (result) => {
        const output = await result;
        expect(output.code).toBe(0);
        expect(output.stdout).toContain("partial\r\nNEXT:raw");
      },
    );
  });
});

test("human load without a controlling terminal fails before creating a session", async () => {
  await fixture(async (server, root, env) => {
    const file = join(root, "input.json");
    await writeFile(file, JSON.stringify({ session_name: "unattached", windows: [{}] }));
    const result = await processRun([runtime, entry, "load", file, "-S", server.socketPath!], {
      cwd: root,
      env,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("terminal");
    expect(await server.hasSession("unattached")).toBe(false);
  });
});

test("human load attaches only the final workspace through a separate terminal", async () => {
  await fixture(async (server, root, env) => {
    const first = join(root, "first.json");
    const last = join(root, "last.json");
    const saved = join(root, "stdout.txt");
    await writeFile(first, JSON.stringify({ session_name: "first", windows: [{}] }));
    await writeFile(last, JSON.stringify({ session_name: "last", windows: [{}] }));
    await terminal(
      [runtime, entry, "load", first, last, "-S", server.socketPath!],
      root,
      { ...env, WORKSPACE_TEST_STDOUT: saved },
      async (result, interrupt) => {
        try {
          await until(async () =>
            (await server.snapshot()).clients
              .toArray()
              .some((client) => client.session?.name === "last"),
          );
        } catch (error) {
          interrupt();
          throw new Error(
            `${String(error)}: ${JSON.stringify(await result)}; ${await readFile(saved, "utf8")}; ${await readFile(saved + ".err", "utf8")}`,
          );
        }
        const snapshot = await server.snapshot();
        expect(snapshot.clients.length).toBe(1);
        expect(snapshot.sessions.one({ name: "first" }).windows.length).toBe(1);
        await snapshot.clients.at(0)!.detach();
        expect((await result).code).toBe(0);
        const text = await readFile(saved, "utf8");
        expect(text).toContain("Loaded first");
        expect(text).toContain("Loaded last");
        expect(text).not.toContain("\u001b");
        expect(await readFile(saved + ".err", "utf8")).toBe("");
      },
    );
  });
});

test("human load inside tmux switches the invoking client and returns to its shell", async () => {
  await fixture(async (server, root, env) => {
    const source = join(root, "input.json");
    const done = join(root, "done.txt");
    await writeFile(source, JSON.stringify({ session_name: "destination", windows: [{}] }));
    const shell = await (
      await server.snapshot()
    ).sessions
      .one({ name: "fixture" })
      .newWindow({ shellCommand: "/bin/sh" });
    await shell.select();
    await terminal(
      [server.tmuxBin, "-S", server.socketPath!, "attach-session", "-t", "fixture"],
      root,
      env,
      async (result) => {
        await until(async () => (await server.snapshot()).clients.length === 1);
        const pane = shell.panes.at(0)!;
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        await pane.sendKeys(
          `${[runtime, entry, "load", source, "-S", server.socketPath!].map(quote).join(" ")} >${quote(join(root, "load.txt"))} 2>&1; printf '%s' "$?" >${quote(done)}`,
          { enter: true },
        );
        try {
          await until(async () => Bun.file(done).exists());
        } catch (error) {
          throw new Error(`${String(error)}: ${(await pane.capture()).join("\n")}`);
        }
        expect(await readFile(done, "utf8")).toBe("0");
        const client = (await server.snapshot()).clients.at(0)!;
        expect(client.session?.name).toBe("destination");
        await client.detach();
        expect((await result).code).toBe(0);
      },
    );
  });
});

test("interrupting attachment detaches the owned client and preserves the workspace", async () => {
  await fixture(async (server, root, env) => {
    const source = join(root, "input.json");
    await writeFile(source, JSON.stringify({ session_name: "retained", windows: [{}] }));
    await terminal(
      [runtime, entry, "load", source, "-S", server.socketPath!],
      root,
      env,
      async (result, interrupt) => {
        try {
          await until(async () => (await server.snapshot()).clients.length === 1);
        } catch (error) {
          interrupt();
          throw new Error(`${String(error)}: ${JSON.stringify(await result)}`);
        }
        interrupt();
        expect((await result).code).toBe(130);
        const snapshot = await server.snapshot();
        expect(snapshot.clients.length).toBe(0);
        expect(snapshot.sessions.one({ name: "retained" }).windows.length).toBe(1);
      },
    );
  });
});

test("attached load rejects a different tmux server before creating a session", async () => {
  await fixture(async (selected, root, env) => {
    await fixture(async (current) => {
      const source = join(root, "input.json");
      await writeFile(source, JSON.stringify({ session_name: "refused", windows: [{}] }));
      const context = {
        ...env,
        TMUX: `${current.socketPath},${(await current.daemonIdentity()).pid},0`,
        TMUX_PANE: (await current.snapshot()).panes.at(0)!.id,
      };
      await terminal(
        [runtime, entry, "load", source, "-S", selected.socketPath!],
        root,
        context,
        async (result) => {
          const output = await result;
          expect(output.code).toBe(1);
          expect(output.stdout).toContain("current pane's tmux server");
          expect(await selected.hasSession("refused")).toBe(false);
          expect((await current.snapshot()).windows.length).toBe(1);
        },
      );
    });
  });
});
