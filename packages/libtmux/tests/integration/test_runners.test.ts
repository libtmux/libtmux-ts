import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveNode22,
  reapStaleRunRoot,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";
import { waitForPathAbsent, waitForProcessExit } from "../support/converge.js";
import { closeChild } from "../support/owned_child.js";

const tsRoot = fileURLToPath(new URL("../..", import.meta.url));
const nodeRunnerPath = fileURLToPath(new URL("../../scripts/test-node.ts", import.meta.url));

describe("outer test controllers", () => {
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
          // the budget has to outlast every scenario ahead of it. The runner
          // scales what it reads, so this is the idle-machine figure; racing
          // those scenarios instead kills the child before it creates the
          // fixture whose cleanup is the thing under test.
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
