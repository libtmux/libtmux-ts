import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assertSandboxed,
  makeTestDirectory,
  tmuxSocketFor,
} from "../../src/_internal/test/testkit.js";
import { Server } from "../../src/server.js";
import { parseCalls, RECORDING_TMUX } from "../support/recording_tmux.js";

/**
 * What the harness left in this process; `sandbox_control.test.ts` reruns it without the harness.
 * The real-client cases start a real tmux server, only once the process is shown sandboxed.
 */

let directory = "";

/**
 * Where the server a bare `tmux` client starts reports its socket, asked of tmux rather than
 * computed; the server is stopped by that socket before this returns.
 */
function whereABareClientLands(environment: Record<string, string | undefined>): string {
  const started = spawnSync(
    "tmux",
    ["-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{socket_path}", "sleep 600"],
    { encoding: "utf8", env: environment },
  );
  const socket = started.stdout.trim();
  if (socket !== "") spawnSync("tmux", ["-S", socket, "kill-server"], { env: environment });
  expect(started.status).toBe(0);
  return realpathSync(socket);
}

beforeAll(async () => {
  directory = await makeTestDirectory("ltx-canary-");
  await writeFile(join(directory, "tmux"), RECORDING_TMUX);
  await chmod(join(directory, "tmux"), 0o755);
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("sandbox canary", () => {
  test("no variable that names another server survives", () => {
    const set = ["TMUX", "TMUX_PANE", "LIBTMUX_SOCKET", "LIBTMUX_SOCKET_PATH"].filter(
      (name) => process.env[name] !== undefined,
    );
    expect(set).toEqual([]);
  });

  test("the process is in an owner-only sandbox that TMUX_TMPDIR names", () => {
    expect(process.env["TMUX_TMPDIR"] === assertSandboxed()).toBe(true);
  });

  test("a server built with no socket reaches the default socket inside the sandbox", async () => {
    await new Server({ tmuxBin: join(directory, "tmux") }).cmd("list-sessions").catch(() => {});

    const calls = parseCalls(await readFile(join(directory, "trace"), "utf8"));
    expect(calls.length).toBeGreaterThan(0);
    for (const { argv, set, tmpdirIsSandbox } of calls) {
      expect(argv.some((argument) => /^-[LS]/u.test(argument))).toBe(false);
      expect(set).toEqual(["TMUX_TMPDIR"]);
      expect(tmpdirIsSandbox).toBe(true);
    }
  });

  test("a real bare tmux client starts its server on the default socket inside the sandbox", () => {
    // Refuses first, so a process outside the sandbox never starts a server.
    const root = assertSandboxed();
    const expected = join(realpathSync(root), `tmux-${String(process.getuid?.() ?? 0)}`, "default");

    expect(whereABareClientLands(process.env) === expected).toBe(true);
  });

  test("the same client lands elsewhere when TMUX_TMPDIR is not the sandbox", async () => {
    const root = assertSandboxed();
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    const environment = { ...process.env, TMUX_TMPDIR: elsewhere };
    const expected = join(realpathSync(root), `tmux-${String(process.getuid?.() ?? 0)}`, "default");

    expect(tmuxSocketFor(environment) === tmuxSocketFor(process.env)).toBe(false);
    expect(whereABareClientLands(environment) === expected).toBe(false);
  });
});
