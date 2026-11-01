import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, test } from "bun:test";

import {
  deadlineMs,
  enterSandbox,
  readProcessIdentity,
  tmuxSocketFor,
} from "../../src/_internal/test/testkit.js";
import { runToEnd } from "../support/run_to_end.js";

const uid = String(process.getuid?.() ?? 0);

/** Start a detached server with `socketArguments`; its pid, from the server itself. */
async function startServer(
  environment: Record<string, string | undefined>,
  socketArguments: readonly string[],
): Promise<number> {
  const started = await runToEnd(
    "tmux",
    [...socketArguments, "-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pid}", "sleep 600"],
    environment,
  );
  expect(started.status).toBe(0);
  return Number(started.stdout.trim());
}

async function goneWithin(pid: number): Promise<boolean> {
  const deadline = performance.now() + deadlineMs(5_000);
  let alive = true;
  while (alive && performance.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling one process until it is gone.
    alive = (await readProcessIdentity(pid)) !== undefined;
    // eslint-disable-next-line no-await-in-loop -- as above.
    if (alive) await sleep(10);
  }
  return !alive;
}

describe("leaving the sandbox", () => {
  test("stops a server that took the default socket, fails, and removes the directory", async () => {
    const environment: Record<string, string | undefined> = {
      HOME: process.env["HOME"],
      PATH: process.env["PATH"],
    };
    const sandbox = await enterSandbox(environment);
    try {
      // No -L and no -S: the socket is whatever the sandbox makes the default.
      const pid = await startServer(environment, []);
      expect(existsSync(tmuxSocketFor(environment))).toBe(true);
      expect(await readProcessIdentity(pid)).toBeDefined();

      await expect(sandbox.release()).rejects.toThrow(
        `a server was left running on the sandbox's "tmux-${uid}/default" socket and had to be stopped`,
      );

      expect(await goneWithin(pid)).toBe(true);
      expect(existsSync(sandbox.root)).toBe(false);
    } finally {
      await sandbox.release().catch(() => undefined);
    }
  });

  test("stops a server on a socket of its own choosing inside the sandbox", async () => {
    const environment: Record<string, string | undefined> = {
      HOME: process.env["HOME"],
      PATH: process.env["PATH"],
    };
    const sandbox = await enterSandbox(environment);
    try {
      const pid = await startServer(environment, ["-S", join(sandbox.root, "custom.sock")]);
      expect(await readProcessIdentity(pid)).toBeDefined();

      await expect(sandbox.release()).rejects.toThrow(
        `a server was left running on the sandbox's "custom.sock" socket and had to be stopped`,
      );

      expect(await goneWithin(pid)).toBe(true);
      expect(existsSync(sandbox.root)).toBe(false);
    } finally {
      await sandbox.release().catch(() => undefined);
    }
  });
});
