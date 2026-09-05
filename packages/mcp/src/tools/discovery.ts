/**
 * Reading the server: what exists, where, and which of it is yours.
 *
 * Every tool here takes one snapshot and answers from it. Counting windows per
 * session out of the snapshot already in hand, rather than asking each session,
 * is the difference between one command and one per session.
 */

import { z } from "zod";

import type { ToolContext } from "../context.js";
import { effectiveResultLines } from "../policy.js";
import { READ_ONLY, type ToolRegistrar } from "../register.js";
import { ok } from "../results.js";
import { paneIdSchema, requestText, windowIdSchema } from "../schemas.js";
import {
  isFailure,
  paneEntities,
  panePlacements,
  requirePane,
  requireSession,
  windowEntities,
  windowPlacements,
} from "../target_resolution.js";
import {
  limitViews,
  paneLine,
  paneView,
  paneViewSchema,
  renderViews,
  sessionLine,
  sessionView,
  sessionViewSchema,
  windowLine,
  windowView,
  windowViewSchema,
} from "../views.js";

/**
 * A path, safe to put in a result.
 *
 * A socket path is not a tmux name: `check_name` never sees it, so it can hold
 * a newline or any other control byte, and this one reaches an agent's context
 * on every call. Escaping it here keeps a path from introducing a line break
 * into a reply that is read as lines.
 */
function printable(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    escaped +=
      code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : character;
  }
  return escaped;
}

