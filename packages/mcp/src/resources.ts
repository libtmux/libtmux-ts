/**
 * The server as something to browse rather than only to call.
 *
 * Resources are how a client shows a person what is there, and templates are
 * the only place MCP offers argument completion — `completion/complete` takes a
 * prompt or a resource template and nothing else, so a pane id an agent can
 * complete has to be reachable through one of these.
 *
 * Pane content is subscribable. The updates come from the same control-mode
 * connection the wait tools use, so a subscriber costs one attach for the
 * session and no commands at all while it watches.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  isFailure,
  requirePane,
  requireSession,
  requireWindow,
  type ToolContext,
} from "./context.js";
import {
  paneContentUri,
  paneUri,
  sessionUri,
  windowUri,
  CLIENTS_URI,
  PANES_URI,
  SESSIONS_URI,
  WINDOWS_URI,
} from "./uris.js";
import { clientView, paneView, sessionView, windowView } from "./views.js";

/** The shortest gap between two update notifications for one resource. */
const UPDATE_COALESCE_MS = 500;

const JSON_MIME = "application/json";
/** Pane contents are terminal text: neither JSON to parse nor HTML to render. */
const TEXT_MIME = "text/plain";

/**
 * Read a template variable back as the id that was published.
 *
 * The sigils that make a tmux id readable — `%` for a pane, `$` for a session,
 * `@` for a window — are exactly the characters a URI path escapes, so every
 * published id arrives encoded and no id arrives intact by luck. Encoding on
 * the way out without decoding on the way in made the only resolvable form the
 * one this server never advertises.
 */
function publishedId(value: unknown): string {
  return decodeURIComponent(String(value));
}

/**
 * Throw what a lookup would have told a tool caller.
 *
 * A resource read cannot return a tool result, and the alternatives those
 * results carry are the reason a miss stops costing a turn. Reducing them to
 * "No pane %1" on the way through is how the resource surface ended up worse
 * than the tool surface for the same question.
 */
function resourceError(failure: CallToolResult): Error {
  const [first] = failure.content;
  return new Error(first?.type === "text" ? first.text : "Not found");
}

function jsonResource(uri: string, value: unknown): ReadResourceResult {
  return { contents: [{ mimeType: JSON_MIME, text: JSON.stringify(value, null, 2), uri }] };
}

function textResource(uri: string, text: string): ReadResourceResult {
  return { contents: [{ mimeType: TEXT_MIME, text, uri }] };
}

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
function watchTopology(context: ToolContext, announce: () => void): () => void {
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
      })
      .catch(() => undefined)
      .finally(() => {
        starting = false;
      });
  };
}

