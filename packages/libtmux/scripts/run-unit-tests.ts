import { testParallelism } from "../src/_internal/test/testkit.js";

import { NODE22, preflight } from "./preflight.js";

await preflight([NODE22]);

const result = Bun.spawnSync({
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
