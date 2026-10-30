import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

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
import type { Pane } from "../../src/pane.js";
import { Server } from "../../src/server.js";
import { tmuxReaches } from "../support/tmux_release.js";

async function withServer(body: (server: Server) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-pane-wait-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run-root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "pane-wait" });
        const server = new Server({
          environment: fixture.controllerEnvironment,
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });
        await runWithCleanup(
          () => body(server),
          () => fixture.dispose(),
        );
      },
      async () => {
        if (published === undefined) await reapOwnedRunRoot(runRoot);
        done = true;
      },
    );
  } finally {
    // Kept when the reap failed, as the evidence of what it could not remove.
    if (done) await rm(parent, { force: true, recursive: true });
  }
}

async function paneRunning(server: Server, name: string, command: string): Promise<Pane> {
  const session = await server.newSession({ name, shellCommand: command });
  const pane = session.activePane;
  if (pane === undefined) throw new Error("a new session has a pane");
  return pane;
}

/**
 * A bash whose prompt marks each command's end with OSC 133. The first prompt
 * marks nothing, so a command sent before bash is ready is still the first end.
 */
async function markedShell(server: Server): Promise<Pane> {
  const session = await server.newSession({ name: "marked", shellCommand: MARKED_BASH });
  const pane = session.activePane;
  if (pane === undefined) throw new Error("a new session has a pane");
  return pane;
}

/** Variables given in the command, so they reach bash however tmux passes its own. */
const MARKED_BASH =
  "env PS1='ready$ ' " +
  `PROMPT_COMMAND='s=$?; [ -n "$r" ] && printf "\\033]133;D;%s\\007" "$s"; r=1' ` +
  "bash --norc --noprofile -i";

const supported = tmuxReaches("3.8");
const testWait = supported ? test : test.skip;
const testMarked =
  supported && spawnSync("sh", ["-c", "command -v bash"]).status === 0 ? test : test.skip;

