/**
 * The shape tmux objects take when an agent reads them.
 *
 * A projection, not a dump. tmux exposes hundreds of format fields per object
 * and an agent pays for every one it is shown, so these carry what targeting
 * and diagnosis need and nothing else — the rest stays one `display_message`
 * away.
 */

import { z } from "zod";

import { safeInteger, type Client, type Session, type Window } from "libtmux";

import { isAttended, isCallerPane, type CallerIdentity } from "./caller.js";
import { panePlacementIndex, windowPlacementIndex, type ReadablePane } from "./context.js";
import { MAX_RESULT_BYTES } from "./policy.js";
import { boundText, renderBoundedText, tailBytes, type BoundedText } from "./results.js";
import { paneIdSchema, sessionIdSchema, windowIdSchema } from "./schemas.js";

/** Leave room for the result envelope and tool-specific context around a view. */
const PROJECTED_VIEW_BYTES = MAX_RESULT_BYTES - 16 * 1_024;
const PROJECTED_STRING_BYTES = Math.floor((PROJECTED_VIEW_BYTES * 3) / 4);

export const placementViewSchema = z.object({
  index: z.number().int().describe("The window index in this session."),
  sessionId: sessionIdSchema,
  sessionName: z.string(),
});
export type PlacementView = z.infer<typeof placementViewSchema>;

export const windowPlacementViewSchema = placementViewSchema.extend({
  active: z.boolean().describe("Whether this placement is current in its session."),
});
export type WindowPlacementView = z.infer<typeof windowPlacementViewSchema>;

export const paneViewSchema = z.object({
  active: z.boolean().describe("Whether this is its window's active pane."),
  command: z.string().describe("The command tmux reports running in it."),
  cwd: z.string().describe("Its current working directory."),
  dead: z.boolean().describe("Whether its process exited and remain-on-exit kept it."),
  height: z.number().int(),
  id: paneIdSchema.describe("Stable pane id. Prefer this for entity-scoped targeting."),
  index: z.number().int(),
  isAttended: z.boolean().describe("A person is currently looking at this pane."),
  isCallerPane: z.boolean().describe("This is the pane this MCP server runs in."),
  metadataComplete: z.boolean().describe("Whether every projected metadata string is complete."),
  omittedMetadataBytes: z
    .number()
    .int()
    .nonnegative()
    .describe("UTF-8 bytes omitted from projected metadata strings."),
  omittedPlacements: z.number().int().nonnegative().describe("Later placements omitted."),
  placements: z
    .array(placementViewSchema)
    .describe("Retained session and window indexes through which this pane is reachable."),
  placementsComplete: z.boolean().describe("Whether placements contains every placement."),
  title: z.string(),
  width: z.number().int(),
  windowId: windowIdSchema,
  windowName: z.string(),
});
export type PaneView = z.infer<typeof paneViewSchema>;

