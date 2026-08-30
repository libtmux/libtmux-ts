/**
 * Reading the server: what exists, where, and which of it is yours.
 *
 * Every tool here takes one snapshot and answers from it. Counting windows per
 * session out of the snapshot already in hand, rather than asking each session,
 * is the difference between one command and one per session.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CallerIdentity } from "../caller.js";
import type { ToolContext } from "../context.js";
import { effectiveResultLines, MAX_RESULT_BYTES } from "../policy.js";
import { offers, OPEN_WORLD, READ_ONLY } from "../register.js";
import { boundText, ok, renderBoundedText } from "../results.js";
import { inlineRequestText, paneIdSchema, requestText, windowIdSchema } from "../schemas.js";
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
  clientView,
  clientViewSchema,
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
  type ClientView,
} from "../views.js";

const PROJECTED_RESULT_BYTES = MAX_RESULT_BYTES - 1_024;

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

interface WhoamiProjection extends Readonly<Record<string, unknown>> {
  readonly attendedPaneIds: readonly string[];
  readonly callerPaneId: string | null;
  readonly callerPaneIsOnThisServer: boolean;
  readonly clients: readonly ClientView[];
  readonly complete: boolean;
  readonly omittedAttendedPaneIds: number;
  readonly omittedClients: number;
  readonly serverPid: string | null;
}

function whoamiLines(value: WhoamiProjection): readonly string[] {
  const watched =
    value.attendedPaneIds.length === 0
      ? value.omittedAttendedPaneIds === 0
        ? "Nobody is attached; no pane is being watched."
        : `${String(value.omittedAttendedPaneIds)} watched pane ids omitted by the result ceiling.`
      : `Watched by a person: ${value.attendedPaneIds.join(", ")}${
          value.omittedAttendedPaneIds === 0
            ? ""
            : `, and ${String(value.omittedAttendedPaneIds)} more`
        }`;
  return [
    value.callerPaneId === null
      ? "This server does not run inside a tmux pane, so it has no pane of its own."
      : value.callerPaneIsOnThisServer
        ? `Running inside pane ${value.callerPaneId} on this server — do not write to it.`
        : `Running inside pane ${value.callerPaneId}, but on a different tmux server than this one.`,
    watched,
    value.omittedClients === 0
      ? ""
      : `${String(value.omittedClients)} attached clients omitted by the result ceiling.`,
  ].filter((line) => line !== "");
}

function largestFittingPrefix(length: number, fits: (count: number) => boolean): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

function boundedWhoami(
  identity: CallerIdentity,
  callerPaneId: string | null,
  clients: readonly ClientView[],
): WhoamiProjection {
  const build = (attendedCount: number, clientCount: number): WhoamiProjection => {
    const omittedAttendedPaneIds = identity.attendedPaneIds.length - attendedCount;
    const omittedClients = clients.length - clientCount;
    return {
      attendedPaneIds: identity.attendedPaneIds.slice(0, attendedCount),
      callerPaneId,
      callerPaneIsOnThisServer: identity.callerPaneIsOnThisServer,
      clients: clients.slice(0, clientCount),
      complete: omittedAttendedPaneIds === 0 && omittedClients === 0,
      omittedAttendedPaneIds,
      omittedClients,
      serverPid: identity.serverPid ?? null,
    };
  };
  const fits = (value: WhoamiProjection): boolean =>
    Buffer.byteLength(JSON.stringify(value), "utf8") <= PROJECTED_RESULT_BYTES &&
    Buffer.byteLength(whoamiLines(value).join("\n"), "utf8") <= PROJECTED_RESULT_BYTES;
  // Pane ids carry the safety decision, so retain them before client metadata.
  const attendedCount = largestFittingPrefix(identity.attendedPaneIds.length, (count) =>
    fits(build(count, 0)),
  );
  const clientCount = largestFittingPrefix(clients.length, (count) =>
    fits(build(attendedCount, count)),
  );
  return build(attendedCount, clientCount);
}

/**
 * The bare variable names in a tmux format.
 *
 * Only `#{name}` is a name. Everything else tmux allows inside the braces —
 * `#{?cond,a,b}`, `#{==:x,y}`, `#{s/a/b/:var}`, `#{e|...}`, `#{T:...}` — is an
 * expression, and an identifier test skips all of them because none is one.
 * Rejecting a working format would be worse than the silence this replaces.
 */
function formatVariables(format: string): readonly string[] {
  const names: string[] = [];
  for (const match of format.matchAll(/#\{([^{}]*)\}/gu)) {
    const inner = match[1] ?? "";
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(inner)) names.push(inner);
  }
  return names;
}

/**
 * Say which names in a format tmux does not know.
 *
 * tmux prints nothing for a field it has never heard of and exits 0, so a typo
 * and a genuinely empty field are the same answer — in the one tool documented
 * as the escape hatch for fields nothing else projects, which is where a
 * hand-written format is most likely. `display-message -a` enumerates the
 * table, so the two can be told apart.
 *
 * Enumerated against the same target the caller used: the set is
 * target-dependent, and a pane field checked at server scope would look
 * missing when it is only out of scope.
 *
 * Asking the running tmux rather than carrying a table is what makes this
 * version-aware: 3.4 knows 120 variables against a pane and 3.7 knows 141, so
 * a format written against a newer server is told exactly which field the
 * older one lacks, and a field added in a future tmux needs no change here.
 * A static list would be faster and would quietly lose all of that.
 */
