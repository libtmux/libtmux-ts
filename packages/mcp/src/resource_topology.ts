import type { ServerSnapshot, SessionId, TmuxEvent } from "libtmux";

import { requireActive, waitForAbort } from "./abort.js";
import { isUnreachableError, type ToolContext } from "./context.js";
import type { LiveListener } from "./live.js";

const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 5_000;
const STABLE_MS = 5_000;

const STRUCTURAL = new Set<TmuxEvent["kind"]>([
  "session-renamed",
  "sessions-changed",
  "unlinked-window-add",
  "unlinked-window-close",
  "unlinked-window-renamed",
  "window-add",
  "window-close",
  "window-renamed",
]);

/** Whether an event can change resource identity or its catalog description. */
function isCatalogResourceEvent(event: TmuxEvent): boolean {
  return STRUCTURAL.has(event.kind);
}

export interface TopologyLease {
  /** Keep the watch after this request finishes because a client received a baseline. */
  readonly retain: () => void;
  readonly release: () => void;
}

export interface TopologyWatch {
  /** Provision coverage for one catalog request until its lease is released. */
  readonly acquire: (signal?: AbortSignal) => Promise<TopologyLease>;
  readonly close: () => void;
  /** Start and retain coverage directly. Primarily useful to lifecycle tests. */
  readonly start: (signal?: AbortSignal) => Promise<void>;
}

interface ReconcileRun {
  readonly generation: number;
  readonly promise: Promise<void>;
}

const NOOP_LEASE: TopologyLease = {
  release: () => undefined,
  retain: () => undefined,
};

/** Choose an irredundant set of sessions that observes every distinct window. */
function coveringSessions(
  snapshot: ServerSnapshot,
  active: ReadonlyMap<SessionId, unknown>,
): Set<SessionId> {
  const bySession = new Map<SessionId, Set<string>>();
  const uncovered = new Set<string>();
  for (const window of snapshot.windows.toArray()) {
    uncovered.add(window.id);
    const sessionId = window.format.session_id;
    const windows = bySession.get(sessionId) ?? new Set<string>();
    windows.add(window.id);
    bySession.set(sessionId, windows);
  }

  const desired = new Set<SessionId>();
  while (uncovered.size > 0) {
    let best: SessionId | undefined;
    let bestActive = false;
    let bestScore = 0;
    for (const [sessionId, windows] of bySession) {
      if (desired.has(sessionId)) continue;
      let score = 0;
      for (const windowId of windows) {
        if (uncovered.has(windowId)) score += 1;
      }
      const isActive = active.has(sessionId);
      if (score > bestScore || (score === bestScore && isActive && !bestActive)) {
        best = sessionId;
        bestActive = isActive;
        bestScore = score;
      }
    }
    if (best === undefined || bestScore === 0) break;
    desired.add(best);
    for (const windowId of bySession.get(best) ?? []) uncovered.delete(windowId);
  }

  // Greedy selection can make an earlier choice redundant once later sessions
  // cover its windows. Drop such choices without turning this into exact set cover.
  for (const candidate of desired) {
    const windows = bySession.get(candidate) ?? [];
    let needed = false;
    for (const windowId of windows) {
      let coveredElsewhere = false;
      for (const other of desired) {
        if (other !== candidate && bySession.get(other)?.has(windowId) === true) {
          coveredElsewhere = true;
          break;
        }
      }
      if (coveredElsewhere) continue;
      needed = true;
      break;
    }
    if (!needed) desired.delete(candidate);
  }
  return desired;
}

/**
 * Watch every session whose pane layouts contribute resource URIs.
 *
 * tmux broadcasts session and window lifecycle, but sends a layout change only
 * to clients whose session contains that window. One listener cannot cover the
 * whole resource catalog.
 */
