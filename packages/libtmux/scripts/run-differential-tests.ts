import { runSupervisor, sweepStaleRunRoots } from "../src/_internal/test/testkit.js";

// Cleanup is a finally, and SIGKILL skips it. A run killed that way left its
// tmux daemon behind under a name no later run revisits; this is where one
// still can. Once per suite process, before anything creates a root of its own.
await sweepStaleRunRoots();

process.exitCode = await runSupervisor({
  command: [
    "bun",
    "test",
    "--no-orphans",
    "--preload",
    "./tests/support/bun_hooks.ts",
    "tests/integration/differential_substrate.test.ts",
  ],
  ...(process.env.LIBTMUX_TEST_RUN_ROOT === undefined
    ? {}
    : { runRoot: process.env.LIBTMUX_TEST_RUN_ROOT }),
});
