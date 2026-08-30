import type { SessionId, TmuxEvent } from "libtmux";

import { requireActive, waitForAbort } from "./abort.js";
import { isUnreachableError, type ToolContext } from "./context.js";
import { coveringSessions } from "./covering_sessions.js";
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
  readonly close: () => Promise<void>;
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

/** Own topology coverage, retries, generations, and every reconciliation task. */
class TopologySupervisor implements TopologyWatch {
  readonly #announce: () => void;
  readonly #context: ToolContext;
  readonly #listeners = new Map<SessionId, LiveListener>();
  readonly #tasks = new Set<Promise<void>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #generation = 0;
  #generationAbort = new AbortController();
  #leases = 0;
  #lossNoticeSent = false;
  #ready = false;
  #reconcileAgain = false;
  #reconciling: ReconcileRun | undefined;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #recoveryNeeded = false;
  #retained = false;
  #retry = 0;
  #stable: ReturnType<typeof setTimeout> | undefined;

  constructor(context: ToolContext, announce: () => void) {
    this.#context = context;
    this.#announce = announce;
  }

  async acquire(signal?: AbortSignal): Promise<TopologyLease> {
    requireActive(signal);
    if (this.#closed || this.#context.hub.closed || !this.#context.policy.liveEnabled) {
      return NOOP_LEASE;
    }
    this.#leases += 1;
    let released = false;
    const lease: TopologyLease = {
      release: () => {
        if (released) return;
        released = true;
        this.#leases -= 1;
        if (!this.#closed && !this.#retained && this.#leases === 0) this.#dropCoverage();
      },
      retain: () => {
        if (!released) this.#retained = true;
      },
    };
    try {
      await waitForAbort(this.#ensureStarted(), signal);
      requireActive(signal);
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#dropCoverage();
      }
      await Promise.allSettled(this.#tasks);
    })();
    return this.#closePromise;
  }

  start(signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      this.#retained = true;
      return this.#ensureStarted();
    }
    return this.acquire(signal).then((lease) => {
      lease.retain();
      lease.release();
    });
  }

  #announceLoss(): void {
    this.#requireRecovery();
    if (this.#lossNoticeSent) return;
    this.#lossNoticeSent = true;
    this.#announce();
  }

