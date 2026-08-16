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
