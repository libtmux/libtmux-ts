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
const testMarked = supported && Bun.which("bash") !== null ? test : test.skip;

describe("pane waits", () => {
  test("refuse below tmux 3.8", async () => {
    await withServer(async (server) => {
      if (supported) return;
      const pane = await paneRunning(server, "old", "sleep 30");
      await expect(pane.waitForExit()).rejects.toBeInstanceOf(VersionTooLowError);
      await expect(pane.waitForCommand()).rejects.toBeInstanceOf(VersionTooLowError);
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
      });
    },
    40_000,
  );

  testWait(
    "a pane killed from outside, which fires no event, is reported missing",
    async () => {
      await withServer(async (server) => {
        const pane = await paneRunning(server, "killed", "sleep 30");
        const waiting = pane.waitForExit({ timeoutMs: 20_000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await server.cmd("kill-pane", ["-t", pane.id]);
        await expect(waiting).rejects.toBeInstanceOf(ObjectNotFoundError);
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
});
