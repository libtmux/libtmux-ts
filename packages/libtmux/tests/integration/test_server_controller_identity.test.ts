import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, renameSync, statSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  ControlMode,
  readProcessIdentity,
  prepareRunRoot,
  reapOwnedRunRoot,
  type FixtureRecord,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { closeChildWithin, waitForProcessExit } from "../support/converge.js";
import type { CapturedTmuxCleanup } from "../support/tmux_cleanup.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface ReplacedControllerCleanup extends CapturedTmuxCleanup {
  readonly cleanupExecutable: string;
  readonly executableIdentity: { readonly device: bigint; readonly inode: bigint };
  readonly recordBytes: string;
  readonly recordIdentity: { readonly device: bigint; readonly inode: bigint };
  readonly recordPath: string;
}

interface ReplaceableControllerHarness {
  readonly cleanupExecutable: string;
  readonly controllerExecutable: string;
  readonly decoyExecutable: string;
  readonly marker: string;
  readonly parent: string;
  readonly recoverySocket: string;
  readonly root: string;
}

async function makeReplaceableControllerHarness(
  name: string,
): Promise<ReplaceableControllerHarness> {
  const tmux = Bun.which("tmux");
  if (tmux === null) throw new Error("tmux is required");
  const parent = await makeTestDirectory(`ltx4-controller-${name}-`);
  const root = join(parent, "root");
  const controllerExecutable = join(parent, "tmux");
  const cleanupExecutable = join(parent, "tmux-controller-recovery");
  const decoyExecutable = join(parent, "tmux-controller-decoy");
  const marker = join(parent, "decoy-invoked");
  const recoverySocket = join(parent, "recovery.sock");
  await copyFile(await realpath(tmux), controllerExecutable);
  await chmod(controllerExecutable, 0o700);
  await link(controllerExecutable, cleanupExecutable);
  // Recording the argv, not just the fact: if this ever runs, the question is
  // which invocation reached it, and a bare "invoked" cannot answer that.
  await writeFile(
    decoyExecutable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(marker)}\nexit 91\n`,
    { mode: 0o700 },
  );
  await prepareRunRoot(root, controllerExecutable);
  return {
    cleanupExecutable,
    controllerExecutable,
    decoyExecutable,
    marker,
    parent,
    recoverySocket,
    root,
  };
}

function captureControllerReplacementSync(
  recordPath: string,
  cleanupExecutable: string,
  recoverySocket: string,
): ReplacedControllerCleanup {
  const recordBytes = readFileSync(recordPath, "utf8");
  const record = JSON.parse(recordBytes) as FixtureRecord;
  if (record.phase !== "running") throw new Error("fixture did not publish running authority");
  const recordEntry = lstatSync(recordPath, { bigint: true });
  const socket = lstatSync(record.socketPath, { bigint: true });
  if (!socket.isSocket()) throw new Error("test-owned tmux path is not a socket");
  linkSync(record.socketPath, recoverySocket);
  const executable = statSync(`/proc/${String(record.daemon.pid)}/exe`, { bigint: true });
  const recoveryExecutable = lstatSync(cleanupExecutable, { bigint: true });
  if (executable.dev !== recoveryExecutable.dev || executable.ino !== recoveryExecutable.ino) {
    throw new Error("test cleanup executable does not match the captured daemon inode");
  }
  return {
    cleanupExecutable,
    commandLine: readFileSync(`/proc/${String(record.daemon.pid)}/cmdline`),
    daemon: record.daemon,
    executableIdentity: { device: executable.dev, inode: executable.ino },
    recordBytes,
    recordIdentity: { device: recordEntry.dev, inode: recordEntry.ino },
    recordPath,
    recoverySocket,
    socketIdentity: { device: socket.dev, inode: socket.ino },
  };
}

async function captureControllerReplacement(
  server: TestServer,
  harness: ReplaceableControllerHarness,
): Promise<ReplacedControllerCleanup> {
  return captureControllerReplacementSync(
    server.recordPath,
    harness.cleanupExecutable,
    harness.recoverySocket,
  );
}

async function assertControllerEvidence(captured: ReplacedControllerCleanup): Promise<void> {
  expect(await readFile(captured.recordPath, "utf8")).toBe(captured.recordBytes);
  const record = await lstat(captured.recordPath, { bigint: true });
  expect({ device: record.dev, inode: record.ino }).toEqual(captured.recordIdentity);
  const socket = await lstat(captured.recoverySocket, { bigint: true });
  expect({ device: socket.dev, inode: socket.ino }).toEqual(captured.socketIdentity);
  // A refused launch leaves the fixture's only pane command finished, so its
  // session goes and tmux exits on its own. The invariant is that nothing
  // replaced the daemon under us, not that it outlived this assertion: check
  // its identity while it is there, and accept that it may already be gone.
  // The daemon may exit at any point during these reads, including between two
  // of them, so the whole sequence tolerates its disappearance rather than
  // testing existence once and assuming it holds for the rest.
  let evidence:
    | { commandLine: string; executable: { device: bigint; inode: bigint }; identity: unknown }
    | undefined;
  try {
    const identity = await readProcessIdentity(captured.daemon.pid);
    if (identity === undefined) return;
    const executable = await stat(`/proc/${String(captured.daemon.pid)}/exe`, { bigint: true });
    const commandLine = await readFile(`/proc/${String(captured.daemon.pid)}/cmdline`);
    evidence = {
      commandLine: commandLine.toString("hex"),
      executable: { device: executable.dev, inode: executable.ino },
      identity,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return;
    throw error;
  }

  expect(evidence.identity).toEqual({
    pid: captured.daemon.pid,
    startIdentity: captured.daemon.startIdentity,
  });
  expect(evidence.executable).toEqual(captured.executableIdentity);
  expect(evidence.commandLine).toBe(captured.commandLine.toString("hex"));
}

async function terminateAfterControllerReplacement(
  captured: ReplacedControllerCleanup,
): Promise<void> {
  await assertControllerEvidence(captured);
  // The fixture's own cleanup races this: a replaced controller makes creation
  // fail, and that failure's cleanup may already have reaped the daemon. What
  // has to hold is that the daemon does not survive, not that it is still alive
  // at this instant, so finding it already gone satisfies the check rather than
  // breaking it.
  if ((await readProcessIdentity(captured.daemon.pid)) === undefined) return;
  expect((await readFile(`/proc/${String(captured.daemon.pid)}/comm`, "utf8")).trim()).toBe(
    "tmux: server",
  );
  const cleanupExecutable = await lstat(captured.cleanupExecutable, { bigint: true });
  expect({ device: cleanupExecutable.dev, inode: cleanupExecutable.ino }).toEqual(
    captured.executableIdentity,
  );
  const mismatch = `test-cleanup-mismatch-${randomUUID()}`;
  const child = spawn(
    captured.cleanupExecutable,
    [
      "-N",
      "-S",
      captured.recoverySocket,
      "if-shell",
      "-F",
      `#{==:#{pid},${String(captured.daemon.pid)}}`,
      "kill-server",
      `display-message -p ${mismatch}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = await closeChildWithin(child, 2_000);
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  // The recovery socket is a hard link to the daemon's own, so "no server
  // running" is not a refusal — it is the daemon having already closed it on
  // the way out. Either way the requirement is the same one asserted below:
  // the daemon does not survive.
  const alreadyGone = stderrText.includes("no server running");
  if (!alreadyGone && (closed.code !== 0 || stdoutText === `${mismatch}\n`)) {
    throw new Error(`test-owned tmux cleanup refused: ${stderrText || stdoutText}`);
  }
  await waitForProcessExit(captured.daemon.pid);
  expect(await readProcessIdentity(captured.daemon.pid)).toBeUndefined();
}

async function restoreAndRemoveControllerHarness(
  harness: ReplaceableControllerHarness,
  captured: ReplacedControllerCleanup | undefined,
): Promise<void> {
  if (captured !== undefined && (await readProcessIdentity(captured.daemon.pid)) !== undefined) {
    await terminateAfterControllerReplacement(captured);
  }
  await unlink(harness.controllerExecutable).catch(() => undefined);
  await link(harness.cleanupExecutable, harness.controllerExecutable);
  const report = await reapOwnedRunRoot(harness.root);
  expect(report.leaks).toEqual([]);
  expect(report.rootRemoved).toBe(true);
  if (captured !== undefined) await unlink(captured.recoverySocket).catch(() => undefined);
  await rm(harness.parent, { force: true, recursive: true });
}

describe("TestServer controller identity", () => {
  test("refuses readiness before transport when the trusted controller is replaced", async () => {
    const harness = await makeReplaceableControllerHarness("readiness");
    let captured: ReplacedControllerCleanup | undefined;
    let failure: unknown;
    let replaced = false;
    try {
      await TestServer.create({
        requestObserver: (request) => {
          if (request.purpose !== "readiness" || replaced) return;
          const socketPath = request.args[2];
          if (socketPath === undefined) throw new Error("readiness request has no exact socket");
          captured = captureControllerReplacementSync(
            join(dirname(socketPath), "fixture.json"),
            harness.cleanupExecutable,
            harness.recoverySocket,
          );
          renameSync(harness.decoyExecutable, harness.controllerExecutable);
          replaced = true;
        },
        runRoot: harness.root,
        tmuxExecutable: harness.controllerExecutable,
      }).catch((error: unknown) => {
        failure = error;
      });
      expect(replaced).toBe(true);
      if (captured === undefined)
        throw new Error("readiness replacement did not capture authority");
      await assertControllerEvidence(captured);
      // What must never happen is the fixture executing a replaced controller.
      // One invoker is outside its reach: tmux launches the readiness pane
      // before the replacement, and the shell inside that pane resolves the
      // controller path itself, whenever it gets scheduled. No check the
      // fixture performs can sit between that resolution and the exec, so the
      // pane's own handshake is the one invocation allowed to reach the decoy —
      // and its argv says so exactly.
      const decoyArgv = await readFile(harness.marker, "utf8").catch(() => undefined);
      const fromReadinessPane =
        decoyArgv !== undefined &&
        /^-N\n-S\n\S+\nwait-for\n-S\nready-[0-9a-f-]+\n$/u.test(decoyArgv);
      expect(fromReadinessPane ? "the readiness pane" : (decoyArgv ?? "the readiness pane")).toBe(
        "the readiness pane",
      );
      expect(String(failure)).toMatch(/controller.*(?:changed|replaced)/iu);
    } finally {
      await restoreAndRemoveControllerHarness(harness, captured);
    }
  });

  test("refuses an ordinary command before transport when the trusted controller is replaced", async () => {
    const harness = await makeReplaceableControllerHarness("ordinary");
    const server = await TestServer.create({
      runRoot: harness.root,
      tmuxExecutable: harness.controllerExecutable,
    });
    const captured = await captureControllerReplacement(server, harness);
    let failure: unknown;
    try {
      await rename(harness.decoyExecutable, harness.controllerExecutable);
      await server.executeRaw(["display-message", "-p", "ordinary"]).catch((error: unknown) => {
        failure = error;
      });
      await assertControllerEvidence(captured);
      await expect(access(harness.marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(String(failure)).toMatch(/controller.*(?:changed|replaced)/iu);
    } finally {
      await restoreAndRemoveControllerHarness(harness, captured);
    }
  });

  test("refuses ControlMode before spawn when the trusted controller is replaced", async () => {
    const harness = await makeReplaceableControllerHarness("control");
    const server = await TestServer.create({
      runRoot: harness.root,
      tmuxExecutable: harness.controllerExecutable,
    });
    const captured = await captureControllerReplacement(server, harness);
    let failure: unknown;
    try {
      await rename(harness.decoyExecutable, harness.controllerExecutable);
      await ControlMode.open({ server, targetSession: server.sessionId }).catch(
        (error: unknown) => {
          failure = error;
        },
      );
      await assertControllerEvidence(captured);
      await expect(access(harness.marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(String(failure)).toMatch(/controller.*(?:changed|replaced)/iu);
    } finally {
      await restoreAndRemoveControllerHarness(harness, captured);
    }
  });
});
