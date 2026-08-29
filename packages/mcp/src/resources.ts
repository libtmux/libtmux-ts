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
import type { TmuxEvent } from "libtmux";

import {
  isFailure,
  paneEntities,
  panePlacements,
  requirePane,
  requireSession,
  requireWindow,
  windowEntities,
  windowPlacements,
  type ToolContext,
} from "./context.js";
import { captureGridBounded } from "./grid_capture.js";
import type { LiveListener } from "./live.js";
import { effectiveResultLines, MAX_RESULT_BYTES } from "./policy.js";
import { boundText, renderBoundedText } from "./results.js";
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
  const pretty = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(pretty, "utf8") <= MAX_RESULT_BYTES) {
    return { contents: [{ mimeType: JSON_MIME, text: pretty, uri }] };
  }
  const compact = JSON.stringify(value);
  if (Buffer.byteLength(compact, "utf8") <= MAX_RESULT_BYTES) {
    return { contents: [{ mimeType: JSON_MIME, text: compact, uri }] };
  }
  const text = JSON.stringify({
    complete: false,
    omittedBytes: Buffer.byteLength(compact, "utf8"),
    reason: `The resource exceeds the ${String(MAX_RESULT_BYTES)}-byte result ceiling.`,
    value: null,
  });
  return { contents: [{ mimeType: JSON_MIME, text, uri }] };
}

