import { spawn } from "node:child_process";
import { access, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { waitForPathAbsent, waitForProcessExit } from "../support/converge.js";
import { closeChild } from "../support/owned_child.js";

import { resolveNode22 } from "../../src/_internal/test/node22.js";
import { OWNER_RECORD_NAME, reapStaleRunRoot } from "../../src/_internal/test/testkit.js";
import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

const tsRoot = fileURLToPath(new URL("../..", import.meta.url));
const differentialRunnerPath = fileURLToPath(
  new URL("../../scripts/run-differential-tests.ts", import.meta.url),
);
const nodeRunnerPath = fileURLToPath(new URL("../../scripts/test-node.ts", import.meta.url));

async function observePathWhileRunning(
  candidatePath: string,
  child: ReturnType<typeof spawn>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- observation is bounded by process lifetime.
      await access(candidatePath);
      return true;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      // eslint-disable-next-line no-await-in-loop -- observation is bounded by process lifetime.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return false;
}

async function observeReservationWhileRunning(
  runRoot: string,
  child: ReturnType<typeof spawn>,
): Promise<{ distinctOwners: boolean; observed: boolean }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- this observes worker-owned state while the runner is live.
      const entries = await readdir(runRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const reservation = join(runRoot, entry.name);
        // eslint-disable-next-line no-await-in-loop -- both files must coexist in the same observed reservation.
        const [record, socket] = await Promise.all([
          stat(join(reservation, "fixture.json")).catch(() => undefined),
          stat(join(reservation, "s")).catch(() => undefined),
        ]);
        if (record?.isFile() === true && socket?.isSocket() === true) {
          // eslint-disable-next-line no-await-in-loop -- ownership must be read from the reservation just observed.
          const [ownerValue, fixtureValue] = await Promise.all([
            readFile(join(runRoot, OWNER_RECORD_NAME), "utf8"),
            readFile(join(reservation, "fixture.json"), "utf8"),
          ]);
          const owner = JSON.parse(ownerValue) as { owner: { pid: number } };
          const fixture = JSON.parse(fixtureValue) as { owner: { pid: number } };
          return { distinctOwners: owner.owner.pid !== fixture.owner.pid, observed: true };
        }
      }
    } catch {
      // The supervisor may still be publishing the root.
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return { distinctOwners: false, observed: false };
    }
    // eslint-disable-next-line no-await-in-loop -- observation is bounded by process lifetime.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { distinctOwners: false, observed: false };
}

describe("outer test controllers", () => {
  test.skipIf(process.env.LIBTMUX_PYTHON_REPO === undefined)(
    "differential runner uses the exact root published by its caller",
    async () => {
      const parent = await makeTestDirectory("ltx4-ci-root-");
      const root = join(parent, "published, root");
      const child = spawn("bun", [differentialRunnerPath], {
        cwd: tsRoot,
        env: { ...process.env, LIBTMUX_TEST_RUN_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const [rootObserved, reservationObserved] = await Promise.all([
          observePathWhileRunning(root, child),
          observeReservationWhileRunning(root, child),
        ]);
        expect(rootObserved).toBe(true);
        expect(reservationObserved).toEqual({
          distinctOwners: true,
          observed: true,
        });
        const closed = await closeChild(child);
        expect(closed.code, `${closed.stdout}${closed.stderr}`).toBe(0);
        await waitForPathAbsent(root);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await reapStaleRunRoot(root).catch(() => undefined);
        await rm(parent, { force: true, recursive: true });
      }
    },
    60_000,
  );

  for (const mode of ["after-create", "timeout-after-create"] as const) {
    test(`emitted Node ${mode} failure performs exact cleanup before parent removal`, async () => {
      const parent = await makeTestDirectory("ltx4-node-failure-");
      const root = join(parent, "published-node-root");
      const marker = join(parent, "failure.json");
      const node22 = await resolveNode22();
      const child = spawn("bun", [nodeRunnerPath, "--node", node22, "--expect-major", "22"], {
        cwd: tsRoot,
        env: {
          ...process.env,
          LIBTMUX_NODE_FAILURE_MARKER: marker,
          LIBTMUX_NODE_INJECT_FAILURE: mode,
          // The hang this mode injects is ended by the child's own budget, so
          // the budget has to outlast every scenario ahead of it under load.
          // Racing them instead kills the child before it creates the fixture
          // whose cleanup is the thing under test.
          ...(mode === "timeout-after-create" ? { LIBTMUX_NODE_SCENARIO_TIMEOUT_MS: "45000" } : {}),
          LIBTMUX_TEST_RUN_ROOT: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const result = await closeChild(child);
        expect(result.code).not.toBe(0);
        // The marker is written by the injected failure itself, so its absence
        // means the child never reached the injection point. What it did
        // instead is already captured; reporting it turns a bare ENOENT into
        // the reason.
        const recorded = await readFile(marker, "utf8").catch(() => undefined);
        if (recorded === undefined) {
          throw new Error(
            `the emitted Node run never reached its injected ${mode} failure:\n${result.stderr || result.stdout}`,
          );
        }
        const state = JSON.parse(recorded) as { daemonPid: number };
        await waitForProcessExit(state.daemonPid);
        await waitForPathAbsent(root);
      } finally {
        await reapStaleRunRoot(root).catch(() => undefined);
        await rm(parent, { force: true, recursive: true });
      }
    }, 90_000);
  }
});
