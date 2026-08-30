import { spawn } from "node:child_process";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { processExists, waitForPathPresent, waitForProcessExit } from "../support/converge.js";
import {
  beginSyntheticLaunch,
  closeNetServer,
  journalIdentity,
  listenOnUnixSocket,
  syntheticLaunchInput,
} from "../support/fixture_evidence.js";
import { readLaunchFrame } from "../support/launch_frame.js";
import {
  closeChild,
  closeChildWithin,
  exitChildWithin,
  readJsonMarker,
  spawnLeakingWorker,
} from "../support/owned_child.js";
import { createIsolatedRunRoot, removeIsolatedRunRoot } from "../support/run_root_harness.js";
import {
  captureTmuxCleanup,
  killExactTmux,
  launchExactTmux,
  terminateCapturedTmux,
  type CapturedTmuxCleanup,
} from "../support/tmux_cleanup.js";

import {
  beginFixtureLaunch,
  OWNER_RECORD_NAME,
  prepareRunRoot,
  promoteFixtureLaunch,
  readFixtureRecord,
  reapFixture,
  reapOwnedRunRoot,
  reapStaleRunRoot,
  reserveFixture,
  rollbackFixtureLaunchNotStarted,
  readDaemonIdentity,
  readProcessIdentity,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

const tsRoot = fileURLToPath(new URL("../..", import.meta.url));
const reaperPath = fileURLToPath(new URL("../../scripts/reap-test-run.ts", import.meta.url));

async function reapWithoutMasking(label: string, reap: () => Promise<void>): Promise<void> {
  try {
    await reap();
  } catch (error) {
    process.stderr.write(
      `cleanup step ${label} did not complete: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeLaunchingHoldWrapper(parent: string, marker: string): Promise<string> {
  const python = Bun.which("python3");
  const tmux = Bun.which("tmux");
  if (python === null) throw new Error("python3 is required");
  if (tmux === null) throw new Error("tmux is required");
  const wrapper = join(parent, "tmux-launching-hold");
  const program = `import ctypes
import os
import signal
import subprocess
import sys

parent = os.getppid()
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG) failed")
if os.getppid() != parent:
    os.kill(os.getpid(), signal.SIGKILL)
completed = subprocess.run([sys.argv[2], *sys.argv[3:]], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
sys.stdout.buffer.write(completed.stdout)
sys.stdout.buffer.flush()
sys.stderr.buffer.write(completed.stderr)
sys.stderr.buffer.flush()
with open(sys.argv[1], "wb") as stream:
    stream.write(f"{os.getpid()}\\n".encode() + completed.stdout)
    stream.flush()
    os.fsync(stream.fileno())
signal.pause()
`;
  await writeFile(
    wrapper,
    `#!/bin/sh
exec ${shellQuote(python)} -c ${shellQuote(program)} ${shellQuote(marker)} ${shellQuote(tmux)} "$@"
`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

describe("fixture launch and exact-root reaping", () => {
  test("discovers, promotes, and reaps a generation-authenticated launching fixture", async () => {
    const { parent, root } = await createIsolatedRunRoot("stale-launching-generation");
    const marker = join(parent, "launch.frame");
    const wrapper = await writeLaunchingHoldWrapper(parent, marker);
    const worker = await spawnLeakingWorker(root, "launching-hold", marker, {
      LIBTMUX_TEST_LAUNCH_WRAPPER: wrapper,
    });
    let daemonPid: number | undefined;
    let captured: CapturedTmuxCleanup | undefined;
    let socketPath: string | undefined;
    let wrapperPid: number | undefined;
    try {
      const launched = await readLaunchFrame(marker);
      [wrapperPid, socketPath, daemonPid] = [
        launched.wrapperPid,
        launched.socketPath,
        launched.daemonPid,
      ];
      expect(processExists(daemonPid)).toBe(true);
      captured = await captureTmuxCleanup(
        daemonPid,
        socketPath,
        join(parent, "launching-recovery.sock"),
      );
      worker.kill("SIGKILL");
      await exitChildWithin(worker, 2_000);
      await waitForProcessExit(wrapperPid);

      const reservations = (await readdir(root)).filter((entry) => entry !== OWNER_RECORD_NAME);
      expect(reservations).toHaveLength(1);
      expect((await readFixtureRecord(join(root, reservations[0]!))).phase).toBe("launching");
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks).toEqual([]);
      expect(report.rootRemoved).toBe(true);
      await waitForProcessExit(daemonPid);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
        await exitChildWithin(worker, 2_000);
      }
      const reaped = wrapperPid;
      if (reaped !== undefined) {
        await reapWithoutMasking("wrapper exit", () => waitForProcessExit(reaped));
      }
      if (captured !== undefined) await terminateCapturedTmux(captured);
      await reapOwnedRunRoot(root).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  }, 30_000);

  test("preserves stale launching evidence when the process generation mismatches", async () => {
    const { parent, root } = await createIsolatedRunRoot("stale-launching-generation-mismatch");
    const marker = join(parent, "launch.frame");
    const wrapper = await writeLaunchingHoldWrapper(parent, marker);
    const worker = await spawnLeakingWorker(root, "launching-hold", marker, {
      LIBTMUX_TEST_LAUNCH_WRAPPER: wrapper,
    });
    let captured: CapturedTmuxCleanup | undefined;
    let wrapperPid: number | undefined;
    try {
      const launched = await readLaunchFrame(marker);
      wrapperPid = launched.wrapperPid;
      const socketPath = launched.socketPath;
      const daemonPid = launched.daemonPid;
      if (socketPath === undefined || !Number.isSafeInteger(daemonPid)) {
        throw new Error("launch wrapper returned an invalid frame");
      }
      const authority = await captureTmuxCleanup(
        daemonPid,
        socketPath,
        join(parent, "launching-mismatch-recovery.sock"),
      );
      captured = authority;
      worker.kill("SIGKILL");
      await exitChildWithin(worker, 2_000);
      await waitForProcessExit(wrapperPid);

      const reservations = (await readdir(root)).filter((entry) => entry !== OWNER_RECORD_NAME);
      expect(reservations).toHaveLength(1);
      const reservationPath = join(root, reservations[0]!);
      const recordPath = join(reservationPath, "fixture.json");
      const originalRecord = JSON.parse(await readFile(recordPath, "utf8")) as {
        generation?: { name: string; value: string };
        phase?: string;
      };
      if (originalRecord.generation === undefined) {
        throw new Error("launching fixture lacks a durable generation");
      }
      expect(originalRecord.phase).toBe("launching");
      const mismatchedValue = "11111111-1111-4111-8111-111111111111";
      expect(originalRecord.generation.value).not.toBe(mismatchedValue);
      const mutatedRecord = `${JSON.stringify({
        ...originalRecord,
        generation: { ...originalRecord.generation, value: mismatchedValue },
      })}\n`;
      await writeFile(recordPath, mutatedRecord, { mode: 0o600 });
      const recordEntry = journalIdentity(await lstat(recordPath));
      const socketEntry = journalIdentity(await lstat(socketPath));

      const report = await reapOwnedRunRoot(root);

      expect(report.rootRemoved).toBe(false);
      expect(report.leaks.some((leak) => leak.includes("generation"))).toBe(true);
      expect(await readDaemonIdentity(daemonPid)).toEqual(authority.daemon);
      expect(await readFile(recordPath, "utf8")).toBe(mutatedRecord);
      expect(journalIdentity(await lstat(recordPath))).toEqual(recordEntry);
      expect(journalIdentity(await lstat(socketPath))).toEqual(socketEntry);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
        await exitChildWithin(worker, 2_000);
      }
      const reaped = wrapperPid;
      if (reaped !== undefined) {
        await reapWithoutMasking("wrapper exit", () => waitForProcessExit(reaped));
      }
      if (captured !== undefined) await terminateCapturedTmux(captured);
      await rm(parent, { force: true, recursive: true });
    }
  }, 30_000);

  test("refuses a fabricated non-tmux daemon record without signaling its process", async () => {
    const { parent, root } = await createIsolatedRunRoot("fabricated-non-tmux");
    const reservation = join(root, "fabricated");
    await mkdir(reservation, { mode: 0o700 });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childClosed = closeChild(child);
    if (child.pid === undefined) throw new Error("test child has no PID");
    const identity = await readProcessIdentity(child.pid);
    if (identity === undefined) throw new Error("test child exited before identity capture");
    const owner = JSON.parse(await readFile(join(root, OWNER_RECORD_NAME), "utf8")) as {
      runId: string;
    };
    const socketPath = join(reservation, "s");
    const listener = await listenOnUnixSocket(socketPath);
    await writeFile(
      join(reservation, "fixture.json"),
      `${JSON.stringify({
        daemon: {
          ...identity,
          comm: "tmux: server",
          executablePath: await realpath(`/proc/${String(child.pid)}/exe`),
        },
        logicalSocketName: "fabricated",
        owner: await readProcessIdentity(process.pid),
        phase: "running",
        protocol: "libtmux-test-fixture-v2",
        runId: owner.runId,
        socketIdentity: journalIdentity(await lstat(socketPath)),
        socketPath,
        tmuxExecutable: "tmux",
      })}\n`,
      { mode: 0o600 },
    );
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks.some((leak) => /bad magic|protocol/u.test(leak))).toBe(true);
      expect(processExists(child.pid)).toBe(true);
    } finally {
      if (processExists(child.pid)) child.kill("SIGKILL");
      await childClosed.catch(() => undefined);
      await closeNetServer(listener);
      await unlink(socketPath).catch(() => undefined);
      await removeIsolatedRunRoot(parent, root);
    }
  });

  test("refuses a fabricated stale record copied from a tmux daemon on another socket", async () => {
    const unrelatedRoot = await createIsolatedRunRoot("unrelated-tmux-root");
    const unrelated = await TestServer.create({ runRoot: unrelatedRoot.root });
    const stale = await createIsolatedRunRoot("fabricated-stale-tmux");
    const reservation = join(stale.root, "fabricated");
    await mkdir(reservation, { mode: 0o700 });
    const ownerPath = join(stale.root, OWNER_RECORD_NAME);
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { runId: string };
    const daemon = await readDaemonIdentity(unrelated.daemonIdentity.pid);
    if (daemon === undefined) throw new Error("unrelated tmux daemon disappeared");
    const socketPath = join(reservation, "s");
    const listener = await listenOnUnixSocket(socketPath);
    await writeFile(
      join(reservation, "fixture.json"),
      `${JSON.stringify({
        daemon,
        logicalSocketName: "fabricated",
        owner: await readProcessIdentity(process.pid),
        phase: "running",
        protocol: "libtmux-test-fixture-v2",
        runId: owner.runId,
        socketIdentity: journalIdentity(await lstat(socketPath)),
        socketPath,
        tmuxExecutable: "tmux",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        ...owner,
        owner: {
          pid: 2_147_483_000,
          startIdentity: "linux:00000000-0000-4000-8000-000000000000:1",
        },
      })}\n`,
      { mode: 0o600 },
    );
    try {
      const report = await reapStaleRunRoot(stale.root);
      expect(processExists(unrelated.daemonIdentity.pid)).toBe(true);
      expect(report.leaks.some((leak) => /bad magic|protocol/u.test(leak))).toBe(true);
      expect(
        (await unrelated.executeText(["display-message", "-p", "#{socket_path}"])).stdout,
      ).toEqual([unrelated.socketPath]);
    } finally {
      await closeNetServer(listener);
      await unlink(socketPath).catch(() => undefined);
      await unrelated.dispose().catch(() => undefined);
      await removeIsolatedRunRoot(unrelatedRoot.parent, unrelatedRoot.root);
      await rm(stale.parent, { force: true, recursive: true });
    }
  });

  test("refuses to record another socket's tmux daemon for a legitimate reservation", async () => {
    const { parent, root } = await createIsolatedRunRoot("record-wrong-daemon");
    const unrelated = await TestServer.create({ runRoot: root });
    const reserved = await reserveFixture(root);
    const { attempt } = await beginSyntheticLaunch(reserved);
    const daemon = await readDaemonIdentity(unrelated.daemonIdentity.pid);
    if (daemon === undefined) throw new Error("unrelated tmux daemon disappeared");
    let recordError: unknown;
    try {
      try {
        await promoteFixtureLaunch(attempt, daemon.pid);
      } catch (error) {
        recordError = error;
      }
      expect(processExists(unrelated.daemonIdentity.pid)).toBe(true);
      expect(recordError).toBeInstanceOf(Error);
    } finally {
      await rollbackFixtureLaunchNotStarted(attempt).catch(() => undefined);
      await reapFixture(reserved.capability).catch(() => undefined);
      await unrelated.dispose().catch(() => undefined);
      await removeIsolatedRunRoot(parent, root);
    }
  });

  test("rejects the legacy path-and-record phase writer before it can publish authority", async () => {
    const { parent, root } = await createIsolatedRunRoot("legacy-phase-writer");
    const reserved = await reserveFixture(root);
    try {
      await expect(
        Reflect.apply(beginFixtureLaunch, undefined, [
          reserved.recordPath,
          { bootstrapArgv: [], generation: { name: "invalid", value: "invalid" } },
        ]),
      ).rejects.toThrow("authenticated reservation capability");
      expect((await readFixtureRecord(reserved.reservationPath)).phase).toBe("reserved");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("rejects a structurally copied reservation capability at runtime", async () => {
    const { parent, root } = await createIsolatedRunRoot("fake-writer-capability");
    const reserved = await reserveFixture(root);
    const fakeCapability = { ...reserved.capability };
    try {
      await expect(
        Reflect.apply(beginFixtureLaunch, undefined, [
          fakeCapability,
          { bootstrapArgv: [], generation: { name: "invalid", value: "invalid" } },
        ]),
      ).rejects.toThrow("authenticated reservation capability");
      expect((await readFixtureRecord(reserved.reservationPath)).phase).toBe("reserved");
    } finally {
      await reapFixture(reserved.capability).catch(() => undefined);
      await removeIsolatedRunRoot(parent, root).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("does not let an issued reservation capability be retargeted", async () => {
    const { parent, root } = await createIsolatedRunRoot("retargeted-writer-capability");
    const first = await reserveFixture(root);
    const second = await reserveFixture(root);
    try {
      expect(Reflect.set(first.capability, "recordPath", second.recordPath)).toBe(false);
      expect(Reflect.set(first.capability, "reservationPath", second.reservationPath)).toBe(false);
      expect(first.capability.recordPath).toBe(first.recordPath);
      expect(first.capability.reservationPath).toBe(first.reservationPath);
      expect((await readFixtureRecord(second.reservationPath)).phase).toBe("reserved");
    } finally {
      await reapFixture(first.capability).catch(() => undefined);
      await reapFixture(second.capability).catch(() => undefined);
      await removeIsolatedRunRoot(parent, root).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("rejects the legacy daemon writer without a launch-attempt capability", async () => {
    const { parent, root } = await createIsolatedRunRoot("legacy-daemon-writer");
    const reserved = await reserveFixture(root);
    try {
      await expect(
        Reflect.apply(promoteFixtureLaunch, undefined, [reserved.recordPath, process.pid]),
      ).rejects.toThrow("authenticated launch-attempt capability");
      expect((await readFixtureRecord(reserved.reservationPath)).phase).toBe("reserved");
    } finally {
      await reapFixture(reserved.capability);
      await removeIsolatedRunRoot(parent, root);
    }
  });

  test("does not adopt an exact-path daemon with the wrong generation", async () => {
    const parent = await makeTestDirectory("ltx4-");
    const root = join(parent, "r");
    await prepareRunRoot(root);
    const reserved = await reserveFixture(root);
    const { attempt, record: launching } = await beginSyntheticLaunch(reserved);
    const pid = await launchExactTmux(launching.socketPath);
    try {
      const report = await reapFixture(reserved.capability);
      expect(report.leaks.some((leak) => leak.includes("generation"))).toBe(true);
      expect(processExists(pid)).toBe(true);
      expect((await lstat(launching.socketPath)).isSocket()).toBe(true);
      expect((await readFixtureRecord(reserved.reservationPath)).phase).toBe("launching");
    } finally {
      await killExactTmux(launching.socketPath, pid);
      await unlink(launching.socketPath).catch(() => undefined);
      await rollbackFixtureLaunchNotStarted(attempt);
      await reapFixture(reserved.capability);
      await removeIsolatedRunRoot(parent, root);
    }
  });

  for (const intendedState of ["live", "exited"] as const) {
    test(`preserves a foreign replacement socket when the recorded daemon is ${intendedState}`, async () => {
      const parent = await makeTestDirectory(`ltx4-foreign-socket-${intendedState}-`);
      const root = join(parent, "root");
      const intendedRecoverySocket = join(parent, "intended.sock");
      const replacementRecoverySocket = join(parent, "replacement.sock");
      await prepareRunRoot(root);
      const intended = await TestServer.create({ runRoot: root });
      if (intendedState === "exited") {
        const killed = await closeChild(
          spawn("tmux", ["-N", "-S", intended.socketPath, "kill-server"], {
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
        if (killed.code !== 0) throw new Error(`intended tmux kill failed: ${killed.stderr}`);
        await waitForProcessExit(intended.daemonIdentity.pid);
      }
      await rename(intended.socketPath, intendedRecoverySocket);
      const replacementPid = await launchExactTmux(intended.socketPath);
      await link(intended.socketPath, replacementRecoverySocket);
      const replacementSocketIdentity = journalIdentity(await lstat(intended.socketPath));
      let cleanupError: unknown;
      try {
        await intended.dispose();
      } catch (error) {
        cleanupError = error;
      }
      try {
        expect(String(cleanupError)).toContain("foreign socket");
        if (intendedState === "live") {
          await waitForProcessExit(intended.daemonIdentity.pid);
        }
        expect(processExists(replacementPid)).toBe(true);
        expect(journalIdentity(await lstat(intended.socketPath))).toEqual(
          replacementSocketIdentity,
        );
        expect((await lstat(intended.recordPath)).isFile()).toBe(true);
        const replacementSocket = await closeChild(
          spawn("tmux", ["-N", "-S", intended.socketPath, "display-message", "-p", "#{pid}"], {
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
        expect(replacementSocket.stdout.trim()).toBe(String(replacementPid));
      } finally {
        await killExactTmux(replacementRecoverySocket, replacementPid);
        await unlink(replacementRecoverySocket).catch(() => undefined);
        await unlink(intendedRecoverySocket).catch(() => undefined);
        await unlink(intended.socketPath).catch(() => undefined);
        await rm(parent, { force: true, recursive: true });
      }
    }, 30_000);
  }

  test("fails closed on a version-one running record instead of inferring socket authority", async () => {
    const { parent, root } = await createIsolatedRunRoot("version-one-record");
    const server = await TestServer.create({ runRoot: root });
    const original = await readFile(server.recordPath, "utf8");
    const oldRecord = JSON.parse(original) as Record<string, unknown>;
    oldRecord.protocol = "libtmux-test-fixture-v1";
    delete oldRecord.socketIdentity;
    await writeFile(server.recordPath, `${JSON.stringify(oldRecord)}\n`, { mode: 0o600 });
    try {
      const report = await reapOwnedRunRoot(root);
      expect(report.leaks.some((leak) => leak.includes("bad magic"))).toBe(true);
      expect(processExists(server.daemonIdentity.pid)).toBe(true);
      expect((await lstat(server.socketPath)).isSocket()).toBe(true);
      expect((await lstat(server.recordPath)).isFile()).toBe(true);
    } finally {
      if (
        await access(server.recordPath)
          .then(() => true)
          .catch(() => false)
      ) {
        await writeFile(server.recordPath, original, { mode: 0o600 });
        await server.dispose().catch(() => undefined);
      } else {
        await killExactTmux(server.socketPath, server.daemonIdentity.pid);
      }
      await rm(parent, { force: true, recursive: true });
    }
  });

  for (const mutation of ["reserved-with-daemon", "running-without-socket"] as const) {
    test(`rejects a fixture phase/authority mismatch: ${mutation}`, async () => {
      const { parent, root } = await createIsolatedRunRoot(`phase-authority-${mutation}`);
      const server = await TestServer.create({ runRoot: root });
      const original = await readFile(server.recordPath, "utf8");
      const tampered = JSON.parse(original) as Record<string, unknown>;
      if (mutation === "reserved-with-daemon") {
        tampered.phase = "reserved";
        delete tampered.socketIdentity;
      } else {
        tampered.phase = "running";
        delete tampered.socketIdentity;
      }
      await writeFile(server.recordPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
      try {
        await expect(readFixtureRecord(server.reservationPath)).rejects.toThrow(
          /fixture identity record/u,
        );
        expect(processExists(server.daemonIdentity.pid)).toBe(true);
      } finally {
        await writeFile(server.recordPath, original, { mode: 0o600 });
        await server.dispose().catch(() => undefined);
        await removeIsolatedRunRoot(parent, root).catch(() => undefined);
        await rm(parent, { force: true, recursive: true });
      }
    });
  }

  for (const order of ["fixture-first", "fixture-last"] as const) {
    test(`rejects ambiguous repeated socket selectors with the fixture ${order}`, async () => {
      const { parent, root } = await createIsolatedRunRoot(`repeated-selector-${order}`);
      const reserved = await reserveFixture(root);
      const otherSocket = join(parent, "other.sock");
      const launch = syntheticLaunchInput(reserved.record);
      const bootstrapArgv = [...launch.bootstrapArgv];
      const insertion = order === "fixture-first" ? 5 : 3;
      bootstrapArgv.splice(insertion, 0, "-S", otherSocket);
      try {
        await expect(
          beginFixtureLaunch(reserved.capability, {
            bootstrapArgv,
            generation: launch.generation,
          }),
        ).rejects.toThrow(/bootstrap argv/u);
        expect((await readFixtureRecord(reserved.reservationPath)).phase).toBe("reserved");
      } finally {
        await reapFixture(reserved.capability);
        await removeIsolatedRunRoot(parent, root);
      }
    });
  }

  test("standalone stale reaper refuses a fixture under a live owner", async () => {
    const { parent, root } = await createIsolatedRunRoot("live-owner-reaper");
    const server = await TestServer.create({ runRoot: root });
    try {
      const reaper = spawn("bun", [reaperPath, "--run-root", root], {
        cwd: tsRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = await closeChildWithin(reaper, 2_000);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("live owner");
      expect(processExists(server.daemonIdentity.pid)).toBe(true);
      expect((await stat(server.socketPath)).isSocket()).toBe(true);
    } finally {
      await server.dispose().catch(() => undefined);
      await removeIsolatedRunRoot(parent, root);
    }
  });

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(`reaps a fixture abandoned by a worker killed with ${signal}`, async () => {
      const { parent, root } = await createIsolatedRunRoot(`worker-${signal}`);
      const marker = join(parent, "ready.json");
      const child = await spawnLeakingWorker(root, "hold", marker);
      try {
        await waitForPathPresent(marker);
        const state = await readJsonMarker<{ daemonPid: number }>(marker);
        child.kill(signal);
        const closed = await closeChild(child);
        expect(
          closed.signal === signal || closed.code === 128 + (signal === "SIGTERM" ? 15 : 9),
        ).toBe(true);
        expect(processExists(state.daemonPid)).toBe(true);

        expect((await reapOwnedRunRoot(root)).leaks).toEqual([]);
        await waitForProcessExit(state.daemonPid);
        await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await closeChild(child).catch(() => undefined);
        }
        await removeIsolatedRunRoot(parent, root);
      }
    }, 30_000);
  }

  test("reaps the published successor after a replacement worker is killed", async () => {
    const { parent, root } = await createIsolatedRunRoot("replacement-worker");
    const marker = join(parent, "ready.json");
    const child = await spawnLeakingWorker(root, "replacement-hold", marker);
    try {
      await waitForPathPresent(marker);
      const state = await readJsonMarker<{ daemonPid: number }>(marker);
      child.kill("SIGKILL");
      const closed = await closeChild(child);
      expect(closed.signal === "SIGKILL" || closed.code === 137).toBe(true);
      expect(processExists(state.daemonPid)).toBe(true);

      expect((await reapOwnedRunRoot(root)).leaks).toEqual([]);
      await waitForProcessExit(state.daemonPid);
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closeChild(child).catch(() => undefined);
      }
      await removeIsolatedRunRoot(parent, root);
    }
  }, 30_000);
});