export function registerResources(mcp: McpServer, context: ToolContext): void {
  // Reading a browsable list is what says somebody is browsing, and so the
  // point at which it is worth holding a connection to hear about changes
  // this server did not make.
  const watching = watchTopology(context, () => {
    context.topologyChanged();
  });

  mcp.registerResource(
    "sessions",
    SESSIONS_URI,
    { description: "Every session on this server.", mimeType: JSON_MIME, title: "Sessions" },
    async () => {
      const snapshot = await context.snapshot();
      return jsonResource(
        SESSIONS_URI,
        snapshot.sessions
          .toArray()
          .map((session) =>
            sessionView(session, snapshot.windows.count({ session: { is: { id: session.id } } })),
          ),
      );
    },
  );

  mcp.registerResource(
    "windows",
    WINDOWS_URI,
    { description: "Every window on this server.", mimeType: JSON_MIME, title: "Windows" },
    async () =>
      jsonResource(WINDOWS_URI, (await context.snapshot()).windows.toArray().map(windowView)),
  );

  mcp.registerResource(
    "panes",
    PANES_URI,
    { description: "Every pane on this server.", mimeType: JSON_MIME, title: "Panes" },
    async () => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      return jsonResource(
        PANES_URI,
        snapshot.panes.toArray().map((pane) => paneView(pane, identity)),
      );
    },
  );

  mcp.registerResource(
    "clients",
    CLIENTS_URI,
    {
      description: "Who is attached, and which pane each is looking at.",
      mimeType: JSON_MIME,
      title: "Clients",
    },
    async () =>
      jsonResource(CLIENTS_URI, (await context.snapshot()).clients.toArray().map(clientView)),
  );

  mcp.registerResource(
    "session",
    new ResourceTemplate("tmux://sessions/{sessionId}", {
      complete: {
        sessionId: async (value) =>
          (await context.snapshot()).sessions
            .toArray()
            .flatMap((session) => [session.id, session.name ?? ""])
            .filter((candidate) => candidate !== "" && candidate.startsWith(value)),
      },
      list: async () => (
        watching(),
        {
          resources: (await context.snapshot()).sessions.toArray().map((session) => ({
            mimeType: JSON_MIME,
            name: session.name ?? session.id,
            uri: sessionUri(session.id),
          })),
        }
      ),
    }),
    { description: "One session with its windows.", mimeType: JSON_MIME, title: "Session" },
    async (uri, { sessionId }) => {
      const target = publishedId(sessionId);
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, target);
      if (isFailure(found)) throw resourceError(found);
      const session = found;
      return jsonResource(uri.href, {
        ...sessionView(session, snapshot.windows.count({ session: { is: { id: session.id } } })),
        windows: snapshot.windows
          .toArray()
          .filter((window) => window.sessionId === session.id)
          .map(windowView),
      });
    },
  );

  mcp.registerResource(
    "window",
    new ResourceTemplate("tmux://windows/{windowId}", {
      complete: {
        windowId: async (value) =>
          (await context.snapshot()).windows
            .toArray()
            .map((window) => window.id)
            .filter((candidate) => candidate.startsWith(value)),
      },
      list: async () => (
        watching(),
        {
          resources: (await context.snapshot()).windows.toArray().map((window) => ({
            mimeType: JSON_MIME,
            name: `${window.sessionName ?? "?"}:${window.name ?? window.id}`,
            uri: windowUri(window.id),
          })),
        }
      ),
    }),
    { description: "One window with its panes.", mimeType: JSON_MIME, title: "Window" },
    async (uri, { windowId }) => {
      const target = publishedId(windowId);
      const snapshot = await context.snapshot();
      const found = requireWindow(snapshot, target);
      if (isFailure(found)) throw resourceError(found);
      const window = found;
      const identity = await context.identity(snapshot);
      return jsonResource(uri.href, {
        ...windowView(window),
        panes: snapshot.panes
          .toArray()
          .filter((pane) => pane.windowId === window.id)
          .map((pane) => paneView(pane, identity)),
      });
    },
  );

  const completePaneId = async (value: string): Promise<string[]> =>
    (await context.snapshot()).panes
      .toArray()
      .map((pane) => pane.id)
      .filter((candidate) => candidate.startsWith(value));

  mcp.registerResource(
    "pane",
    new ResourceTemplate("tmux://panes/{paneId}", {
      complete: { paneId: completePaneId },
      list: async () => {
        watching();
        const snapshot = await context.snapshot();
        return {
          resources: snapshot.panes.toArray().map((pane) => ({
            description: `${pane.sessionName ?? "?"}:${pane.windowName ?? "?"} running ${pane.currentCommand ?? "?"}`,
            mimeType: JSON_MIME,
            name: pane.id,
            uri: paneUri(pane.id),
          })),
        };
      },
    }),
    { description: "One pane's metadata.", mimeType: JSON_MIME, title: "Pane" },
    async (uri, { paneId }) => {
      const target = publishedId(paneId);
      const snapshot = await context.snapshot();
      const found = requirePane(snapshot, target);
      if (isFailure(found)) throw resourceError(found);
      const pane = found;
      return jsonResource(uri.href, paneView(pane, await context.identity(snapshot)));
    },
  );

  mcp.registerResource(
    "pane-content",
    new ResourceTemplate("tmux://panes/{paneId}/content", {
      complete: { paneId: completePaneId },
      list: async () => (
        watching(),
        {
          resources: (await context.snapshot()).panes.toArray().map((pane) => ({
            description: `What ${pane.id} is showing.`,
            mimeType: TEXT_MIME,
            name: `${pane.id} contents`,
            uri: paneContentUri(pane.id),
          })),
        }
      ),
    }),
    {
      description: "What a pane is showing, as text. Subscribe to be told when it changes.",
      mimeType: TEXT_MIME,
      title: "Pane contents",
    },
    async (uri, { paneId }) => {
      const target = publishedId(paneId);
      const snapshot = await context.snapshot();
      const found = requirePane(snapshot, target);
      if (isFailure(found)) throw resourceError(found);
      const pane = found;
      return textResource(uri.href, (await pane.capture()).join("\n"));
    },
  );

  registerSubscriptions(mcp, context);
}

/**
 * Tell subscribers when a pane's contents change.
 *
 * `McpServer` handles reads but not subscriptions, so these go on the protocol
 * server underneath it. Updates are driven by the control connection rather than
 * a timer: a subscriber that nothing is writing to costs nothing.
 */
function registerSubscriptions(mcp: McpServer, context: ToolContext): void {
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
    const snapshot = await context.snapshot();
    const pane = snapshot.panes.oneOrUndefined({ id: paneId });
    const sessionId = pane?.sessionId;
    if (pane === undefined || sessionId === null || sessionId === undefined) {
      throw new Error(`No pane ${paneId} to subscribe to`);
    }

    // Coalesced hard. A subscriber re-reads the whole pane per notification, so
    // a build printing continuously would cost a capture every time tmux
    // flushed. This bounds that to twice a second however fast the pane talks.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const stop = await context.hub.listen(sessionId, (event) => {
      if (event.kind !== "output" && event.kind !== "extended-output") return;
      if (event.paneId !== paneId) return;
      if (pending !== undefined) return;
      pending = setTimeout(() => {
        pending = undefined;
        void mcp.server.sendResourceUpdated({ uri }).catch(() => undefined);
      }, UPDATE_COALESCE_MS);
      pending.unref?.();
    });
    if (stop === undefined) throw new Error(`Cannot watch ${paneId}: no control connection`);

    watching.set(uri, () => {
      if (pending !== undefined) clearTimeout(pending);
      stop();
    });
    return {};
  });

  mcp.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    watching.get(request.params.uri)?.();
    watching.delete(request.params.uri);
    return {};
  });
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