async function unknownFields(
  enumerate: () => Promise<readonly string[]>,
  asked: readonly string[],
  value: string,
): Promise<readonly string[]> {
  // Extracting the names is pure string work, so it happens first and for
  // free. The table is consulted when nothing resolved, and also when more
  // than one name could have contributed — a format mixing a known field with
  // an unknown one produces something that reads like a value, so partial
  // resolution is invisible in a way a wholly empty result is not. One name
  // that resolved is the common case and still costs nothing.
  if (asked.length === 0) return [];
  if (value !== "" && asked.length < 2) return [];
  const known = new Set(
    (await enumerate().catch(() => [])).map((line) => line.slice(0, line.indexOf("="))),
  );
  if (known.size === 0) return [];
  return asked.filter((name) => !known.has(name));
}

/** How an empty result explains itself. */
function emptyNote(unknown: readonly string[]): string {
  if (unknown.length === 0) return "";
  return (
    `\n\n[tmux has no ${unknown.length === 1 ? "field" : "fields"} ${unknown.join(", ")}. ` +
    `It prints nothing for a name it does not know, so an empty value can be a typo ` +
    `rather than an empty field.]`
  );
}

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
          ? "No sessions on this server. Create one with new_session."
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
    "get_pane",
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
        attendedPaneIds: z.array(paneIdSchema),
        callerPaneId: paneIdSchema.nullable(),
        callerPaneIsOnThisServer: z.boolean(),
        clients: z.array(clientViewSchema),
        complete: z.boolean(),
        omittedAttendedPaneIds: z.number().int().nonnegative(),
        omittedClients: z.number().int().nonnegative(),
        serverPid: z.string().nullable(),
      },
      title: "Who and where am I",
    },
    async () => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const clients = snapshot.clients.toArray().map(clientView);
      const callerPaneId = paneIdSchema.safeParse(identity.callerPaneId);
      const structured = boundedWhoami(
        identity,
        callerPaneId.success ? callerPaneId.data : null,
        clients,
      );
      return ok(structured, whoamiLines(structured).join("\n"));
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

  if (offers(context.policy, "mutating")) {
    mcp.registerTool(
      "display_message",
      {
        annotations: OPEN_WORLD,
        description:
          "Resolve a tmux format string against a target, e.g. '#{pane_current_command}'. " +
          "The escape hatch for any field these tools do not project.",
        inputSchema: {
          format: inlineRequestText("format").describe("A tmux format, e.g. '#{pane_pid}'."),
          target: paneIdSchema.optional().describe("Pane id to resolve against."),
        },
        outputSchema: {
          complete: z.boolean(),
          droppedLines: z.number().int(),
          omittedBytes: z.number().int(),
          returnedBytes: z.number().int(),
          value: z.string(),
        },
        title: "Resolve a tmux format",
      },
      async ({ format, target }) => {
        const snapshot = await context.snapshot();
        if (target !== undefined) {
          const pane = requirePane(snapshot, target);
          if (isFailure(pane)) return pane;
          const lines = await pane.displayMessage(format);
          const value = lines.join("\n");
          // displayMessage takes a format, not flags, so the enumeration goes
          // through the command with the same pane as its target.
          const unknown = await unknownFields(
            () => context.tmux.cmd("display-message", ["-p", "-a"], { target }),
            formatVariables(format),
            value,
          );
          return boundedDisplay(context, value, unknown);
        }
        const lines = await context.tmux.cmd("display-message", ["-p", format], { target: null });
        const value = lines.join("\n");
        const unknown = await unknownFields(
          () => context.tmux.cmd("display-message", ["-p", "-a"], { target: null }),
          formatVariables(format),
          value,
        );
        return boundedDisplay(context, value, unknown);
      },
    );
  }
}

function boundedDisplay(
  context: ToolContext,
  value: string,
  unknown: readonly string[],
): ReturnType<typeof ok> {
  const lineLimit = effectiveResultLines(context.policy, undefined);
  const diagnostic = emptyNote(unknown).trimStart();
  const diagnosticLines = diagnostic === "" ? [] : diagnostic.split("\n");
  const diagnosticBounded = boundText(diagnosticLines, lineLimit, MAX_RESULT_BYTES);
  const valueBounded = boundText(
    value === "" ? [] : value.split("\n"),
    Math.max(0, lineLimit - diagnosticLines.length),
    Math.max(0, MAX_RESULT_BYTES - diagnosticBounded.returnedBytes),
  );
  const recovery = "use a narrower format or resolve its fields separately";
  const complete =
    valueBounded.droppedLines === 0 &&
    valueBounded.omittedBytes === 0 &&
    diagnosticBounded.droppedLines === 0 &&
    diagnosticBounded.omittedBytes === 0;
  return ok(
    {
      complete,
      droppedLines: valueBounded.droppedLines + diagnosticBounded.droppedLines,
      omittedBytes: valueBounded.omittedBytes + diagnosticBounded.omittedBytes,
      returnedBytes: valueBounded.returnedBytes + diagnosticBounded.returnedBytes,
      value: valueBounded.text,
    },
    [
      renderBoundedText(valueBounded, recovery),
      renderBoundedText(diagnosticBounded, "use fewer format fields"),
    ]
      .filter((part) => part !== "")
      .join("\n\n"),
  );
}
