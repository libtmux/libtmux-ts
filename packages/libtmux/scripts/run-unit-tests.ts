import { enterSandbox, testParallelism } from "../src/_internal/test/testkit.js";

import { NODE22, preflight } from "./preflight.js";

await preflight([NODE22]);

// Bun runs each file of a parallel run in a context of its own, which would
// each enter a sandbox of its own: entering here has them share this one.
const sandbox = await enterSandbox();

const result = Bun.spawnSync({
  // Without this the children get the environment this process started with,
  // not the one it has now, and each file would enter a sandbox of its own.
  env: process.env,
  cmd: [
    "bun",
    "test",
    `--parallel=${String(testParallelism())}`,
    "--timeout=30000",
    "--no-orphans",
    "tests/unit",
    ...Bun.argv.slice(2),
  ],
  stderr: "inherit",
  stdout: "inherit",
});

process.exitCode = result.exitCode;
// A server a test left behind fails the run, whatever its tests said.
await sandbox.release();