  #armStable(): void {
    this.#clearStable();
    this.#stable = setTimeout(() => {
      this.#stable = undefined;
      this.#retry = 0;
    }, STABLE_MS);
    this.#stable.unref?.();
  }

  #beginReconcile(): Promise<void> {
    const runGeneration = this.#generation;
    const signal = this.#generationAbort.signal;
    if (this.#reconciling?.generation === runGeneration) return this.#reconciling.promise;
    let run!: ReconcileRun;
    const running = (async () => {
      try {
        while (
          this.#reconcileAgain &&
          !this.#closed &&
          !this.#context.hub.closed &&
          runGeneration === this.#generation
        ) {
          this.#reconcileAgain = false;
          // eslint-disable-next-line no-await-in-loop -- topology changes collapse into ordered passes.
          const result = await this.#reconcile(runGeneration, signal);
          if (result === undefined) return;
          if (!result.complete) {
            this.#requireRecovery();
            this.#schedule(runGeneration);
            return;
          }
          if (this.#reconnect !== undefined) return;
          if (result.installed) this.#reconcileAgain = true;
        }
        if (
          this.#closed ||
          this.#context.hub.closed ||
          runGeneration !== this.#generation ||
          this.#reconnect !== undefined
        ) {
          return;
        }
        this.#ready = true;
        if (this.#recoveryNeeded) {
          this.#recoveryNeeded = false;
          this.#lossNoticeSent = false;
          this.#announce();
        }
        this.#armStable();
      } catch (error) {
        if (this.#closed || this.#context.hub.closed || runGeneration !== this.#generation) return;
        if (isUnreachableError(error)) return;
        this.#requireRecovery();
        this.#schedule(runGeneration);
      }
    })().finally(() => {
      if (this.#reconciling === run) this.#reconciling = undefined;
    });
    run = { generation: runGeneration, promise: running };
    this.#reconciling = run;
    this.#tasks.add(running);
    void running.then(
      () => this.#tasks.delete(running),
      () => this.#tasks.delete(running),
    );
    return running;
  }

  #clearStable(): void {
    if (this.#stable === undefined) return;
    clearTimeout(this.#stable);
    this.#stable = undefined;
  }

  #dropCoverage(): void {
    this.#generationAbort.abort();
    this.#generation += 1;
    this.#generationAbort = new AbortController();
    this.#ready = false;
    this.#reconcileAgain = false;
    this.#recoveryNeeded = false;
    this.#lossNoticeSent = false;
    this.#retry = 0;
    if (this.#reconnect !== undefined) clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    this.#clearStable();
    const active = [...this.#listeners.values()];
    this.#listeners.clear();
    for (const stop of active) stop();
  }

  #ensureStarted(): Promise<void> {
    if (
      this.#closed ||
      this.#context.hub.closed ||
      !this.#context.policy.liveEnabled ||
      this.#reconnect !== undefined
    ) {
      return Promise.resolve();
    }
    if (this.#ready) return Promise.resolve();
    if (this.#reconciling?.generation === this.#generation) return this.#reconciling.promise;
    this.#reconcileAgain = true;
    return this.#beginReconcile();
  }

  readonly #listener = (event: TmuxEvent): void => {
    if (event.kind === "layout-change" || isCatalogResourceEvent(event)) this.#announce();
    if (
      event.kind !== "sessions-changed" &&
      event.kind !== "unlinked-window-add" &&
      event.kind !== "unlinked-window-close" &&
      event.kind !== "window-add" &&
      event.kind !== "window-close"
    ) {
      return;
    }
    this.#requireRecovery();
    this.#lossNoticeSent = true;
    this.#requestReconcile();
  };

  async #reconcile(
    runGeneration: number,
    signal: AbortSignal,
  ): Promise<{ complete: boolean; installed: boolean } | undefined> {
    const snapshot = await this.#context.snapshot(signal);
    if (this.#closed || this.#context.hub.closed || runGeneration !== this.#generation) {
      return undefined;
    }
    const desired = coveringSessions(snapshot, this.#listeners);
    let installed = false;
    let complete = desired.size > 0;

    for (const sessionId of desired) {
      if (this.#listeners.has(sessionId)) continue;
      // eslint-disable-next-line no-await-in-loop -- serial attaches bound process startup pressure.
      const opened = await this.#context.hub.listen(sessionId, this.#listener, signal);
      if (this.#closed || this.#context.hub.closed || runGeneration !== this.#generation) {
        opened?.();
        return undefined;
      }
      if (opened === undefined || !opened.active) {
        opened?.();
        complete = false;
        continue;
      }
      this.#listeners.set(sessionId, opened);
      this.#track(sessionId, opened);
      installed = true;
    }

    if ([...desired].some((sessionId) => this.#listeners.get(sessionId)?.active !== true)) {
      complete = false;
    }
    if (complete) {
      for (const [sessionId, opened] of this.#listeners) {
        if (desired.has(sessionId)) continue;
        this.#listeners.delete(sessionId);
        opened();
      }
    }
    return { complete, installed };
  }

  #requestReconcile(): void {
    if (this.#closed || this.#context.hub.closed || this.#reconnect !== undefined) return;
    this.#reconcileAgain = true;
    void this.#beginReconcile();
  }

  #requireRecovery(): void {
    this.#recoveryNeeded = true;
    this.#ready = false;
    this.#clearStable();
  }

  #schedule(runGeneration = this.#generation): void {
    if (
      this.#closed ||
      this.#context.hub.closed ||
      runGeneration !== this.#generation ||
      this.#reconnect !== undefined
    ) {
      return;
    }
    this.#ready = false;
    const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(this.#retry, 5));
    this.#retry += 1;
    this.#reconnect = setTimeout(() => {
      if (runGeneration !== this.#generation) return;
      this.#reconnect = undefined;
      this.#requestReconcile();
    }, wait);
    this.#reconnect.unref?.();
  }

  #track(sessionId: SessionId, opened: LiveListener): void {
    void opened.ended.then(() => {
      if (this.#listeners.get(sessionId) !== opened) return;
      this.#listeners.delete(sessionId);
      if (this.#closed || this.#context.hub.closed) return;
      this.#announceLoss();
      this.#schedule();
    });
  }
}

/** Watch every session whose pane layouts contribute resource URIs. */
export function watchTopology(context: ToolContext, announce: () => void): TopologyWatch {
  return new TopologySupervisor(context, announce);
}
