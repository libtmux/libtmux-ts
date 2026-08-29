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
import { type CallToolResult, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

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
import { effectiveResultLines, MAX_RESULT_BYTES } from "./policy.js";
import { JSON_MIME, registerResourceCatalog, TEXT_MIME } from "./resource_catalog.js";
import { registerResourceSubscriptions, watchTopology } from "./resource_watch.js";
import { boundText, renderBoundedText } from "./results.js";
import { CLIENTS_URI, PANES_URI, SESSIONS_URI, WINDOWS_URI } from "./uris.js";
import { clientView, paneView, sessionView, windowView } from "./views.js";

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
            .map((session) => session.id)
            .filter((candidate) => candidate.startsWith(value)),
      },
      list: undefined,
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
      list: undefined,
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
      list: undefined,
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
      list: undefined,
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

  registerResourceCatalog(mcp, context, watching);
  registerResourceSubscriptions(mcp, context);
}
