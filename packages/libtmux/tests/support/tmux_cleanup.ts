import { deepStrictEqual, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, readFile, unlink } from "node:fs/promises";

import { readDaemonIdentity } from "../../src/_internal/test/testkit.js";
import { closeChildWithin, waitForProcessExit } from "./converge.js";
import { closeChild } from "./owned_child.js";

interface CapturedTmuxCleanup {
  readonly commandLine: Buffer;
  readonly daemon: NonNullable<Awaited<ReturnType<typeof readDaemonIdentity>>>;
  readonly recoverySocket: string;
  readonly socketIdentity: { readonly device: bigint; readonly inode: bigint };
}

async function captureTmuxCleanup(
  pid: number,
  socketPath: string,
  recoverySocket: string,
): Promise<CapturedTmuxCleanup> {
  const daemon = await readDaemonIdentity(pid);
  if (daemon === undefined) throw new Error("test-owned tmux daemon disappeared before capture");
  const commandLine = await readFile(`/proc/${String(pid)}/cmdline`);
  const socket = await lstat(socketPath, { bigint: true });
  if (!socket.isSocket()) throw new Error("test-owned tmux path is not a socket");
  await link(socketPath, recoverySocket);
  const recovery = await lstat(recoverySocket, { bigint: true });
  if (recovery.dev !== socket.dev || recovery.ino !== socket.ino) {
    throw new Error("test-owned recovery socket does not match the captured socket");
  }
  return {
    commandLine,
    daemon,
    recoverySocket,
    socketIdentity: { device: socket.dev, inode: socket.ino },
  };
}

async function terminateCapturedTmux(captured: CapturedTmuxCleanup): Promise<void> {
  const recovery = await lstat(captured.recoverySocket, { bigint: true });
  deepStrictEqual({ device: recovery.dev, inode: recovery.ino }, captured.socketIdentity);
  const observed = await readDaemonIdentity(captured.daemon.pid);
  if (observed === undefined) return;
  deepStrictEqual(observed, captured.daemon);
  strictEqual(
    (await readFile(`/proc/${String(captured.daemon.pid)}/cmdline`)).toString("hex"),
    captured.commandLine.toString("hex"),
  );
  const mismatch = `test-cleanup-mismatch-${randomUUID()}`;
  const child = spawn(
    captured.daemon.executablePath,
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
  if (closed.code !== 0 || stdoutText === `${mismatch}\n`) {
    throw new Error(`test-owned tmux cleanup refused: ${stderrText || stdoutText}`);
  }
  await waitForProcessExit(captured.daemon.pid);
  strictEqual(await readDaemonIdentity(captured.daemon.pid), undefined);
  const after = await lstat(captured.recoverySocket, { bigint: true });
  deepStrictEqual({ device: after.dev, inode: after.ino }, captured.socketIdentity);
}

async function reapRedLaunch(socketPath: string): Promise<void> {
  const tmux = Bun.which("tmux");
  if (tmux === null) throw new Error("tmux is required");
  const child = spawn(tmux, ["-S", socketPath, "kill-server"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function launchExactTmux(socketPath: string): Promise<number> {
  const launched = await closeChild(
    spawn(
      "tmux",
      [
        "-f",
        "/dev/null",
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pid}",
        "-s",
        `replacement-${randomUUID().slice(0, 8)}`,
        "exec cat",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  if (launched.code !== 0) throw new Error(`tmux exact launch failed: ${launched.stderr}`);
  const pid = Number.parseInt(launched.stdout.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("tmux exact launch returned bad PID");
  return pid;
}

async function killExactTmux(socketPath: string, pid: number): Promise<void> {
  const recoverySocket = `${socketPath}.test-cleanup-${randomUUID()}`;
  const captured = await captureTmuxCleanup(pid, socketPath, recoverySocket);
  await terminateCapturedTmux(captured);
  const original = await lstat(socketPath, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (original !== undefined) {
    deepStrictEqual({ device: original.dev, inode: original.ino }, captured.socketIdentity);
    await unlink(socketPath);
  }
  const recovery = await lstat(recoverySocket, { bigint: true });
  deepStrictEqual({ device: recovery.dev, inode: recovery.ino }, captured.socketIdentity);
  await unlink(recoverySocket);
}

export { captureTmuxCleanup, killExactTmux, launchExactTmux, reapRedLaunch, terminateCapturedTmux };
export type { CapturedTmuxCleanup };
