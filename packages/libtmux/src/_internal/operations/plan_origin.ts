import { TmuxServerRestartedError } from "../../errors.js";
import type { PlannedOperation } from "../../types.js";
import { originForHandle, type HandleOrigin } from "../runtime/live_handle.js";
import {
  lastObservedDaemon,
  serverAddress,
  type DaemonIdentity,
  type RuntimeContext,
} from "../runtime/context.js";

/**
 * Who made each plan, kept where a caller cannot forge or strip it.
 *
 * A tmux id means something only on the daemon that issued it, so a plan that
 * names `$0` is a statement about one daemon of one runtime. Plans built by
 * hand have no entry and run on whichever server runs them, as they always did.
 *
 * The record is keyed by the plan's `resolve` function and by its `argv`
 * array, not by the plan object: a copy made by spread, `Object.assign` or
 * `.map` is a new object holding the same two references, so it stays bound.
 * Only a copy that replaces both has left the library's plan behind, and that
 * is a plan written by hand.
 */
const byResolver = new WeakMap<object, HandleOrigin>();
const byArgv = new WeakMap<object, HandleOrigin>();

function sameOrigin(left: HandleOrigin, right: HandleOrigin): boolean {
  if (left === right) return true;
  const a = left.daemon;
  const b = right.daemon;
  const sameDaemon =
    a === b ||
    (a !== undefined && b !== undefined && a.pid === b.pid && a.startTime === b.startTime);
  return left.runtime === right.runtime && left.epoch === right.epoch && sameDaemon;
}

/**
 * The origin a plan was bound to, read from both of its keys.
 *
 * `argv` carries the ids, so it decides when only one key is bound. A plan
 * whose two keys were bound to different origins was assembled from parts of
 * two plans, so it names ids of one server and resolves for another.
 *
 * @throws TypeError when both keys are bound and they disagree.
 */
function originOf(plan: PlannedOperation<unknown>): HandleOrigin | undefined {
  const fromArgv = byArgv.get(plan.argv);
  const fromResolver = byResolver.get(plan.resolve);
  if (fromArgv !== undefined && fromResolver !== undefined && !sameOrigin(fromArgv, fromResolver)) {
    throw new TypeError(
      `batch was given a plan (${plan.argv[0] ?? ""}) whose argv and resolver were written for different handles: it was assembled from two plans, and a tmux id means something else on each server.`,
    );
  }
  return fromArgv ?? fromResolver;
}

/**
 * Record where a plan was written, so only its own runtime and daemon may run it.
 *
 * Returns a frozen copy with a resolver and an `argv` of its own: they are the
 * keys, so no other plan may share them.
 */
function bindPlanToOrigin<T>(
  origin: HandleOrigin,
  plan: PlannedOperation<T>,
): PlannedOperation<T> {
  const argv = Object.freeze([...plan.argv]);
  const inner = plan.resolve as (snapshot: unknown, lines: readonly string[]) => T;
  const bound = Object.freeze({
    ...plan,
    argv,
    resolve: (snapshot: unknown, lines: readonly string[]) => inner(snapshot, lines),
  }) as PlannedOperation<T>;
  byResolver.set(bound.resolve, origin);
  byArgv.set(argv, origin);
  return bound;
}

/** Record that a handle wrote this plan. */
export function bindPlan<T>(
  handle: Parameters<typeof originForHandle>[0],
  plan: PlannedOperation<T>,
): PlannedOperation<T> {
  return bindPlanToOrigin(originForHandle(handle), plan);
}

/** The daemon a plan's command must run on, if its handle recorded one. */
export function daemonOfPlan(plan: PlannedOperation<unknown>): DaemonIdentity | undefined {
  return originOf(plan)?.daemon;
}

/**
 * Refuse a plan the runtime may not run, before anything is dispatched.
 *
 * Another `Server` object over the same endpoint may run it if the daemon the
 * plan was read from is the one it has seen, or has seen none yet, in which
 * case the guard each command carries into tmux's queue decides. A runtime
 * that cannot name its endpoint is known only by identity.
 *
 * @throws TypeError when the plan was written for another endpoint, or for a
 * `Server` that cannot be shown to share this one's daemon.
 * @throws TmuxServerRestartedError when the daemon the plan's handle was read
 * from is no longer the one this runtime talks to.
 */
export function assertPlanRunnable(runtime: RuntimeContext, plan: PlannedOperation<unknown>): void {
  const origin = originOf(plan);
  if (origin === undefined) return;
  const current = lastObservedDaemon(runtime);
  const daemonMoved =
    current !== undefined &&
    origin.daemon !== undefined &&
    (current.pid !== origin.daemon.pid || current.startTime !== origin.daemon.startTime);
  if (origin.runtime !== runtime) {
    const address = serverAddress(runtime);
    const sameEndpoint = address !== undefined && address === serverAddress(origin.runtime);
    if (!sameEndpoint || origin.daemon === undefined) {
      throw new TypeError(
        `batch was given a plan (${plan.argv[0] ?? ""}) written for another Server object: a tmux id means something else on each, so a plan runs only on a Server for the same tmux server and daemon as its handle's.`,
      );
    }
    if (daemonMoved) throw restarted(plan);
    return;
  }
  if (origin.epoch !== runtime.daemonEpoch || daemonMoved) throw restarted(plan);
}

function restarted(plan: PlannedOperation<unknown>): TmuxServerRestartedError {
  return new TmuxServerRestartedError(
    `batch was given a plan (${plan.argv[0] ?? ""}) written for a different run of this tmux server; tmux reissues ids from the start, so that id names whatever holds it now.`,
  );
}
