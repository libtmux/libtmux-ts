import type {
  ConnectionAlias,
  DaemonEpoch,
  LogicalRef,
  PaneRef,
  SessionRef,
  WindowRef,
} from "../../common.js";
import { QueryValidationError } from "../../exc.js";
import type { ListCommand } from "../codec/format_types.js";
import type { DaemonIdentity } from "../runtime/context.js";
import type { CompleteFormatRow, RawCompleteFormatRow } from "../codec/schemas.js";
import type { WinlinkRef } from "./refs.js";

declare const graphSourceIdBrand: unique symbol;

export type GraphSourceId = string & {
  readonly [graphSourceIdBrand]: "graph-source";
};

declare class GraphRecordRefNominal {
  private readonly graphRecordRefBrand: undefined;
}

export interface GraphRecordRef extends GraphRecordRefNominal {
  readonly ordinal: number;
  readonly source: GraphSourceId;
}

export interface GraphCapture {
  readonly capabilityFingerprint: string;
  readonly connection: ConnectionAlias;
  /** Which daemon answered. Optional only on normalized legacy graph input. */
  readonly daemon?: DaemonIdentity;
  readonly epoch: DaemonEpoch;
  /**
   * The tmux that answered, so a query can be told a field is newer than it.
   *
   * Optional because a graph normalized from stored bytes predates this and
   * cannot know — a query against one of those is answered the way it always
   * was rather than refused on a guess.
   */
  readonly tmuxVersion?: string;
}

export interface CapturedRowSet {
  readonly listCommand: ListCommand;
  readonly rows: readonly RawCompleteFormatRow[];
  readonly source: GraphSourceId;
}

export interface GraphSource {
  readonly id: GraphSourceId;
  readonly listCommand: ListCommand;
  readonly records: readonly GraphRecordRef[];
}

export interface ClientRef {
  readonly connection: ConnectionAlias;
  readonly epoch: DaemonEpoch;
  readonly id: string;
  readonly kind: "client";
}

export type GraphEntityRef = ClientRef | LogicalRef;

export interface GraphEntity<Ref extends GraphEntityRef = GraphEntityRef> {
  readonly occurrences: readonly GraphRecordRef[];
  readonly ref: Ref;
}

export interface WinlinkEntity {
  readonly occurrences: readonly GraphRecordRef[];
  readonly ref: WinlinkRef;
}

export type GraphModel = "client" | "pane" | "session" | "window";

export interface GraphRecord {
  readonly entity: GraphEntityRef;
  readonly model: GraphModel;
  readonly ref: GraphRecordRef;
  readonly scalars: CompleteFormatRow;
  readonly winlink: WinlinkRef | null;
}

declare class NormalizedGraphNominal {
  private readonly normalizedGraphBrand: undefined;
}

export interface NormalizedGraph extends NormalizedGraphNominal {
  readonly capture: GraphCapture;
  readonly clients: readonly GraphEntity<ClientRef>[];
  readonly panes: readonly GraphEntity<PaneRef>[];
  readonly records: readonly GraphRecord[];
  readonly sessions: readonly GraphEntity<SessionRef>[];
  readonly sources: readonly GraphSource[];
  readonly windows: readonly GraphEntity<WindowRef>[];
  readonly winlinks: readonly WinlinkEntity[];
}

const authenticatedGraphRecordRefs = new WeakSet<object>();
const authenticatedNormalizedGraphs = new WeakSet<object>();
const normalizedGraphRecordIndexes = new WeakMap<
  object,
  ReadonlyMap<string, ReadonlyMap<number, GraphRecord>>
>();

interface NormalizedGraphData {
  readonly capture: GraphCapture;
  readonly clients: readonly GraphEntity<ClientRef>[];
  readonly panes: readonly GraphEntity<PaneRef>[];
  readonly records: readonly GraphRecord[];
  readonly sessions: readonly GraphEntity<SessionRef>[];
  readonly sources: readonly GraphSource[];
  readonly windows: readonly GraphEntity<WindowRef>[];
  readonly winlinks: readonly WinlinkEntity[];
}

function invalidGraphIdentity(message: string): never {
  throw new QueryValidationError({ code: "invalid-query", message });
}

export function createGraphSourceId(value: string): GraphSourceId {
  if (typeof value !== "string" || value.length === 0) {
    return invalidGraphIdentity("Graph source ID must be a nonempty string");
  }
  return value as GraphSourceId;
}

export function createGraphRecordRef(source: GraphSourceId, ordinal: number): GraphRecordRef {
  if (typeof source !== "string" || source.length === 0) {
    return invalidGraphIdentity("Graph source ID must be a nonempty string");
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    return invalidGraphIdentity("Graph record ordinal must be a nonnegative safe integer");
  }

  const ref = Object.freeze({ source, ordinal }) as unknown as GraphRecordRef;
  authenticatedGraphRecordRefs.add(ref);
  return ref;
}

/** Whether this ref was minted by {@link createGraphRecordRef}. */
export function isGraphRecordRef(value: unknown): value is GraphRecordRef {
  return typeof value === "object" && value !== null && authenticatedGraphRecordRefs.has(value);
}

export function graphRecordRefsEqual(left: GraphRecordRef, right: GraphRecordRef): boolean {
  return (
    isGraphRecordRef(left) &&
    isGraphRecordRef(right) &&
    left.source === right.source &&
    left.ordinal === right.ordinal
  );
}

export function createNormalizedGraph(data: NormalizedGraphData): NormalizedGraph {
  const graph = Object.freeze({
    capture: data.capture,
    sources: data.sources,
    sessions: data.sessions,
    windows: data.windows,
    panes: data.panes,
    clients: data.clients,
    winlinks: data.winlinks,
    records: data.records,
  }) as unknown as NormalizedGraph;
  authenticatedNormalizedGraphs.add(graph);
  const bySource = new Map<string, Map<number, GraphRecord>>();
  for (const record of data.records) {
    if (!isGraphRecordRef(record.ref)) continue;
    let byOrdinal = bySource.get(record.ref.source);
    if (byOrdinal === undefined) {
      byOrdinal = new Map<number, GraphRecord>();
      bySource.set(record.ref.source, byOrdinal);
    }
    if (!byOrdinal.has(record.ref.ordinal)) byOrdinal.set(record.ref.ordinal, record);
  }
  normalizedGraphRecordIndexes.set(graph, bySource);
  return graph;
}

export function isNormalizedGraph(value: unknown): value is NormalizedGraph {
  return typeof value === "object" && value !== null && authenticatedNormalizedGraphs.has(value);
}

export function graphRecordForRef(graph: unknown, ref: GraphRecordRef): GraphRecord | undefined {
  if (!isNormalizedGraph(graph) || !isGraphRecordRef(ref)) return undefined;
  return normalizedGraphRecordIndexes.get(graph)?.get(ref.source)?.get(ref.ordinal);
}
