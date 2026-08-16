/**
 * Reading the server: what exists, where, and which of it is yours.
 *
 * Every tool here takes one snapshot and answers from it. Counting windows per
 * session out of the snapshot already in hand, rather than asking each session,
 * is the difference between one command and one per session.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { isFailure, requirePane, type ToolContext } from "../context.js";
import { offers, READ_ONLY } from "../register.js";
import { ok } from "../results.js";
import {
  clientView,
  clientViewSchema,
  paneLine,
  paneView,
  paneViewSchema,
  sessionLine,
  sessionView,
  sessionViewSchema,
  windowLine,
  windowView,
  windowViewSchema,
} from "../views.js";

export function registerDiscovery(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "readonly")) return;

  mcp.registerTool(
    "list_sessions",
    {
      annotations: READ_ONLY,
      description:
        "Every session on this server with its id, name, window count, and whether " +
        "anyone is attached. Metadata only — for what a pane shows, use capture_pane " +
        "or search_panes.",
      inputSchema: {},
      outputSchema: { sessions: z.array(sessionViewSchema) },
      title: "List sessions",
    },
    async () => {
      const snapshot = await context.snapshot();
      const sessions = snapshot.sessions
        .toArray()
        .map((session) =>
          sessionView(session, snapshot.windows.count({ session: { is: { id: session.id } } })),
        );
      return ok(
        { sessions },
        sessions.length === 0
          ? "No sessions on this server. Create one with new_session."
          : sessions.map(sessionLine).join("\n"),
      );
    },
  );

  mcp.registerTool(
    "list_windows",
    {
      annotations: READ_ONLY,
      description: "Windows on this server, optionally restricted to one session by id or name.",
      inputSchema: {
        session: z.string().optional().describe("Session id ($1) or name. Omit for all sessions."),
      },
      outputSchema: { windows: z.array(windowViewSchema) },
      title: "List windows",
    },
    async ({ session }) => {
      const snapshot = await context.snapshot();
      const all = snapshot.windows.toArray();
      const windows = (
        session === undefined
          ? all
          : all.filter((window) => window.sessionId === session || window.sessionName === session)
      ).map(windowView);
      return ok(
        { windows },
        windows.length === 0 ? "No windows matched." : windows.map(windowLine).join("\n"),
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
        session: z.string().optional().describe("Session id ($1) or name."),
        window: z.string().optional().describe("Window id (@1)."),
      },
      outputSchema: { panes: z.array(paneViewSchema) },
      title: "List panes",
    },
    async ({ session, window }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const panes = snapshot.panes
        .toArray()
        .filter(
          (pane) =>
            (session === undefined || pane.sessionId === session || pane.sessionName === session) &&
            (window === undefined || pane.windowId === window),
        )
        .map((pane) => paneView(pane, identity));
      return ok(
        { panes },
        panes.length === 0 ? "No panes matched." : panes.map(paneLine).join("\n"),
      );
    },
  );

  mcp.registerTool(
    "get_pane",
    {
      annotations: READ_ONLY,
      description:
        "One pane's metadata: what it runs, where, how big, and whether it is yours " +
        "or watched. Does not read its contents — capture_pane does that.",
      inputSchema: { paneId: z.string().describe("Pane id, e.g. %1.") },
      outputSchema: { pane: paneViewSchema },
      title: "Get pane",
    },
    async ({ paneId }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      const identity = await context.identity(snapshot);
      const view = paneView(pane, identity);
      return ok({ pane: view }, paneLine(view));
    },
  );

  mcp.registerTool(
    "whoami",
    {
      annotations: READ_ONLY,
      description:
        "Which pane this MCP server runs in, and which panes a person is currently " +
        "watching. Call this before writing to a pane you did not create: typing " +
        "into your own terminal or into someone's foreground window is the one " +
        "mistake tmux cannot undo.",
      inputSchema: {},
      outputSchema: {
        attendedPaneIds: z.array(z.string()),
        callerPaneId: z.string().nullable(),
        callerPaneIsOnThisServer: z.boolean(),
        clients: z.array(clientViewSchema),
        serverPid: z.string().nullable(),
      },
      title: "Who and where am I",
    },
    async () => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const clients = snapshot.clients.toArray().map(clientView);
      const structured = {
        attendedPaneIds: identity.attendedPaneIds,
        callerPaneId: identity.callerPaneId ?? null,
        callerPaneIsOnThisServer: identity.callerPaneIsOnThisServer,
        clients,
        serverPid: identity.serverPid ?? null,
      };
      const lines = [
        identity.callerPaneId === undefined
          ? "This server does not run inside a tmux pane, so it has no pane of its own."
          : identity.callerPaneIsOnThisServer
            ? `Running inside pane ${identity.callerPaneId} on this server — do not write to it.`
            : `Running inside pane ${identity.callerPaneId}, but on a different tmux server than this one.`,
        identity.attendedPaneIds.length === 0
          ? "Nobody is attached; no pane is being watched."
          : `Watched by a person: ${identity.attendedPaneIds.join(", ")}`,
      ];
      return ok(structured, lines.join("\n"));
    },
  );

  mcp.registerTool(
    "server_info",
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
      const [version, identity] = await Promise.all([
        context.tmux.version(),
        context.tmux.daemonIdentity(),
      ]);
      const structured = {
        panes: snapshot.panes.count(),
        pid: identity?.pid ?? null,
        sessions: snapshot.sessions.count(),
        socketPath: context.tmux.socketPath ?? null,
        version: version.raw,
        windows: snapshot.windows.count(),
      };
      return ok(
        structured,
        `tmux ${structured.version} on ${structured.socketPath ?? "<default socket>"}, ` +
          `${String(structured.sessions)} sessions / ${String(structured.windows)} windows / ${String(structured.panes)} panes`,
      );
    },
  );

  mcp.registerTool(
    "display_message",
    {
      annotations: READ_ONLY,
      description:
        "Resolve a tmux format string against a target, e.g. '#{pane_current_command}'. " +
        "The escape hatch for any field these tools do not project.",
      inputSchema: {
        format: z.string().describe("A tmux format, e.g. '#{pane_pid}'."),
        target: z.string().optional().describe("Pane id to resolve against."),
      },
      outputSchema: { value: z.string() },
      title: "Resolve a tmux format",
    },
    async ({ format, target }) => {
      const snapshot = await context.snapshot();
      if (target !== undefined) {
        const pane = requirePane(snapshot, target);
        if (isFailure(pane)) return pane;
        const lines = await pane.displayMessage(format);
        const value = lines.join("\n");
        return ok({ value }, value);
      }
      const lines = await context.tmux.cmd("display-message", ["-p", format], { target: null });
      const value = lines.join("\n");
      return ok({ value }, value);
    },
  );
}
