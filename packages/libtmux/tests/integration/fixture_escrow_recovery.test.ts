import { spawn } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { processExists, waitForPathAbsent, waitForProcessExit } from "../support/converge.js";
import {
  beginSyntheticLaunch,
  closeNetServer,
  journalIdentity,
  listenOnUnixSocket,
  writeFixtureEscrowJournal,
  type ClosableServer,
} from "../support/fixture_evidence.js";
import { closeChild } from "../support/owned_child.js";
import { createIsolatedRunRoot } from "../support/run_root_harness.js";
import {
  captureTmuxCleanup,
  killExactTmux,
  terminateCapturedTmux,
} from "../support/tmux_cleanup.js";

import {
  prepareRunRoot,
  readFixtureRecord,
  reapOwnedRunRoot,
  reserveFixture,
  readDaemonIdentity,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

describe("fixture escrow recovery", () => {
  for (const boundary of [
    "empty-before-journal",
    "journal-temp-written",
    "journal-written-before-moves",
    "reservation-moved",
    "record-unlinked",
    "reservation-removed",
    "journal-unlinked",
  ] as const) {
    test(`recovers fixture escrow after ${boundary}`, async () => {
      const { parent, root } = await createIsolatedRunRoot(`fixture-escrow-${boundary}`);
      const reserved = await reserveFixture(root);
      const escrow = join(
        root,
        `.fixture-escrow-${basename(reserved.reservationPath)}.${reserved.record.runId}`,
      );
      await mkdir(escrow, { mode: 0o700 });
      if (boundary === "journal-temp-written") {
        await writeFile(join(escrow, ".journal.tmp"), '{"partial":', {
          flag: "wx",
          mode: 0o600,
        });
      } else if (boundary !== "empty-before-journal") {
        await writeFixtureEscrowJournal(reserved, escrow);
      }
      const movedReservation = join(escrow, "reservation");
      if (
        boundary !== "empty-before-journal" &&
        boundary !== "journal-temp-written" &&
        boundary !== "journal-written-before-moves"
      ) {
        await rename(reserved.reservationPath, movedReservation);
      }
      if (boundary === "record-unlinked") {
        await unlink(join(movedReservation, "fixture.json"));
      }
      if (boundary === "reservation-removed" || boundary === "journal-unlinked") {
        await unlink(join(movedReservation, "fixture.json"));
        await unlink(join(movedReservation, "s")).catch(() => undefined);
        await rmdir(movedReservation);
      }
      if (boundary === "journal-unlinked") {
        await unlink(join(escrow, "journal.json"));
      }
      try {
        const report = await reapOwnedRunRoot(root);
        expect(report.leaks).toEqual([]);
        expect(report.rootRemoved).toBe(true);
        await waitForPathAbsent(escrow);
      } finally {
        await rm(parent, { force: true, recursive: true });
      }
    });
  }

  test("recovers a running fixture escrow after its authenticated socket is removed", async () => {
    const { parent, root } = await createIsolatedRunRoot("fixture-escrow-socket-unlinked");
    const server = await TestServer.create({ runRoot: root });
    const record = await readFixtureRecord(server.reservationPath);
    const escrow = join(root, `.fixture-escrow-${server.logicalSocketName}.${record.runId}`);
    const movedReservation = join(escrow, "reservation");
    const stopped = await closeChild(
      spawn(server.tmuxExecutable, ["-N", "-S", server.socketPath, "kill-server"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (stopped.code !== 0) throw new Error(`journal fixture stop failed: ${stopped.stderr}`);
    await waitForProcessExit(server.daemonIdentity.pid);
    await mkdir(escrow, { mode: 0o700 });
    await writeFixtureEscrowJournal(
      {
        record,
        recordPath: server.recordPath,
        reservationPath: server.reservationPath,
      },
      escrow,
    );
    await rename(server.reservationPath, movedReservation);
    await unlink(join(movedReservation, "s"));
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks).toEqual([]);
      expect(report.rootRemoved).toBe(true);
      await waitForPathAbsent(escrow);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  for (const location of ["uncommitted", "committed"] as const) {
    for (const socketState of ["with-socket", "record-only"] as const) {
      test(`preserves a ${location} launching journal ${socketState}`, async () => {
        const { parent, root } = await createIsolatedRunRoot(
          `launching-journal-${location}-${socketState}`,
        );
        const reserved = await reserveFixture(root);
        const launched = await beginSyntheticLaunch(reserved);
        const launchingReservation = { ...reserved, record: launched.record };
        const escrow = join(
          root,
          `.fixture-escrow-${basename(reserved.reservationPath)}.${reserved.record.runId}`,
        );
        let listener: ClosableServer | undefined;
        try {
          if (socketState === "with-socket") {
            listener = await listenOnUnixSocket(launched.record.socketPath);
          }
          await mkdir(escrow, { mode: 0o700 });
          await writeFixtureEscrowJournal(launchingReservation, escrow);
          const evidenceReservation =
            location === "committed" ? join(escrow, "reservation") : reserved.reservationPath;
          if (location === "committed") {
            await rename(reserved.reservationPath, evidenceReservation);
          }
          const evidenceRecord = join(evidenceReservation, "fixture.json");
          const evidenceSocket = join(evidenceReservation, "s");
          const journalPath = join(escrow, "journal.json");
          const [recordText, journalText] = await Promise.all([
            readFile(evidenceRecord, "utf8"),
            readFile(journalPath, "utf8"),
          ]);

          const report = await reapOwnedRunRoot(root);

          expect(report.leaks.some((leak) => leak.includes("launching"))).toBe(true);
          expect(report.rootRemoved).toBe(false);
          expect(await readFile(journalPath, "utf8")).toBe(journalText);
          expect(await readFile(evidenceRecord, "utf8")).toBe(recordText);
          if (socketState === "with-socket") {
            expect((await lstat(evidenceSocket)).isSocket()).toBe(true);
          }
        } finally {
          await closeNetServer(listener);
          await rm(parent, { force: true, recursive: true });
        }
      });
    }
  }

  for (const location of ["uncommitted", "committed"] as const) {
    test(`preserves a ${location} journal whose fixture controller differs from its owner`, async () => {
      const parent = await makeTestDirectory("ltx4-");
      const root = join(parent, "r");
      const recoverySocket = join(parent, "recovery.sock");
      await prepareRunRoot(root);
      const server = await TestServer.create({ runRoot: root });
      const record = await readFixtureRecord(server.reservationPath);
      if (record.phase !== "running") throw new Error("fixture did not publish running authority");
      const captured = await captureTmuxCleanup(
        server.daemonIdentity.pid,
        server.socketPath,
        recoverySocket,
      );
      const changedRecord: typeof record = {
        ...record,
        controller: {
          ...record.controller,
          fileIdentity: {
            ...record.controller.fileIdentity,
            inode: String(BigInt(record.controller.fileIdentity.inode) + 1n),
          },
        },
      };
      await writeFile(server.recordPath, `${JSON.stringify(changedRecord)}\n`, { mode: 0o600 });
      const escrow = join(root, `.fixture-escrow-${server.logicalSocketName}.${record.runId}`);
      await mkdir(escrow, { mode: 0o700 });
      await writeFixtureEscrowJournal(
        {
          record: changedRecord,
          recordPath: server.recordPath,
          reservationPath: server.reservationPath,
        },
        escrow,
      );
      const evidenceReservation =
        location === "committed" ? join(escrow, "reservation") : server.reservationPath;
      if (location === "committed") {
        await rename(server.reservationPath, evidenceReservation);
      }
      const evidenceRecord = join(evidenceReservation, "fixture.json");
      const evidenceSocket = join(evidenceReservation, "s");
      const journalPath = join(escrow, "journal.json");
      const [recordBytes, journalBytes] = await Promise.all([
        readFile(evidenceRecord, "utf8"),
        readFile(journalPath, "utf8"),
      ]);
      const [recordEntry, journalEntry, socketEntry] = await Promise.all([
        lstat(evidenceRecord).then(journalIdentity),
        lstat(journalPath).then(journalIdentity),
        lstat(evidenceSocket).then(journalIdentity),
      ]);
      try {
        const report = await reapOwnedRunRoot(root);

        expect(await readDaemonIdentity(server.daemonIdentity.pid)).toEqual(captured.daemon);
        expect(await readFile(evidenceRecord, "utf8")).toBe(recordBytes);
        expect(journalIdentity(await lstat(evidenceRecord))).toEqual(recordEntry);
        expect(await readFile(journalPath, "utf8")).toBe(journalBytes);
        expect(journalIdentity(await lstat(journalPath))).toEqual(journalEntry);
        expect(journalIdentity(await lstat(evidenceSocket))).toEqual(socketEntry);
        expect(report.leaks.some((leak) => leak.includes("controller"))).toBe(true);
        expect(report.rootRemoved).toBe(false);
      } finally {
        if (processExists(server.daemonIdentity.pid)) {
          await terminateCapturedTmux(captured);
          await waitForProcessExit(server.daemonIdentity.pid);
        }
        await rm(parent, { force: true, recursive: true });
      }
    });
  }

  test("preserves an impossible committed socket-only fixture escrow", async () => {
    const parent = await makeTestDirectory("ltx4-");
    const root = join(parent, "r");
    await prepareRunRoot(root);
    const server = await TestServer.create({ runRoot: root });
    const record = await readFixtureRecord(server.reservationPath);
    const escrow = join(root, `.fixture-escrow-${server.logicalSocketName}.${record.runId}`);
    const movedReservation = join(escrow, "reservation");
    const movedSocket = join(movedReservation, "s");
    const recoverySocket = join(parent, "recovery.sock");
    try {
      const captured = await captureTmuxCleanup(
        server.daemonIdentity.pid,
        server.socketPath,
        recoverySocket,
      );
      await terminateCapturedTmux(captured);
      await unlink(recoverySocket);
      await mkdir(escrow, { mode: 0o700 });
      await writeFixtureEscrowJournal(
        {
          record,
          recordPath: server.recordPath,
          reservationPath: server.reservationPath,
        },
        escrow,
      );
      await rename(server.reservationPath, movedReservation);
      await unlink(join(movedReservation, "fixture.json"));
      const socketIdentity = journalIdentity(await lstat(movedSocket));
      const journalText = await readFile(join(escrow, "journal.json"), "utf8");

      const report = await reapOwnedRunRoot(root);

      expect(report.leaks.some((leak) => leak.includes("socket-only"))).toBe(true);
      expect(report.rootRemoved).toBe(false);
      expect(journalIdentity(await lstat(movedSocket))).toEqual(socketIdentity);
      expect(await readFile(join(escrow, "journal.json"), "utf8")).toBe(journalText);
    } finally {
      await unlink(recoverySocket).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("verifies a committed record before unlinking its journaled socket", async () => {
    const parent = await makeTestDirectory("ltx4-");
    const root = join(parent, "r");
    await prepareRunRoot(root);
    const server = await TestServer.create({ runRoot: root });
    const record = await readFixtureRecord(server.reservationPath);
    const escrow = join(root, `.fixture-escrow-${server.logicalSocketName}.${record.runId}`);
    const movedReservation = join(escrow, "reservation");
    const movedRecord = join(movedReservation, "fixture.json");
    const movedSocket = join(movedReservation, "s");
    const recoverySocket = join(parent, "recovery.sock");
    await link(server.socketPath, recoverySocket);
    try {
      await mkdir(escrow, { mode: 0o700 });
      await writeFixtureEscrowJournal(
        {
          record,
          recordPath: server.recordPath,
          reservationPath: server.reservationPath,
        },
        escrow,
      );
      await rename(server.reservationPath, movedReservation);
      await writeFile(movedRecord, '{"changed":true}\n', { mode: 0o600 });
      const socketIdentity = journalIdentity(await lstat(movedSocket));
      const journalText = await readFile(join(escrow, "journal.json"), "utf8");

      const report = await reapOwnedRunRoot(root);

      expect(report.leaks.some((leak) => leak.includes("digest changed"))).toBe(true);
      expect(report.rootRemoved).toBe(false);
      expect(journalIdentity(await lstat(movedSocket))).toEqual(socketIdentity);
      expect(await readFile(movedRecord, "utf8")).toBe('{"changed":true}\n');
      expect(await readFile(join(escrow, "journal.json"), "utf8")).toBe(journalText);
    } finally {
      if (processExists(server.daemonIdentity.pid)) {
        await killExactTmux(recoverySocket, server.daemonIdentity.pid);
        await waitForProcessExit(server.daemonIdentity.pid);
      }
      await unlink(recoverySocket).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("preserves unexpected fixture escrow contents", async () => {
    const { parent, root } = await createIsolatedRunRoot("fixture-escrow-unexpected");
    const reserved = await reserveFixture(root);
    const escrow = join(
      root,
      `.fixture-escrow-${basename(reserved.reservationPath)}.${reserved.record.runId}`,
    );
    await mkdir(escrow, { mode: 0o700 });
    await writeFixtureEscrowJournal(reserved, escrow);
    await writeFile(join(escrow, "sentinel"), "keep", { mode: 0o600 });
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks.some((leak) => leak.includes("unexpected entries"))).toBe(true);
      expect(await readFile(join(escrow, "sentinel"), "utf8")).toBe("keep");
      expect(await readFile(reserved.recordPath, "utf8")).toContain(reserved.record.runId);
    } finally {
      await unlink(join(escrow, "sentinel")).catch(() => undefined);
      await rmdir(escrow).catch(() => undefined);
      await reapOwnedRunRoot(root).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("preserves a fixture escrow whose journal is missing", async () => {
    const { parent, root } = await createIsolatedRunRoot("fixture-escrow-missing-journal");
    const reserved = await reserveFixture(root);
    const escrow = join(
      root,
      `.fixture-escrow-${basename(reserved.reservationPath)}.${reserved.record.runId}`,
    );
    await mkdir(escrow, { mode: 0o700 });
    await rename(reserved.reservationPath, join(escrow, "reservation"));
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks.some((leak) => leak.includes("journal"))).toBe(true);
      expect((await stat(escrow)).isDirectory()).toBe(true);
      expect(await readFile(join(escrow, "reservation", "fixture.json"), "utf8")).toContain(
        reserved.record.runId,
      );
    } finally {
      await rename(join(escrow, "reservation"), reserved.reservationPath).catch(() => undefined);
      await rmdir(escrow).catch(() => undefined);
      await reapOwnedRunRoot(root).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("removes a partial deterministic record temp after authenticating the canonical record", async () => {
    const { parent, root } = await createIsolatedRunRoot("record-temp-recovery");
    const reserved = await reserveFixture(root);
    const temporary = join(reserved.reservationPath, ".fixture.json.tmp");
    await writeFile(temporary, '{"partial":', { flag: "wx", mode: 0o600 });
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks).toEqual([]);
      expect(report.rootRemoved).toBe(true);
      await waitForPathAbsent(temporary);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("removes a prelaunch registration temp without a published record or socket", async () => {
    const { parent, root } = await createIsolatedRunRoot("registration-temp-recovery");
    const reserved = await reserveFixture(root);
    const temporary = join(reserved.reservationPath, ".fixture.json.tmp");
    await rename(reserved.recordPath, temporary);
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks).toEqual([]);
      expect(report.rootRemoved).toBe(true);
      await waitForPathAbsent(temporary);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
