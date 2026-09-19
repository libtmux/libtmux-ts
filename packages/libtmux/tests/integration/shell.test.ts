import { existsSync } from "node:fs";
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

import { safeInteger } from "../../src/common.js";
import { TmuxCommandError, TmuxTransportError } from "../../src/errors.js";
import { Server } from "../../src/server.js";
import { Session } from "../../src/session.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-shell-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "shell" });
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

describe("shell execution and pane movement", () => {
  test("runs a shell command, returning its output where tmux reports it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const output = await server.runShell("echo libtmux-run");

      // tmux 3.3a suppressed run-shell output for an invocation with no client
      // — a script's, for instance — and later versions restored it. Probing
      // beats encoding a version range: the same command decides, so a tmux
      // that reports output is still held to reporting the right output.
      const reportsOutput = (await server.runShell("echo libtmux-probe")).join("").length > 0;
      if (reportsOutput) expect(output.join("\n")).toContain("libtmux-run");
      else expect(output).toEqual([]);
    });
  }, 40_000);

  // `runShell` forwards `options.signal` and `options.timeoutMs` to
  // `runCommand`. `server.cmd("run-shell", ...)` with the identical
  // `timeoutMs` is the control proving 300ms is reachable on this machine.
  test("runShell honours its own timeoutMs and signal", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      const control = await server
        .cmd("run-shell", ["sleep 5"], { timeoutMs: 300 })
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect(control).toBeInstanceOf(TmuxTransportError);
      expect((control as TmuxTransportError).kind).toBe("timeout");

      const timedOut = await server
        .runShell("sleep 5", { timeoutMs: 300 })
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect(timedOut).toBeInstanceOf(TmuxTransportError);
      expect((timedOut as TmuxTransportError).kind).toBe("timeout");

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const aborted = await server
        .runShell("sleep 5", { signal: controller.signal })
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect(aborted).toBeInstanceOf(TmuxTransportError);

      // `abort(reason)` is how a caller says why. A refusal that replaced it
      // with a generic message put their own error out of reach, and the
      // README's cancellation example catches the rejection expecting it.
      const mine = new Error("caller gave up");
      const explained = new AbortController();
      setTimeout(() => explained.abort(mine), 300);
      const reasoned = await server
        .runShell("sleep 5", { signal: explained.signal })
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect((reasoned as TmuxTransportError).kind).toBe("cancelled");
      expect((reasoned as { cause?: unknown }).cause).toBe(mine);
    });
  }, 15_000);

  // The tmux server owns and runs `run-shell` itself, so a client-side
  // timeout ends this call's own wait, not the command tmux dispatched.
  test("a timed-out runShell leaves the server-side command running", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const directory = await makeTestDirectory("ltx-shell-marker-");
      const marker = join(directory, "done");

      const timedOut = await server
        .runShell(`sleep 1; touch ${marker}`, { timeoutMs: 100 })
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect(timedOut).toBeInstanceOf(TmuxTransportError);

      // The call already threw; the server's own child keeps running and
      // finishes on its own schedule, well after this call gave up on it.
      expect(existsSync(marker)).toBe(false);
      for (let waited = 0; !existsSync(marker) && waited < 5_000; waited += 50) {
        // eslint-disable-next-line no-await-in-loop -- polling for the marker is sequential by nature.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(marker)).toBe(true);

      await rm(directory, { force: true, recursive: true });
    });
  }, 15_000);

  test("expands a tmux format through display-message", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();

      const expanded = await pane.displayMessage("#{pane_id}");

      expect(expanded[0]).toBe(pane.id);
    });
  }, 40_000);

  test("guards a display-message value starting with a dash", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();

      // `-a` is display-message's own flag to list every variable; without
      // the guard this returns many lines instead of the one literal value.
      const expanded = await pane.displayMessage("-a");

      expect(expanded).toEqual(["-a"]);
    });
  }, 40_000);

  test("takes the else branch when an if-shell condition fails", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      await server.ifShell("false", "set-option -s history-file /tmp/ltx-then", {
        otherwise: "set-option -s history-file /tmp/ltx-else",
      });

      expect((await server.showOptions()).get("history-file")).toBe("/tmp/ltx-else");
    });
  }, 40_000);

  test("guards an if-shell condition starting with a dash", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // `-e` is none of if-shell's own flags (`-b`, `-F`, `-t`); without the
      // guard it would be refused as one before the condition ever ran.
      await server.ifShell("-e", "set-option -s history-file /tmp/ltx-then-dash", {
        otherwise: "set-option -s history-file /tmp/ltx-else-dash",
      });

      expect((await server.showOptions()).get("history-file")).toBe("/tmp/ltx-else-dash");
    });
  }, 40_000);

  test("guards a run-shell command starting with a dash", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // `-e` is none of run-shell's own flags (`-b`, `-t`, `-C`, `-d`).
      // `-e` is not a program either, so the job itself still fails either
      // way — what the guard changes is whether a job runs at all. Without
      // it, tmux's own parser refuses the whole argument before any job
      // exists, reporting an "unknown option" (libc getopt, 3.2a) or
      // "unknown flag" (`args_parse`, 3.3+) error of its own; with it, tmux
      // launches the job and reports only the job's own exit, on its own
      // stdout — some releases suppress that report with no client attached,
      // so this checks for the absence of a parser refusal rather than for
      // the report's presence.
      const failure = await server
        .runShell("-e")
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect(failure).toBeInstanceOf(TmuxCommandError);
      expect((failure as TmuxCommandError).stderrIncludes("unknown")).toBe(false);
    });
  }, 15_000);

  test("breaks a pane out into its own window", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const window = (await server.snapshot()).windows.one();
      const created = await window.split();

      await created.breakOut("broken-out");

      const after = await server.snapshot();
      expect(after.windows.count({ name: "broken-out" })).toBe(1);
      expect(after.panes.count({ window: { is: { name: "broken-out" } } })).toBe(1);
    });
  }, 40_000);

  test("joins a pane back into another window", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();
      const target = await session.newWindow({ name: "target" });
      const source = await session.newWindow({ name: "source" });
      const pane = source.panes.one();

      await pane.joinTo(target.id);

      const after = await server.snapshot();
      expect(after.panes.count({ window: { is: { name: "target" } } })).toBe(2);
    });
  }, 40_000);

  test("resolves the current session from the tmux environment", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();
      const socketPath = fixture.socketPath;

      const session = await Session.fromEnv({
        ...fixture.controllerEnvironment,
        TMUX: `${socketPath},1,0`,
        TMUX_PANE: pane.id,
      });

      const paneSession = pane.session;
      if (paneSession === undefined) throw new Error("expected the pane to resolve its session");
      expect(session.id).toBe(paneSession.id);
      expect(session.name).toBe(fixture.sessionName);
    });
  }, 40_000);

  test("enters and leaves copy mode", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();

      await pane.enterCopyMode();
      expect((await pane.refreshed()).inMode).toBe(safeInteger(1));

      await pane.exitCopyMode();
      expect((await pane.refreshed()).inMode).toBe(safeInteger(0));
    });
  }, 40_000);

  test("reports a tmux failure as structured fields, not a formatted string", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();

      const error = await pane
        .sendKeys("x", { enter: false })
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeUndefined();

      const failure = await server
        .setOption("definitely-not-an-option", "1")
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);

      expect(failure).toBeInstanceOf(TmuxCommandError);
      const typed = failure as TmuxCommandError;
      expect(typed.args[0]).toBe("set-option");
      expect(typed.exitCode).not.toBe(0);
      expect(typed.stderr.length).toBeGreaterThan(0);
      expect(typed.stderrIncludes("definitely-not-an-option")).toBe(true);
      // The parts stay addressable instead of being baked into the message.
      expect(Object.isFrozen(typed.stderr)).toBe(true);
    });
  }, 40_000);

  test("carries the addressed target on a failing command", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      const pane = (await server.snapshot()).panes.one();
      await pane.kill();

      const failure = await pane
        .capture()
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);

      expect(failure).toBeInstanceOf(TmuxCommandError);
      expect((failure as TmuxCommandError).target).toBe(pane.id);
    });
  }, 40_000);

  test("detaches every client attached to a session, which tmux spells with -s", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      try {
        expect((await server.snapshot()).clients.count()).toBeGreaterThan(0);

        // tmux reads `-t` as a client name and `-s` as a session, so a session
        // id passed as `-t` is not a subtly wrong target — it is no target at
        // all, and tmux answers `can't find client: $0`.
        const session = (await server.snapshot()).sessions.one({ name: "shell" });
        await session.detach();

        expect((await server.snapshot()).clients.count()).toBe(0);
      } finally {
        await live.close().catch(() => undefined);
      }
    });
  }, 40_000);
});