export function registerDiscovery(mcp: ToolRegistrar, context: ToolContext): void {
  mcp.registerTool(
    "list_sessions",
    {
      annotations: READ_ONLY,
      description:
        "Every session on this server with its id, name, window count, and whether " +
        "anyone is attached. Metadata only — for what a pane shows, use capture_pane " +
        "or search_panes.",
      inputSchema: {},
      outputSchema: {
        complete: z.boolean(),
        omittedEntries: z.number().int(),
        sessions: z.array(sessionViewSchema),
      },
      title: "List sessions",
    },
    async () => {
      const snapshot = await context.snapshot();
      const sessions = snapshot.sessions
        .toArray()
        .map((session) =>
          sessionView(session, snapshot.windows.count({ session: { is: { id: session.id } } })),
        );
      const bounded = limitViews(
        sessions,
        effectiveResultLines(context.policy, undefined),
        sessionLine,
      );
      return ok(
        {
          complete: bounded.complete,
          omittedEntries: bounded.omittedEntries,
          sessions: bounded.views,
        },
        sessions.length === 0
          ? "No sessions on this server. Create one with create_session."
          : renderViews(bounded, "sessions", "reduce the server topology before listing again"),
      );
    },
  );

  mcp.registerTool(
    "list_windows",
    {
      annotations: READ_ONLY,
      description: "Windows on this server, optionally restricted to one session by id or name.",
      inputSchema: {
        session: requestText("session")
          .optional()
          .describe("Session id ($1) or name. Omit for all sessions."),
      },
      outputSchema: {
        complete: z.boolean(),
        omittedEntries: z.number().int(),
        windows: z.array(windowViewSchema),
      },
      title: "List windows",
    },
    async ({ session }) => {
      const snapshot = await context.snapshot();
      const all = snapshot.windows.toArray();
      // Resolved rather than matched: an id and a name are different
      // namespaces, and matching either meant one string picked two sessions
      // here while requireSession picked one everywhere else.
      const target = session === undefined ? undefined : requireSession(snapshot, session);
      if (target !== undefined && isFailure(target)) return target;
      const windows = windowEntities(
        target === undefined ? all : all.filter((window) => window.format.session_id === target.id),
      ).map((window) => windowView(window, windowPlacements(snapshot, window.id)));
      const bounded = limitViews(
        windows,
        effectiveResultLines(context.policy, undefined),
        windowLine,
      );
      return ok(
        {
          complete: bounded.complete,
          omittedEntries: bounded.omittedEntries,
          windows: bounded.views,
        },
        windows.length === 0
          ? "No windows matched."
          : renderViews(bounded, "windows", "filter by session before listing again"),
      );
    },
  );

  mcp.registerTool(
    "list_panes",
    {
      annotations: READ_ONLY,
      description:
        "Panes on this server, with the command each is running and its directory. " +
        "Marks the pane this server runs in (isCallerPane) and panes a person is " +
        "watching (isAttended). Metadata only — search_panes reads their contents.",
      inputSchema: {
        session: requestText("session").optional().describe("Session id ($1) or name."),
        window: windowIdSchema.optional(),
      },
      outputSchema: {
        complete: z.boolean(),
        omittedEntries: z.number().int(),
        panes: z.array(paneViewSchema),
      },
      title: "List panes",
    },
    async ({ session, window }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const target = session === undefined ? undefined : requireSession(snapshot, session);
      if (target !== undefined && isFailure(target)) return target;
      const panes = paneEntities(
        snapshot.panes
          .toArray()
          .filter(
            (pane) =>
              (target === undefined || pane.format.session_id === target.id) &&
              (window === undefined || pane.format.window_id === window),
          ),
      ).map((pane) => paneView(pane, identity, panePlacements(snapshot, pane.id)));
      const bounded = limitViews(panes, effectiveResultLines(context.policy, undefined), paneLine);
      return ok(
        {
          complete: bounded.complete,
          omittedEntries: bounded.omittedEntries,
          panes: bounded.views,
        },
        panes.length === 0
          ? "No panes matched."
          : renderViews(bounded, "panes", "filter by session or window before listing again"),
      );
    },
  );

  mcp.registerTool(
    "get_pane_info",
    {
      annotations: READ_ONLY,
      description:
        "One pane's metadata: what it runs, where, how big, and whether it is yours " +
        "or watched. Does not read its contents — capture_pane does that.",
      inputSchema: { paneId: paneIdSchema },
      outputSchema: { pane: paneViewSchema },
      title: "Get pane",
    },
    async ({ paneId }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      const identity = await context.identity(snapshot);
      const view = paneView(pane, identity, panePlacements(snapshot, pane.id));
      return ok({ pane: view }, paneLine(view));
    },
  );

  mcp.registerTool(
    "get_server_info",
    {
      annotations: READ_ONLY,
      description:
        "The tmux server this process drives: its socket, version, daemon pid, and " +
        "totals. Check the version before using a feature that needs a recent tmux.",
      inputSchema: {},
      outputSchema: {
        panes: z.number().int(),
        pid: z.string().nullable(),
        sessions: z.number().int(),
        socketPath: z.string().nullable(),
        version: z.string(),
        windows: z.number().int(),
      },
      title: "Server info",
    },
    async () => {
      const snapshot = await context.snapshot();
      const [version, identity, resolvedSocket] = await Promise.all([
        context.tmux.version(),
        context.tmux.daemonIdentity(),
        // The constructor argument is what this process was told, and on the
        // default socket it was told nothing — so this reported null about a
        // server that has a socket like any other, while the text rendering
        // said "<default socket>" and the two disagreed. tmux knows.
        context.tmux
          .cmd("display-message", ["-p", "#{socket_path}"], { target: null })
          .then((lines) => lines[0] ?? "")
          .catch(() => ""),
      ]);
      const structured = {
        panes: paneEntities(snapshot.panes.toArray()).length,
        pid: identity.pid,
        sessions: snapshot.sessions.count(),
        socketPath: printable(resolvedSocket === "" ? context.tmux.socketPath : resolvedSocket),
        version: version.raw,
        windows: windowEntities(snapshot.windows.toArray()).length,
      };
      return ok(
        structured,
        `tmux ${structured.version} on ${structured.socketPath ?? "<default socket>"}, ` +
          `${String(structured.sessions)} sessions / ${String(structured.windows)} windows / ${String(structured.panes)} panes`,
      );
    },
  );
}