function collectionJson(
  base: Readonly<Record<string, unknown>>,
  field: string,
  items: readonly string[],
  omittedItems: number,
  totalItems: number,
): string {
  const fields = Object.entries(base)
    .filter(([name]) => name !== field)
    .map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`);
  fields.push(
    `"complete":false`,
    `${JSON.stringify(field)}:[${items.join(",")}]`,
    `"omittedItems":${String(omittedItems)}`,
    `"totalItems":${String(totalItems)}`,
  );
  return `{${fields.join(",")}}`;
}

/** Preserve the normal JSON shape unless a collection needs an explicit bounded envelope. */
function jsonCollectionResource(
  uri: string,
  base: Readonly<Record<string, unknown>>,
  field: string,
  items: readonly unknown[],
): ReadResourceResult {
  const whole = Object.keys(base).length === 0 ? items : { ...base, [field]: items };
  const compact = JSON.stringify(whole);
  if (Buffer.byteLength(compact, "utf8") <= MAX_RESULT_BYTES) return jsonResource(uri, whole);

  const serialized = items.map((item) => JSON.stringify(item));
  const empty = collectionJson(base, field, [], items.length, items.length);
  if (Buffer.byteLength(empty, "utf8") > MAX_RESULT_BYTES) {
    return jsonResource(uri, {
      complete: false,
      entityOmitted: true,
      omittedItems: items.length,
      reason: `The entity metadata exceeds the ${String(MAX_RESULT_BYTES)}-byte result ceiling.`,
      totalItems: items.length,
    });
  }

  const kept: string[] = [];
  let bytes = Buffer.byteLength(empty, "utf8");
  for (const item of serialized) {
    const next = bytes + Buffer.byteLength(item, "utf8") + (kept.length === 0 ? 0 : 1);
    if (next > MAX_RESULT_BYTES) break;
    kept.push(item);
    bytes = next;
  }
  const text = collectionJson(base, field, kept, items.length - kept.length, items.length);
  return { contents: [{ mimeType: JSON_MIME, text, uri }] };
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
      return jsonCollectionResource(
        SESSIONS_URI,
        {},
        "items",
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
    async () => {
      const snapshot = await context.snapshot();
      return jsonCollectionResource(
        WINDOWS_URI,
        {},
        "items",
        windowEntities(snapshot.windows.toArray()).map((window) =>
          windowView(window, windowPlacements(snapshot, window.id)),
        ),
      );
    },
  );

  mcp.registerResource(
    "panes",
    PANES_URI,
    { description: "Every pane on this server.", mimeType: JSON_MIME, title: "Panes" },
    async () => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      return jsonCollectionResource(
        PANES_URI,
        {},
        "items",
        paneEntities(snapshot.panes.toArray()).map((pane) =>
          paneView(pane, identity, panePlacements(snapshot, pane.id)),
        ),
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
      jsonCollectionResource(
        CLIENTS_URI,
        {},
        "items",
        (await context.snapshot()).clients.toArray().map(clientView),
      ),
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
      return jsonCollectionResource(
        uri.href,
        sessionView(session, snapshot.windows.count({ session: { is: { id: session.id } } })),
        "windows",
        windowEntities(
          snapshot.windows.toArray().filter((window) => window.format.session_id === session.id),
        ).map((window) => windowView(window, windowPlacements(snapshot, window.id))),
      );
    },
  );

  mcp.registerResource(
    "window",
    new ResourceTemplate("tmux://windows/{windowId}", {
      complete: {
        windowId: async (value) =>
          windowEntities((await context.snapshot()).windows.toArray())
            .map((window) => window.id)
            .filter((candidate) => candidate.startsWith(value)),
      },
      list: async () => (
        watching(),
        {
          resources: windowEntities((await context.snapshot()).windows.toArray()).map((window) => ({
            mimeType: JSON_MIME,
            name: window.name ?? window.id,
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
      return jsonCollectionResource(
        uri.href,
        windowView(window, windowPlacements(snapshot, window.id)),
        "panes",
        paneEntities(
          snapshot.panes.toArray().filter((pane) => pane.format.window_id === window.id),
        ).map((pane) => paneView(pane, identity, panePlacements(snapshot, pane.id))),
      );
    },
  );

  const completePaneId = async (value: string): Promise<string[]> =>
    paneEntities((await context.snapshot()).panes.toArray())
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
          resources: paneEntities(snapshot.panes.toArray()).map((pane) => ({
            description: `${pane.session?.name ?? "?"}:${pane.window?.name ?? "?"} running ${pane.currentCommand ?? "?"}`,
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
      return jsonResource(
        uri.href,
        paneView(pane, await context.identity(snapshot), panePlacements(snapshot, pane.id)),
      );
    },
  );

  mcp.registerResource(
    "pane-content",
    new ResourceTemplate("tmux://panes/{paneId}/content", {
      complete: { paneId: completePaneId },
      list: async () => (
        watching(),
        {
          resources: paneEntities((await context.snapshot()).panes.toArray()).map((pane) => ({
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
      const limit = effectiveResultLines(context.policy, undefined);
      const bounded = await captureGridBounded(pane, {
        byteLimit: MAX_RESULT_BYTES,
        lineLimit: limit,
      });
      const contents = boundText(bounded.lines, limit, MAX_RESULT_BYTES);
      const omitted = bounded.byteClamped && bounded.lines.length === 0;
      const rangeNotice = omitted
        ? `[capture omitted: no complete row fits the ${String(MAX_RESULT_BYTES)}-byte result ceiling]`
        : bounded.range.clamped || bounded.byteClamped
          ? "[capture shortened to fit the server result limits]"
          : "";
      return textResource(
        uri.href,
        [rangeNotice, renderBoundedText(contents, "use capture_pane with a narrower range")]
          .filter((part) => part !== "")
          .join("\n"),
      );
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
    // Coalesced hard. A subscriber re-reads the whole pane per notification, so
    // a build printing continuously would cost a capture every time tmux
    // flushed. This bounds that to twice a second however fast the pane talks.
    let pending: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let stopped = false;
    let stop: LiveListener | undefined;
    const announce = (): void => {
      if (pending !== undefined) return;
      pending = setTimeout(() => {
        pending = undefined;
        void mcp.server.sendResourceUpdated({ uri }).catch(() => undefined);
      }, UPDATE_COALESCE_MS);
      pending.unref?.();
    };
    const listener = (event: TmuxEvent): void => {
      if (event.kind !== "output") return;
      if (event.paneId !== paneId) return;
      announce();
    };
    let open!: (required: boolean) => Promise<void>;
    const schedule = (): void => {
      if (stopped || reconnect !== undefined) return;
      const delay = Math.min(5_000, 250 * 2 ** Math.min(retry, 5));
      retry += 1;
      reconnect = setTimeout(() => {
        reconnect = undefined;
        void open(false).catch(() => {
          schedule();
        });
      }, delay);
      reconnect.unref?.();
    };
    open = async (required): Promise<void> => {
      const snapshot = await context.snapshot();
      const pane = snapshot.panes.first({ id: paneId });
      const sessionId = pane?.format.session_id;
      if (pane === undefined || sessionId === null || sessionId === undefined) {
        announce();
        if (required) throw new Error(`No pane ${paneId} to subscribe to`);
        return;
      }
      const opened = await context.hub.listen(sessionId, listener);
      if (opened === undefined) {
        if (required) throw new Error(`Cannot watch ${paneId}: no control connection`);
        schedule();
        return;
      }
      if (stopped) {
        opened();
        return;
      }
      stop = opened;
      retry = 0;
      void opened.ended.then(() => {
        if (stopped || stop !== opened) return;
        stop = undefined;
        announce();
        schedule();
      });
    };

    const cancel = (): void => {
      stopped = true;
      if (pending !== undefined) clearTimeout(pending);
      if (reconnect !== undefined) clearTimeout(reconnect);
      stop?.();
    };
    watching.set(uri, cancel);
    try {
      await open(true);
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
