import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

import { reportSecondaryCleanupFailure, runWithCleanup } from "./cleanup.js";
import { resolveControllerIdentity } from "./process_identity.js";
import { prepareRunRoot, reapOwnedRunRoot } from "./reaper.js";
import { publishRunRootOwner } from "./records.js";
import { makeTestDirectory } from "./temp_root.js";

export const RUN_ROOT_ENV = "LIBTMUX_TEST_RUN_ROOT";

export interface SupervisorOptions {
  readonly command: readonly [string, ...string[]];
  /** Where the supervised command runs. Defaults to this process's directory. */
  readonly cwd?: string;
  readonly graceMs?: number;
  readonly runRoot?: string;
}

function signalExitCode(signal: NodeJS.Signals): number {
  const number = osConstants.signals[signal];
  if (number === undefined) throw new Error(`unknown signal: ${signal}`);
  return 128 + number;
}

async function terminateSupervisor(signal: "SIGINT" | "SIGTERM"): Promise<never> {
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  const fallback = setTimeout(() => process.exit(signalExitCode(signal)), 250);
  fallback.ref();
  setImmediate(() => {
    process.kill(process.pid, signal);
  });
  return new Promise<never>(() => undefined);
}

/** Run one test command under signal forwarding and authenticated run-root cleanup. */
export async function runSupervisor(options: SupervisorOptions): Promise<number> {
  const graceMs = options.graceMs ?? 500;
  if (!Number.isSafeInteger(graceMs) || graceMs < 1)
    throw new TypeError("graceMs must be positive");
  const runRoot = options.runRoot ?? (await mkdtemp(join(tmpdir(), "ltx-")));
  if (options.runRoot === undefined) {
    await chmod(runRoot, 0o700);
    const controller = await resolveControllerIdentity("tmux");
    await publishRunRootOwner(runRoot, controller);
  } else {
    await prepareRunRoot(runRoot);
  }

  const [executable, ...args] = options.command;
  const child = spawn(executable, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, [RUN_ROOT_ENV]: runRoot },
    shell: false,
    stdio: "inherit",
  });
  let requestedSignal: "SIGINT" | "SIGTERM" | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let hardClose: NodeJS.Timeout | undefined;
  let forceClose: (() => void) | undefined;
  let closeDeadlineExceeded = false;
  const forward = (signal: "SIGINT" | "SIGTERM"): void => {
    if (requestedSignal !== undefined) return;
    requestedSignal = signal;
    child.kill(signal);
    escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, graceMs);
    hardClose = setTimeout(() => {
      closeDeadlineExceeded = true;
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      forceClose?.();
    }, graceMs + 750);
  };
  const onSigint = (): void => forward("SIGINT");
  const onSigterm = (): void => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveChild, reject) => {
        let settled = false;
        const resolveOnce = (value: {
          code: number | null;
          signal: NodeJS.Signals | null;
        }): void => {
          if (settled) return;
          settled = true;
          resolveChild(value);
        };
        forceClose = () => resolveOnce({ code: null, signal: "SIGKILL" });
        child.once("error", reject);
        child.once("close", (code, signal) => resolveOnce({ code, signal }));
      },
    ).catch(async (error: unknown) => {
      try {
        const report = await reapOwnedRunRoot(runRoot);
        if (report.leaks.length > 0) {
          reportSecondaryCleanupFailure(error, new Error(report.leaks.join("; ")));
        }
      } catch (cleanupError) {
        reportSecondaryCleanupFailure(error, cleanupError);
      }
      throw error;
    });
    if (escalation !== undefined) clearTimeout(escalation);
    if (hardClose !== undefined) clearTimeout(hardClose);

    let cleanupFailed = false;
    try {
      const report = await reapOwnedRunRoot(runRoot);
      if (report.leaks.length > 0) throw new Error(report.leaks.join("; "));
    } catch (error) {
      cleanupFailed = true;
      process.stderr.write(`test cleanup failed: ${String(error)}\n`);
    }
    if (closeDeadlineExceeded) {
      cleanupFailed = true;
      process.stderr.write("test child close exceeded hard deadline after SIGKILL\n");
    }

    if (requestedSignal !== undefined) return terminateSupervisor(requestedSignal);

    const childStatus = closed.code ?? (closed.signal === null ? 1 : signalExitCode(closed.signal));
    return childStatus === 0 && cleanupFailed ? 1 : childStatus;
  } finally {
    if (escalation !== undefined) clearTimeout(escalation);
    if (hardClose !== undefined) clearTimeout(hardClose);
    // Bun hides the inherited generic overload, so detach through the EventEmitter view.
    const processEvents: Pick<EventEmitter, "removeListener"> = process;
    processEvents.removeListener("SIGINT", onSigint);
    processEvents.removeListener("SIGTERM", onSigterm);
  }
}

/**
 * Run `body` against a run root, owning that root only when nobody else does.
 *
 * Under a supervisor, `LIBTMUX_TEST_RUN_ROOT` names a root already prepared and
 * reaped by it, so a suite contributes its fixtures there and creates nothing of
 * its own. Without one this owns the whole lifecycle: a directory named for the
 * suite, the root inside it, the reap, and the removal.
 *
 * A directory whose reap failed is kept. What could not be reaped is the
 * evidence for why, and removing it discards the only record.
 */
export async function withOwnedRunRoot<T>(
  prefix: string,
  body: (runRoot: string) => Promise<T>,
): Promise<T> {
  const published = process.env[RUN_ROOT_ENV];
  if (published !== undefined) return body(published);

  const parent = await makeTestDirectory(prefix);
  const runRoot = join(parent, "run, root");
  await prepareRunRoot(runRoot);
  let reaped = false;
  try {
    return await runWithCleanup(
      () => body(runRoot),
      async () => {
        // A reap that reports leaks has not cleaned up, whatever its status
        // says. Treating it as success removed the directory holding the only
        // evidence of what leaked, which is what the supervisor refuses to do
        // for the root it owns.
        const report = await reapOwnedRunRoot(runRoot);
        if (report.leaks.length > 0) throw new Error(report.leaks.join("; "));
        reaped = true;
      },
    );
  } finally {
    if (reaped) await rm(parent, { force: true, recursive: true });
  }
}
