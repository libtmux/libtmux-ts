import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { cancellation } from "./abort.js";
import type { ToolContext } from "./context.js";
import { PaneSubscriptionSupervisor, UPDATE_COALESCE_MS } from "./pane_subscription_supervisor.js";
import { PANES_URI } from "./uris.js";

/** Register pane-content subscriptions and return their joinable disposer. */
export function registerResourceSubscriptions(
  mcp: McpServer,
  context: ToolContext,
): () => Promise<void> {
  mcp.server.registerCapabilities({
    resources: {
      listChanged: true,
      ...(context.policy.liveEnabled ? { subscribe: true } : {}),
    },
  });
  if (!context.policy.liveEnabled) return async () => undefined;

  const watching = new Map<string, PaneSubscriptionSupervisor>();
  const closing = new Set<Promise<void>>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const closeWatch = (watch: PaneSubscriptionSupervisor): Promise<void> => {
    const task = watch.close();
    closing.add(task);
    void task.then(
      () => closing.delete(task),
      () => closing.delete(task),
    );
    return task;
  };
  const acknowledge = async (
    uri: string,
    watch: PaneSubscriptionSupervisor,
    signal: AbortSignal,
  ): Promise<void> => {
    try {
      await watch.wait(signal);
      if (signal.aborted) throw cancellation(signal);
      watch.acknowledged = true;
    } catch (error) {
      if (watching.get(uri) === watch && !watch.acknowledged && watch.waiters === 0) {
        watching.delete(uri);
        void closeWatch(watch);
      }
      throw error;
    }
  };

  mcp.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
    if (disposed) throw new Error("resource subscriptions are closed");
    if (extra.signal.aborted) throw cancellation(extra.signal);
    const uri = request.params.uri;
    const existing = watching.get(uri);
    if (existing !== undefined) {
      await acknowledge(uri, existing, extra.signal);
      return {};
    }

    const paneId = paneIdOfContentUri(uri);
    if (paneId === undefined) {
      throw new Error(`Only ${PANES_URI}/{paneId}/content can be subscribed to; got ${uri}`);
    }
    const watch = new PaneSubscriptionSupervisor(mcp, context, uri, paneId);
    void watch.ready.then(
      () => undefined,
      () => {
        if (watching.get(uri) !== watch) return;
        watching.delete(uri);
        void closeWatch(watch);
      },
    );
    watching.set(uri, watch);
    await acknowledge(uri, watch, extra.signal);
    return {};
  });

  mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const watch = watching.get(request.params.uri);
    if (watch === undefined) return {};
    watching.delete(request.params.uri);
    await closeWatch(watch);
    return {};
  });

  return (): Promise<void> => {
    disposePromise ??= (async () => {
      disposed = true;
      const active = [...watching.values()];
      watching.clear();
      for (const watch of active) void closeWatch(watch);
      await Promise.allSettled(closing);
    })();
    return disposePromise;
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