describe("pane waits", () => {
  test("refuse below tmux 3.8", async () => {
    await withServer(async (server) => {
      if (supported) return;
      const pane = await paneRunning(server, "old", "sleep 30");
      await expect(pane.waitForExit()).rejects.toBeInstanceOf(VersionTooLowError);
      await expect(pane.waitForCommand()).rejects.toBeInstanceOf(VersionTooLowError);
      await expect(pane.waitForText("x")).rejects.toBeInstanceOf(VersionTooLowError);
    });
  }, 40_000);

  testWait(
    "a pane that closes reports the status it took with it",
    async () => {
      await withServer(async (server) => {
        const pane = await paneRunning(server, "closing", "sleep 1; exit 7");
        expect(await pane.waitForExit({ timeoutMs: 10_000 })).toEqual({
          exitCode: 7,
          signalCode: null,
        });
      });
    },
    40_000,
  );

  testWait(
    "a kept pane reports its signal, and one already dead answers at once",
    async () => {
      await withServer(async (server) => {
        await server.setGlobalOption("window", "remain-on-exit", "on");
        const pane = await paneRunning(server, "kept", "sleep 0.5; kill -TERM $$");
        expect(await pane.waitForExit({ timeoutMs: 10_000 })).toEqual({
          exitCode: null,
          signalCode: "SIGTERM",
        });
        const started = performance.now();
        expect(await pane.waitForExit({ timeoutMs: 10_000 })).toEqual({
          exitCode: null,
          signalCode: "SIGTERM",
        });
        expect(performance.now() - started).toBeLessThan(1000);
        // A dead pane will finish no command, so a command wait on it rejects.
        await expect(pane.waitForCommand({ timeoutMs: 10_000 })).rejects.toBeInstanceOf(
          LibTmuxError,
        );
      });
    },
    40_000,
  );

  testWait(
    "a pane killed from outside, which fires no event, is reported missing",
    async () => {
      await withServer(async (server) => {
        const pane = await paneRunning(server, "killed", "sleep 30");
        const text = await paneRunning(server, "watched", "sleep 30");
        const waiting = pane.waitForExit({ timeoutMs: 20_000 }).catch((error: unknown) => error);
        const reading = text
          .waitForText("never", { timeoutMs: 20_000 })
          .catch((error: unknown) => error);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await server.cmd("kill-pane", ["-t", pane.id]);
        await server.cmd("kill-pane", ["-t", text.id]);
        // Each wait names the pane in its message.
        const gone = (target: Pane): ObjectNotFoundError =>
          new ObjectNotFoundError({ message: `${target.id}: the pane is gone` });
        for (const [target, error] of [
          [pane, await waiting],
          [text, await reading],
          [text, await text.waitForText("never").catch((error: unknown) => error)],
          [pane, await pane.waitForExit().catch((error: unknown) => error)],
          [pane, await pane.waitForCommand().catch((error: unknown) => error)],
        ] as const) {
          expect(error).toBeInstanceOf(ObjectNotFoundError);
          expect(error).toMatchObject({ message: gone(target).message });
        }
      });
    },
    40_000,
  );

  testWait(
    "giving up leaves the program running",
    async () => {
      await withServer(async (server) => {
        const pane = await paneRunning(server, "slow", "sleep 30");
        await expect(pane.waitForExit({ timeoutMs: 300 })).rejects.toBeInstanceOf(WaitTimeoutError);
        const stop = new AbortController();
        setTimeout(() => stop.abort(new Error("enough")), 300);
        const aborted = await pane
          .waitForExit({ signal: stop.signal })
          .catch((error: unknown) => error);
        expect(aborted).toBeInstanceOf(TmuxTransportError);
        expect((aborted as TmuxTransportError).kind).toBe("cancelled");
        expect((await pane.refreshed()).format.pane_dead).toBe("0");
      });
    },
    40_000,
  );

  testMarked(
    "a marked shell reports a sent command's status, and a typed one's",
    async () => {
      await withServer(async (server) => {
        const pane = await markedShell(server);
        expect(await pane.waitForCommand({ send: "(exit 4)", timeoutMs: 10_000 })).toBe(4);
        const typed = pane.waitForCommand({ timeoutMs: 10_000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await pane.sendKeys("false");
        expect(await typed).toBe(1);
      });
    },
    40_000,
  );

  testWait(
    "a wait on its server's last pane reports the pane gone when the server goes with it",
    async () => {
      const directory = await makeTestDirectory("ltx-pane-wait-last-");
      const lone = new Server({ configFile: "/dev/null", socketPath: join(directory, "s") });
      try {
        const pane = await paneRunning(lone, "only", "sleep 60");
        const gone = { message: `${pane.id}: the pane is gone` };
        const waiting = pane.waitForText("never", { timeoutMs: 20_000 }).catch((error) => error);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await lone.cmd("kill-pane", ["-t", pane.id]);
        expect(await waiting).toBeInstanceOf(ObjectNotFoundError);
        expect(await waiting).toMatchObject(gone);
        for (const later of [
          await pane.waitForText("never").catch((error: unknown) => error),
          await pane.waitForExit().catch((error: unknown) => error),
          await pane.waitForCommand().catch((error: unknown) => error),
        ]) {
          expect(later).toBeInstanceOf(ObjectNotFoundError);
          expect(later).toMatchObject(gone);
        }
      } finally {
        if (await lone.isAlive()) await lone.kill();
        await rm(directory, { force: true, recursive: true });
      }
    },
    40_000,
  );

  testWait(
    "a wait whose server dies during a read reports the pane gone",
    async () => {
      const directory = await makeTestDirectory("ltx-pane-wait-died-");
      const dieMidRead = async (kind: "Program.wait" | "waitForExit"): Promise<void> => {
        const lone = new Server({ configFile: "/dev/null", socketPath: join(directory, kind) });
        let paneId: string;
        let waiting: Promise<unknown>;
        if (kind === "waitForExit") {
          const pane = await paneRunning(lone, "only", "sleep 60");
          paneId = pane.id;
          waiting = pane.waitForExit({ timeoutMs: 20_000 }).catch((error: unknown) => error);
        } else {
          const program = await lone.spawn(["sleep", "60"], { orphanAfterMs: null });
          paneId = program.pane.id;
          waiting = program.wait({ timeoutMs: 20_000 }).catch((error: unknown) => error);
        }
        const [pid] = await lone.cmd("display-message", ["-p", "#{pid}"]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Stopped, the server leaves the wait's next read connected and waiting.
        process.kill(Number(pid), "SIGSTOP");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        process.kill(Number(pid), "SIGKILL");
        const error = await waiting;
        expect(error).toBeInstanceOf(ObjectNotFoundError);
        expect(error).toMatchObject({ message: `${paneId}: the pane is gone` });
      };
      try {
        await dieMidRead("waitForExit");
        await dieMidRead("Program.wait");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
    40_000,
  );

  testWait(
    "a command wait on a pane killed from outside is reported missing",
    async () => {
      await withServer(async (server) => {
        const pane = await paneRunning(server, "unmarked", "sleep 30");
        const waiting = pane.waitForCommand({ timeoutMs: 20_000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await server.cmd("kill-pane", ["-t", pane.id]);
        await expect(waiting).rejects.toBeInstanceOf(ObjectNotFoundError);
      });
    },
    40_000,
  );
  testWait(
    "a text wait wakes on the pane's output, well before its once-a-second read",
    async () => {
      await withServer(async (server) => {
        const pane = await paneRunning(server, "text", "sleep 0.4; echo 'first ready'; sleep 30");
        const started = performance.now();
        expect(await pane.waitForText("ready", { timeoutMs: 10_000 })).toBe("first ready");
        // The output came at 0.4 s; a read woken by it lands long before the 1 s read would.
        expect(performance.now() - started).toBeLessThan(900);
        expect(await pane.waitForText(/^first/u)).toBe("first ready");
        // Each later line wakes another read.
        await server.cmd("send-keys", ["-t", pane.id, "-l", "x"]);
        const counting = await paneRunning(
          server,
          "counting",
          "for n in 1 2 3 4 5 6 7 8; do echo line$n; sleep 0.1; done; sleep 30",
        );
        expect(await counting.waitForText("line8", { timeoutMs: 10_000 })).toBe("line8");
        // A line wider than the pane wraps on screen and still matches, and returns, whole.
        const wide = `${"a".repeat(30)}${"b".repeat(30)}tail`;
        const narrow = await server.newSession({
          name: "narrow",
          shellCommand: `printf '%s\\n' ${wide}; sleep 30`,
          width: 20,
        });
        const wrapped = narrow.activePane;
        if (wrapped === undefined) throw new Error("a new session has a pane");
        expect(await wrapped.waitForText(/a+b+tail/u, { timeoutMs: 10_000 })).toBe(wide);
      });
    },
    40_000,
  );

  testWait(
    "a text wait gives up, is cancelled, and stops at a dead pane",
    async () => {
      await withServer(async (server) => {
        const pane = await paneRunning(server, "quiet", "sleep 30");
        await expect(pane.waitForText("never", { timeoutMs: 300 })).rejects.toBeInstanceOf(
          WaitTimeoutError,
        );
        const cancelled = await pane
          .waitForText("never", { signal: AbortSignal.timeout(300) })
          .catch((error: unknown) => error);
        expect(cancelled).toBeInstanceOf(TmuxTransportError);
        expect(cancelled).toMatchObject({ delivery: "replied", kind: "cancelled" });
        const dying = await server.newSession({ name: "dying", shellCommand: "sleep 0.3" });
        await server.cmd("set-option", ["-w", "-t", "=dying:", "remain-on-exit", "on"]);
        const dead = dying.activePane;
        if (dead === undefined) throw new Error("a new session has a pane");
        await expect(dead.waitForText("never", { timeoutMs: 10_000 })).rejects.toBeInstanceOf(
          LibTmuxError,
        );
        // No waiter outlives the waits that armed it.
        const socket = server.socketPath ?? "";
        expect(socket).not.toBe("");
        const waiters = spawnSync("ps", ["-eo", "args="])
          .stdout.toString()
          .split("\n")
          .filter((args) => args.includes(socket) && args.includes("pane-activity"));
        expect(waiters).toEqual([]);
      });
    },
    40_000,
  );
});