export const sessionViewSchema = z.object({
  attachedClients: z.number().int().describe("How many clients are attached; 0 means detached."),
  id: sessionIdSchema,
  metadataComplete: z.boolean().describe("Whether the session name is complete."),
  name: z.string(),
  omittedMetadataBytes: z
    .number()
    .int()
    .nonnegative()
    .describe("UTF-8 bytes omitted from the session name."),
  windows: z.number().int().describe("How many windows it holds."),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const windowViewSchema = z.object({
  id: windowIdSchema,
  layout: z
    .string()
    .describe("tmux's layout string; feed it back only when metadataComplete is true."),
  metadataComplete: z.boolean().describe("Whether every projected metadata string is complete."),
  name: z.string(),
  omittedMetadataBytes: z
    .number()
    .int()
    .nonnegative()
    .describe("UTF-8 bytes omitted from projected metadata strings."),
  panes: z.number().int(),
  omittedPlacements: z.number().int().nonnegative().describe("Later placements omitted."),
  placements: z
    .array(windowPlacementViewSchema)
    .describe("Retained sessions and indexes where this window is linked."),
  placementsComplete: z.boolean().describe("Whether placements contains every placement."),
  zoomed: z.boolean(),
});
export type WindowView = z.infer<typeof windowViewSchema>;

export const clientViewSchema = z.object({
  activePaneId: paneIdSchema.nullable(),
  controlMode: z.boolean().describe("A program rather than a person at a terminal."),
  name: z.string(),
  sessionName: z.string(),
  tty: z.string(),
});
export type ClientView = z.infer<typeof clientViewSchema>;

export interface ViewLimit<View> {
  readonly complete: boolean;
  readonly omittedEntries: number;
  readonly text: BoundedText;
  readonly views: readonly View[];
}

/** Keep leading views whose structured and readable forms fit one result. */
export function limitViews<View>(
  views: readonly View[],
  lineLimit: number,
  render: (view: View) => string,
): ViewLimit<View> {
  const kept: View[] = [];
  const lines: string[] = [];
  let structuredBytes = 2;
  let textBytes = 0;
  for (const view of views) {
    const serialized = JSON.stringify(view);
    const rendered = render(view);
    const renderedLines = rendered.split("\n");
    const nextStructured =
      structuredBytes + Buffer.byteLength(serialized, "utf8") + (kept.length === 0 ? 0 : 1);
    const nextTextBytes =
      textBytes + Buffer.byteLength(rendered, "utf8") + (lines.length === 0 ? 0 : 1);
    if (
      nextStructured > PROJECTED_VIEW_BYTES ||
      lines.length + renderedLines.length > lineLimit ||
      nextTextBytes > PROJECTED_VIEW_BYTES
    ) {
      break;
    }
    kept.push(view);
    lines.push(...renderedLines);
    structuredBytes = nextStructured;
    textBytes = nextTextBytes;
  }
  return {
    complete: kept.length === views.length,
    omittedEntries: views.length - kept.length,
    text: boundText(lines, lineLimit, PROJECTED_VIEW_BYTES),
    views: kept,
  };
}

export function renderViews(result: ViewLimit<unknown>, noun: string, recovery: string): string {
  const omission =
    result.omittedEntries === 0
      ? ""
      : `[${String(result.omittedEntries)} later ${noun} omitted; ${recovery}]`;
  return [renderBoundedText(result.text, recovery), omission]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * A field tmux left unset.
 *
 * The library decodes a missing format field to `null`; these views promise a
 * value for every key so a consumer never has to branch on absence.
 */
function no<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

export function boundedStrings(
  values: readonly string[],
  budget: number = PROJECTED_STRING_BYTES,
): { readonly omittedBytes: number; readonly values: readonly string[] } {
  const widths = values.map((value) => Buffer.byteLength(value, "utf8"));
  const kept = values.map(() => "");
  let pending = values.map((_, index) => index);
  let remaining = budget;
  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    const fitting = pending.filter((index) => (widths[index] ?? 0) <= share);
    if (fitting.length === 0) {
      for (const index of pending) kept[index] = tailBytes(values[index] ?? "", share).text;
      break;
    }
    const fitted = new Set(fitting);
    for (const index of fitting) {
      kept[index] = values[index] ?? "";
      remaining -= widths[index] ?? 0;
    }
    pending = pending.filter((index) => !fitted.has(index));
  }
  return {
    omittedBytes: widths.reduce(
      (total, width, index) => total + width - Buffer.byteLength(kept[index] ?? "", "utf8"),
      0,
    ),
    values: kept,
  };
}

/** Keep the largest leading projection that fits both MCP result representations. */
function boundedProjection<Item, View>(
  items: readonly Item[],
  build: (kept: readonly Item[], omitted: number) => View,
  render: (view: View) => string,
): View {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = build(items.slice(0, middle), items.length - middle);
    const structuredBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    const textBytes = Buffer.byteLength(render(candidate), "utf8");
    if (structuredBytes <= PROJECTED_VIEW_BYTES && textBytes <= PROJECTED_VIEW_BYTES) low = middle;
    else high = middle - 1;
  }
  return build(items.slice(0, low), items.length - low);
}

export function panePlacementView(pane: ReadablePane): PlacementView {
  return {
    index: panePlacementIndex(pane),
    sessionId: pane.format.session_id,
    sessionName: no(pane.session?.name, ""),
  };
}

/**
 * Project a pane, including whether anybody is watching it.
 *
 * `identity` is required rather than optional because these two fields are the
 * whole safety signal and they are declared, so a caller that omitted it got
 * `false` — a fact about the call site, presented as a fact about the pane.
 * Six tools did, including on this server's own pane.
 */
export function paneView(
  pane: ReadablePane,
  identity: CallerIdentity,
  placements: readonly ReadablePane[] = [pane],
): PaneView {
  const metadata = boundedStrings([
    no(pane.currentCommand, ""),
    no(pane.currentPath, ""),
    no(pane.title, ""),
    no(pane.window?.name, ""),
  ]);
  const base = {
    active: no(pane.active, false),
    command: metadata.values[0] ?? "",
    cwd: metadata.values[1] ?? "",
    dead: no(pane.dead, false),
    height: no(pane.height, safeInteger(0)),
    id: pane.id,
    index: no(pane.index, safeInteger(0)),
    isAttended: isAttended(identity, pane.id),
    isCallerPane: isCallerPane(identity, pane.id),
    metadataComplete: metadata.omittedBytes === 0,
    omittedMetadataBytes: metadata.omittedBytes,
    title: metadata.values[2] ?? "",
    width: no(pane.width, safeInteger(0)),
    windowId: pane.format.window_id,
    windowName: metadata.values[3] ?? "",
  };
  const projected = placements.map(panePlacementView);
  return boundedProjection(
    projected,
    (kept, omittedPlacements): PaneView => ({
      ...base,
      omittedPlacements,
      placements: [...kept],
      placementsComplete: omittedPlacements === 0,
    }),
    paneLine,
  );
}

export function sessionView(session: Session, windows: number): SessionView {
  const metadata = boundedStrings([no(session.name, "")]);
  return {
    attachedClients: no(session.attached, safeInteger(0)),
    id: session.id,
    metadataComplete: metadata.omittedBytes === 0,
    name: metadata.values[0] ?? "",
    omittedMetadataBytes: metadata.omittedBytes,
    windows,
  };
}

export function windowView(window: Window, placements: readonly Window[] = [window]): WindowView {
  const metadata = boundedStrings([no(window.layout, ""), no(window.name, "")]);
  const base = {
    id: window.id,
    layout: metadata.values[0] ?? "",
    metadataComplete: metadata.omittedBytes === 0,
    name: metadata.values[1] ?? "",
    omittedMetadataBytes: metadata.omittedBytes,
    panes: no(window.windowPanes, safeInteger(0)),
    zoomed: no(window.zoomedFlag, false),
  };
  const projected = placements.map((placement) => ({
    active: no(placement.active, false),
    index: windowPlacementIndex(placement),
    sessionId: placement.format.session_id,
    sessionName: no(placement.session?.name, ""),
  }));
  return boundedProjection(
    projected,
    (kept, omittedPlacements): WindowView => ({
      ...base,
      omittedPlacements,
      placements: [...kept],
      placementsComplete: omittedPlacements === 0,
    }),
    windowLine,
  );
}

export function clientView(client: Client): ClientView {
  return {
    activePaneId: client.pane?.id ?? null,
    controlMode: no(client.controlMode, false),
    name: no(client.name, ""),
    sessionName: no(client.session?.name, ""),
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
  const placements = view.placements
    .map(({ index, sessionName }) => `${sessionName}:${String(index)}`)
    .join(",");
  const omitted =
    view.omittedPlacements === 0
      ? ""
      : `${placements === "" ? "" : ","}+${String(view.omittedPlacements)} placements`;
  const metadata =
    view.omittedMetadataBytes === 0
      ? ""
      : ` [${String(view.omittedMetadataBytes)} metadata bytes omitted]`;
  return `${view.id}  ${placements}${omitted} ${view.windowName}.${String(view.index)}  ${view.command}  ${view.cwd}${suffix}${metadata}`;
}

export function sessionLine(view: SessionView): string {
  const attached = view.attachedClients === 0 ? "" : ` [attached x${String(view.attachedClients)}]`;
  const metadata =
    view.omittedMetadataBytes === 0
      ? ""
      : ` [${String(view.omittedMetadataBytes)} name bytes omitted]`;
  return `${view.id}  ${view.name}  ${String(view.windows)} windows${attached}${metadata}`;
}

export function windowLine(view: WindowView): string {
  const placements = view.placements
    .map(({ active, index, sessionName }) => `${sessionName}:${String(index)}${active ? "*" : ""}`)
    .join(",");
  const omitted =
    view.omittedPlacements === 0
      ? ""
      : `${placements === "" ? "" : ","}+${String(view.omittedPlacements)} placements`;
  const metadata =
    view.omittedMetadataBytes === 0
      ? ""
      : ` [${String(view.omittedMetadataBytes)} metadata bytes omitted]`;
  return `${view.id}  ${placements}${omitted} ${view.name}  ${String(view.panes)} panes${view.zoomed ? " [zoomed]" : ""}${metadata}`;
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
  const boundedRequested = tailBytes(requested, 4 * 1_024);
  const boundedActual = tailBytes(actual, 4 * 1_024);
  const shownRequested = `${boundedRequested.droppedBytes === 0 ? "" : "…"}${boundedRequested.text}`;
  const shownActual = `${boundedActual.droppedBytes === 0 ? "" : "…"}${boundedActual.text}`;
  return (
    `\n\n[startDirectory ${shownRequested} was not used: the pane is in ${shownActual}. ` +
    `tmux falls back silently when it cannot enter the directory.]`
  );
}
