import type { CommandOptions } from "../../common.js";
import type { PlannedOperation } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand } from "./command.js";
import { assertPlanRunnable, daemonOfPlan } from "./plan_origin.js";

function validatePipeline(commands: readonly (readonly string[])[]): void {
  for (const command of commands) {
    if (command.length === 0 || command[0] === undefined || command[0] === "") {
      throw new TypeError("every command in a pipeline needs a tmux command name");
    }
    if (command.includes(";")) {
      throw new TypeError("a pipeline command cannot contain a bare `;` separator");
    }
  }
}

/** Run commands in order and stop at the first failure. */
export async function runPipeline(
  runtime: RuntimeContext,
  commands: readonly (readonly string[])[],
  options: CommandOptions = {},
): Promise<readonly (readonly string[])[]> {
  validatePipeline(commands);
  const results: (readonly string[])[] = [];
  for (const command of commands) {
    // eslint-disable-next-line no-await-in-loop -- later commands must not run after a failure.
    results.push(await runCommand(runtime, command, options));
  }
  return results;
}

/**
 * Say how many of a batch's commands had finished when it failed.
 *
 * The count rides on the error as a read-only `applied` property, so every
 * error class keeps its type and message. It counts whole commands that
 * completed before the failing one; the failing command itself is not counted
 * and, when it timed out or was abandoned, may still have taken effect.
 */
export function withApplied<E>(error: E, applied: number): E {
  if (typeof error !== "object" || error === null || "applied" in error) return error;
  try {
    Object.defineProperty(error, "applied", { configurable: true, value: applied });
  } catch {
    // A frozen error keeps its shape and loses only the count.
  }
  return error;
}

/**
 * Run planned commands in order, each pinned to the daemon its plan was written for.
 *
 * Every plan is checked against this runtime before the first command goes
 * out, so a plan from elsewhere refuses the batch rather than part of it.
 */
export async function runPlans(
  runtime: RuntimeContext,
  plans: readonly PlannedOperation<unknown>[],
  options: CommandOptions = {},
): Promise<readonly (readonly string[])[]> {
  validatePipeline(plans.map((plan) => plan.argv));
  for (const plan of plans) assertPlanRunnable(runtime, plan);
  const results: (readonly string[])[] = [];
  for (const plan of plans) {
    try {
      const daemon = daemonOfPlan(plan);
      // eslint-disable-next-line no-await-in-loop -- later commands must not run after a failure.
      const lines = await runCommand(runtime, plan.argv, {
        ...options,
        ...(daemon === undefined ? {} : { daemon }),
      });
      results.push(lines);
    } catch (error) {
      throw withApplied(error, results.length);
    }
  }
  return results;
}
