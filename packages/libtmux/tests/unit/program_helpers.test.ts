import { constants } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { signalName } from "../../src/_internal/operations/program.js";

const PROGRAM = fileURLToPath(
  new URL("../../src/_internal/operations/program.ts", import.meta.url),
);

describe("program signal names", () => {
  // tmux writes sys_signame (`term`) where the platform has it, as BSD and macOS
  // do, and the bare number (`15`) where it does not, as glibc does.
  test("reads both the name and the number tmux may report", () => {
    expect(signalName("term")).toBe("SIGTERM");
    expect(signalName("TERM")).toBe("SIGTERM");
    expect(signalName(String(constants.signals.SIGKILL))).toBe("SIGKILL");
    expect(signalName("")).toBeNull();
  });

  test("keeps a number this platform has no name for", () => {
    expect(signalName("250")).toBe("250");
  });
});

describe("program sleeps", () => {
  // An armed timer keeps a script alive after wait() has returned.
  test("leave no timer behind once woken", async () => {
    const started = performance.now();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { sleep } from ${JSON.stringify(PROGRAM)}; const wake = new AbortController(); queueMicrotask(() => wake.abort()); await sleep(60_000, wake.signal);`,
      ],
      { stderr: "inherit", stdout: "ignore" },
    );
    expect(await child.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 40_000);
});
