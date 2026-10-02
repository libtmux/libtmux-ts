import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { Pane } from "../../src/pane.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { PaneRunTimeoutError } from "../../src/errors.js";
import { Server } from "../../src/server.js";

/** Whether this machine has a shell, looked up the way `sh` would, on every runtime. */
function hasShell(name: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-paneio-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "paneio" });
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

/** Poll a pane until its contents satisfy a predicate or the deadline passes. */
async function captureUntil(
  pane: Pane,
  matches: (lines: readonly string[]) => boolean,
  attempts = 100,
): Promise<readonly string[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- Polling is inherently sequential.
    const lines = await pane.capture();
    if (matches(lines)) return lines;
    // eslint-disable-next-line no-await-in-loop -- Each wait follows the capture before it.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pane never reached the expected contents");
}

describe("pane input and capture", () => {
  test("sends literal text and captures it back", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      await pane.sendKeys("libtmux-marker", { literal: true });
      const lines = await captureUntil(pane, (captured) =>
        captured.some((line) => line.includes("libtmux-marker")),
      );

      expect(lines.some((line) => line.includes("libtmux-marker"))).toBe(true);
    });
  }, 40_000);

  test("guards keys starting with a dash from being read as tmux's own flags", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      // `-R` is send-keys's own terminal-reset flag; without the guard
      // nothing would be typed and the pane's saved state would be reset
      // instead of these two characters reaching the shell.
      await pane.sendKeys("-R", { enter: false });
      const lines = await captureUntil(pane, (captured) =>
        captured.some((line) => line.includes("-R")),
      );

      expect(lines.some((line) => line.includes("-R"))).toBe(true);
    });
  }, 40_000);

  test("leaves copy mode on the keys, and delivers Enter to the pane after it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      // vi mode-keys binds `q` to cancel, which is what makes the second key
      // resolve against a pane that is no longer in a mode.
      await server.setGlobalOption("window", "mode-keys", "vi");
      const pane = (await server.snapshot()).panes.one();
      // A shell this test controls, so the Enter that follows the keys has
      // something that answers it.
      await pane.respawn("sh", { kill: true });

      await pane.enterCopyMode();
      expect((await pane.refreshed()).format.pane_in_mode).toBe("1");

      // One `send-keys` carrying both would resolve Enter as a copy-mode
      // binding against the mode `q` had just cancelled, and tmux would answer
      // `not in a mode`.
      await pane.sendKeys("q");
      expect((await pane.refreshed()).format.pane_in_mode).toBe("0");

      // The Enter after the keys has to reach the pane, which it only does
      // when tmux resolves it as its own command rather than as a binding for
      // the mode the key before it just cancelled.
      await pane.sendKeys("echo after-copy-mode");
      await captureUntil(
        await pane.refreshed(),
        (lines) => lines.some((line) => line.trim() === "after-copy-mode"),
        400,
      );
    });
  }, 40_000);

  test("capture returns lines without a trailing blank", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      const lines = await pane.capture();

      expect(Array.isArray(lines)).toBe(true);
      expect(lines.at(-1)).not.toBe("");
    });
  }, 40_000);

  test("honours an explicit start line", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      const visible = await pane.capture({ start: 0 });
      const withHistory = await pane.capture({ start: -50 });

      expect(withHistory.length).toBeGreaterThanOrEqual(visible.length);
    });
  }, 40_000);

  test("keeps the escape sequences that style the text when asked", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();
      const escape = String.fromCharCode(27);

      await pane.sendKeys(`printf '${escape}[31mred-marker${escape}[0m\\n'`);
      await captureUntil(pane, (captured) => captured.some((line) => line.includes("red-marker")));

      const plain = (await pane.capture()).join("\n");
      const styled = (await pane.capture({ escapeSequences: true })).join("\n");

      // The characters are in both; only one carries what a terminal would
      // render them with, which is the difference the flag is for.
      expect(plain).toContain("red-marker");
      expect(styled).toContain("red-marker");
      expect(plain).not.toContain(escape);
      expect(styled).toContain(escape);
    });
  }, 40_000);

  test("answers tmux's own reason for a pane with no alternate screen", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      // A shell is not a full-screen program, so there is nothing to capture
      // and tmux says so rather than returning the ordinary screen.
      await expect(pane.capture({ alternateScreen: true })).rejects.toThrow(/alternate screen/u);
    });
  }, 40_000);

  test("clears scrollback history without disturbing the visible pane", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      await pane.sendKeys("history-marker", { literal: true });
      await captureUntil(pane, (captured) =>
        captured.some((line) => line.includes("history-marker")),
      );

      await pane.clearHistory();

      // clear-history drops scrollback, so the deep capture collapses toward
      // the visible region rather than erroring.
      const afterClear = await pane.capture({ start: -50 });
      expect(afterClear.length).toBeGreaterThan(0);
    });
  }, 40_000);

  test("guards a pipe-pane command starting with a dash", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      // `-h` is none of pipe-pane's own flags (`-I`, `-O`, `-o`, `-t`).
      // pipe-pane returns as soon as the job is spawned rather than waiting
      // on it, so this only needs to show a pipe was accepted at all: without
      // the guard the whole argument is refused before that happens, and the
      // call below rejects instead of resolving.
      await expect(pane.pipeTo("-h")).resolves.toBeUndefined();
      await pane.pipeTo();
    });
  }, 15_000);

  // The fixture's own pane runs `cat`, which is not a shell prompt. Each of
  // these shells reads the typed line differently (dash has no `history`, zsh
  // needs a plain `eval`, bash a `command eval`), so the mechanism is shown on
  // every one this machine has.
  for (const shell of ["sh", "bash", "zsh"]) {
    if (!hasShell(shell)) continue;

    test(`runs a command in a ${shell} pane and reports status and output`, async () => {
      await withServer(async (fixture) => {
        const base = (await serverFor(fixture).snapshot()).panes.one();
        const pane = await base.split({ shellCommand: shell });

        const ok = await pane.run("echo hello; echo there");
        expect(ok.exitCode).toBe(0);
        expect(ok.stdout).toEqual(["hello", "there"]);
        expect(ok.truncated).toBe(false);

        // A nonzero status is a result, and the shell's own.
        const failed = await pane.run("sh -c 'echo oops; exit 3'");
        expect(failed.exitCode).toBe(3);
        expect(failed.stdout).toEqual(["oops"]);

        // Typed raw, an open quote would leave the line unfinished and the wait
        // blocked: the command goes through `eval` on a quoted string instead.
        expect((await pane.run('echo "unterminated')).exitCode).not.toBe(0);

        // The command runs in the pane's own shell, so state carries over.
        await pane.run("LT_RUN_STATE=kept");
        expect((await pane.run('echo "$LT_RUN_STATE"')).stdout).toEqual(["kept"]);
      });
    }, 60_000);
  }

  test("bounds a command that keeps running and returns what it printed", async () => {
    await withServer(async (fixture) => {
      const base = (await serverFor(fixture).snapshot()).panes.one();
      // bash abandons the rest of a typed line on C-c unless the line traps INT.
      const pane = await base.split({ shellCommand: hasShell("bash") ? "bash" : "sh" });

      const failure = await pane.run("echo before; sleep 30", { timeoutMs: 1_500 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PaneRunTimeoutError);
      const timeout = failure as PaneRunTimeoutError;
      expect(timeout.started).toBe(true);
      expect(timeout.stdout).toEqual(["before"]);

      await pane.sendKeys("C-c", { enter: false });
      expect((await pane.run("echo recovered")).stdout).toEqual(["recovered"]);
    });
  }, 60_000);

  test("reports an interrupted command as status 130 rather than losing the line", async () => {
    await withServer(async (fixture) => {
      const base = (await serverFor(fixture).snapshot()).panes.one();
      const pane = await base.split({ shellCommand: hasShell("bash") ? "bash" : "sh" });

      const running = pane.run("sleep 30", { timeoutMs: 20_000 });
      // C-c only reaches the command once the shell is running it.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- Polling is inherently sequential.
        const command = (await pane.refreshed()).format.pane_current_command;
        if (command === "sleep") break;
        // eslint-disable-next-line no-await-in-loop -- Each poll follows the wait before it.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await pane.sendKeys("C-c", { enter: false });

      // Without `trap : INT` the shell abandons the typed line, nothing reports
      // back, and this waits out its whole deadline.
      const result = await running;
      expect(result.exitCode).toBe(130);
    });
  }, 60_000);
});
