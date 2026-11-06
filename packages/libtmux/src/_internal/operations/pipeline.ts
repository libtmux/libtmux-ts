import type { CommandOptions } from "../../common.js";
import { TmuxTransportError } from "../../errors.js";
import type { PlannedOperation } from "../../types.js";
import type { AbortLike } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand } from "./command.js";
import { assertPlanRunnable, daemonOfPlan } from "./plan_origin.js";
import { timerDuration } from "../timing.js";

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

/** A signal that fires when either does, and the listeners to remove once it is spent. */
function eitherSignal(
  first: AbortLike | undefined,
  second: AbortLike | undefined,
): { readonly dispose: () => void; readonly signal: AbortLike | undefined } {
  if (first === undefined || second === undefined) {
    return { dispose: () => undefined, signal: first ?? second };
  }
  const controller = new AbortController();
  const fire = (): void => {
    controller.abort((first.aborted ? first : second).reason);
  };
  if (first.aborted || second.aborted) {
    fire();
    return { dispose: () => undefined, signal: controller.signal };
  }
  first.addEventListener("abort", fire, { once: true });
  second.addEventListener("abort", fire, { once: true });
  return {
    dispose: () => {
      first.removeEventListener("abort", fire);
      second.removeEventListener("abort", fire);
    },
    signal: controller.signal,
  };
}

/** Refuse a deadline the direct call would refuse; `null` and `undefined` are choices, not numbers. */
function validateDeadline(name: string, value: number | null | undefined): void {
  if (typeof value === "number") timerDuration(name, value);
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
 * The deadline two parties name for one command: the shorter number wins.
 *
 * `null` means no deadline, so it yields to a number from the other side and
 * only stands when neither names one. `undefined` is silence, which leaves the
 * server's default.
 */
export function tighterDeadline(
  plan: number | null | undefined,
  batch: number | null | undefined,
): number | null | undefined {
  if (typeof plan === "number" && typeof batch === "number") return Math.min(plan, batch);
  if (typeof plan === "number") return plan;
  if (typeof batch === "number") return batch;
  return plan === null || batch === null ? null : undefined;
}

/**
 * Run planned commands in order, each under what its plan carries.
 *
 * Every plan is checked against this runtime before the first command goes
 * out, so a plan from elsewhere refuses the batch rather than part of it. Each
 * command then runs pinned to the daemon its plan was written for, under its
 * plan's `signal` and `timeoutMs` combined with the batch's: either signal
 * abandons the command and the shorter deadline applies. A signal that has
 * fired stops the batch before its command is sent.
 */
export async function runPlans(
  runtime: RuntimeContext,
  plans: readonly PlannedOperation<unknown>[],
  options: CommandOptions = {},
): Promise<readonly (readonly string[])[]> {
  validatePipeline(plans.map((plan) => plan.argv));
  validateDeadline("timeoutMs", options.timeoutMs);
  for (const plan of plans) validateDeadline("timeoutMs", plan.options?.timeoutMs);
  for (const plan of plans) assertPlanRunnable(runtime, plan);
  const results: (readonly string[])[] = [];
  for (const plan of plans) {
    const { dispose, signal } = eitherSignal(options.signal, plan.options?.signal);
    try {
      if (signal?.aborted === true) {
        throw new TmuxTransportError(`batch cancelled before ${plan.argv[0] ?? "a command"}`, {
          ...(signal.reason === undefined ? {} : { cause: signal.reason }),
          delivery: "not_started",
          kind: "cancelled",
          subcommand: plan.argv[0] ?? "",
        });
      }
      const timeoutMs = tighterDeadline(plan.options?.timeoutMs, options.timeoutMs);
      const daemon = daemonOfPlan(plan);
      // eslint-disable-next-line no-await-in-loop -- later commands must not run after a failure.
      const lines = await runCommand(runtime, plan.argv, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(daemon === undefined ? {} : { daemon }),
      });
      results.push(lines);
    } catch (error) {
      throw withApplied(error, results.length);
    } finally {
      dispose();
    }
  }
  return results;
}