export function watchTopology(context: ToolContext, announce: () => void): TopologyWatch {
  const listeners = new Map<SessionId, LiveListener>();
  let closed = false;
  let generation = 0;
  let generationAbort = new AbortController();
  let leases = 0;
  let lossNoticeSent = false;
  let ready = false;
  let reconcileAgain = false;
  let reconciling: ReconcileRun | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let recoveryNeeded = false;
  let retained = false;
  let retry = 0;
  let stable: ReturnType<typeof setTimeout> | undefined;

  const clearStable = (): void => {
    if (stable === undefined) return;
    clearTimeout(stable);
    stable = undefined;
  };
  const armStable = (): void => {
    clearStable();
    stable = setTimeout(() => {
      stable = undefined;
      retry = 0;
    }, STABLE_MS);
    stable.unref?.();
  };
  const requireRecovery = (): void => {
    recoveryNeeded = true;
    ready = false;
    clearStable();
  };
  const announceLoss = (): void => {
    requireRecovery();
    if (lossNoticeSent) return;
    lossNoticeSent = true;
    announce();
  };
  const dropCoverage = (): void => {
    generationAbort.abort();
    generation += 1;
    generationAbort = new AbortController();
    ready = false;
    reconcileAgain = false;
    reconciling = undefined;
    recoveryNeeded = false;
    lossNoticeSent = false;
    retry = 0;
    if (reconnect !== undefined) clearTimeout(reconnect);
    reconnect = undefined;
    clearStable();
    const active = [...listeners.values()];
    listeners.clear();
    for (const stop of active) stop();
  };
  let requestReconcile!: () => void;
  const schedule = (runGeneration = generation): void => {
    if (closed || context.hub.closed || runGeneration !== generation || reconnect !== undefined) {
      return;
    }
    ready = false;
    const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(retry, 5));
    retry += 1;
    reconnect = setTimeout(() => {
      if (runGeneration !== generation) return;
      reconnect = undefined;
      requestReconcile();
    }, wait);
    reconnect.unref?.();
  };
  const listener = (event: TmuxEvent): void => {
    // Layout also fires for resize and zoom. The shared notifier coalesces those
    // false positives; omitting it would leave external split and kill stale.
    if (event.kind === "layout-change" || isCatalogResourceEvent(event)) announce();
    if (
      event.kind !== "sessions-changed" &&
      event.kind !== "unlinked-window-add" &&
      event.kind !== "unlinked-window-close" &&
      event.kind !== "window-add" &&
      event.kind !== "window-close"
    ) {
      return;
    }
    requireRecovery();
    // The event announcement above already told the client coverage may differ.
    lossNoticeSent = true;
    requestReconcile();
  };
  const track = (sessionId: SessionId, opened: LiveListener): void => {
    void opened.ended.then(() => {
      if (listeners.get(sessionId) !== opened) return;
      listeners.delete(sessionId);
      if (closed || context.hub.closed) return;
      announceLoss();
      schedule();
    });
  };
  const reconcile = async (
    runGeneration: number,
    signal: AbortSignal,
  ): Promise<{ complete: boolean; installed: boolean } | undefined> => {
    const snapshot = await context.snapshot();
    if (closed || context.hub.closed || runGeneration !== generation) return undefined;
    const desired = coveringSessions(snapshot, listeners);
    let installed = false;
    let complete = desired.size > 0;

    for (const sessionId of desired) {
      if (listeners.has(sessionId)) continue;
      // eslint-disable-next-line no-await-in-loop -- serial attaches bound process startup pressure.
      const opened = await context.hub.listen(sessionId, listener, signal);
      if (closed || context.hub.closed || runGeneration !== generation) {
        opened?.();
        return undefined;
      }
      if (opened === undefined || !opened.active) {
        opened?.();
        complete = false;
        continue;
      }
      listeners.set(sessionId, opened);
      track(sessionId, opened);
      installed = true;
    }

    if ([...desired].some((sessionId) => listeners.get(sessionId)?.active !== true)) {
      complete = false;
    }
    if (complete) {
      for (const [sessionId, opened] of listeners) {
        if (desired.has(sessionId)) continue;
        listeners.delete(sessionId);
        opened();
      }
    }
    return { complete, installed };
  };
  const beginReconcile = (): Promise<void> => {
    const runGeneration = generation;
    const signal = generationAbort.signal;
    if (reconciling?.generation === runGeneration) return reconciling.promise;
    let run!: ReconcileRun;
    const running = (async () => {
      try {
        while (reconcileAgain && !closed && !context.hub.closed && runGeneration === generation) {
          reconcileAgain = false;
          // eslint-disable-next-line no-await-in-loop -- topology changes collapse into ordered passes.
          const result = await reconcile(runGeneration, signal);
          if (result === undefined) return;
          if (!result.complete) {
            requireRecovery();
            schedule(runGeneration);
            return;
          }
          if (reconnect !== undefined) return;
          // Verify after attaching: a new session before its listener opened
          // could not have delivered the event that asks for another pass.
          if (result.installed) reconcileAgain = true;
        }
        if (
          closed ||
          context.hub.closed ||
          runGeneration !== generation ||
          reconnect !== undefined
        ) {
          return;
        }
        ready = true;
        if (recoveryNeeded) {
          recoveryNeeded = false;
          lossNoticeSent = false;
          announce();
        }
        armStable();
      } catch (error) {
        if (closed || context.hub.closed || runGeneration !== generation) return;
        if (isUnreachableError(error)) return;
        requireRecovery();
        schedule(runGeneration);
      }
    })().finally(() => {
      if (reconciling === run) reconciling = undefined;
    });
    run = { generation: runGeneration, promise: running };
    reconciling = run;
    return running;
  };
  requestReconcile = (): void => {
    if (closed || context.hub.closed || reconnect !== undefined) return;
    reconcileAgain = true;
    void beginReconcile();
  };
  const ensureStarted = (): Promise<void> => {
    if (closed || context.hub.closed || !context.policy.liveEnabled || reconnect !== undefined) {
      return Promise.resolve();
    }
    if (ready) return Promise.resolve();
    if (reconciling?.generation === generation) return reconciling.promise;
    reconcileAgain = true;
    return beginReconcile();
  };
  const acquire = async (signal?: AbortSignal): Promise<TopologyLease> => {
    requireActive(signal);
    if (closed || context.hub.closed || !context.policy.liveEnabled) return NOOP_LEASE;
    leases += 1;
    let released = false;
    const lease: TopologyLease = {
      release: () => {
        if (released) return;
        released = true;
        leases -= 1;
        if (!closed && !retained && leases === 0) dropCoverage();
      },
      retain: () => {
        if (!released) retained = true;
      },
    };
    try {
      await waitForAbort(ensureStarted(), signal);
      requireActive(signal);
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  };

  return {
    acquire,
    close: () => {
      if (closed) return;
      closed = true;
      dropCoverage();
    },
    start: (signal?: AbortSignal) => {
      if (signal === undefined) {
        retained = true;
        return ensureStarted();
      }
      return acquire(signal).then((lease) => {
        lease.retain();
        lease.release();
      });
    },
  };
}
