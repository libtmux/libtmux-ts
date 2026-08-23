/**
 * The shape tmux objects take when an agent reads them.
 *
 * A projection, not a dump. tmux exposes hundreds of format fields per object
 * and an agent pays for every one it is shown, so these carry what targeting
 * and diagnosis need and nothing else — the rest stays one `display_message`
 * away.
 */

import { z } from "zod";

import type { Client, Session, Window } from "libtmux";

import { isAttended, isCallerPane, type CallerIdentity } from "./caller.js";
import type { ReadablePane } from "./context.js";

export const paneViewSchema = z.object({
  active: z.boolean().describe("Whether this is its window's active pane."),
  command: z.string().describe("The command tmux reports running in it."),
  cwd: z.string().describe("Its current working directory."),
  dead: z.boolean().describe("Whether its process exited and remain-on-exit kept it."),
  height: z.number().int(),
  id: z.string().describe("Stable pane id, e.g. %1. Prefer this for targeting."),
  index: z.number().int(),
  isAttended: z.boolean().describe("A person is currently looking at this pane."),
  isCallerPane: z.boolean().describe("This is the pane this MCP server runs in."),
  sessionId: z.string(),
  sessionName: z.string(),
  title: z.string(),
  width: z.number().int(),
  windowId: z.string(),
  windowName: z.string(),
});
export type PaneView = z.infer<typeof paneViewSchema>;

export const sessionViewSchema = z.object({
  attachedClients: z.number().int().describe("How many clients are attached; 0 means detached."),
  id: z.string().describe("Stable session id, e.g. $1."),
  name: z.string(),
  windows: z.number().int().describe("How many windows it holds."),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const windowViewSchema = z.object({
  active: z.boolean(),
  id: z.string().describe("Stable window id, e.g. @1."),
  index: z.number().int(),
  layout: z.string().describe("tmux's layout string; feed it back to select_layout."),
  name: z.string(),
  panes: z.number().int(),
  sessionId: z.string(),
  sessionName: z.string(),
  zoomed: z.boolean(),
});
export type WindowView = z.infer<typeof windowViewSchema>;

export const clientViewSchema = z.object({
  activePaneId: z.string(),
  controlMode: z.boolean().describe("A program rather than a person at a terminal."),
  name: z.string(),
  sessionName: z.string(),
  tty: z.string(),
});
export type ClientView = z.infer<typeof clientViewSchema>;

/**
 * A field tmux left unset.
 *
 * The library decodes a missing format field to `null`; these views promise a
 * value for every key so a consumer never has to branch on absence.
 */
function no<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

/**
 * Project a pane, including whether anybody is watching it.
 *
 * `identity` is required rather than optional because these two fields are the
 * whole safety signal and they are declared, so a caller that omitted it got
 * `false` — a fact about the call site, presented as a fact about the pane.
 * Six tools did, including on this server's own pane.
 */
export function paneView(pane: ReadablePane, identity: CallerIdentity): PaneView {
  return {
    active: no(pane.active, false),
    command: no(pane.currentCommand, ""),
    cwd: no(pane.currentPath, ""),
    dead: no(pane.dead, false),
    height: no(pane.height, 0),
    id: pane.id,
    index: no(pane.index, 0),
    isAttended: isAttended(identity, pane.id),
    isCallerPane: isCallerPane(identity, pane.id),
    sessionId: no(pane.sessionId, ""),
    sessionName: no(pane.sessionName, ""),
    title: no(pane.title, ""),
    width: no(pane.width, 0),
    windowId: no(pane.windowId, ""),
    windowName: no(pane.windowName, ""),
  };
}

export function sessionView(session: Session, windows: number): SessionView {
  return {
    attachedClients: no(session.attached, 0),
    id: session.id,
    name: no(session.name, ""),
    windows,
  };
}

export function windowView(window: Window): WindowView {
  return {
    active: no(window.active, false),
    id: window.id,
    index: no(window.index, 0),
    layout: no(window.layout, ""),
    name: no(window.name, ""),
    panes: no(window.windowPanes, 0),
    sessionId: no(window.sessionId, ""),
    sessionName: no(window.sessionName, ""),
    zoomed: no(window.zoomedFlag, false),
  };
}

export function clientView(client: Client): ClientView {
  return {
    activePaneId: no(client.paneId, ""),
    controlMode: no(client.controlMode, false),
    name: no(client.name, ""),
    sessionName: no(client.sessionName, ""),
    tty: no(client.tty, ""),
  };
}

/** One line per pane, which is what an agent scans before it targets one. */
export function paneLine(view: PaneView): string {
  const marks = [
    view.active ? "active" : "",
    view.isCallerPane ? "SELF" : "",
    view.isAttended ? "WATCHED" : "",
    view.dead ? "dead" : "",
  ]
    .filter((mark) => mark !== "")
    .join(",");
  const suffix = marks === "" ? "" : ` [${marks}]`;
  return `${view.id}  ${view.sessionName}:${view.windowName}.${String(view.index)}  ${view.command}  ${view.cwd}${suffix}`;
}

export function sessionLine(view: SessionView): string {
  const attached = view.attachedClients === 0 ? "" : ` [attached x${String(view.attachedClients)}]`;
  return `${view.id}  ${view.name}  ${String(view.windows)} windows${attached}`;
}

export function windowLine(view: WindowView): string {
  const marks = [view.active ? "active" : "", view.zoomed ? "zoomed" : ""]
    .filter((mark) => mark !== "")
    .join(",");
  return `${view.id}  ${view.sessionName}:${String(view.index)} ${view.name}  ${String(view.panes)} panes${marks === "" ? "" : ` [${marks}]`}`;
}

/**
 * Say when a pane did not start where it was asked to.
 *
 * tmux chdirs in the forked child (`spawn.c`), and when the directory is not
 * usable it falls back to the session's, then home, then "/" — with no channel
 * to report that it did. The command succeeds and the pane is somewhere else.
 * This layer is the only one that can notice, because it knows what was asked
 * for and can read where the pane landed.
 */
export function directoryNote(
  requested: string | undefined,
  landed: string | null | undefined,
): string {
  const actual = landed ?? "";
  if (requested === undefined || actual === "" || actual === requested) return "";
  return (
    `\n\n[startDirectory ${requested} was not used: the pane is in ${actual}. ` +
    `tmux falls back silently when it cannot enter the directory.]`
  );
}
