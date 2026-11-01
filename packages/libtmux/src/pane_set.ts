import type { CommandOptions, CommandOutcome, CommandResult, PaneRef } from "./common.js";
import { TmuxCommandError, TmuxServerRestartedError, TmuxTransportError } from "./errors.js";
import type { Pane } from "./pane.js";
import type { CaptureOptions, SendKeysOptions } from "./types.js";
import { logicalRefForHandle, runtimeForHandle } from "./_internal/runtime/live_handle.js";
import { capturePaneWithResult, sendKeysWithResult } from "./_internal/operations/pane_io.js";

/** Per-call worker and target limits. Both must be positive safe integers. */
export interface PaneSetOptions {
  readonly concurrency?: number;
  readonly maxTargets?: number;
}

/** One requested slot; duplicate pane handles keep distinct indices. */
export interface PaneSetOutcome<Value> extends CommandOutcome {
  readonly index: number;
  readonly target: PaneRef;
  readonly value?: Value;
  /** Original error object, retained without changing or freezing it. */
  readonly error?: unknown;
  readonly reason?: string;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function failure(
  error: unknown,
): CommandOutcome & { readonly error: unknown; readonly reason: string } {
  if (error instanceof TmuxTransportError) {
    const status =
      error.delivery === "not_started"
        ? error.kind === "cancelled"
          ? "skipped"
          : "failed"
        : error.delivery === "replied"
          ? "failed"
          : "unknown";
    return { delivery: error.delivery, error, reason: error.kind, status };
  }
  if (error instanceof TmuxCommandError) {
    return { delivery: "replied", error, reason: "command_refused", status: "failed" };
  }
  if (error instanceof TmuxServerRestartedError) {
    return { delivery: "not_started", error, reason: "stale_daemon", status: "failed" };
  }
  return { delivery: "indeterminate", error, reason: "unclassified", status: "unknown" };
}

/**
 * Ordered pane actions with a result for every slot, including duplicates.
 *
 * Captures are separate samples; input submissions are separate invocations.
 * Neither forms a multi-pane transaction. The group borrows its handles and
 * never closes their servers. Limits apply to each call, including concurrent
 * calls on one group; native timeoutMs applies to each dispatched invocation.
 */
export class PaneSet {
  readonly #concurrency: number;
  readonly #targets: readonly PaneRef[];
  /**
   * The copied, frozen target list in caller order.
   *
   * ```ts
   * import { PaneSet } from "libtmux";
   * const group = new PaneSet([pane, pane]);
   * group.panes.length; // 2
   * ```
   */
  readonly panes: readonly Pane[];

  constructor(panes: readonly Pane[], options: PaneSetOptions = {}) {
    this.#concurrency = positiveInteger(options.concurrency ?? 4, "concurrency");
    const maxTargets = positiveInteger(options.maxTargets ?? 1024, "maxTargets");
    if (panes.length > maxTargets) throw new RangeError("pane group exceeds maxTargets");
    this.panes = Object.freeze([...panes]);
    this.#targets = Object.freeze(
      this.panes.map((pane) => {
        const reference = logicalRefForHandle(pane);
        if (reference.kind !== "pane") throw new TypeError("PaneSet requires pane handles");
        return reference;
      }),
    );
    Object.freeze(this);
  }

  /**
   * Capture each slot, retaining its text and original command result.
   *
   * ```ts
   * import { PaneSet } from "libtmux";
   * const captures = await new PaneSet([pane]).capture({ start: -100 });
   * captures[0]?.value?.join("\n");
   * ```
   */
  capture(options: CaptureOptions = {}): Promise<readonly PaneSetOutcome<readonly string[]>[]> {
    const request = Object.freeze({ ...options });
    return this.#collect(request, (pane) =>
      capturePaneWithResult(runtimeForHandle(pane), pane.id, request),
    );
  }

  /**
   * Submit keys using the pane's ordinary enter/literal semantics.
   *
   * A conclusive reply means submission, not application completion. An
   * interrupted submitted invocation is unknown and is never retried.
   *
   * ```ts
   * import { PaneSet } from "libtmux";
   * const submissions = await new PaneSet([pane]).sendKeys("go", { literal: true });
   * submissions[0]?.status;
   * ```
   */
  sendKeys(keys: string, options: SendKeysOptions = {}): Promise<readonly PaneSetOutcome<void>[]> {
    const request = Object.freeze({ ...options });
    return this.#collect(request, async (pane) => ({
      result: await sendKeysWithResult(runtimeForHandle(pane), pane.id, keys, request),
      value: undefined,
    }));
  }

  async #collect<Value>(
    options: CommandOptions,
    action: (pane: Pane) => Promise<{ readonly result: CommandResult; readonly value: Value }>,
  ): Promise<readonly PaneSetOutcome<Value>[]> {
    const outcomes: PaneSetOutcome<Value>[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < this.panes.length) {
        const index = next++;
        const pane = this.panes[index]!;
        const target = this.#targets[index]!;
        if (options.signal?.aborted === true) {
          outcomes[index] = Object.freeze({
            index,
            target,
            delivery: "not_started",
            status: "skipped",
            reason: "cancelled_before_submission",
          });
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop -- A worker must settle one slot before claiming the next.
          const { result, value } = await action(pane);
          outcomes[index] = Object.freeze({
            index,
            target,
            delivery: "replied",
            result,
            status: "complete",
            value,
          });
        } catch (error) {
          outcomes[index] = Object.freeze({ index, target, ...failure(error) });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, this.panes.length) }, worker),
    );
    return Object.freeze(outcomes);
  }
}
