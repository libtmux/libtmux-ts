import { resolveNode22 } from "../src/_internal/test/node22.js";

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
 * The fixture supervisor reads `/proc`, and says so before it fails.
 *
 * Process identity there is `linux:<boot id>:<start time>`, read from
 * `/proc/<pid>/stat` and `/proc/sys/kernel/random/boot_id`, and the cancellation
 * tests assume descendants that hold an inherited pipe behave as they do on
 * Linux. None of that has a Darwin equivalent yet. Without this check a macOS
 * checkout gets a wall of ENOENT from a file nobody mentioned; with it, one
 * sentence naming what is missing.
 */
export const LINUX_HARNESS: PreflightRequirement = {
  check: async () => {
    if (process.platform === "linux") return;
    throw new Error(
      `the fixture supervisor identifies processes through /proc, which ${process.platform} does not have.` +
        " The unit suite runs anywhere; the real-tmux suites need Linux until the supervisor is ported",
    );
  },
  name: "a Linux host for the real-tmux fixture supervisor",
};

export const NODE22: PreflightRequirement = {
  check: async () => {
    await resolveNode22();
  },
  name: "a Node 22 for the emitted-package lanes",
};

/** Resolve Bun's suite parallelism before a runner starts child processes. */
export function testParallelism(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.LIBTMUX_TEST_PARALLEL ?? "4";
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error("LIBTMUX_TEST_PARALLEL must be a positive integer");
  }
  const parallelism = Number(raw);
  if (!Number.isSafeInteger(parallelism)) {
    throw new Error("LIBTMUX_TEST_PARALLEL must be a positive integer");
  }
  return parallelism;
}

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
