import { RUN_ROOT_ENV, runSupervisor, sweepStaleRunRoots } from "../src/_internal/test/testkit.js";

// Only a top-level runner owns the namespace sweep. A nested runner inherits
// its parent's exact root and must not race that owner or an explicit reaper.
if (process.env[RUN_ROOT_ENV] === undefined) await sweepStaleRunRoots();

process.exitCode = await runSupervisor({
  command: [
    "bun",
    "test",
    "--no-orphans",
    "--preload",
    "./tests/support/bun_hooks.ts",
    "tests/integration/differential_substrate.test.ts",
  ],
  ...(process.env[RUN_ROOT_ENV] === undefined ? {} : { runRoot: process.env[RUN_ROOT_ENV] }),
});
