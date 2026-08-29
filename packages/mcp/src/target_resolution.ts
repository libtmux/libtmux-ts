import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pane, ServerSnapshot, Session, Window } from "libtmux";

import { isAttended, isCallerPane, type CallerIdentity } from "./caller.js";
import { MAX_RESULT_BYTES } from "./policy.js";
import { fail } from "./results.js";

/** How many alternatives an error lists before the list stops helping. */
const SUGGESTION_LIMIT = 12;
const SUGGESTION_BYTES = MAX_RESULT_BYTES - 1_024;

/**
 * Name some of what exists, and say when that is not all of it.
 *
 * A list that stops at twelve with no marker reads as the whole list, so an
 * agent that does not find what it asked for concludes it is not there — and
 * on a busy server the twelve shown are rarely the twelve it wants. Naming the
 * remainder and the tool that lists it costs one clause.
 */
function suggest(all: readonly string[], listing: string): string {
  const shown: string[] = [];
  let bytes = 0;
  for (const value of all.slice(0, SUGGESTION_LIMIT)) {
    const added = Buffer.byteLength(value, "utf8") + (shown.length === 0 ? 0 : 2);
    if (bytes + added > SUGGESTION_BYTES) break;
    shown.push(value);
    bytes += added;
  }
  const rest = all.length - shown.length;
  if (shown.length === 0) return `${String(rest)} entries omitted — ${listing} lists them all`;
  return rest === 0
    ? shown.join(", ")
    : `${shown.join(", ")}, and ${String(rest)} more — ${listing} lists them all`;
}

/**
 * The pane operations that put input into a pane, or end what runs in it.
 *
 * Named so the type system can withhold them. Resizing and retitling are not
 * here: they rearrange a pane without reaching the program inside it.
 */
type PaneWrite = "kill" | "pasteBuffer" | "respawn" | "sendKeys";

/**
 * A pane resolved for reading and arranging, but not for writing into.
 *
 * `requirePane` hands this back so that a tool which goes on to type into the
 * pane does not compile. The guard used to be a per-tool convention, and three
 * write tools were shipped without it; withholding the methods is what makes
 * the next one impossible rather than merely discouraged.
 */
export type ReadablePane = Omit<Pane, PaneWrite>;

export interface SourcePlacement {
  readonly sourceIndex?: number;
  readonly sourceSession?: string;
}

