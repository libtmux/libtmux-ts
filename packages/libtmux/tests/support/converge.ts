import { access } from "node:fs/promises";

/**
 * Bounded waits for the resources a failed fixture reclaims.
 *
 * Killing a process and unlinking its socket are the tail of a cleanup that the
 * call which triggered it has already returned from. Asserting the result the
 * instant that promise settles tests whether the assertion outran the kernel,
 * which is true on an idle machine and a coin flip on a busy one. Waiting
 * within a bound keeps the guarantee — the resource is reclaimed — and drops
 * only the assumption that reclamation is synchronous.
 */

/**
 * Bounded for liveness, not for speed.
 *
 * A resource that genuinely leaks is never reclaimed, so a generous bound only
 * delays the report; a tight one fails a cleanup that was merely slow. The
 * second these allowed is shorter than starting a process on a busy machine.
 */
const TIMEOUT_MS = 30_000;
const INTERVAL_MS = 5;

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Signal a process, treating one that has already exited as success.
 *
 * Asking whether it is running first does not help: it can exit between the
 * answer and the signal, and cleanup wants it not running either way. Checking
 * only narrows the window and turns reaching the goal into an error.
 */
export function killIfRunning(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  // A non-positive pid does not name a process: zero signals the caller's own
  // process group, which for cleanup would take the test runner with it.
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`refusing to signal ${String(pid)}, which is not a process id`);
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function waitForProcessExit(pid: number): Promise<void> {
  // Zero is not a process here: `kill(0, 0)` signals the caller's whole group
  // and succeeds, so waiting on it can only ever time out. It means a pid was
  // read before it was written, and saying that beats waiting to say nothing.
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`refusing to wait on ${String(pid)}, which is not a process id`);
  }
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (!processExists(pid)) return;
    if (Date.now() > deadline) {
      throw new Error(`process ${String(pid)} did not exit within the test bound`);
    }
    // eslint-disable-next-line no-await-in-loop -- process exit is observed within one monotonic bound.
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

export async function waitForPathAbsent(path: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop -- absence is observed within one monotonic bound.
      await access(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(`${path} was not reclaimed within the test bound`);
    }
    // eslint-disable-next-line no-await-in-loop -- absence observation is bounded and sequential.
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}
