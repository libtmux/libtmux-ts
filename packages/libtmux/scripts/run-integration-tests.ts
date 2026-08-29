import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runSupervisor, sweepStaleRunRoots } from "../src/_internal/test/testkit.js";
import { testParallelism } from "../src/_internal/test/testkit.js";

import { LINUX_HARNESS, NODE22, preflight } from "./preflight.js";

/**
 * The suites this runner is responsible for, checked before it starts.
 *
 * `bun test` treats a path it cannot find as nothing to run and exits 0, so a
 * renamed suite disappears from the gate silently. Two did: the consumer suites
 * moved from `consumers/` to their own packages and this file went on naming
 * the old paths, so `test:integration` reported green over two files it never
 * loaded.
 */
const SUITES: readonly string[] = [
  "tests/integration/test_server_bootstrap.test.ts",
  "tests/integration/test_server_controller_identity.test.ts",
  "tests/integration/test_server_recovery.test.ts",
  "tests/integration/test_server_cleanup.test.ts",
  "tests/integration/control_mode.test.ts",
  "tests/integration/fixture_reaper.test.ts",
  "tests/integration/run_root_recovery.test.ts",
  "tests/integration/fixture_escrow_recovery.test.ts",
  "tests/integration/process_identity_reaping.test.ts",
  "tests/integration/test_supervisor.test.ts",
  "tests/integration/test_runners.test.ts",
  "tests/integration/graph.test.ts",
  "tests/integration/contract.test.ts",
  "tests/integration/control_bounds.test.ts",
  "tests/integration/control_forgery.test.ts",
  "tests/integration/acquire.test.ts",
  "tests/integration/snapshot.test.ts",
  "tests/integration/version_gate.test.ts",
  "tests/integration/options.test.ts",
  "tests/integration/mutations.test.ts",
  "tests/integration/pane_io.test.ts",
  "tests/integration/topology.test.ts",
  "tests/integration/server_utils.test.ts",
  "tests/integration/shell.test.ts",
  "tests/integration/interactive.test.ts",
  "tests/integration/watch.test.ts",
  "tests/integration/documented_commands.test.ts",
  "tests/integration/engine.test.ts",
  // Cited as evidence elsewhere and, until this check existed, never run: the
  // parity ledger names `environment` for five symbols, and the generated field
  // types name `format_types` as what proves them on every version CI runs.
  "tests/integration/environment.test.ts",
  "tests/integration/format_types.test.ts",
];

/** Run by `test:differential`, which needs the Python oracle this runner has no part in. */
const ELSEWHERE: ReadonlySet<string> = new Set([
  "tests/integration/differential_substrate.test.ts",
]);

const listed: ReadonlySet<string> = new Set(SUITES);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const missing = SUITES.filter((suite) => !existsSync(new URL(suite, `file://${packageRoot}`)));
if (missing.length > 0) {
  process.stderr.write(`integration suites are missing: ${missing.join(", ")}\n`);
  process.exit(1);
}

const found = new Set(
  Array.from(new Bun.Glob("tests/integration/*.test.ts").scanSync({ cwd: packageRoot })),
);
const unlisted = [...found]
  .filter((suite) => !listed.has(suite) && !ELSEWHERE.has(suite))
  .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
if (unlisted.length > 0) {
  process.stderr.write(`integration suites are not listed here: ${unlisted.join(", ")}\n`);
  process.exit(1);
}

await preflight([LINUX_HARNESS, NODE22]);

// Cleanup is a finally, and SIGKILL skips it. A run killed that way left its
// tmux daemon behind under a name no later run revisits; this is where one
// still can. Once per suite process, before anything creates a root of its own.
await sweepStaleRunRoots();

process.exitCode = await runSupervisor({
  command: [
    "bun",
    "test",
    `--parallel=${String(testParallelism())}`,
    "--no-orphans",
    // Bun's default bound is sized for a unit test, not for one that starts a
    // tmux server, waits for a shell, and reaps it again. A liveness bound for
    // the tests that name none of their own: one that genuinely hangs still
    // fails, later.
    "--timeout",
    "60000",
    "--preload",
    "./tests/support/bun_hooks.ts",
    ...SUITES,
  ],
  ...(process.env.LIBTMUX_TEST_RUN_ROOT === undefined
    ? {}
    : { runRoot: process.env.LIBTMUX_TEST_RUN_ROOT }),
});
