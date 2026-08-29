import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { processExists, waitForPathAbsent } from "../support/converge.js";
import { journalIdentity } from "../support/fixture_evidence.js";
import { createIsolatedRunRoot, removeIsolatedRunRoot } from "../support/run_root_harness.js";
import {
  captureTmuxCleanup,
  launchExactTmux,
  terminateCapturedTmux,
  type CapturedTmuxCleanup,
} from "../support/tmux_cleanup.js";

import {
  OWNER_RECORD_NAME,
  prepareRunRoot,
  reapOwnedRunRoot,
  reapStaleRunRoot,
  type FixtureRecord,
  readDaemonIdentity,
  readProcessIdentity,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

describe("run-root recovery", () => {
  test("enumerates only the exact run root", async () => {
    const { parent, root } = await createIsolatedRunRoot("exact");
    const sibling = join(parent, "exact-sibling");
    await mkdir(sibling, { mode: 0o700 });
    await writeFile(join(sibling, "sentinel"), "keep");
    try {
      expect((await reapOwnedRunRoot(root)).leaks).toEqual([]);
      expect(await readFile(join(sibling, "sentinel"), "utf8")).toBe("keep");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("refuses broad, relative, missing-magic, and symlink run roots", async () => {
    const parent = await makeTestDirectory("ltx4-root-guard-");
    const ordinary = join(parent, "ordinary");
    const linked = join(parent, "linked");
    await mkdir(ordinary, { mode: 0o700 });
    await writeFile(join(ordinary, "sentinel"), "keep");
    await symlink(ordinary, linked);
    try {
      await expect(reapOwnedRunRoot("relative-root")).rejects.toThrow("absolute");
      await expect(reapOwnedRunRoot("/")).rejects.toThrow("unsafe run root");
      await expect(reapOwnedRunRoot(tmpdir())).rejects.toThrow("unsafe run root");
      await expect(reapOwnedRunRoot(ordinary)).rejects.toThrow("owner record");
      await expect(reapOwnedRunRoot(linked)).rejects.toThrow("symlink");
      expect(await readFile(join(ordinary, "sentinel"), "utf8")).toBe("keep");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("rejects a canonical-looking root reached through a symlinked parent", async () => {
    const parent = await makeTestDirectory("ltx4-parent-link-");
    const realParent = join(parent, "real");
    const linkedParent = join(parent, "linked");
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, linkedParent);
    const root = join(linkedParent, "run");
    try {
      await expect(prepareRunRoot(root)).rejects.toThrow(/symlink|canonical/u);
      await expect(stat(join(realParent, "run"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("validates owner and fixture record file ownership metadata before reading", async () => {
    const { parent, root } = await createIsolatedRunRoot("record-metadata");
    const ownerPath = join(root, OWNER_RECORD_NAME);
    const ownerBackup = join(parent, "owner-backup");
    await copyFile(ownerPath, ownerBackup);
    await unlink(ownerPath);
    await symlink(ownerBackup, ownerPath);
    try {
      await expect(reapOwnedRunRoot(root)).rejects.toThrow(/owner.*symlink|regular file|ELOOP/u);
      expect((await lstat(ownerPath)).isSymbolicLink()).toBe(true);
    } finally {
      await unlink(ownerPath).catch(() => undefined);
      try {
        await stat(root);
        await copyFile(ownerBackup, ownerPath);
        await chmod(ownerPath, 0o600);
        await removeIsolatedRunRoot(parent, root);
      } catch {
        await rm(parent, { force: true, recursive: true });
      }
    }
  });

  test("preserves socket and identity evidence when a reservation has unexpected entries", async () => {
    const { parent, root } = await createIsolatedRunRoot("evidence-order");
    const server = await TestServer.create({ runRoot: root });
    const unexpected = join(server.reservationPath, "unexpected");
    await writeFile(unexpected, "keep");
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks.some((leak) => leak.includes("unexpected"))).toBe(true);
      expect((await stat(server.socketPath)).isSocket()).toBe(true);
      expect((await stat(server.recordPath)).isFile()).toBe(true);
      expect(processExists(server.daemonIdentity.pid)).toBe(true);
    } finally {
      await unlink(unexpected);
      await server.dispose().catch(() => undefined);
      await removeIsolatedRunRoot(parent, root);
    }
  });

  for (const corruption of ["run-id", "mode", "symlink"] as const) {
    test(`refuses a fixture record with ${corruption} corruption before signaling`, async () => {
      const { parent, root } = await createIsolatedRunRoot(`fixture-record-${corruption}`);
      const server = await TestServer.create({ runRoot: root });
      const original = await readFile(server.recordPath, "utf8");
      const backup = join(parent, `fixture-${corruption}.json`);
      try {
        if (corruption === "run-id") {
          const record = JSON.parse(original) as FixtureRecord;
          await writeFile(
            server.recordPath,
            `${JSON.stringify({ ...record, runId: randomUUID() })}\n`,
            { mode: 0o600 },
          );
        } else if (corruption === "mode") {
          await chmod(server.recordPath, 0o644);
        } else {
          await copyFile(server.recordPath, backup);
          await unlink(server.recordPath);
          await symlink(backup, server.recordPath);
        }
        await expect(server.dispose()).rejects.toThrow();
        expect(processExists(server.daemonIdentity.pid)).toBe(true);
        expect((await stat(server.socketPath)).isSocket()).toBe(true);
      } finally {
        await unlink(server.recordPath).catch(() => undefined);
        await writeFile(server.recordPath, original, { mode: 0o600 });
        await reapOwnedRunRoot(root).catch(() => undefined);
        await rm(parent, { force: true, recursive: true });
      }
    });
  }

  test("does not follow a reservation symlink outside the exact root", async () => {
    const { parent, root } = await createIsolatedRunRoot("symlink-child");
    const external = join(parent, "external");
    await mkdir(external, { mode: 0o700 });
    await writeFile(join(external, "sentinel"), "keep");
    await symlink(external, join(root, "linked-reservation"));
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks.some((leak) => leak.includes("symlink"))).toBe(true);
      expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep");
    } finally {
      await rm(join(root, "linked-reservation"), { force: true });
      await reapOwnedRunRoot(root);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("preserves version-one owner evidence without migration or cleanup", async () => {
    const { parent, root } = await createIsolatedRunRoot("legacy-owner-v1");
    const ownerPath = join(root, OWNER_RECORD_NAME);
    const currentOwner = await readFile(ownerPath, "utf8");
    const parsed = JSON.parse(currentOwner) as {
      owner: { pid: number; startIdentity: string };
      runId: string;
    };
    const legacy = `${JSON.stringify({
      owner: {
        pid: parsed.owner.pid,
        startIdentity: "linux:00000000-0000-4000-8000-000000000000:1",
      },
      protocol: "libtmux-test-run-v1",
      runId: parsed.runId,
    })}\n`;
    await writeFile(ownerPath, legacy, { mode: 0o600 });
    const ownerEntry = journalIdentity(await lstat(ownerPath));
    try {
      await expect(reapStaleRunRoot(root)).rejects.toThrow(/bad magic|protocol/u);
      expect(await readFile(ownerPath, "utf8")).toBe(legacy);
      expect(journalIdentity(await lstat(ownerPath))).toEqual(ownerEntry);
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally {
      await writeFile(ownerPath, currentOwner, { mode: 0o600 }).catch(() => undefined);
      await reapOwnedRunRoot(root).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("preserves a version-two fixture record without normalization or deletion", async () => {
    const { parent, root } = await createIsolatedRunRoot("legacy-fixture-v2");
    const owner = JSON.parse(await readFile(join(root, OWNER_RECORD_NAME), "utf8")) as {
      runId: string;
    };
    const reservationPath = join(root, "t-legacy-00000000-000");
    const recordPath = join(reservationPath, "fixture.json");
    await mkdir(reservationPath, { mode: 0o700 });
    const identity = await readProcessIdentity(process.pid);
    if (identity === undefined) throw new Error("test process identity disappeared");
    const legacy = `${JSON.stringify({
      logicalSocketName: basename(reservationPath),
      owner: identity,
      phase: "reserved",
      protocol: "libtmux-test-fixture-v2",
      runId: owner.runId,
      socketPath: join(reservationPath, "s"),
      tmuxExecutable: "tmux",
    })}\n`;
    await writeFile(recordPath, legacy, { flag: "wx", mode: 0o600 });
    const recordEntry = journalIdentity(await lstat(recordPath));
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.rootRemoved).toBe(false);
      expect(report.leaks.some((leak) => /bad magic|protocol/u.test(leak))).toBe(true);
      expect(await readFile(recordPath, "utf8")).toBe(legacy);
      expect(journalIdentity(await lstat(recordPath))).toEqual(recordEntry);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("preserves a version-two cleanup journal and its reservation", async () => {
    const { parent, root } = await createIsolatedRunRoot("legacy-journal-v2");
    const owner = JSON.parse(await readFile(join(root, OWNER_RECORD_NAME), "utf8")) as {
      runId: string;
    };
    const identity = await readProcessIdentity(process.pid);
    if (identity === undefined) throw new Error("test process identity disappeared");
    const logicalSocketName = "t-journal-00000000-000";
    const reservationPath = join(root, logicalSocketName);
    const recordPath = join(reservationPath, "fixture.json");
    const socketPath = join(reservationPath, "s");
    await mkdir(reservationPath, { mode: 0o700 });
    const record = `${JSON.stringify({
      logicalSocketName,
      owner: identity,
      phase: "reserved",
      protocol: "libtmux-test-fixture-v2",
      runId: owner.runId,
      socketPath,
      tmuxExecutable: "tmux",
    })}\n`;
    await writeFile(recordPath, record, { flag: "wx", mode: 0o600 });
    const escrow = join(root, `.fixture-escrow-${logicalSocketName}.${owner.runId}`);
    await mkdir(escrow, { mode: 0o700 });
    const journalPath = join(escrow, "journal.json");
    const journal = `${JSON.stringify({
      logicalSocketName,
      protocol: "libtmux-fixture-escrow-v2",
      record: journalIdentity(await lstat(recordPath)),
      recordDigest: createHash("sha256").update(record).digest("hex"),
      recordPath,
      reservation: journalIdentity(await lstat(reservationPath)),
      reservationPath,
      runId: owner.runId,
      socketPath,
    })}\n`;
    await writeFile(journalPath, journal, { flag: "wx", mode: 0o600 });
    const recordEntry = journalIdentity(await lstat(recordPath));
    const journalEntry = journalIdentity(await lstat(journalPath));
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.rootRemoved).toBe(false);
      expect(report.leaks.some((leak) => /bad magic|protocol/u.test(leak))).toBe(true);
      expect(await readFile(journalPath, "utf8")).toBe(journal);
      expect(await readFile(recordPath, "utf8")).toBe(record);
      expect(journalIdentity(await lstat(journalPath))).toEqual(journalEntry);
      expect(journalIdentity(await lstat(recordPath))).toEqual(recordEntry);
      expect((await stat(reservationPath)).isDirectory()).toBe(true);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("preserves a committed live version-two journal without signaling or unlinking", async () => {
    const { parent, root } = await createIsolatedRunRoot("legacy-live-journal-v2");
    const owner = JSON.parse(await readFile(join(root, OWNER_RECORD_NAME), "utf8")) as {
      runId: string;
    };
    const ownerIdentity = await readProcessIdentity(process.pid);
    if (ownerIdentity === undefined) throw new Error("test process identity disappeared");
    const logicalSocketName = "t-live-v2-00000000-000";
    const reservationPath = join(root, logicalSocketName);
    const recordPath = join(reservationPath, "fixture.json");
    const socketPath = join(reservationPath, "s");
    const recoverySocket = join(parent, "live-v2-recovery.sock");
    const escrow = join(root, `.fixture-escrow-${logicalSocketName}.${owner.runId}`);
    const movedReservation = join(escrow, "reservation");
    const movedRecord = join(movedReservation, "fixture.json");
    const movedSocket = join(movedReservation, "s");
    let captured: CapturedTmuxCleanup | undefined;
    await mkdir(reservationPath, { mode: 0o700 });
    const daemonPid = await launchExactTmux(socketPath);
    const daemon = await readDaemonIdentity(daemonPid);
    if (daemon === undefined) throw new Error("legacy live tmux daemon disappeared");
    try {
      captured = await captureTmuxCleanup(daemonPid, socketPath, recoverySocket);
      const socketIdentity = journalIdentity(await lstat(socketPath));
      const record = `${JSON.stringify({
        daemon,
        logicalSocketName,
        owner: ownerIdentity,
        phase: "running",
        protocol: "libtmux-test-fixture-v2",
        runId: owner.runId,
        socketIdentity,
        socketPath,
        tmuxExecutable: daemon.executablePath,
      })}\n`;
      await writeFile(recordPath, record, { flag: "wx", mode: 0o600 });
      const recordEntry = journalIdentity(await lstat(recordPath));
      const reservationEntry = journalIdentity(await lstat(reservationPath));
      await mkdir(escrow, { mode: 0o700 });
      const journalPath = join(escrow, "journal.json");
      const journal = `${JSON.stringify({
        logicalSocketName,
        protocol: "libtmux-fixture-escrow-v2",
        record: recordEntry,
        recordDigest: createHash("sha256").update(record).digest("hex"),
        recordPath,
        reservation: reservationEntry,
        reservationPath,
        runId: owner.runId,
        socket: socketIdentity,
        socketPath,
      })}\n`;
      await writeFile(journalPath, journal, { flag: "wx", mode: 0o600 });
      const journalEntry = journalIdentity(await lstat(journalPath));
      await rename(reservationPath, movedReservation);
      const movedRecordEntry = journalIdentity(await lstat(movedRecord));
      const movedSocketEntry = journalIdentity(await lstat(movedSocket));

      const report = await reapOwnedRunRoot(root);

      expect(report.rootRemoved).toBe(false);
      expect(report.leaks.some((leak) => /bad magic|protocol/u.test(leak))).toBe(true);
      expect(await readDaemonIdentity(daemonPid)).toEqual(daemon);
      expect(await readFile(movedRecord, "utf8")).toBe(record);
      expect(await readFile(journalPath, "utf8")).toBe(journal);
      expect(journalIdentity(await lstat(movedRecord))).toEqual(movedRecordEntry);
      expect(journalIdentity(await lstat(movedSocket))).toEqual(movedSocketEntry);
      expect(journalIdentity(await lstat(journalPath))).toEqual(journalEntry);
    } finally {
      if (captured !== undefined) await terminateCapturedTmux(captured);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("refuses a root owned by the same live process identity", async () => {
    const { parent, root } = await createIsolatedRunRoot("live-owner");
    try {
      await expect(prepareRunRoot(root)).rejects.toThrow("live owner");
    } finally {
      await removeIsolatedRunRoot(parent, root);
    }
  });

  test("reaps a dead owner and republishes the root", async () => {
    const { parent, root } = await createIsolatedRunRoot("dead-owner");
    const ownerPath = join(root, OWNER_RECORD_NAME);
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    owner.owner = {
      pid: 2_147_483_000,
      startIdentity: "linux:00000000-0000-4000-8000-000000000000:1",
    };
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
    try {
      await prepareRunRoot(root);
      const current = JSON.parse(await readFile(ownerPath, "utf8")) as {
        owner: { pid: number };
      };
      expect(current.owner.pid).toBe(process.pid);
    } finally {
      await removeIsolatedRunRoot(parent, root);
    }
  });

  test("recovers the deterministic owner escrow left by interrupted finalization", async () => {
    const { parent, root } = await createIsolatedRunRoot("owner-escrow-recovery");
    const escrow = `${root}.owner-escrow`;
    await mkdir(escrow, { mode: 0o700 });
    await rename(join(root, OWNER_RECORD_NAME), join(escrow, OWNER_RECORD_NAME));
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report).toEqual({ leaks: [], reservationsFound: 0, rootRemoved: true });
      await waitForPathAbsent(root);
      await waitForPathAbsent(escrow);
    } finally {
      await rm(parent, { force: true, recursive: true });
      await rm(escrow, { force: true, recursive: true });
    }
  });

  test("recovers matching canonical and escrow owner hardlinks", async () => {
    const { parent, root } = await createIsolatedRunRoot("owner-hardlink-recovery");
    const escrow = `${root}.owner-escrow`;
    await mkdir(escrow, { mode: 0o700 });
    await link(join(root, OWNER_RECORD_NAME), join(escrow, OWNER_RECORD_NAME));
    try {
      expect((await reapOwnedRunRoot(root)).rootRemoved).toBe(true);
      await waitForPathAbsent(escrow);
    } finally {
      await rm(parent, { force: true, recursive: true });
      await rm(escrow, { force: true, recursive: true });
    }
  });

  test("preserves conflicting canonical and escrow owner inodes", async () => {
    const { parent, root } = await createIsolatedRunRoot("owner-hardlink-conflict");
    const ownerPath = join(root, OWNER_RECORD_NAME);
    const ownerText = await readFile(ownerPath, "utf8");
    const escrow = `${root}.owner-escrow`;
    const escrowOwner = join(escrow, OWNER_RECORD_NAME);
    await mkdir(escrow, { mode: 0o700 });
    await link(ownerPath, escrowOwner);
    await unlink(ownerPath);
    await writeFile(ownerPath, ownerText, { flag: "wx", mode: 0o600 });
    try {
      await expect(reapOwnedRunRoot(root)).rejects.toThrow(/owner escrow|inode|changed/u);
      expect((await stat(ownerPath)).isFile()).toBe(true);
      expect((await stat(escrowOwner)).isFile()).toBe(true);
    } finally {
      await unlink(ownerPath).catch(() => undefined);
      await link(escrowOwner, ownerPath).catch(() => undefined);
      await unlink(escrowOwner).catch(() => undefined);
      await rmdir(escrow).catch(() => undefined);
      await reapOwnedRunRoot(root).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("removes an empty owner escrow left before the owner record move", async () => {
    const { parent, root } = await createIsolatedRunRoot("empty-owner-escrow");
    const escrow = `${root}.owner-escrow`;
    await mkdir(escrow, { mode: 0o700 });
    try {
      expect((await reapOwnedRunRoot(root)).rootRemoved).toBe(true);
      await waitForPathAbsent(escrow);
    } finally {
      await rm(parent, { force: true, recursive: true });
      await rm(escrow, { force: true, recursive: true });
    }
  });

  test("removes an empty detached owner escrow left after its record unlink", async () => {
    const { parent, root } = await createIsolatedRunRoot("empty-detached-owner-escrow");
    const escrow = `${root}.owner-escrow`;
    await rm(root, { force: true, recursive: true });
    await mkdir(escrow, { mode: 0o700 });
    try {
      expect((await reapStaleRunRoot(root)).rootRemoved).toBe(true);
      await waitForPathAbsent(escrow);
    } finally {
      await rm(parent, { force: true, recursive: true });
      await rm(escrow, { force: true, recursive: true });
    }
  });

  test("treats the same PID with a different start identity as stale reuse", async () => {
    const { parent, root } = await createIsolatedRunRoot("pid-reuse");
    const ownerPath = join(root, OWNER_RECORD_NAME);
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    owner.owner = {
      pid: process.pid,
      startIdentity: "linux:00000000-0000-4000-8000-000000000000:1",
    };
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
    try {
      await prepareRunRoot(root);
      const current = JSON.parse(await readFile(ownerPath, "utf8")) as {
        owner: { startIdentity: string };
      };
      expect(current.owner.startIdentity).toBe(
        (await readProcessIdentity(process.pid))!.startIdentity,
      );
    } finally {
      await removeIsolatedRunRoot(parent, root);
    }
  });

  test("fails closed on a corrupt owner identity and preserves the root", async () => {
    const { parent, root } = await createIsolatedRunRoot("corrupt-owner");
    await writeFile(join(root, OWNER_RECORD_NAME), "not-json\n");
    try {
      await expect(prepareRunRoot(root)).rejects.toThrow("owner record");
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("rejects a syntactically invalid process identity before liveness checks", async () => {
    const { parent, root } = await createIsolatedRunRoot("invalid-identity");
    const ownerPath = join(root, OWNER_RECORD_NAME);
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    owner.owner = { pid: 2_147_483_000, startIdentity: "dead" };
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    try {
      await expect(prepareRunRoot(root)).rejects.toThrow(/identity.*corrupt/u);
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
