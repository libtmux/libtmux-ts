import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  AMBIENT_TMUX_VARIABLES,
  isolateTmuxEnvironment,
} from "../../scripts/doc-examples/example_harness.js";

/**
 * The runners that execute documented recipes against real tmux.
 *
 * A recipe writes `new Server()` and expects to find tmux running. `TMUX_TMPDIR`
 * moves only the default socket, so a runner that sets nothing else still
 * reaches the server of whoever runs it: tmux follows `TMUX`, and the library
 * follows `LIBTMUX_SOCKET` and `LIBTMUX_SOCKET_PATH`.
 */
const RUNNERS = [
  "../../../../scripts/check-readme-runs.ts",
  "../../scripts/doc-examples/check-readme-runs.ts",
  "../../scripts/doc-examples/check-symbol-runs.ts",
] as const;

describe("isolateTmuxEnvironment", () => {
  test("names every variable that routes past TMUX_TMPDIR", () => {
    expect([...AMBIENT_TMUX_VARIABLES].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "LIBTMUX_SOCKET",
      "LIBTMUX_SOCKET_PATH",
      "TMUX",
      "TMUX_PANE",
    ]);
  });

  test("removes each of them and points the default socket at the directory", () => {
    const environment: Record<string, string | undefined> = {
      HOME: "/home/ltx",
      LIBTMUX_SOCKET: "work",
      LIBTMUX_SOCKET_PATH: "/tmp/work.sock",
      PATH: "/usr/bin",
      TMUX: "/tmp/tmux-1000/work,123,0",
      TMUX_PANE: "%3",
      TMUX_TMPDIR: "/var/tmp",
    };

    isolateTmuxEnvironment("/tmp/ltx-isolated", environment);

    expect(environment).toEqual({
      HOME: "/home/ltx",
      PATH: "/usr/bin",
      TMUX_TMPDIR: "/tmp/ltx-isolated",
    });
  });
});

describe("the documentation runners", () => {
  for (const runner of RUNNERS) {
    test(`${runner.replace(/^(?:\.\.\/)+/u, "")} isolates through the helper and sets nothing itself`, async () => {
      const source = await readFile(fileURLToPath(new URL(runner, import.meta.url)), "utf8");

      expect(source).toMatch(/\bisolateTmuxEnvironment\(/u);
      expect(source).not.toMatch(/(?:\["TMUX_TMPDIR"\]|\.TMUX_TMPDIR)\s*=(?!=)/u);
    });
  }
});