function compareSession(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

export function windowPlacementIndex(window: Window): number {
  return window.index ?? Number(window.format.window_index ?? 0);
}

export function panePlacementIndex(pane: ReadablePane): number {
  return pane.window?.index ?? Number(pane.format.window_index ?? 0);
}

function compareWindows(left: Window, right: Window): number {
  return (
    compareSession(left.format.session_id, right.format.session_id) ||
    windowPlacementIndex(left) - windowPlacementIndex(right)
  );
}

function comparePanes(left: ReadablePane, right: ReadablePane): number {
  return (
    compareSession(left.format.session_id, right.format.session_id) ||
    panePlacementIndex(left) - panePlacementIndex(right)
  );
}

export function windowPlacements(snapshot: ServerSnapshot, windowId: string): readonly Window[] {
  return snapshot.windows
    .toArray()
    .filter((window) => window.id === windowId)
    .toSorted(compareWindows);
}

export function panePlacements(snapshot: ServerSnapshot, paneId: string): readonly ReadablePane[] {
  return snapshot.panes
    .toArray()
    .filter((pane) => pane.id === paneId)
    .toSorted(comparePanes);
}

export function windowEntities(windows: readonly Window[]): readonly Window[] {
  const seen = new Set<string>();
  return [...windows].toSorted(compareWindows).filter((window) => {
    if (seen.has(window.id)) return false;
    seen.add(window.id);
    return true;
  });
}

export function paneEntities(panes: readonly ReadablePane[]): readonly ReadablePane[] {
  const seen = new Set<string>();
  return [...panes].toSorted(comparePanes).filter((pane) => {
    if (seen.has(pane.id)) return false;
    seen.add(pane.id);
    return true;
  });
}

function paneNotFound(snapshot: ServerSnapshot, paneId: string): CallToolResult {
  const available = paneEntities(snapshot.panes.toArray()).map(
    (entry) =>
      `${entry.id} (${entry.session?.name ?? "?"}:${entry.window?.name ?? "?"} ${entry.currentCommand ?? "?"})`,
  );
  return fail({
    hint:
      available.length === 0
        ? "This server has no panes. Create one with new_session."
        : `Panes on this server: ${suggest(available, "list_panes")}`,
    reason: `No pane ${paneId} on this server.`,
  });
}

/**
 * Find a pane, or say what exists instead.
 *
 * A bare "no such pane" costs the agent a turn to discover what it should have
 * asked for. Naming the panes that do exist makes the failed call the last one.
 */
export function requirePane(
  snapshot: ServerSnapshot,
  paneId: string,
): CallToolResult | ReadablePane {
  return panePlacements(snapshot, paneId)[0] ?? paneNotFound(snapshot, paneId);
}

/**
 * Find a pane this caller is cleared to write into.
 *
 * Refuses the terminal this server is running in and panes a person is
 * watching: typing into either puts irreversible input in front of a person.
 * `force` is how a caller says it meant that pane. `verb` names the act in the
 * refusal, because "refusing to restart" and "refusing to type into" send a
 * caller to different remedies.
 */
export function requireWritablePane(
  snapshot: ServerSnapshot,
  identity: CallerIdentity,
  paneId: string,
  force: boolean | undefined,
  verb = "write into",
): CallToolResult | Pane {
  const pane = panePlacements(snapshot, paneId)[0] as Pane | undefined;
  if (pane === undefined) return paneNotFound(snapshot, paneId);
  if (force !== true && isCallerPane(identity, paneId)) {
    return fail({
      hint: "That is this server's own terminal. Pick another pane, or pass force to mean it.",
      reason: `Refusing to ${verb} ${paneId}: it is the pane this MCP server runs in.`,
    });
  }
  if (force !== true && isAttended(identity, paneId)) {
    return fail({
      hint: "whoami lists who is attached. Pick another pane, or pass force to mean it.",
      reason: `Refusing to ${verb} ${paneId}: a person is watching that pane.`,
    });
  }
  return pane;
}

export function requireSession(snapshot: ServerSnapshot, target: string): CallToolResult | Session {
  if (/^\$\d+$/u.test(target)) {
    const byId = snapshot.sessions.oneOrUndefined({ id: target });
    if (byId !== undefined) return byId;
  }
  const byName = snapshot.sessions.oneOrUndefined({ name: target });
  if (byName !== undefined) return byName;
  const available = snapshot.sessions
    .toArray()
    .map((entry) => `${entry.id} (${entry.name ?? "?"})`);
  return fail({
    hint:
      available.length === 0
        ? "This server has no sessions. Create one with new_session."
        : `Sessions on this server: ${suggest(available, "list_sessions")}`,
    reason: `No session ${target} on this server.`,
  });
}

export function requireWindow(snapshot: ServerSnapshot, target: string): CallToolResult | Window {
  const byId = windowPlacements(snapshot, target)[0];
  if (byId !== undefined) return byId;
  const available = windowEntities(snapshot.windows.toArray()).map(
    (entry) => `${entry.id} (${entry.session?.name ?? "?"}:${entry.name ?? "?"})`,
  );
  return fail({
    hint:
      available.length === 0
        ? "This server has no windows."
        : `Windows on this server: ${suggest(available, "list_windows")}`,
    reason: `No window ${target} on this server.`,
  });
}

function sourceMatches(
  sessionId: string,
  sessionName: string | null | undefined,
  sourceSession: string,
): boolean {
  return /^\$\d+$/u.test(sourceSession)
    ? sessionId === sourceSession
    : sessionName === sourceSession;
}

function placementFailure(
  kind: "pane" | "window",
  id: string,
  placements: readonly {
    readonly index: number;
    readonly sessionId: string;
    readonly sessionName: string | null | undefined;
  }[],
  source: SourcePlacement,
): CallToolResult {
  const choices = placements.map(
    ({ index, sessionId, sessionName }) => `${sessionId}:${String(index)} (${sessionName ?? "?"})`,
  );
  const selected = [
    ...(source.sourceSession === undefined
      ? []
      : [`sourceSession=${JSON.stringify(source.sourceSession)}`]),
    ...(source.sourceIndex === undefined ? [] : [`sourceIndex=${String(source.sourceIndex)}`]),
  ];
  const incomplete =
    placements.length > 1 &&
    (source.sourceSession === undefined || source.sourceIndex === undefined);
  return fail({
    hint: `Available source placements: ${suggest(
      choices,
      kind === "pane" ? "list_panes" : "list_windows",
    )}. Pass sourceSession and sourceIndex.`,
    reason:
      selected.length === 0
        ? `${kind === "pane" ? "Pane" : "Window"} ${id} names ${String(placements.length)} placements; a source placement is required.`
        : incomplete
          ? `${kind === "pane" ? "Pane" : "Window"} ${id} names ${String(placements.length)} placements; sourceSession and sourceIndex are both required.`
          : `${kind === "pane" ? "Pane" : "Window"} ${id} has no single placement matching ${selected.join(" and ")}.`,
  });
}

function resolvePlacement<Model>(
  kind: "pane" | "window",
  id: string,
  placements: readonly Model[],
  describe: (placement: Model) => {
    readonly index: number;
    readonly sessionId: string;
    readonly sessionName: string | null | undefined;
  },
  source: SourcePlacement,
): CallToolResult | Model {
  const described = placements.map((placement) => ({ placement, ...describe(placement) }));
  if (
    placements.length > 1 &&
    (source.sourceSession === undefined || source.sourceIndex === undefined)
  ) {
    return placementFailure(kind, id, described, source);
  }
  const matches = described.filter(
    ({ index, sessionId, sessionName }) =>
      (source.sourceSession === undefined ||
        sourceMatches(sessionId, sessionName, source.sourceSession)) &&
      (source.sourceIndex === undefined || index === source.sourceIndex),
  );
  if (matches.length === 1) return matches[0]!.placement;
  return placementFailure(kind, id, described, source);
}

export function requireWindowPlacement(
  snapshot: ServerSnapshot,
  windowId: string,
  source: SourcePlacement,
): CallToolResult | Window {
  const placements = windowPlacements(snapshot, windowId);
  if (placements.length === 0) return requireWindow(snapshot, windowId);
  return resolvePlacement(
    "window",
    windowId,
    placements,
    (window) => ({
      index: windowPlacementIndex(window),
      sessionId: window.format.session_id,
      sessionName: window.session?.name,
    }),
    source,
  );
}

export function requirePanePlacement(
  snapshot: ServerSnapshot,
  paneId: string,
  source: SourcePlacement,
): CallToolResult | ReadablePane {
  const placements = panePlacements(snapshot, paneId);
  if (placements.length === 0) return requirePane(snapshot, paneId);
  return resolvePlacement(
    "pane",
    paneId,
    placements,
    (pane) => ({
      index: panePlacementIndex(pane),
      sessionId: pane.format.session_id,
      sessionName: pane.session?.name,
    }),
    source,
  );
}

/** Whether `requirePane` and its kin returned a failure rather than a handle. */
export function isFailure(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && "isError" in value;
}
