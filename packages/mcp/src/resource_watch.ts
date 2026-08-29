import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TmuxEvent } from "libtmux";

import { cancellation, waitForAbort } from "./abort.js";
import type { ToolContext } from "./context.js";
import type { LiveListener } from "./live.js";
import { panePlacements } from "./target_resolution.js";
import { PANES_URI } from "./uris.js";

/** The shortest gap between two update notifications for one resource. */
const UPDATE_COALESCE_MS = 500;

const PLACEMENT_INVALIDATING_EVENTS = new Set<TmuxEvent["kind"]>([
  "sessions-changed",
  "unlinked-window-add",
  "unlinked-window-close",
  "window-add",
  "window-close",
]);

interface SubscriptionWatch {
  acknowledged: boolean;
  readonly cancel: () => void;
  readonly ready: Promise<void>;
  waiters: number;
}

/**
 * Tell subscribers when a pane's contents change.
 *
 * `McpServer` handles reads but not subscriptions, so these go on the protocol
 * server underneath it. Updates are driven by the control connection rather than
 * a timer: a subscriber that nothing is writing to costs nothing.
 */
export function registerResourceSubscriptions(mcp: McpServer, context: ToolContext): () => void {
  mcp.server.registerCapabilities({
    resources: {
      listChanged: true,
      // The subscribe handler needs a control connection and can only throw
      // without one. A capability is a promise, so it follows the ability.
      ...(context.policy.liveEnabled ? { subscribe: true } : {}),
    },
  });
  if (!context.policy.liveEnabled) return () => undefined;

  const watching = new Map<string, SubscriptionWatch>();
  const awaitReady = async (
    uri: string,
    watch: SubscriptionWatch,
    signal: AbortSignal,
  ): Promise<void> => {
    watch.waiters += 1;
    try {
      await waitForAbort(watch.ready, signal);
    } finally {
      watch.waiters -= 1;
      if (
        signal.aborted &&
        !watch.acknowledged &&
        watch.waiters === 0 &&
        watching.get(uri) === watch
      ) {
        watching.delete(uri);
        watch.cancel();
      }
    }
  };

  mcp.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
    const uri = request.params.uri;
    if (extra.signal.aborted) throw cancellation(extra.signal);
    const existing = watching.get(uri);
    if (existing !== undefined) {
      await awaitReady(uri, existing, extra.signal);
      if (extra.signal.aborted) throw cancellation(extra.signal);
      existing.acknowledged = true;
      return {};
    }

    const paneId = paneIdOfContentUri(uri);
    if (paneId === undefined) {
      throw new Error(`Only ${PANES_URI}/{paneId}/content can be subscribed to; got ${uri}`);
    }
    // Coalesced hard. A subscriber re-reads the whole pane per notification, so
    // a build printing continuously would cost a capture every time tmux
    // flushed. This bounds that to twice a second however fast the pane talks.
    let pending: ReturnType<typeof setTimeout> | undefined;
    let placementCheck: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let stopped = false;
    let stop: LiveListener | undefined;
    let boundSessionId: string | undefined;
    let boundWindowId: string | undefined;
    let reconciling: Promise<void> | undefined;
    let reconcileAgain = false;
    const watchAbort = new AbortController();
    const announce = (): void => {
      if (pending !== undefined) return;
      pending = setTimeout(() => {
        pending = undefined;
        void mcp.server.sendResourceUpdated({ uri }).catch(() => undefined);
      }, UPDATE_COALESCE_MS);
      pending.unref?.();
    };
    let requestReconcile!: () => void;
    const resetRetry = (): void => {
      retry = 0;
      if (reconnect === undefined) return;
      clearTimeout(reconnect);
      reconnect = undefined;
    };
    const schedule = (): void => {
      if (stopped || context.hub.closed || reconnect !== undefined) return;
      const delay = Math.min(5_000, 250 * 2 ** Math.min(retry, 5));
      retry += 1;
      reconnect = setTimeout(() => {
        reconnect = undefined;
        requestReconcile();
      }, delay);
      reconnect.unref?.();
    };
    let deferPlacementCheck!: () => void;
    const listener = (event: TmuxEvent): void => {
      if (event.kind === "output") {
        if (event.paneId === paneId) announce();
        return;
      }
      if (event.kind === "layout-change") {
        if (event.windowId === boundWindowId) {
          announce();
          deferPlacementCheck();
        }
        return;
      }
      if (PLACEMENT_INVALIDATING_EVENTS.has(event.kind)) requestReconcile();
    };
    const reconcile = async (required: boolean): Promise<boolean> => {
      if (stopped) return false;
      const snapshot = await context.snapshot();
      if (stopped) return false;
      const placements = panePlacements(snapshot, paneId);
      if (placements.length === 0) {
        const previous = stop;
        stop = undefined;
        boundSessionId = undefined;
        boundWindowId = undefined;
        previous?.();
        resetRetry();
        announce();
        if (required) throw new Error(`No pane ${paneId} to subscribe to`);
        return false;
      }
      const current = placements.find((pane) => pane.format.session_id === boundSessionId);
      if (current !== undefined) {
        const previousWindowId = boundWindowId;
        boundWindowId = current.format.window_id;
        resetRetry();
        return previousWindowId !== boundWindowId;
      }
      const placement = placements[0];
      if (placement === undefined) return false;
      const sessionId = placement.format.session_id;
      const opened = await context.hub.listen(sessionId, listener, watchAbort.signal);
      if (opened === undefined || !opened.active) {
        opened?.();
        throw new Error(`Cannot watch ${paneId}: no control connection`);
      }
      if (stopped) {
        opened();
        return false;
      }
      const previous = stop;
      stop = opened;
      boundSessionId = sessionId;
      boundWindowId = placement.format.window_id;
      previous?.();
      resetRetry();
      if (!required) announce();
      void opened.ended.then(() => {
        if (stopped || stop !== opened) return;
        stop = undefined;
        boundSessionId = undefined;
        boundWindowId = undefined;
        announce();
        schedule();
      });
      return true;
    };
    const startReconcile = (required: boolean): Promise<void> => {
      reconcileAgain = true;
      if (reconciling !== undefined) return reconciling;
      const running = (async () => {
        while (reconcileAgain && !stopped) {
          reconcileAgain = false;
          // eslint-disable-next-line no-await-in-loop -- topology bursts collapse here in order.
          const installed = await reconcile(required);
          // Verify after attaching. An unlink between the first snapshot and
          // the attach happened before this listener could hear about it.
          if (installed) reconcileAgain = true;
        }
      })().finally(() => {
        if (reconciling === running) reconciling = undefined;
      });
      reconciling = running;
      return running;
    };
    requestReconcile = (): void => {
      if (stopped || context.hub.closed) return;
      if (placementCheck !== undefined) {
        clearTimeout(placementCheck);
        placementCheck = undefined;
      }
      void startReconcile(false).catch(() => {
        schedule();
      });
    };
    deferPlacementCheck = (): void => {
      if (stopped || context.hub.closed || placementCheck !== undefined) return;
      placementCheck = setTimeout(() => {
        placementCheck = undefined;
        requestReconcile();
      }, UPDATE_COALESCE_MS);
      placementCheck.unref?.();
    };

    const cancelled = Promise.withResolvers<never>();
    const cancel = (): void => {
      if (stopped) return;
      stopped = true;
      watchAbort.abort();
      reconcileAgain = false;
      if (pending !== undefined) clearTimeout(pending);
      if (placementCheck !== undefined) clearTimeout(placementCheck);
      if (reconnect !== undefined) clearTimeout(reconnect);
      stop?.();
      stop = undefined;
      boundSessionId = undefined;
      boundWindowId = undefined;
      cancelled.reject(new Error("resource subscription cancelled"));
    };
    const startup = startReconcile(true);
    const ready = Promise.race([startup, cancelled.promise]);
    const watch: SubscriptionWatch = {
      acknowledged: false,
      cancel,
      ready,
      waiters: 0,
    };
    void ready.then(
      () => undefined,
      () => {
        if (watching.get(uri) !== watch) return;
        watching.delete(uri);
        cancel();
      },
    );
    watching.set(uri, watch);
    try {
      await awaitReady(uri, watch, extra.signal);
      if (extra.signal.aborted) throw cancellation(extra.signal);
      watch.acknowledged = true;
    } catch (error) {
      if (watching.get(uri) === watch && !watch.acknowledged && watch.waiters === 0) {
        watching.delete(uri);
        cancel();
      }
      throw error;
    }
    return {};
  });

  mcp.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    watching.get(request.params.uri)?.cancel();
    watching.delete(request.params.uri);
    return {};
  });

  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    for (const watch of watching.values()) watch.cancel();
    watching.clear();
  };
}

/** The pane a `tmux://panes/{id}/content` URI names, or undefined. */
function paneIdOfContentUri(uri: string): string | undefined {
  const match = /^tmux:\/\/panes\/([^/]+)\/content$/.exec(uri);
  const encoded = match?.[1];
  return encoded === undefined ? undefined : decodeURIComponent(encoded);
}

/** Coalesce tool mutations and externally observed catalog changes into one notice. */
export function createListChangedNotifier(mcp: McpServer): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined;
  return (): void => {
    if (pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      void mcp.server.sendResourceListChanged().catch(() => undefined);
    }, UPDATE_COALESCE_MS);
    pending.unref?.();
  };
}
