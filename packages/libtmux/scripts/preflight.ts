import { tmpdir } from "node:os";

import { resolveNode22 } from "../src/_internal/test/testkit.js";

/**
 * What a suite needs from the machine, checked once and reported once.
 *
 * The suites do not skip what they cannot run — a missing dependency that reads
 * as a pass is how a gate stops being one. What they should not do is say so
 * per test: a checkout without a Node 22 answered with a wall of identical
 * failures, and the one useful sentence was in all of them.
 */
export interface PreflightRequirement {
  readonly check: () => Promise<void>;
  readonly name: string;
}

/**
 * The fixture supervisor identifies processes by what the host reports, and
 * says so before it fails.
 *
 * Linux reads `/proc`. Darwin has none: it asks `ps` for a start time and
 * `sysctl(KERN_PROCARGS2)`, through Python's `ctypes`, for a command line and
 * environment. Any other host has neither, and without this check gets a wall
 * of ENOENT from a file nobody mentioned; with it, one sentence.
 */
export const PROCESS_HARNESS: PreflightRequirement = {
  check: async () => {
    if (process.platform === "linux") return;
    if (process.platform !== "darwin") {
      throw new Error(
        `the fixture supervisor identifies processes through /proc or ps and sysctl, which ${process.platform} lacks.` +
          " The unit suite runs anywhere; the real-tmux suites need Linux or macOS",
      );
    }
    const python = "python3";
    const probe = Bun.spawnSync({
      cmd: [python, "-I", "-c", "import ctypes; ctypes.CDLL(None).sysctl"],
      stderr: "pipe",
      stdout: "pipe",
    });
    if (probe.exitCode !== 0) {
      throw new Error(
        `reading a process's arguments on macOS needs ${python} with ctypes; put one that has it first on PATH`,
      );
    }
  },
  name: "a host the real-tmux fixture supervisor can inspect",
};

/**
 * A socket path has to fit `sun_path`, and the fixture's longest path already
 * uses most of it under `/tmp`. macOS's own `$TMPDIR` leaves too little.
 */
export const SHORT_TMPDIR: PreflightRequirement = {
  check: async () => {
    const directory = tmpdir();
    if (Buffer.byteLength(directory, "utf8") > 24) {
      throw new Error(
        `${directory} leaves too little of a socket path for the fixture; run with TMPDIR=/tmp (TMPDIR=/private/tmp on macOS, where /tmp is a symlink)`,
      );
    }
  },
  name: "a short temporary directory for tmux sockets",
};

export const NODE22: PreflightRequirement = {
  check: async () => {
    await resolveNode22();
  },
  name: "a Node 22 for the emitted-package lanes",
};

/** Report every unmet requirement at once, so one run names all of them. */
export async function preflight(requirements: readonly PreflightRequirement[]): Promise<void> {
  const failures: string[] = [];
  for (const requirement of requirements) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one probe at a time keeps the report ordered.
      await requirement.check();
    } catch (error) {
      failures.push(
        `  ${requirement.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length === 0) return;
  process.stderr.write(
    `This suite needs something this machine does not have:\n${failures.join("\n")}\n`,
  );
  process.exit(1);
}
