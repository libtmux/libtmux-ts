import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";
import { tmuxReaches } from "../support/tmux_release.js";

import { leaseTimer } from "../../src/_internal/operations/program_lease.js";

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
  OutputLostError,
  ProgramStartError,
  ServerNotLocalError,
  TmuxServerRestartedError,
  TmuxTransportError,
  VersionTooLowError,
  WaitTimeoutError,
} from "../../src/errors.js";
import { Server } from "../../src/server.js";
import type { SpawnOptions } from "../../src/types.js";

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

function onPath(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

/**
 * A caller of its own, under Bun so it can import the sources, that prints one
 * JSON line once it has started its program and lives until killed.
 */
async function startCaller(
  script: string,
  environment: Record<string, string>,
): Promise<{ readonly first: unknown; readonly kill: () => Promise<void> }> {
  const caller = spawn("bun", ["-e", script], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<void>((resolve) => caller.once("exit", () => resolve()));
  let line = "";
  for await (const chunk of caller.stdout) {
    line += String(chunk);
    if (line.includes("\n")) break;
  }
  return {
    first: JSON.parse(line),
    kill: async () => {
      caller.kill("SIGKILL");
      await exited;
    },
  };
}

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
const testWithVim = supported && onPath("vim") ? test : test.skip;

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
          lostEnd: false,
          lostStart: false,
          output: "one\ntwo",
          signalCode: null,
          success: false,
          timedOut: false,
        });
        // argv reaches the program untouched: no shell expands it, even as one word.
        expect((await server.run(["echo", "a;b", "$HOME", "*"])).output).toBe("a;b $HOME *");
        // A one-word argv is a program name, never a command line for default-shell.
        expect(await server.run(["echo $HOME"]).catch((error: unknown) => error)).toMatchObject({
          exitCode: 127,
          reason: "not-found",
        });
        expect((await server.run(["pwd"], { startDirectory: "/" })).output).toBe("/");
        // tmux's `-c` would fall back to $HOME; this ends the run before the program.
        const missing = await server
          .run(["pwd"], { startDirectory: "/ltx-no-such-directory" })
          .catch((error: unknown) => error);
        expect(missing).toBeInstanceOf(ProgramStartError);
        expect(missing).toMatchObject({ exitCode: 126, reason: "start-directory" });
        // Without one, it starts where this process is, as a child process would.
        expect((await server.run(["pwd", "-P"])).output).toBe(await realpath(process.cwd()));
        expect(
          (await server.run(["sh", "-c", "echo $LTX"], { environment: { LTX: "x y" } })).output,
        ).toBe("x y");
        // The status is the one `$?` gives: a signal's death is 128 plus its number,
        // and a program's own exit 130 stays 130.
        expect(await server.run(["sh", "-c", "kill -TERM $$"])).toMatchObject({
          exitCode: 143,
          signalCode: null,
        });
        expect(await server.run(["sh", "-c", "exit 130"])).toMatchObject({
          exitCode: 130,
          signalCode: null,
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
        expect(result).toMatchObject({ lostEnd: false, lostStart: true });
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
        expect(error).toMatchObject({ delivery: "written", kind: "cancelled" });
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "an AbortSignal.timeout ends a run past setup",
    async () => {
      await withServer(async (server) => {
        // Setup adds and removes its own listener first, which Bun before 1.4 takes as the
        // timer's end: https://github.com/oven-sh/bun/pull/37666
        const started = performance.now();
        const error = await server
          .run(["sleep", "30"], { signal: AbortSignal.timeout(1500) })
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({ delivery: "written", kind: "cancelled" });
        expect(performance.now() - started).toBeLessThan(10_000);
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
        // An abort mid-wait wakes the loop; its next read must not report the abort as unsent.
        const cancelled = await program
          .wait({ signal: AbortSignal.timeout(300) })
          .catch((error: unknown) => error);
        expect(cancelled).toBeInstanceOf(TmuxTransportError);
        expect(cancelled).toMatchObject({ delivery: "replied", kind: "cancelled" });
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
    "a program that never ran is an error, and one that exits 127 is not",
    async () => {
      await withServer(async (server, directory) => {
        const missing = await server.run(["ltx-no-such-program"]).catch((error: unknown) => error);
        expect(missing).toBeInstanceOf(ProgramStartError);
        expect(missing).toMatchObject({ exitCode: 127, reason: "not-found" });
        const plain = join(directory, "plain");
        await writeFile(plain, "echo never\n");
        for (const unrunnable of [plain, directory]) {
          // eslint-disable-next-line no-await-in-loop -- one run at a time.
          expect(await server.run([unrunnable]).catch((error: unknown) => error)).toMatchObject({
            exitCode: 126,
            reason: "not-executable",
          });
        }
        // On PATH, an unexecutable file is 126 as exec says, and a script whose interpreter
        // is missing gets past the check to exec's own 127.
        const bin = join(directory, "bin");
        await mkdir(bin);
        await writeFile(join(bin, "ltx-unexecutable"), "echo never\n", { mode: 0o644 });
        await writeFile(join(bin, "ltx-no-interpreter"), "#!/ltx-no-such-interpreter\n", {
          mode: 0o755,
        });
        const path = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
        // tmux gives a pane its client's PATH over one passed with -e; the wrapper sets this one.
        expect((await server.run(["sh", "-c", 'echo "$PATH"'], { environment: path })).output).toBe(
          path.PATH,
        );
        expect(
          await server
            .run(["ltx-unexecutable"], { environment: path })
            .catch((error: unknown) => error),
        ).toMatchObject({ exitCode: 126, reason: "not-executable" });
        expect((await server.run(["ltx-no-interpreter"], { environment: path })).exitCode).toBe(
          127,
        );
        // A program's own 127 is its status, and a builtin with a binary runs the binary.
        expect((await server.run(["sh", "-c", "exit 127"])).exitCode).toBe(127);
        expect((await server.run(["true"])).success).toBe(true);
        // A spawn starts, then its wait and its stream end with the error, after the complaint.
        await using unstarted = await server.spawn(["ltx-no-such-program"], { stream: true });
        let streamed = "";
        const ended = await (async () => {
          for await (const chunk of unstarted.stream()) streamed += chunk;
        })().catch((error: unknown) => error);
        expect(ended).toBeInstanceOf(ProgramStartError);
        expect(streamed).toContain("ltx-no-such-program: not found");
        expect(streamed).not.toContain("libtmux-ran-");
        await expect(unstarted.wait()).rejects.toBeInstanceOf(ProgramStartError);
        await expect(unstarted.wait()).rejects.toMatchObject({ reason: "not-found" });
      });
    },
    40_000,
  );

  testProgram(
    "an argv[0] with = in it is a program name, not an assignment",
    async () => {
      await withServer(async (server) => {
        expect(await server.run(["FOO=bar"]).catch((error: unknown) => error)).toMatchObject({
          code: "ProgramStartError",
          reason: "not-found",
        });
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
        // A cast past the type: nothing would read a spawn's stderr file.
        const runOnly = { separateStderr: true } as SpawnOptions;
        await expect(server.spawn(["true"], runOnly)).rejects.toBeInstanceOf(TypeError);
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
    "starts the server it runs on, and again once that one has exited",
    async () => {
      await withServer(async (_server, directory, fixture) => {
        const cold = new Server({
          configFile: "/dev/null",
          environment: fixture.controllerEnvironment,
          socketPath: join(directory, "cold"),
          tmuxBin: fixture.tmuxExecutable,
        });
        try {
          expect(await cold.isAlive()).toBe(false);
          expect((await cold.run(["echo", "first"])).output).toBe("first");
          // The run's session was the server's only one, so the server went with it.
          expect(await cold.isAlive()).toBe(false);
          expect((await cold.run(["sort"], { input: "b\na\n" })).output).toBe("a\nb");
        } finally {
          if (await cold.isAlive()) await cold.kill();
        }
      });
    },
    40_000,
  );

  testProgram(
    "separateStderr returns stderr apart from the terminal's output",
    async () => {
      await withServer(async (server) => {
        const result = await server.run(["sh", "-c", "echo out; echo err >&2; exit 3"], {
          separateStderr: true,
        });
        expect(result).toMatchObject({ exitCode: 3, output: "out", stderr: "err\n" });
        const merged = await server.run(["sh", "-c", "echo out; echo err >&2"]);
        expect(merged.output).toBe("out\nerr");
        expect(merged.stderr).toBeUndefined();
        // A directory the sh cannot enter fails the run before the program starts.
        const unentered = await server
          .run(["true"], { separateStderr: true, startDirectory: "/nonexistent-ltx-directory" })
          .catch((error: unknown) => error);
        expect(unentered).toMatchObject({ exitCode: 126, reason: "start-directory" });
        // The wrapper's own variables leave the program's alone.
        const own = await server.run(["sh", "-c", "echo $m $s $e"], {
          environment: { e: "three", m: "one", s: "two" },
        });
        expect(own.output).toBe("one two three");
      });
    },
    40_000,
  );

  testProgram(
    "back-to-back runs each start the server the last one took down",
    async () => {
      await withServer(async (_server, directory, fixture) => {
        const lone = new Server({
          configFile: "/dev/null",
          environment: fixture.controllerEnvironment,
          socketPath: join(directory, "lone"),
          tmuxBin: fixture.tmuxExecutable,
        });
        try {
          // A larger output keeps the server exiting longer, which is when the next run meets it.
          for (let run = 0; run < 30; run += 1) {
            // eslint-disable-next-line no-await-in-loop -- each run follows the last one's exit.
            expect((await lone.run(["seq", "1", "200000"])).exitCode).toBe(0);
          }
        } finally {
          if (await lone.isAlive()) await lone.kill();
        }
      });
    },
    120_000,
  );

  testProgram(
    "a run whose pane takes its server with it rejects as not found",
    async () => {
      await withServer(async (_server, directory, fixture) => {
        const cold = new Server({
          configFile: "/dev/null",
          environment: fixture.controllerEnvironment,
          socketPath: join(directory, "lone"),
          tmuxBin: fixture.tmuxExecutable,
        });
        try {
          const running = cold.run(["sleep", "30"]);
          // Killed once the program runs, not while setup still holds the placeholder.
          const pane = await eventually(
            async () =>
              (await cold.isAlive())
                ? cold.cmd("list-panes", ["-a", "-F", "#{pane_id} #{pane_current_command}"])
                : [],
            (panes) => panes.some((row) => row.endsWith(" sleep")),
            5000,
          );
          await cold.cmd("kill-pane", ["-t", (pane[0] ?? "").split(" ")[0] ?? ""]);
          expect(await running.catch((error: unknown) => error)).toBeInstanceOf(
            ObjectNotFoundError,
          );
        } finally {
          if (await cold.isAlive()) await cold.kill();
        }
      });
    },
    40_000,
  );

  testProgram(
    "a spawn aborted before it starts removes what it made",
    async () => {
      await withServer(async (server) => {
        const early = new AbortController();
        early.abort(new Error("enough"));
        const refused = await server
          .spawn(["sleep", "30"], { signal: early.signal })
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(TmuxTransportError);
        expect(refused).toMatchObject({ delivery: "not_started", kind: "cancelled" });

        // Aborted while the pane is made: setup notices before it waits for the start.
        const late = new AbortController();
        const starting = server.spawn(["sleep", "30"], { signal: late.signal });
        late.abort(new Error("enough"));
        const cut = await starting.catch((error: unknown) => error);
        expect(cut).toMatchObject({ delivery: "indeterminate", kind: "cancelled" });
        expect(await programSessions(server)).toBe(0);
      });
    },
    40_000,
  );

  testProgram(
    "a signal ends a stream and leaves the program running",
    async () => {
      await withServer(async (server) => {
        await using program = await server.spawn(["sh", "-c", "echo up; sleep 30"], {
          stream: true,
        });
        const controller = new AbortController();
        let text = "";
        const reading = (async () => {
          for await (const chunk of program.stream({ signal: controller.signal })) {
            text += chunk;
            if (text.includes("up")) controller.abort(new Error("enough"));
          }
        })();
        expect(await reading.catch((error: unknown) => error)).toMatchObject({ kind: "cancelled" });
        expect(text).toContain("up");
        const [dead] = await server.cmd("display-message", [
          "-p",
          "-t",
          program.pane.id,
          "#{pane_dead}",
        ]);
        expect(dead).toBe("0");
      });
    },
    40_000,
  );

  testProgram(
    "stream() without stream: true throws at the call",
    async () => {
      await withServer(async (server) => {
        await using program = await server.spawn(["true"]);
        expect(() => program.stream()).toThrow(TypeError);
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
        // The token first: a timer queued with no delay fires before a later command.
        for (const [command = "", ...args] of leaseTimer(
          program.pane.id,
          owned,
          false,
          false,
          7,
          0,
        ).toReversed()) {
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
        // The token first: a timer queued with no delay fires before a later command.
        for (const [command = "", ...args] of leaseTimer(
          program.pane.id,
          owned,
          false,
          false,
          1,
          0.3,
        ).toReversed()) {
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
        // The token first: a timer queued with no delay fires before a later command.
        for (const [command = "", ...args] of leaseTimer(
          program.pane.id,
          owned,
          true,
          false,
          3,
          4,
        ).toReversed()) {
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
        const caller = await startCaller(
          `import { Server } from ${JSON.stringify(SERVER_MODULE)};
const server = new Server(JSON.parse(process.env.LTX_PROGRAM_SERVER));
const program = await server.spawn(["sh", "-c", "trap '' HUP TERM; sleep 300"], { orphanAfterMs: 1000, stream: true });
console.log(JSON.stringify({ pane: program.pane.id, session: program.sessionName }));
setInterval(() => undefined, 1000);`,
          {
            LTX_PROGRAM_SERVER: JSON.stringify({
              environment: fixture.controllerEnvironment,
              socketPath: fixture.socketPath,
              tmuxBin: fixture.tmuxExecutable,
            }),
          },
        );
        const { pane, session } = caller.first as { pane: string; session: string };
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
        await caller.kill();
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
    "a killed caller's files go even when its session was the server's last",
    async () => {
      await withServer(async (_server, directory, fixture) => {
        const options = {
          configFile: "/dev/null",
          environment: fixture.controllerEnvironment,
          socketPath: join(directory, "lone"),
          tmuxBin: fixture.tmuxExecutable,
        };
        const lone = new Server(options);
        const caller = await startCaller(
          `import { Server } from ${JSON.stringify(SERVER_MODULE)};
const server = new Server(JSON.parse(process.env.LTX_PROGRAM_SERVER));
const program = await server.spawn(["sh", "-c", "while :; do echo x; sleep 0.05; done"], { input: "x", orphanAfterMs: 1000, stream: true });
console.log(JSON.stringify({ pane: program.pane.id }));
setInterval(() => undefined, 1000);`,
          { LTX_PROGRAM_SERVER: JSON.stringify(options) },
        );
        try {
          const { pane } = caller.first as { pane: string };
          const [files = ""] = await lone.cmd("show-options", [
            "-p",
            "-v",
            "-t",
            pane,
            "@libtmux-files",
          ]);
          expect(files).not.toBe("");
          await caller.kill();
          // The lease removes the only session, and tmux exits with it.
          expect(
            await eventually(
              () => lone.isAlive(),
              (alive) => !alive,
              5000,
            ),
          ).toBe(false);
          expect(
            await eventually(
              () => gone(files),
              (removed) => removed,
              5000,
            ),
          ).toBe(true);
        } finally {
          if (await lone.isAlive()) await lone.kill();
        }
      });
    },
    40_000,
  );

  testProgram(
    "a program from a restarted server leaves the new server's pane of its id alone",
    async () => {
      await withServer(async (_server, directory, fixture) => {
        const options = {
          configFile: "/dev/null",
          environment: fixture.controllerEnvironment,
          socketPath: join(directory, "restarted"),
          tmuxBin: fixture.tmuxExecutable,
        };
        const server = new Server(options);
        try {
          const program = await server.spawn(["sleep", "300"], { orphanAfterMs: 1000 });
          await server.kill();
          const replacement = new Server(options);
          await replacement.newSession({ name: "bystander", shellCommand: "sleep 300" });
          const [bystander] = (await replacement.panes()).toArray();
          expect(bystander?.id).toBe(program.pane.id);
          // The first Server reads the new daemon, so a raw id guarded by what it last saw would pass.
          await server.panes();
          await expect(program.output()).rejects.toBeInstanceOf(TmuxServerRestartedError);
          await expect(program.wait({ timeoutMs: 500 })).rejects.toBeInstanceOf(
            TmuxServerRestartedError,
          );
          // Past a renewal: none may lease the bystander, whose timer would kill it.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const [lease = ""] = await replacement.cmd("show-options", [
            "-p",
            "-q",
            "-v",
            "-t",
            bystander?.id ?? "",
            "@libtmux-lease",
          ]);
          expect(lease).toBe("");
          await program.kill();
          expect(await replacement.hasSession("bystander")).toBe(true);
        } finally {
          if (await server.isAlive()) await server.kill();
        }
      });
    },
    40_000,
  );

  testProgram(
    "a pane killed from outside hangs up its program, as a shell's would",
    async () => {
      await withServer(async (server) => {
        const program = await server.spawn(["sleep", "300"], { orphanAfterMs: null });
        const sh = await panePid(server, program.pane.id);
        const child = await eventually(
          async () =>
            Number(spawnSync("ps", ["-o", "pid=", "--ppid", String(sh)]).stdout.toString()),
          (pid) => pid > 0,
          5000,
        );
        await server.cmd("kill-session", ["-t", `=${program.sessionName}`]);
        expect(
          await eventually(
            async () => running(child),
            (alive) => !alive,
            5000,
          ),
        ).toBe(false);
        expect(running(sh)).toBe(false);
      });
    },
    40_000,
  );

  testProgram(
    "a pane killed from outside lets its caller exit, by a wait or a renewal",
    async () => {
      await withServer(async (_server, _directory, fixture) => {
        const environment = {
          LTX_PROGRAM_SERVER: JSON.stringify({
            environment: fixture.controllerEnvironment,
            socketPath: fixture.socketPath,
            tmuxBin: fixture.tmuxExecutable,
          }),
        };
        // tmux fires no event for the kill, so only the wait's read or the lease's renewal sees it.
        for (const [options, after] of [
          ["{ orphanAfterMs: null }", "await program.wait().catch(() => undefined);"],
          ["{ orphanAfterMs: 1500 }", ""],
        ]) {
          const caller = spawn(
            "bun",
            [
              "-e",
              `import { Server } from ${JSON.stringify(SERVER_MODULE)};
const server = new Server(JSON.parse(process.env.LTX_PROGRAM_SERVER));
const program = await server.spawn(["sleep", "300"], ${options});
await server.cmd("kill-pane", ["-t", program.pane.id]);
${after}`,
            ],
            { env: { ...process.env, ...environment }, stdio: ["ignore", "ignore", "inherit"] },
          );
          // eslint-disable-next-line no-await-in-loop -- one caller at a time.
          const ended = await Promise.race([
            new Promise<number | null>((resolve) => caller.once("exit", resolve)),
            new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 10_000)),
          ]);
          if (ended === "running") caller.kill("SIGKILL");
          expect(ended).toBe(0);
        }
      });
    },
    40_000,
  );

  testProgram(
    "a window beside a killed caller's pane goes, and the pane's session stays",
    async () => {
      await withServer(async (server, _directory, fixture) => {
        const session = await server.newSession({ name: "person" });
        const caller = await startCaller(
          `import { Server } from ${JSON.stringify(SERVER_MODULE)};
const server = new Server(JSON.parse(process.env.LTX_PROGRAM_SERVER));
const from = (await server.panes()).toArray().find((pane) => pane.id === process.env.LTX_FROM);
const program = await server.spawn(["sh", "-c", "trap '' HUP TERM; sleep 300"], { from, orphanAfterMs: 1000 });
console.log(JSON.stringify({ pane: program.pane.id }));
setInterval(() => undefined, 1000);`,
          {
            LTX_FROM: session.activePane?.id ?? "",
            LTX_PROGRAM_SERVER: JSON.stringify({
              environment: fixture.controllerEnvironment,
              socketPath: fixture.socketPath,
              tmuxBin: fixture.tmuxExecutable,
            }),
          },
        );
        const { pane } = caller.first as { pane: string };
        const pid = await panePid(server, pane);
        const windows = async (): Promise<number> =>
          (await server.cmd("list-windows", ["-t", "=person", "-F", "#{window_id}"])).length;
        expect(await windows()).toBe(2);
        await caller.kill();
        expect(await eventually(windows, (count) => count === 1, 5000)).toBe(1);
        expect(running(pid)).toBe(false);
        expect(await server.hasSession("person")).toBe(true);
      });
    },
    40_000,
  );

  testProgram(
    "a run or stream that ends without its mark says its end may be lost",
    async () => {
      await withServer(async (server) => {
        // USR1 ends the wrapper before its mark, as a pane tmux removed early would read.
        const cut = await server.run(["sh", "-c", "echo hi; kill -USR1 $PPID; sleep 1"]);
        expect(cut).toMatchObject({ lostEnd: true, output: "hi", signalCode: "SIGUSR1" });
        // A SIGKILL to the group stops the wrapper before its mark too: the end is unproven.
        const killed = await server.run(["sh", "-c", "echo hi; kill -KILL 0"]);
        expect(killed).toMatchObject({ lostEnd: true, output: "hi", signalCode: "SIGKILL" });
        expect((await server.run(["echo", "whole"])).lostEnd).toBe(false);
        await using streamed = await server.spawn(
          ["sh", "-c", "echo hi; kill -USR1 $PPID; sleep 1"],
          { stream: true },
        );
        let text = "";
        const reading = (async () => {
          for await (const chunk of streamed.stream()) text += chunk;
        })();
        await expect(reading).rejects.toBeInstanceOf(OutputLostError);
        expect(text).toBe("hi\r\n");
      });
    },
    40_000,
  );

  testProgram(
    "a spawn holds a lease unless orphanAfterMs is null",
    async () => {
      await withServer(async (server) => {
        await using leased = await server.spawn(["sleep", "30"]);
        await using unleased = await server.spawn(["sleep", "30"], { orphanAfterMs: null });
        const lease = async (paneId: string): Promise<readonly string[]> =>
          server.cmd("show-options", ["-p", "-v", "-t", paneId, "@libtmux-lease"]).catch(() => []);
        expect(await lease(leased.pane.id)).toEqual(["0"]);
        expect(await lease(unleased.pane.id)).toEqual([]);
      });
    },
    40_000,
  );

  testProgram(
    "a lease stops renewing once its pane is removed from outside",
    async () => {
      await withServer(async (_server, _directory, fixture) => {
        let renewals = 0;
        const observed = new Server({
          environment: fixture.controllerEnvironment,
          onInvocation: (report) => {
            if (report.commands.some((command) => command.includes("@libtmux-lease")))
              renewals += 1;
          },
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });
        const program = await observed.spawn(["sleep", "30"], { orphanAfterMs: 1000 });
        await observed.cmd("kill-pane", ["-t", program.pane.id]);
        // One renewal finds the pane gone; none follow it.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const seen = renewals;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(renewals).toBe(seen);
        await program.kill().catch(() => undefined);
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
    "a limit that lands inside the end mark still fits output below it",
    async () => {
      await withServer(async (server) => {
        // The mark is ST, OSC 7, the run's mark and BEL: 55 bytes, and 70 with a reason.
        const limits = Array.from({ length: 80 }, (_, index) => index + 3);
        const streamed = async (limit: number): Promise<string> => {
          await using program = await server.spawn(["printf", "12345"], {
            maxStreamBytes: limit,
            stream: true,
          });
          let text = "";
          try {
            for await (const chunk of program.stream()) text += chunk;
          } catch (error) {
            return `${text} ${(error as Error).name}`;
          }
          return text;
        };
        const results: string[] = [];
        for (let at = 0; at < limits.length; at += 16) {
          // eslint-disable-next-line no-await-in-loop -- sixteen at a time.
          results.push(...(await Promise.all(limits.slice(at, at + 16).map(streamed))));
        }
        expect(results.slice(0, 2)).toEqual(["123 StreamLimitError", "1234 StreamLimitError"]);
        expect(new Set(results.slice(2))).toEqual(new Set(["12345"]));
      });
    },
    60_000,
  );

  testProgram(
    "refuses input, stream and separateStderr, leaving nothing, when tmux cannot see its files",
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
        await expect(remote.run(["cat"], { input: "x" })).rejects.toBeInstanceOf(
          ServerNotLocalError,
        );
        await expect(remote.spawn(["true"], { stream: true })).rejects.toBeInstanceOf(
          ServerNotLocalError,
        );
        await expect(remote.run(["true"], { separateStderr: true })).rejects.toBeInstanceOf(
          ServerNotLocalError,
        );
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
