import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TmuxEvent } from "libtmux";

import { waitForAbort } from "./abort.js";
import type { ToolContext } from "./context.js";
import type { LiveListener } from "./live.js";
import { panePlacements } from "./target_resolution.js";

export const UPDATE_COALESCE_MS = 500;

const PLACEMENT_INVALIDATING_EVENTS = new Set<TmuxEvent["kind"]>([
  "sessions-changed",
  "unlinked-window-add",
  "unlinked-window-close",
  "window-add",
  "window-close",
]);

/** Own one pane subscription's placement, retry, notification, and close tasks. */
export class PaneSubscriptionSupervisor {
  acknowledged = false;
  readonly #cancelled = Promise.withResolvers<never>();
  #closePromise: Promise<void> | undefined;
  readonly #context: ToolContext;
  readonly #mcp: McpServer;
  readonly #paneId: string;
  #pending: ReturnType<typeof setTimeout> | undefined;
  #placementCheck: ReturnType<typeof setTimeout> | undefined;
  readonly ready: Promise<void>;
  #reconcileAgain = false;
  #reconciling: Promise<void> | undefined;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #retry = 0;
  #stop: LiveListener | undefined;
  #stopped = false;
  readonly #tasks = new Set<Promise<void>>();
  readonly #uri: string;
  readonly #watchAbort = new AbortController();
  #boundSessionId: string | undefined;
  #boundWindowId: string | undefined;
  #waiters = 0;

  constructor(mcp: McpServer, context: ToolContext, uri: string, paneId: string) {
    this.#mcp = mcp;
    this.#context = context;
    this.#uri = uri;
    this.#paneId = paneId;
    this.ready = Promise.race([this.#startReconcile(true), this.#cancelled.promise]);
  }

  get waiters(): number {
    return this.#waiters;
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      if (!this.#stopped) {
        this.#stopped = true;
        this.#watchAbort.abort();
        this.#reconcileAgain = false;
        if (this.#pending !== undefined) clearTimeout(this.#pending);
        if (this.#placementCheck !== undefined) clearTimeout(this.#placementCheck);
        if (this.#reconnect !== undefined) clearTimeout(this.#reconnect);
        this.#stop?.();
        this.#stop = undefined;
        this.#boundSessionId = undefined;
        this.#boundWindowId = undefined;
        this.#cancelled.reject(new Error("resource subscription cancelled"));
      }
      await Promise.allSettled(this.#tasks);
    })();
    return this.#closePromise;
  }

  async wait(signal: AbortSignal): Promise<void> {
    this.#waiters += 1;
    try {
      await waitForAbort(this.ready, signal);
    } finally {
      this.#waiters -= 1;
    }
  }

  #announce(): void {
    if (this.#pending !== undefined) return;
    this.#pending = setTimeout(() => {
      this.#pending = undefined;
      void this.#mcp.server.sendResourceUpdated({ uri: this.#uri }).catch(() => undefined);
    }, UPDATE_COALESCE_MS);
    this.#pending.unref?.();
  }

  #deferPlacementCheck(): void {
    if (this.#stopped || this.#context.hub.closed || this.#placementCheck !== undefined) return;
    this.#placementCheck = setTimeout(() => {
      this.#placementCheck = undefined;
      this.#requestReconcile();
    }, UPDATE_COALESCE_MS);
    this.#placementCheck.unref?.();
  }

  readonly #listener = (event: TmuxEvent): void => {
    if (event.kind === "output") {
      if (event.paneId === this.#paneId) this.#announce();
      return;
    }
    if (event.kind === "layout-change") {
      if (event.windowId === this.#boundWindowId) {
        this.#announce();
        this.#deferPlacementCheck();
      }
      return;
    }
    if (PLACEMENT_INVALIDATING_EVENTS.has(event.kind)) this.#requestReconcile();
  };

  async #reconcile(required: boolean): Promise<boolean> {
    if (this.#stopped) return false;
    const snapshot = await this.#context.snapshot(this.#watchAbort.signal);
    if (this.#stopped) return false;
    const placements = panePlacements(snapshot, this.#paneId);
    if (placements.length === 0) {
      const previous = this.#stop;
      this.#stop = undefined;
      this.#boundSessionId = undefined;
      this.#boundWindowId = undefined;
      previous?.();
      this.#resetRetry();
      this.#announce();
      if (required) throw new Error(`No pane ${this.#paneId} to subscribe to`);
      return false;
    }
    const current = placements.find((pane) => pane.format.session_id === this.#boundSessionId);
    if (current !== undefined) {
      const previousWindowId = this.#boundWindowId;
      this.#boundWindowId = current.format.window_id;
      this.#resetRetry();
      return previousWindowId !== this.#boundWindowId;
    }
    const placement = placements[0];
    if (placement === undefined) return false;
    const sessionId = placement.format.session_id;
    const opened = await this.#context.hub.listen(
      sessionId,
      this.#listener,
      this.#watchAbort.signal,
    );
    if (opened === undefined || !opened.active) {
      opened?.();
      throw new Error(`Cannot watch ${this.#paneId}: no control connection`);
    }
    if (this.#stopped) {
      opened();
      return false;
    }
    const previous = this.#stop;
    this.#stop = opened;
    this.#boundSessionId = sessionId;
    this.#boundWindowId = placement.format.window_id;
    previous?.();
    this.#resetRetry();
    if (!required) this.#announce();
    void opened.ended.then(() => {
      if (this.#stopped || this.#stop !== opened) return;
      this.#stop = undefined;
      this.#boundSessionId = undefined;
      this.#boundWindowId = undefined;
      this.#announce();
      this.#schedule();
    });
    return true;
  }

  #requestReconcile(): void {
    if (this.#stopped || this.#context.hub.closed) return;
    if (this.#placementCheck !== undefined) {
      clearTimeout(this.#placementCheck);
      this.#placementCheck = undefined;
    }
    void this.#startReconcile(false).catch(() => {
      this.#schedule();
    });
  }

  #resetRetry(): void {
    this.#retry = 0;
    if (this.#reconnect === undefined) return;
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
  }

  #schedule(): void {
    if (this.#stopped || this.#context.hub.closed || this.#reconnect !== undefined) return;
    const delay = Math.min(5_000, 250 * 2 ** Math.min(this.#retry, 5));
    this.#retry += 1;
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      this.#requestReconcile();
    }, delay);
    this.#reconnect.unref?.();
  }

  #startReconcile(required: boolean): Promise<void> {
    this.#reconcileAgain = true;
    if (this.#reconciling !== undefined) return this.#reconciling;
    const running = (async () => {
      while (this.#reconcileAgain && !this.#stopped) {
        this.#reconcileAgain = false;
        // eslint-disable-next-line no-await-in-loop -- topology bursts collapse here in order.
        const installed = await this.#reconcile(required);
        if (installed) this.#reconcileAgain = true;
      }
    })().finally(() => {
      if (this.#reconciling === running) this.#reconciling = undefined;
    });
    this.#reconciling = running;
    this.#tasks.add(running);
    void running.then(
      () => this.#tasks.delete(running),
      () => this.#tasks.delete(running),
    );
    return running;
  }
}
