import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { scanSource } from "../../../../scripts/sandbox_entry.js";

/**
 * The runners that execute documented recipes against real tmux. A recipe's `new Server()`
 * follows `TMUX` and the socket variables, so each runner takes its environment from `enterSandbox`.
 */
const RUNNERS = [
  "../../../../scripts/check-readme-runs.ts",
  "../../scripts/doc-examples/check-readme-runs.ts",
  "../../scripts/doc-examples/check-symbol-runs.ts",
] as const;

describe("the documentation runners", () => {
  for (const runner of RUNNERS) {
    test(`${runner.replace(/^(?:\.\.\/)+/u, "")} enters the sandbox and sets nothing itself`, async () => {
      const source = await readFile(fileURLToPath(new URL(runner, import.meta.url)), "utf8");

      const { bare, code } = scanSource(source);

      expect(bare).toMatch(/\benterSandbox\(/u);
      expect(code).not.toMatch(/(?:\["TMUX_TMPDIR"\]|\.TMUX_TMPDIR)\s*=(?!=)/u);
    });
  }
});
