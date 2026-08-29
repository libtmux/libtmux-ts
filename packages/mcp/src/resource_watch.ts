import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TmuxEvent } from "libtmux";

import type { ToolContext } from "./context.js";
import type { LiveListener } from "./live.js";
import { panePlacements } from "./target_resolution.js";
import { PANES_URI } from "./uris.js";

/** The shortest gap between two update notifications for one resource. */
const UPDATE_COALESCE_MS = 500;

/** The notifications that change which sessions, windows or panes exist. */
const STRUCTURAL = new Set([
  "session-renamed",
  "sessions-changed",
  "unlinked-window-add",
  "unlinked-window-close",
  "unlinked-window-renamed",
  "window-add",
  "window-close",
  "window-renamed",
]);

/**
 * Announce a change somebody else made.
 *
 * Sending `listChanged` from this server's own mutating tools covers what this
 * server did, and this server is not the only thing changing the list: a
 * person in a terminal, or another agent on the same tmux server, changes it
 * too — and a client that believes `listChanged` refreshes only on notice.
 *
 * Anchored on the first read of a browsable list rather than at startup, so a
 * server nobody browses holds no connection for this. If the anchor cannot be
 * opened, because there is no session to attach to, the next read tries again.
 */
export function watchTopology(context: ToolContext, announce: () => void): () => void {
  let stop: (() => void) | undefined;
  let starting = false;

  return (): void => {
    if (stop !== undefined || starting || !context.policy.liveEnabled) return;
    starting = true;
    void context.hub
      .anchor((event) => {
        if (STRUCTURAL.has(event.kind)) announce();
      })
      .then((opened) => {
        stop = opened;
        if (opened !== undefined) {
          void opened.ended.then(() => {
            if (stop !== opened) return;
            stop = undefined;
            announce();
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        starting = false;
      });
  };
}

/**
 * Tell subscribers when a pane's contents change.
 *
 * `McpServer` handles reads but not subscriptions, so these go on the protocol
 * server underneath it. Updates are driven by the control connection rather than
 * a timer: a subscriber that nothing is writing to costs nothing.
 */
export function registerResourceSubscriptions(mcp: McpServer, context: ToolContext): void {
  const watching = new Map<string, () => void>();

  mcp.server.registerCapabilities({
    resources: {
      listChanged: true,
      // The subscribe handler needs a control connection and can only throw
      // without one. A capability is a promise, so it follows the ability.
      ...(context.policy.liveEnabled ? { subscribe: true } : {}),
    },
  });

  mcp.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (watching.has(uri)) return {};

    const paneId = paneIdOfContentUri(uri);
    if (paneId === undefined) {
      throw new Error(`Only ${PANES_URI}/{paneId}/content can be subscribed to; got ${uri}`);
    }
    // Coalesced hard. A subscriber re-reads the whole pane per notification, so
    // a build printing continuously would cost a capture every time tmux
    // flushed. This bounds that to twice a second however fast the pane talks.
    let pending: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let stopped = false;
    let stop: LiveListener | undefined;
    let boundSessionId: string | undefined;
    let reconciling: Promise<void> | undefined;
    let reconcileAgain = false;
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
    const listener = (event: TmuxEvent): void => {
      if (event.kind === "output") {
        if (event.paneId === paneId) announce();
        return;
      }
      if (STRUCTURAL.has(event.kind)) requestReconcile();
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
        previous?.();
        resetRetry();
        announce();
        if (required) throw new Error(`No pane ${paneId} to subscribe to`);
        return false;
      }
      if (
        boundSessionId !== undefined &&
        placements.some((pane) => pane.format.session_id === boundSessionId)
      ) {
        resetRetry();
        return false;
      }
      const sessionId = placements[0]?.format.session_id;
      if (sessionId === undefined) return false;
      const opened = await context.hub.listen(sessionId, listener);
      if (opened === undefined) {
        throw new Error(`Cannot watch ${paneId}: no control connection`);
      }
      if (stopped) {
        opened();
        return false;
      }
      const previous = stop;
      stop = opened;
      boundSessionId = sessionId;
      previous?.();
      resetRetry();
      if (!required) announce();
      void opened.ended.then(() => {
        if (stopped || stop !== opened) return;
        stop = undefined;
        boundSessionId = undefined;
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
      void startReconcile(false).catch(() => {
        schedule();
      });
    };

    const cancel = (): void => {
      stopped = true;
      reconcileAgain = false;
      if (pending !== undefined) clearTimeout(pending);
      if (reconnect !== undefined) clearTimeout(reconnect);
      stop?.();
      stop = undefined;
      boundSessionId = undefined;
    };
    watching.set(uri, cancel);
    try {
      await startReconcile(true);
    } catch (error) {
      cancel();
      watching.delete(uri);
      throw error;
    }
    return {};
  });

  mcp.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    watching.get(request.params.uri)?.();
    watching.delete(request.params.uri);
    return {};
  });

  const closed = mcp.server.onclose;
  mcp.server.onclose = (): void => {
    for (const cancel of watching.values()) cancel();
    watching.clear();
    closed?.();
  };
}

/** The pane a `tmux://panes/{id}/content` URI names, or undefined. */
function paneIdOfContentUri(uri: string): string | undefined {
  const match = /^tmux:\/\/panes\/([^/]+)\/content$/.exec(uri);
  const encoded = match?.[1];
  return encoded === undefined ? undefined : decodeURIComponent(encoded);
}

/**
 * Say the resource list changed, at most once per coalescing window.
 *
 * A client that believes `listChanged` caches the list and refreshes only on
 * notice, so a list this server changed and did not announce is a world the
 * agent goes on acting in after it is gone. Every split, every new window and
 * every dead pane changes it, which is why this is cheap enough to send from
 * each of them: build_workspace makes a session, its windows and their panes
 * in one call, and that is one notice rather than nine.
 *
 * This covers changes this server made. A change somebody else made on the
 * same tmux server still goes unannounced — that needs a control connection
 * held for structural notifications, which is a lifecycle question of its own.
 */
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
