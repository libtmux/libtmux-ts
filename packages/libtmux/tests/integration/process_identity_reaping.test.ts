import { lstat, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  killIfRunning,
  processExists,
  waitForPathAbsent,
  waitForProcessExit,
} from "../support/converge.js";
import { journalIdentity } from "../support/fixture_evidence.js";
import { createIsolatedRunRoot, removeIsolatedRunRoot } from "../support/run_root_harness.js";
import {
  captureTmuxCleanup,
  terminateCapturedTmux,
  type CapturedTmuxCleanup,
} from "../support/tmux_cleanup.js";

import {
  parseProcStatStartTime,
  readDaemonIdentity,
  reapOwnedRunRoot,
  validateOwnedRecordMetadata,
  type FixtureRecord,
  TestServer,
} from "../../src/_internal/test/testkit.js";

describe("process identity", () => {
  test("parses field 22 after the final parenthesis without numeric coercion", () => {
    const line =
      "91 (tmux: odd ) server) S " +
      Array.from({ length: 18 }, (_, i) => `${i + 1}`).join(" ") +
      " 18446744073709551614 99";
    expect(parseProcStatStartTime(line)).toBe("18446744073709551614");
  });

  test("rejects record metadata owned by a different uid", () => {
    expect(() =>
      validateOwnedRecordMetadata(
        { isRegularFile: true, mode: 0o600, uid: 4242 },
        "fixture identity record",
        1000,
      ),
    ).toThrow("wrong uid");
  });
});

