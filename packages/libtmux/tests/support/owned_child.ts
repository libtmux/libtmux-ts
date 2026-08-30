import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const tsRoot = fileURLToPath(new URL("../..", import.meta.url));
const workerPath = fileURLToPath(new URL("../fixtures/leaking_tmux_worker.ts", import.meta.url));

interface ClosedChild {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function closeChild(child: ReturnType<typeof spawn>): Promise<ClosedChild> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
}

async function closeChildWithin(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<ClosedChild> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const onStdout = (chunk: Buffer): number => stdout.push(chunk);
  const onStderr = (chunk: Buffer): number => stderr.push(chunk);
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  const waitForClose = async (
    boundMs: number,
  ): Promise<{ code: number | null; signal: string | null } | undefined> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { code: child.exitCode, signal: child.signalCode };
    }
    return await new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        child.removeListener("close", onClose);
        child.removeListener("error", onError);
      };
      const onClose = (code: number | null, signal: string | null): void => {
        cleanup();
        resolve({ code, signal });
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, boundMs);
      timer.unref();
      child.once("close", onClose);
      child.once("error", onError);
      if (child.exitCode !== null || child.signalCode !== null) {
        onClose(child.exitCode, child.signalCode);
      }
    });
  };
  try {
    let closed = await waitForClose(timeoutMs);
    if (closed === undefined) {
      child.kill("SIGTERM");
      closed = await waitForClose(100);
    }
    if (closed === undefined) {
      child.kill("SIGKILL");
      closed = await waitForClose(500);
    }
    if (closed === undefined) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      throw new Error("owned child did not close after SIGKILL");
    }
    return {
      ...closed,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    };
  } finally {
    child.stdout?.removeListener("data", onStdout);
    child.stderr?.removeListener("data", onStderr);
  }
}

async function exitChildWithin(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("child exit exceeded hard deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read a marker once it holds a whole JSON document.
 *
 * A worker creates its marker and writes to it as two steps, so a reader that
 * waits only for the path can arrive between them and parse a fragment. Waiting
 * for the content to parse is the same wait, expressed against what the caller
 * actually needs.
 */
async function readJsonMarker<T>(path: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature.
    last = await readFile(path, "utf8").catch(() => "");
    if (last.trim() !== "") {
      try {
        return JSON.parse(last) as T;
      } catch {
        // Written but not yet whole; the next read is the one that works.
      }
    }
    if (Date.now() > deadline) throw new Error(`marker never became readable: ${path} (${last})`);
    // eslint-disable-next-line no-await-in-loop -- each wait follows the read before it.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function spawnLeakingWorker(
  root: string,
  mode: string,
  marker: string,
  environment: NodeJS.ProcessEnv = {},
) {
  return spawn("bun", [workerPath, "--mode", mode, "--marker", marker], {
    cwd: tsRoot,
    env: { ...process.env, ...environment, LIBTMUX_TEST_RUN_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export { closeChild, closeChildWithin, exitChildWithin, readJsonMarker, spawnLeakingWorker };
export type { ClosedChild };
