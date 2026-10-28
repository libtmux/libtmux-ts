import { access, chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";
import { tmuxReaches } from "../support/tmux_release.js";

import { leaseTimer } from "../../src/_internal/operations/program.js";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import {
  LibTmuxError,
  ObjectNotFoundError,
  TmuxTransportError,
  VersionTooLowError,
  WaitTimeoutError,
} from "../../src/errors.js";
import { Server } from "../../src/server.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(
  body: (server: Server, directory: string, fixture: TestServer) => Promise<void>,
): Promise<void> {
  const parent = await makeTestDirectory("ltx-program-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "program" });
        await runWithCleanup(
          () => body(serverFor(fixture), parent, fixture),
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

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function panePid(server: Server, paneId: string): Promise<number> {
  return Number((await server.cmd("display-message", ["-p", "-t", paneId, "#{pane_pid}"]))[0]);
}

const SERVER_MODULE = fileURLToPath(new URL("../../src/server.ts", import.meta.url));

async function gone(path: string): Promise<boolean> {
  return access(path).then(
    () => false,
    () => true,
  );
}

/** Read again until `check` holds or `ms` pass; the last reading is returned. */
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  ms: number,
): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- each read follows the last.
    const value = await read();
    if (check(value) || performance.now() >= deadline) return value;
    // eslint-disable-next-line no-await-in-loop -- not yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function programSessions(server: Server): Promise<number> {
  return (await server.sessions())
    .toArray()
    .filter((session) => session.name?.startsWith("libtmux-program-") === true).length;
}

/** Program runs need tmux 3.8, candidates refused; below it the first test checks the refusal. */
const supported = tmuxReaches("3.8");
const testProgram = supported ? test : test.skip;
const testWithVim = supported && Bun.which("vim") !== null ? test : test.skip;

describe("program runs", () => {
  test("refuses below tmux 3.8 and creates nothing", async () => {
    await withServer(async (server) => {
      if (supported) return;
      await expect(server.run(["true"])).rejects.toBeInstanceOf(VersionTooLowError);
      await expect(server.spawn(["true"])).rejects.toBeInstanceOf(VersionTooLowError);
      expect(await programSessions(server)).toBe(0);
    });
  }, 40_000);

  testProgram(
    "returns only what the program printed, and how it exited",
    async () => {
      await withServer(async (server) => {
        const result = await server.run(["sh", "-c", "printf 'one\\ntwo\\n'; exit 3"]);
        expect(result).toEqual({
          exitCode: 3,
          output: "one\ntwo",
          signalCode: null,
          success: false,
          timedOut: false,
          truncated: false,
        });
        // argv reaches the program untouched: no shell expands it, even as one word.
        expect((await server.run(["echo", "a;b", "$HOME", "*"])).output).toBe("a;b $HOME *");
        // A one-word argv is a program name, never a command line for default-shell.
        expect((await server.run(["echo $HOME"])).exitCode).toBe(127);
        expect((await server.run(["pwd"], { startDirectory: "/" })).output).toBe("/");
        // tmux's `-c` would fall back to $HOME; this ends the run before the program.
        const missing = await server.run(["pwd"], { startDirectory: "/ltx-no-such-directory" });
        expect(missing.exitCode).toBe(126);
        expect(missing.output).toContain("/ltx-no-such-directory");
        // Without one, it starts where this process is, as a child process would.
        expect((await server.run(["pwd", "-P"])).output).toBe(await realpath(process.cwd()));
        expect(
          (await server.run(["sh", "-c", "echo $LTX"], { environment: { LTX: "x y" } })).output,
        ).toBe("x y");
        expect((await server.run(["sh", "-c", "kill -TERM $$"])).signalCode).toBe("SIGTERM");
        // A status above 128 is the signal it encodes, as a shell reports one.
        expect(await server.run(["sh", "-c", "exit 130"])).toMatchObject({
          exitCode: null,
          signalCode: "SIGINT",
        });
        expect((await server.run(["sh", "-c", "exit 200"])).exitCode).toBe(200);
        // The rendering keeps tabs and trailing spaces and drops colors.
        const rendered = await server.run(["printf", "a\tb  \n\x1b[31mred\x1b[0m\n"]);
        expect(rendered.output).toBe("a\tb  \nred");
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "renders the terminal: colors applied, wrapped lines joined",
    async () => {
      await withServer(async (server) => {
        expect((await server.run(["printf", "\\033[31mred\\033[0m aaa\\rb\\n"])).output).toBe(
          "bed aaa",
        );
        const wide = await server.run(["sh", "-c", "printf '%0300d\\n' 0"], { width: 80 });
        expect(wide.output).toBe("0".repeat(300));
      });
    },
    40_000,
  );

  testProgram(
    "says when output scrolled past the history limit",
    async () => {
      await withServer(async (server) => {
        const result = await server.run(["seq", "1", "3000"], { historyLimit: 1000 });
        expect(result.truncated).toBe(true);
        expect(result.output.endsWith("2999\n3000")).toBe(true);
      });
    },
    40_000,
  );

  testProgram(
    "ends a program at its timeout and still reports its output",
    async () => {
      await withServer(async (server) => {
        const started = Date.now();
        const result = await server.run(["sh", "-c", "echo started; sleep 30"], {
          timeoutMs: 2_000,
        });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(result).toMatchObject({ exitCode: null, output: "started", timedOut: true });
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "an abort ends the program and rejects",
    async () => {
      await withServer(async (server) => {
        const controller = new AbortController();
        const running = server.run(["sleep", "30"], { signal: controller.signal });
        setTimeout(() => controller.abort(new Error("stop")), 200);
        const error = await running.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(TmuxTransportError);
        expect((error as TmuxTransportError).kind).toBe("cancelled");
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "an instant program is never missed",
    async () => {
      await withServer(async (server) => {
        for (let run = 0; run < 25; run += 1) {
          // eslint-disable-next-line no-await-in-loop -- serial runs, each its own session.
          const result = await server.run(["true"]);
          expect(result.success).toBe(true);
        }
      });
    },
    60_000,
  );

  testWithVim(
    "a spawned program is driven by keys sent at once",
    async () => {
      await withServer(async (server, directory) => {
        const file = join(directory, "notes.txt");
        await writeFile(file, "x\n");
        await using vim = await server.spawn(["vim", "-Nu", "NONE", "-i", "NONE", "-n", file]);
        await vim.pane.sendKeys("ggOfrom keys", { enter: false });
        await vim.pane.sendKeys("Escape", { enter: false });
        await vim.pane.sendKeys(":wq");
        expect(await vim.wait({ timeoutMs: 10_000 })).toEqual({ exitCode: 0, signalCode: null });
        expect(await readFile(file, "utf8")).toBe("from keys\nx\n");
      });
    },
    40_000,
  );

  testProgram(
    "a wait that gives up leaves the program running",
    async () => {
      await withServer(async (server) => {
        const program = await server.spawn(["sleep", "30"]);
        await expect(program.wait({ timeoutMs: 200 })).rejects.toBeInstanceOf(WaitTimeoutError);
        expect((await program.pane.refreshed()).dead).toBe(false);
        await program.kill();
        await program.kill();
        expect(await server.hasSession(program.sessionName)).toBe(false);
      });
    },
    40_000,
  );

  testProgram(
    "a pane killed from outside fails the wait",
    async () => {
      await withServer(async (server) => {
        await using program = await server.spawn(["sleep", "30"]);
        await server.cmd("kill-session", ["-t", `=${program.sessionName}`]);
        await expect(program.wait({ timeoutMs: 5_000 })).rejects.toBeInstanceOf(
          ObjectNotFoundError,
        );
      });
    },
    40_000,
  );

  testProgram(
    "a stream returns every byte, including the last write",
    async () => {
      await withServer(async (server) => {
        const want = `${Array.from({ length: 2000 }, (_, index) => String(index + 1)).join("\r\n")}\r\nend\r\n`;
        for (let run = 0; run < 5; run += 1) {
          // eslint-disable-next-line no-await-in-loop -- serial runs, each its own session.
          await using program = await server.spawn(["sh", "-c", "seq 1 2000; echo end"], {
            stream: true,
          });
          let text = "";
          // eslint-disable-next-line no-await-in-loop -- one stream at a time.
          for await (const chunk of program.stream()) text += chunk;
          expect(text).toBe(want);
        }
        expect(await programSessions(server)).toBe(0);
      });
    },
    60_000,
  );

  testProgram(
    "a stream yields while the program runs",
    async () => {
      await withServer(async (server, directory) => {
        // The last line waits up to 10 s for a file the reader makes only once
        // the first line has arrived, so it comes after only if streaming works.
        const gate = join(directory, "gate");
        const script =
          'echo first; i=0; while [ ! -e "$0" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; [ -e "$0" ] && echo last';
        await using program = await server.spawn(["sh", "-c", script, gate], { stream: true });
        let text = "";
        for await (const chunk of program.stream()) {
          text += chunk;
          if (text.includes("first") && !text.includes("last")) await writeFile(gate, "");
        }
        expect(text).toBe("first\r\nlast\r\n");
      });
    },
    40_000,
  );

  testProgram(
    "rejects an empty argv and a bad variable name before tmux sees them",
    async () => {
      await withServer(async (server) => {
        await expect(server.run([""])).rejects.toBeInstanceOf(TypeError);
        await expect(server.run(["true"], { environment: { "A=B": "x" } })).rejects.toBeInstanceOf(
          TypeError,
        );
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "an argv[0] with = in it is a program name, not an assignment",
    async () => {
      await withServer(async (server) => {
        expect((await server.run(["FOO=bar"])).exitCode).toBe(127);
      });
    },
    40_000,
  );

  testProgram(
    "refuses a bad size, limit, or timeout before anything is created",
    async () => {
      await withServer(async (server) => {
        await expect(server.run(["true"], { width: 0 })).rejects.toBeInstanceOf(TypeError);
        await expect(server.run(["true"], { historyLimit: Number.NaN })).rejects.toBeInstanceOf(
          TypeError,
        );
        // tmux's own ceiling, INT_MAX, refused here rather than after the session exists.
        await expect(server.run(["true"], { historyLimit: 2 ** 31 })).rejects.toBeInstanceOf(
          TypeError,
        );
        await expect(server.run(["true"], { timeoutMs: -1 })).rejects.toBeInstanceOf(TypeError);
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "ends a program that ignores SIGHUP, on kill and at a timeout",
    async () => {
      await withServer(async (server) => {
        // Ignores the pty's SIGHUP and the first SIGTERM, so only the SIGKILL ends it.
        const stubborn = ["sh", "-c", "trap '' HUP TERM; echo ready; sleep 30"];
        const program = await server.spawn(stubborn);
        // Its traps are set once it says so; a kill before that tests nothing.
        let shown = "";
        for (let attempt = 0; attempt < 200 && shown !== "ready"; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop -- read until it is ready.
          shown = await program.output();
          // eslint-disable-next-line no-await-in-loop -- not ready yet.
          if (shown !== "ready") await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(shown).toBe("ready");
        const pid = await panePid(server, program.pane.id);
        expect(running(pid)).toBe(true);
        await program.kill();
        expect(running(pid)).toBe(false);

        const result = await server.run(stubborn, { timeoutMs: 2_000 });
        expect(result).toMatchObject({ output: "ready", timedOut: true });
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "live programs hold no slot of the server's ceiling",
    async () => {
      await withServer(async (_server, _directory, fixture) => {
        const server = new Server({
          environment: fixture.controllerEnvironment,
          maxInFlight: 1,
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });
        const programs = [
          await server.spawn(["sleep", "30"]),
          await server.spawn(["sleep", "30"]),
          await server.spawn(["sleep", "30"]),
        ];
        expect(await programSessions(server)).toBe(3);
        await Promise.all(programs.map((program) => program.kill()));
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "concurrent kills all wait for the same end",
    async () => {
      await withServer(async (server) => {
        const program = await server.spawn(["sleep", "30"]);
        await Promise.all([program.kill(), program.kill(), program.kill()]);
        expect(await server.hasSession(program.sessionName)).toBe(false);
        await expect(program.output()).rejects.toBeInstanceOf(ObjectNotFoundError);
      });
    },
    40_000,
  );

  testProgram(
    "leaving a stream early stops it, and a killed program streams nothing",
    async () => {
      await withServer(async (server) => {
        const program = await server.spawn(["sh", "-c", "echo one; sleep 30"], { stream: true });
        for await (const chunk of program.stream()) {
          expect(chunk).toContain("one");
          break;
        }
        await program.kill();
        expect(await programSessions(server)).toBe(0);
        const stream = program.stream();
        await expect(stream.next()).rejects.toBeInstanceOf(LibTmuxError);
      });
    },
    40_000,
  );

  testProgram(
    "a pane removed from outside ends its stream with the wait's error",
    async () => {
      await withServer(async (server) => {
        await using program = await server.spawn(["sh", "-c", "echo one; sleep 30"], {
          stream: true,
        });
        let removed: Promise<readonly string[]> | undefined;
        const reading = (async () => {
          for await (const chunk of program.stream()) {
            if (chunk.includes("one")) {
              removed ??= server.cmd("kill-session", ["-t", `=${program.sessionName}`]);
            }
          }
        })();
        await expect(reading).rejects.toBeInstanceOf(ObjectNotFoundError);
        await removed;
      });
    },
    40_000,
  );

  testProgram(
    "a kill ends a stream in progress with an error",
    async () => {
      await withServer(async (server) => {
        const program = await server.spawn(["sh", "-c", "echo one; sleep 30"], { stream: true });
        let killing: Promise<void> | undefined;
        const reading = (async () => {
          for await (const chunk of program.stream()) {
            if (chunk.includes("one")) killing ??= program.kill();
          }
        })();
        await expect(reading).rejects.toBeInstanceOf(LibTmuxError);
        await killing;
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "a stream copy lands in a temporary directory whose name tmux would expand",
    async () => {
      await withServer(async (server, directory) => {
        const odd = join(directory, "tmp #{pane_id} %Y");
        await mkdir(odd);
        const saved = process.env.TMPDIR;
        process.env.TMPDIR = odd;
        try {
          await using program = await server.spawn(["echo", "hi"], { stream: true });
          let text = "";
          for await (const chunk of program.stream()) text += chunk;
          expect(text).toBe("hi\r\n");
        } finally {
          if (saved === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = saved;
        }
      });
    },
    40_000,
  );

  testProgram(
    "a run leases its program from tmux while it waits",
    async () => {
      await withServer(async (server) => {
        const running = server.run(["sleep", "2"]);
        const lease = await eventually(
          async () => {
            const session = (await server.sessions())
              .toArray()
              .find((candidate) => candidate.name?.startsWith("libtmux-program-") === true);
            const paneId = session?.activePane?.id;
            if (paneId === undefined) return [];
            return server.cmd("show-options", ["-p", "-v", "-t", paneId, "@libtmux-lease"]);
          },
          (values) => values.length > 0,
          10_000,
        );
        expect(lease).toEqual(["0"]);
        expect((await running).success).toBe(true);
      });
    },
    40_000,
  );

  testProgram(
    "an expired lease kills a live program and removes its session",
    async () => {
      await withServer(async (server) => {
        const program = await server.spawn(["sh", "-c", "trap '' HUP TERM; sleep 30"]);
        const pid = await panePid(server, program.pane.id);
        const owned = { kind: "session", target: `=${program.sessionName}` } as const;
        for (const [command = "", ...args] of leaseTimer(
          program.pane.id,
          owned,
          false,
          false,
          7,
          0,
        )) {
          // eslint-disable-next-line no-await-in-loop -- the timer reads the lease the first sets.
          await server.cmd(command, args);
        }
        expect(
          await eventually(
            async () => running(pid),
            (alive) => !alive,
            5000,
          ),
        ).toBe(false);
        expect(
          await eventually(
            () => server.hasSession(program.sessionName),
            (has) => !has,
            5000,
          ),
        ).toBe(false);
        await program.kill();
      });
    },
    40_000,
  );

  testProgram(
    "a renewed lease leaves the program running",
    async () => {
      await withServer(async (server) => {
        await using program = await server.spawn(["sleep", "30"]);
        const owned = { kind: "session", target: `=${program.sessionName}` } as const;
        for (const [command = "", ...args] of leaseTimer(
          program.pane.id,
          owned,
          false,
          false,
          1,
          0.3,
        )) {
          // eslint-disable-next-line no-await-in-loop -- in order.
          await server.cmd(command, args);
        }
        await server.cmd("set-option", ["-p", "-t", program.pane.id, "@libtmux-lease", "2"]);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(running(await panePid(server, program.pane.id))).toBe(true);
      });
    },
    40_000,
  );

  testProgram(
    "an expired lease reads the pane when it fires and spares a dead one's group",
    async () => {
      await withServer(async (server, directory) => {
        // The program waits for a file, so it still runs when the timer is queued,
        // then exits before the timer fires and leaves a child in its process group:
        // a pane state read when the timer was queued would have that child killed.
        const gate = join(directory, "gate");
        const script =
          'trap "" HUP; sleep 30 </dev/null >/dev/null 2>&1 & echo $!; i=0; while [ ! -e "$0" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done';
        await using program = await server.spawn(["sh", "-c", script, gate], { keep: true });
        const owned = { kind: "session", target: `=${program.sessionName}` } as const;
        const queued = Date.now();
        for (const [command = "", ...args] of leaseTimer(
          program.pane.id,
          owned,
          true,
          false,
          3,
          4,
        )) {
          // eslint-disable-next-line no-await-in-loop -- in order.
          await server.cmd(command, args);
        }
        await writeFile(gate, "");
        await program.wait({ timeoutMs: 10_000 });
        const child = Number(await program.output());
        expect(running(child)).toBe(true);
        try {
          // Past the timer, which leaves nothing to see for a dead pane.
          const fired = queued + 5_000 - Date.now();
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, fired)));
          expect(running(child)).toBe(true);
        } finally {
          if (running(child)) process.kill(child, "SIGKILL");
          await server.cmd("kill-session", ["-t", `=${program.sessionName}`]);
        }
      });
    },
    40_000,
  );

  testProgram(
    "tmux ends a spawned program, its session and its copy once its caller is killed",
    async () => {
      await withServer(async (server, _directory, fixture) => {
        const caller = Bun.spawn(
          [
            process.execPath,
            "-e",
            `import { Server } from ${JSON.stringify(SERVER_MODULE)};
const server = new Server(JSON.parse(process.env.LTX_PROGRAM_SERVER));
const program = await server.spawn(["sh", "-c", "trap '' HUP TERM; sleep 300"], { orphanAfterMs: 1000, stream: true });
console.log(JSON.stringify({ pane: program.pane.id, session: program.sessionName }));
setInterval(() => undefined, 1000);`,
          ],
          {
            env: {
              ...process.env,
              LTX_PROGRAM_SERVER: JSON.stringify({
                environment: fixture.controllerEnvironment,
                socketPath: fixture.socketPath,
                tmuxBin: fixture.tmuxExecutable,
              }),
            },
            stderr: "inherit",
            stdout: "pipe",
          },
        );
        const reader = caller.stdout.getReader();
        let line = "";
        while (!line.includes("\n")) {
          // eslint-disable-next-line no-await-in-loop -- until the caller has started it.
          const { done, value } = await reader.read();
          if (done) break;
          line += new TextDecoder().decode(value);
        }
        const { pane, session } = JSON.parse(line) as { pane: string; session: string };
        const pid = await panePid(server, pane);
        const [files = ""] = await server.cmd("show-options", [
          "-p",
          "-v",
          "-t",
          pane,
          "@libtmux-files",
        ]);
        // Past two renewals, so a live caller is seen to keep the lease.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(await server.hasSession(session)).toBe(true);
        caller.kill("SIGKILL");
        await caller.exited;
        expect(
          await eventually(
            () => server.hasSession(session),
            (has) => !has,
            5000,
          ),
        ).toBe(false);
        expect(running(pid)).toBe(false);
        expect(
          await eventually(
            () => gone(files),
            (removed) => removed,
            5000,
          ),
        ).toBe(true);
      });
    },
    40_000,
  );

  testProgram(
    "a split beside a pane leaves its window, its options and its focus as they were",
    async () => {
      await withServer(async (server) => {
        const session = await server.newSession({ name: "work" });
        const pane = session.activePane;
        if (pane === undefined) throw new Error("a new session has a pane");
        const result = await server.run(["echo", "beside"], { from: pane, placement: "split" });
        expect(result.output).toBe("beside");
        expect(await server.cmd("list-panes", ["-t", "=work:", "-F", "#{pane_id}"])).toEqual([
          pane.id,
        ]);
        expect(
          await server.cmd("show-options", ["-w", "-v", "-t", pane.id, "remain-on-exit"]),
        ).toEqual([]);
        expect(await server.cmd("display-message", ["-p", "-t", "=work:", "#{pane_id}"])).toEqual([
          pane.id,
        ]);
      });
    },
    40_000,
  );

  testProgram(
    "a kept pane stays, dead and showing the output, for a person to close",
    async () => {
      await withServer(async (server) => {
        const session = await server.newSession({ name: "work" });
        const pane = session.activePane;
        if (pane === undefined) throw new Error("a new session has a pane");
        const result = await server.run(["sh", "-c", "echo kept; exit 2"], {
          from: pane,
          keep: true,
          placement: "split",
        });
        expect(result.exitCode).toBe(2);
        const ids = await server.cmd("list-panes", ["-t", "=work:", "-F", "#{pane_id}"]);
        const kept = (await server.panes())
          .toArray()
          .find((each) => ids.includes(each.id) && each.id !== pane.id);
        if (kept === undefined) throw new Error("the kept pane is gone");
        expect(await server.cmd("display-message", ["-p", "-t", kept.id, "#{pane_dead}"])).toEqual([
          "1",
        ]);
        expect((await kept.capture()).filter((text) => text !== "")).toEqual(["kept"]);

        let name = "";
        {
          await using program = await server.spawn(["sleep", "30"], { keep: true });
          name = program.sessionName;
        }
        // Disposal ended the program and left its session.
        expect(
          await server.cmd("display-message", ["-p", "-t", `=${name}:`, "#{pane_dead}"]),
        ).toEqual(["1"]);
      });
    },
    40_000,
  );

  testProgram(
    "input reaches the program's stdin, byte for byte",
    async () => {
      await withServer(async (server) => {
        expect((await server.run(["sort"], { input: "pear\napple\n" })).output).toBe("apple\npear");
        const bytes = new Uint8Array([0, 1, 2, 255, 10]);
        expect((await server.run(["wc", "-c"], { input: bytes })).output.trim()).toBe("5");
        // The terminal is still the program's output, and its tty.
        expect(
          (await server.run(["sh", "-c", "cat; [ -t 1 ] && echo tty"], { input: "in\n" })).output,
        ).toBe("in\ntty");
      });
    },
    40_000,
  );

  testProgram(
    "maxStreamBytes stops the copy and says so after what it kept",
    async () => {
      await withServer(async (server) => {
        await using program = await server.spawn(["seq", "1", "100000"], {
          maxStreamBytes: 100,
          stream: true,
        });
        let text = "";
        const reading = (async () => {
          for await (const chunk of program.stream()) text += chunk;
        })();
        await expect(reading).rejects.toBeInstanceOf(LibTmuxError);
        expect(new TextEncoder().encode(text)).toHaveLength(100);
        expect(await program.wait({ timeoutMs: 10_000 })).toEqual({
          exitCode: 0,
          signalCode: null,
        });

        await using fits = await server.spawn(["printf", "12345"], {
          maxStreamBytes: 5,
          stream: true,
        });
        let whole = "";
        for await (const chunk of fits.stream()) whole += chunk;
        expect(whole).toBe("12345");
      });
    },
    40_000,
  );

  testProgram(
    "refuses input and stream before anything starts when tmux cannot see this machine's files",
    async () => {
      await withServer(async (_server, directory, fixture) => {
        // A tmux whose shell writes nowhere this process can see, as a remote one would.
        const elsewhere = join(directory, "tmux-elsewhere");
        await writeFile(
          elsewhere,
          `#!/bin/sh\nfor arg do shift; case $arg in ": > "*) arg=: ;; esac; set -- "$@" "$arg"; done\nexec ${fixture.tmuxExecutable} "$@"\n`,
        );
        await chmod(elsewhere, 0o755);
        const remote = new Server({
          environment: fixture.controllerEnvironment,
          socketPath: fixture.socketPath,
          tmuxBin: elsewhere,
        });
        await expect(remote.run(["cat"], { input: "x" })).rejects.toThrow(/on this machine/u);
        await expect(remote.spawn(["true"], { stream: true })).rejects.toThrow(/on this machine/u);
        expect(await programSessions(remote)).toBe(0);
      });
    },
    40_000,
  );

  test("refuses placements and limits its options do not fit", async () => {
    await withServer(async (server) => {
      const pane = (await server.panes()).toArray()[0];
      if (pane === undefined) throw new Error("the fixture has a pane");
      await expect(server.run(["true"], { placement: "split" })).rejects.toBeInstanceOf(TypeError);
      await expect(
        server.run(["true"], { from: pane, placement: "session" }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        server.run(["true"], { from: pane, placement: "split", height: 5 }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(server.spawn(["true"], { maxStreamBytes: 10 })).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(server.spawn(["true"], { orphanAfterMs: 999 })).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(await programSessions(server)).toBe(0);
    });
  }, 40_000);

  testProgram(
    "refuses a from pane of another tmux server before creating anything",
    async () => {
      await withServer(async (server, directory, fixture) => {
        const other = new Server({
          environment: fixture.controllerEnvironment,
          socketPath: join(directory, "other.sock"),
          tmuxBin: fixture.tmuxExecutable,
        });
        const session = await other.newSession({ name: "elsewhere" });
        try {
          const pane = session.activePane;
          if (pane === undefined) throw new Error("a new session has a pane");
          await expect(server.run(["true"], { from: pane })).rejects.toBeInstanceOf(TypeError);
          expect(await programSessions(server)).toBe(0);
          expect((await server.windows()).toArray().length).toBe(1);
        } finally {
          await other.cmd("kill-server", []).catch(() => undefined);
        }
      });
    },
    40_000,
  );

  test("refuses an argv[0] that a shell's exec would read as its own option", async () => {
    await withServer(async (server) => {
      await expect(server.run(["-l"])).rejects.toBeInstanceOf(TypeError);
    });
  }, 40_000);

  testProgram(
    "from a pane: its directory and session environment, and only its own window goes",
    async () => {
      await withServer(async (server, directory) => {
        const session = await server.newSession({ name: "work", startDirectory: directory });
        await server.cmd("set-environment", ["-t", "=work", "PROJECT_ENV", "from-session"]);
        const pane = session.activePane;
        if (pane === undefined) throw new Error("a new session has a pane");
        const windows = (await server.windows()).toArray().length;
        const result = await server.run(["sh", "-c", 'echo "$(pwd -P) $PROJECT_ENV"'], {
          from: pane,
        });
        expect(result.output).toBe(`${await realpath(directory)} from-session`);
        expect((await server.windows()).toArray().length).toBe(windows);
        expect(await server.hasSession("work")).toBe(true);
        await expect(server.run(["true"], { from: pane, width: 80 })).rejects.toBeInstanceOf(
          TypeError,
        );
      });
    },
    40_000,
  );

  testProgram(
    "takes a start directory literally, # and all",
    async () => {
      await withServer(async (server, directory) => {
        const literal = join(directory, "build#{pane_id}#2");
        await mkdir(literal);
        expect((await server.run(["pwd", "-P"], { startDirectory: literal })).output).toBe(
          await realpath(literal),
        );
      });
    },
    40_000,
  );

  testProgram(
    "a wait during a kill settles without spinning",
    async () => {
      await withServer(async (_server, _directory, fixture) => {
        let reads = 0;
        const observed = new Server({
          environment: fixture.controllerEnvironment,
          onInvocation: (report) => {
            if (report.commands.some(([name]) => name === "display-message")) reads += 1;
          },
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });
        // Ignores SIGTERM, so the kill spends its whole grace period before SIGKILL.
        const program = await observed.spawn(["sh", "-c", "trap '' TERM; sleep 30"]);
        const waiting = program.wait().then(
          () => "exited",
          (error: unknown) => (error instanceof ObjectNotFoundError ? "gone" : String(error)),
        );
        reads = 0;
        await program.kill();
        expect(["exited", "gone"]).toContain(await waiting);
        // A wait that woke on its settled watcher again would read without pause.
        expect(reads).toBeLessThan(300);
      });
    },
    40_000,
  );
});