describe("identity-safe inaccessible-socket fallback", () => {
  test("refuses pidfd signaling when the durable launch generation changes", async () => {
    const { parent, root } = await createIsolatedRunRoot("pidfd-generation-mismatch");
    const server = await TestServer.create({ runRoot: root });
    const original = await readFile(server.recordPath, "utf8");
    const record = JSON.parse(original) as {
      generation?: { name: string; value: string };
    };
    const recoverySocket = join(parent, "pidfd-generation-recovery.sock");
    let captured: CapturedTmuxCleanup | undefined;
    let evidenceError: unknown;
    let mutatedRecord: string | undefined;
    let mutatedRecordEntry: ReturnType<typeof journalIdentity> | undefined;
    try {
      captured = await captureTmuxCleanup(
        server.daemonIdentity.pid,
        server.socketPath,
        recoverySocket,
      );
      if (record.generation === undefined) {
        throw new Error("running fixture lacks a durable launch generation");
      }
      const daemonBefore = await readDaemonIdentity(server.daemonIdentity.pid);
      expect(daemonBefore).toEqual(captured.daemon);
      await unlink(server.socketPath);
      mutatedRecord = `${JSON.stringify({
        ...JSON.parse(original),
        generation: {
          ...record.generation,
          value: "11111111-1111-4111-8111-111111111111",
        },
      })}\n`;
      await writeFile(server.recordPath, mutatedRecord, { mode: 0o600 });
      mutatedRecordEntry = journalIdentity(await lstat(server.recordPath));
      await expect(server.dispose()).rejects.toThrow(/generation/u);
      expect(await readDaemonIdentity(server.daemonIdentity.pid)).toEqual(daemonBefore);
      expect(await readFile(server.recordPath, "utf8")).toBe(mutatedRecord);
      expect(journalIdentity(await lstat(server.recordPath))).toEqual(mutatedRecordEntry);
      expect((await stat(server.reservationPath)).isDirectory()).toBe(true);
    } finally {
      if (mutatedRecord !== undefined && mutatedRecordEntry !== undefined) {
        try {
          expect(await readFile(server.recordPath, "utf8")).toBe(mutatedRecord);
          expect(journalIdentity(await lstat(server.recordPath))).toEqual(mutatedRecordEntry);
          await writeFile(server.recordPath, original, { mode: 0o600 });
          expect(journalIdentity(await lstat(server.recordPath))).toEqual(mutatedRecordEntry);
        } catch (error) {
          evidenceError = error;
        }
      }
      if (captured !== undefined) {
        await terminateCapturedTmux(captured);
        expect(await readDaemonIdentity(server.daemonIdentity.pid)).toBeUndefined();
      }
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks).toEqual([]);
      expect(report.rootRemoved).toBe(true);
      await waitForPathAbsent(root);
      if (captured !== undefined) {
        const recovery = await lstat(recoverySocket, { bigint: true });
        expect({ device: recovery.dev, inode: recovery.ino }).toEqual(captured.socketIdentity);
        await unlink(recoverySocket);
      }
      await rmdir(parent);
    }
    if (evidenceError !== undefined) throw evidenceError;
  });

  test("signals through a matching pidfd identity", async () => {
    const { parent, root } = await createIsolatedRunRoot("pidfd-match");
    const server = await TestServer.create({ runRoot: root });
    const daemonPid = server.daemonIdentity.pid;
    try {
      await unlink(server.socketPath);
      await server.dispose();
      await waitForProcessExit(daemonPid);
    } finally {
      await removeIsolatedRunRoot(parent, root);
    }
  });

  for (const corruption of ["mismatch", "missing", "corrupt"] as const) {
    test(`does not signal an inaccessible daemon with ${corruption} identity`, async () => {
      const { parent, root } = await createIsolatedRunRoot(`pidfd-${corruption}`);
      const server = await TestServer.create({ runRoot: root });
      const recordPath = server.recordPath;
      const original = await readFile(recordPath, "utf8");
      const record = JSON.parse(original) as FixtureRecord;
      if (record.phase !== "running") throw new Error("fixture did not publish running authority");
      try {
        await unlink(server.socketPath);
        if (corruption === "mismatch") {
          await writeFile(
            recordPath,
            `${JSON.stringify({
              ...record,
              daemon: {
                ...record.daemon,
                startIdentity: "linux:00000000-0000-4000-8000-000000000000:1",
              },
            })}\n`,
          );
        } else if (corruption === "missing") {
          await writeFile(recordPath, `${JSON.stringify({ ...record, daemon: undefined })}\n`);
        } else {
          await writeFile(recordPath, "{broken\n");
        }

        await expect(server.dispose()).rejects.toThrow();
        expect(processExists(server.daemonIdentity.pid)).toBe(true);
      } finally {
        await writeFile(recordPath, original);
        await reapOwnedRunRoot(root);
        await removeIsolatedRunRoot(parent, root);
      }
    });
  }

  test("bounds and reaps a pidfd helper that ignores TERM and keeps pipes open", async () => {
    const { parent, root } = await createIsolatedRunRoot("hanging-pidfd-helper");
    const helper = join(parent, "hanging-python");
    const helperMarker = join(parent, "helper.pid");
    await writeFile(
      helper,
      `#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(process.env.LIBTMUX_HELPER_MARKER,String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);\n`,
      { mode: 0o700 },
    );
    const server = await TestServer.create({
      environment: {
        ...process.env,
        LIBTMUX_HELPER_MARKER: helperMarker,
        LIBTMUX_TEST_PYTHON: helper,
      },
      runRoot: root,
    });
    let cleanup: Promise<void> | undefined;
    try {
      await unlink(server.socketPath);
      cleanup = server.dispose();
      const outcome = await Promise.race([
        cleanup.then(
          () => ({ kind: "done" as const }),
          (error: unknown) => ({ error, kind: "error" as const }),
        ),
        // Bounded for liveness: what is asserted is that disposal returns at
        // all when a helper ignores TERM and holds the pipes, and a disposal
        // that never returns fails this at any size.
        new Promise<{ kind: "deadline" }>((resolve) =>
          setTimeout(() => resolve({ kind: "deadline" }), 30_000),
        ),
      ]);
      expect(outcome.kind).not.toBe("deadline");
      expect(outcome.kind).toBe("error");
    } finally {
      try {
        const helperPid = Number.parseInt(await readFile(helperMarker, "utf8"), 10);
        killIfRunning(helperPid);
      } catch {
        // A helper that never spawned has nothing to reap.
      }
      await cleanup?.catch(() => undefined);
      await reapOwnedRunRoot(root).catch(() => undefined);
      await removeIsolatedRunRoot(parent, root);
    }
  }, 60_000);
});
