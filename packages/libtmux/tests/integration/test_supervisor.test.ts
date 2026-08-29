import { spawn } from "node:child_process";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  killIfRunning,
  processExists,
  waitForPathPresent,
  waitForProcessExit,
} from "../support/converge.js";
import {
  closeChild,
  exitChildWithin,
  readJsonMarker,
  type ClosedChild,
} from "../support/owned_child.js";

import {
  OWNER_RECORD_NAME,
  reapStaleRunRoot,
  runSupervisor,
} from "../../src/_internal/test/testkit.js";
import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

const tsRoot = fileURLToPath(new URL("../..", import.meta.url));
const workerPath = fileURLToPath(new URL("../fixtures/leaking_tmux_worker.ts", import.meta.url));
const supervisorPath = fileURLToPath(new URL("../../scripts/test_supervisor.ts", import.meta.url));
const reaperPath = fileURLToPath(new URL("../../scripts/reap-test-run.ts", import.meta.url));

describe("supervisor status and signal semantics", () => {
  async function runSupervisorCase(
    name: string,
    workerArgs: readonly string[],
    signal?: "SIGINT" | "SIGTERM",
  ): Promise<{ closed: ClosedChild; parent: string; root: string }> {
    const parent = await makeTestDirectory("ltx4-supervised-");
    const root = join(parent, name);
    const marker = join(parent, "ready.json");
    const child = spawn(
      "bun",
      [
        supervisorPath,
        "--run-root",
        root,
        "--grace-ms",
        "100",
        "--",
        "bun",
        workerPath,
        ...workerArgs,
        "--marker",
        marker,
      ],
      { cwd: tsRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (signal !== undefined) {
      await waitForPathPresent(marker);
      child.kill(signal);
    }
    return { closed: await closeChild(child), parent, root };
  }

  test("removes signal listeners when the supervised executable cannot spawn", async () => {
    const before = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- each completed failure is the baseline for the next listener count.
      const parent = await makeTestDirectory("ltx4-supervisor-spawn-error-");
      const root = join(parent, "root");
      try {
        // eslint-disable-next-line no-await-in-loop -- repeated failure proves listener cleanup is idempotent.
        await expect(
          runSupervisor({ command: [join(parent, "missing-executable")], runRoot: root }),
        ).rejects.toThrow();
      } finally {
        // eslint-disable-next-line no-await-in-loop -- exact-root cleanup must complete before the next attempt.
        await reapStaleRunRoot(root).catch(() => undefined);
        // eslint-disable-next-line no-await-in-loop -- parent cleanup must complete before the next attempt.
        await rm(parent, { force: true, recursive: true });
      }
    }
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
  });

  test("preserves status 7 when the child verifies owner-record cleanup failure", async () => {
    const result = await runSupervisorCase("owner-mode-primary", [
      "--mode",
      "owner-mode-exit",
      "--exit-code",
      "7",
    ]);
    try {
      const evidence = JSON.parse(await readFile(join(result.parent, "ready.json"), "utf8")) as {
        observedMode: number;
        ownerPath: string;
      };
      expect(evidence.observedMode).toBe(0o644);
      expect(result.closed.code).toBe(7);
      expect(result.closed.stderr).toContain("mode 0600");
    } finally {
      const ownerPath = join(result.root, OWNER_RECORD_NAME);
      await chmod(ownerPath, 0o600).catch(() => undefined);
      await reapStaleRunRoot(result.root).catch(() => undefined);
      await rm(result.parent, { force: true, recursive: true });
    }
  });

  test("preserves a normal child exit status", async () => {
    const result = await runSupervisorCase("exit-7", ["--mode", "exit", "--exit-code", "7"]);
    try {
      expect(result.closed.code).toBe(7);
      await expect(stat(result.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(result.parent, { force: true, recursive: true });
    }
  });

  test("preserves child signal termination", async () => {
    const result = await runSupervisorCase("child-signal", ["--mode", "self-sigterm"]);
    try {
      expect(result.closed.signal === "SIGTERM" || result.closed.code === 143).toBe(true);
    } finally {
      await rm(result.parent, { force: true, recursive: true });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`forwards ${signal}, escalates, reaps, and preserves interrupt status`, async () => {
      const result = await runSupervisorCase(
        `supervisor-${signal}`,
        ["--mode", "ignore-signals"],
        signal,
      );
      try {
        const expected = signal === "SIGINT" ? 130 : 143;
        expect(result.closed.signal === signal || result.closed.code === expected).toBe(true);
        await expect(stat(result.root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(result.parent, { force: true, recursive: true });
      }
    }, 30_000);
  }

  test("standalone reaper cleans only after a SIGKILLed supervisor owner is dead", async () => {
    const parent = await makeTestDirectory("ltx4-dead-supervisor-");
    const root = join(parent, "root");
    const marker = join(parent, "ready.json");
    const supervisor = spawn(
      "bun",
      [
        supervisorPath,
        "--run-root",
        root,
        "--grace-ms",
        "50",
        "--",
        "bun",
        workerPath,
        "--mode",
        "hold",
        "--marker",
        marker,
      ],
      { cwd: tsRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let workerPid: number | undefined;
    try {
      await waitForPathPresent(marker);
      const state = await readJsonMarker<{ daemonPid: number; workerPid: number }>(marker);
      workerPid = state.workerPid;
      supervisor.kill("SIGKILL");
      await exitChildWithin(supervisor, 2_000);
      expect(processExists(state.daemonPid)).toBe(true);
      const reaper = spawn("bun", [reaperPath, "--run-root", root], {
        cwd: tsRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect((await closeChild(reaper)).code).toBe(0);
      await waitForProcessExit(state.daemonPid);
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      killIfRunning(state.workerPid);
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGKILL");
      }
      if (workerPid !== undefined) killIfRunning(workerPid);
      await reapStaleRunRoot(root).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  }, 30_000);

  test("progresses after SIGKILL when a descendant keeps the child pipes open", async () => {
    const parent = await makeTestDirectory("ltx4-hard-close-");
    const root = join(parent, "root");
    const marker = join(parent, "ready.json");
    const supervisor = spawn(
      "bun",
      [
        supervisorPath,
        "--run-root",
        root,
        "--grace-ms",
        "50",
        "--",
        "bun",
        workerPath,
        "--mode",
        "inherited-pipe",
        "--marker",
        marker,
      ],
      { cwd: tsRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const supervisorClosed = closeChild(supervisor);
    let holderPid: number | undefined;
    try {
      await waitForPathPresent(marker);
      holderPid = (await readJsonMarker<{ holderPid: number }>(marker)).holderPid;
      supervisor.kill("SIGTERM");
      const result = await exitChildWithin(supervisor, 2_000);
      expect(result.signal === "SIGTERM" || result.code === 143).toBe(true);
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGKILL");
        await supervisorClosed.catch(() => undefined);
      }
      if (holderPid !== undefined) killIfRunning(holderPid);
      await supervisorClosed.catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
    // The budget covers two `bun` startups before the part being measured even
    // begins, so it is a liveness bound and not the assertion. What this test
    // actually claims — that a SIGKILLed supervisor makes progress despite a
    // descendant holding the pipes — is the two-second bound above.
  }, 30_000);

  for (const exitCode of [0, 23]) {
    test(`cleanup failure ${exitCode === 0 ? "fails success" : "does not replace failure"}`, async () => {
      const result = await runSupervisorCase(`cleanup-${exitCode}`, [
        "--mode",
        "corrupt-record-exit",
        "--exit-code",
        String(exitCode),
      ]);
      try {
        expect(result.closed.code).toBe(exitCode === 0 ? 1 : exitCode);
        const backup = JSON.parse(await readFile(join(result.parent, "ready.json"), "utf8")) as {
          recordPath: string;
          recordText: string;
        };
        await chmod(dirname(backup.recordPath), 0o700);
        await writeFile(backup.recordPath, backup.recordText);
        expect((await reapStaleRunRoot(result.root)).leaks).toEqual([]);
      } finally {
        await rm(result.parent, { force: true, recursive: true });
      }
    }, 30_000);
  }
});
