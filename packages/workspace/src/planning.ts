import type { PaneId, SessionId, WindowId } from "libtmux/common";
import type { Server } from "libtmux/server";
import type { Session } from "libtmux/session";
import type { Window } from "libtmux/window";
import type { Workspace } from "./config.js";
import { mayPrune, ownedByWorkspace, type PrunePolicy } from "./ownership.js";

/** One existing window placement named by a workspace plan. */
export interface WorkspaceWindowPlacement {
  readonly id: WindowId;
  readonly index: number;
  readonly name: string | null;
  readonly position: number;
  readonly sessionId: SessionId;
}

/** A window that applying would create. */
export interface WorkspaceWindowCreation {
  readonly name?: string;
  readonly position: number;
}

/** Panes that applying would create in one window position. */
export interface WorkspacePaneCreation {
  readonly count: number;
  readonly windowPosition: number;
}

/** Existing panes that applying would destroy. */
export interface WorkspacePaneRemoval {
  readonly paneIds: readonly PaneId[];
  readonly window: WorkspaceWindowPlacement;
}

/** How applying would remove an existing window placement. */
export interface WorkspaceWindowRemoval {
  readonly action: "kill" | "unlink";
  readonly window: WorkspaceWindowPlacement;
}

/** One existing window rename, identified independently of its current name. */
export interface WorkspaceWindowRename {
  readonly from: string | null;
  readonly to: string;
  readonly window: WorkspaceWindowPlacement;
}

/** Surplus topology retained because removing it would exceed the policy. */
export type WorkspaceRetention =
  | {
      readonly count: number;
      readonly kind: "panes";
      readonly reason: "pruning-disabled" | "shared-window";
      readonly window: WorkspaceWindowPlacement;
    }
  | {
      readonly kind: "window";
      readonly reason: "grouped-session" | "pruning-disabled";
      readonly window: WorkspaceWindowPlacement;
    };

/** Session, window, and pane membership changes an apply would make. */
export interface WorkspacePlan {
  /** Windows the apply would create, by the position they would take. */
  readonly createsWindows: readonly WorkspaceWindowCreation[];
  /** Whether the session itself would be created. */
  readonly createsSession: boolean;
  /** Panes the apply would create, grouped by desired window position. */
  readonly createsPanes: readonly WorkspacePaneCreation[];
  /** Panes the apply would destroy, with their containing placement. */
  readonly removesPanes: readonly WorkspacePaneRemoval[];
  /** Window placements the apply would kill or unlink. */
  readonly removesWindows: readonly WorkspaceWindowRemoval[];
  /** Whether this workspace created the session it found. */
  readonly owned: boolean;
  /** Existing windows the apply would rename. */
  readonly renamesWindows: readonly WorkspaceWindowRename[];
  /**
   * Surplus this apply will leave alone, and why.
   *
   * Empty when nothing is surplus or the policy removes it. A non-empty list on
   * a session the workspace did not create is the case `prune: "owned"` exists
   * for: the file and the server disagree, and the file does not get to win by
   * default.
   */
  readonly retains: readonly WorkspaceRetention[];
}

/**
 * The session this workspace names, on a server that may not be running yet.
 *
 * Acquisition raises on an unreachable server rather than reading as empty,
 * which is the answer a caller asking what is there needs. Building from
 * nothing is the ordinary starting point here, though, and a socket with no
 * daemon behind it is holding this session in the way an empty server is: not
 * at all.
 */
export async function runningSession(server: Server, name: string): Promise<Session | undefined> {
  if (!(await server.isAlive())) return undefined;
  return (await server.snapshot()).sessions.oneOrUndefined({ name });
}

export async function planWorkspace(
  server: Server,
  workspace: Workspace,
  prune: PrunePolicy,
): Promise<WorkspacePlan> {
  const existing = await runningSession(server, workspace.session_name);
  if (existing === undefined) {
    return Object.freeze({
      createsPanes: freezeEntries(
        workspace.windows.map((window, windowPosition) => ({
          count: window.panes.length,
          windowPosition,
        })),
      ),
      createsSession: true,
      createsWindows: freezeEntries(
        workspace.windows.map((window, position) => ({
          ...(window.window_name === undefined ? {} : { name: window.window_name }),
          position,
        })),
      ),
      owned: true,
      removesPanes: Object.freeze([]),
      removesWindows: Object.freeze([]),
      renamesWindows: Object.freeze([]),
      retains: Object.freeze([]),
    });
  }

  const owned = await ownedByWorkspace(existing, workspace.session_name);
  const pruning = mayPrune(prune, owned);
  const current = existing.windows.toArray();
  const createsWindows: WorkspaceWindowCreation[] = [];
  const createsPanes: WorkspacePaneCreation[] = [];
  const removesPanes: WorkspacePaneRemoval[] = [];
  const removesWindows: WorkspaceWindowRemoval[] = [];
  const renamesWindows: WorkspaceWindowRename[] = [];
  const retains: WorkspaceRetention[] = [];

  for (const [index, desired] of workspace.windows.entries()) {
    const window = current[index];
    const wanted = desired.panes.length;
    if (window === undefined) {
      createsWindows.push({
        ...(desired.window_name === undefined ? {} : { name: desired.window_name }),
        position: index,
      });
      createsPanes.push({ count: wanted, windowPosition: index });
      continue;
    }
    const placement = workspaceWindowPlacement(window, index);
    if (desired.window_name !== undefined && window.name !== desired.window_name) {
      renamesWindows.push({ from: window.name, to: desired.window_name, window: placement });
    }
    const present = window.panes.length;
    if (present < wanted) {
      createsPanes.push({ count: wanted - present, windowPosition: index });
    }
    if (present <= wanted) continue;
    const count = present - wanted;
    if (!pruning) {
      retains.push({ count, kind: "panes", reason: "pruning-disabled", window: placement });
    } else if (windowIsShared(window)) {
      retains.push({ count, kind: "panes", reason: "shared-window", window: placement });
    } else {
      removesPanes.push({
        paneIds: Object.freeze(
          window.panes
            .toArray()
            .slice(wanted)
            .map(({ id }) => id),
        ),
        window: placement,
      });
    }
  }

  const surplusWindows = current.slice(workspace.windows.length);
  for (const [offset, window] of surplusWindows.entries()) {
    const placement = workspaceWindowPlacement(window, workspace.windows.length + offset);
    if (!pruning) {
      retains.push({ kind: "window", reason: "pruning-disabled", window: placement });
    } else if (existing.grouped !== false) {
      retains.push({ kind: "window", reason: "grouped-session", window: placement });
    } else {
      removesWindows.push({
        action: windowIsShared(window) ? "unlink" : "kill",
        window: placement,
      });
    }
  }

  return Object.freeze({
    createsPanes: freezeEntries(createsPanes),
    createsSession: false,
    createsWindows: freezeEntries(createsWindows),
    owned,
    removesPanes: freezeEntries(removesPanes),
    removesWindows: freezeEntries(removesWindows),
    renamesWindows: freezeEntries(renamesWindows),
    retains: freezeEntries(retains),
  });
}

function freezeEntries<Entry extends object>(
  entries: readonly Entry[],
): readonly Readonly<Entry>[] {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function workspaceWindowPlacement(window: Window, position: number): WorkspaceWindowPlacement {
  return Object.freeze({
    id: window.id,
    index: window.index,
    name: window.name,
    position,
    sessionId: window.format.session_id,
  });
}

export function windowIsShared(window: Window): boolean {
  const session = window.session;
  return (
    session === undefined ||
    session.windows.count({ id: window.id }) !== 1 ||
    window.linkedSessions.count() !== 1
  );
}
