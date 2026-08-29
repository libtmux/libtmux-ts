import type { WhereModel } from "../../_generated/where_fields.js";
import {
  graphRecordRefsEqual,
  type GraphCapture,
  type GraphEntity,
  type GraphEntityRef,
  type GraphRecord,
  type GraphRecordRef,
  type NormalizedGraph,
  type WinlinkEntity,
} from "./model.js";
import type { WinlinkRef } from "./refs.js";

interface ProjectionOneAdjacency {
  readonly cardinality: "one";
  readonly name: string;
  readonly target: GraphRecordRef | null;
  readonly targetModel: WhereModel;
}

interface ProjectionManyAdjacency {
  readonly cardinality: "many";
  readonly name: string;
  readonly targetModel: WhereModel;
  readonly targets: readonly GraphRecordRef[];
}

export type ProjectionAdjacency = ProjectionManyAdjacency | ProjectionOneAdjacency;
export type ProjectionScalars = Readonly<Record<string, string | null>>;

export interface ProjectionRecord {
  readonly adjacency: readonly ProjectionAdjacency[];
  readonly entity: GraphEntityRef;
  readonly model: WhereModel;
  readonly ref: GraphRecordRef;
  readonly scalars: ProjectionScalars;
  readonly winlink: WinlinkRef | null;
}

declare class SelectionProjectionNominal {
  private readonly selectionProjectionBrand: undefined;
}

export interface SelectionProjection extends SelectionProjectionNominal {
  readonly capture: GraphCapture;
  readonly entities: readonly GraphEntity<GraphEntityRef>[];
  readonly members: readonly GraphRecordRef[];
  readonly records: readonly ProjectionRecord[];
  readonly winlinks: readonly WinlinkEntity[];
}

declare class SelectionProjectionCorpusNominal {
  private readonly selectionProjectionCorpusBrand: undefined;
}

export interface SelectionProjectionCorpus extends SelectionProjectionCorpusNominal {
  readonly capture: GraphCapture;
  readonly entities: readonly GraphEntity<GraphEntityRef>[];
  readonly records: readonly ProjectionRecord[];
  readonly winlinks: readonly WinlinkEntity[];
}

interface SelectionProjectionCorpusInput {
  readonly capture: GraphCapture;
  readonly entities: GraphEntity<GraphEntityRef>[];
  readonly records: ProjectionRecord[];
  readonly winlinks: WinlinkEntity[];
}

type ProjectionRecordIndex = ReadonlyMap<string, ReadonlyMap<number, ProjectionRecord>>;

const authenticatedSelectionProjectionCorpora = new WeakSet<object>();
const authenticatedSelectionProjections = new WeakSet<object>();
const selectionProjectionCorpusIndexes = new WeakMap<object, ProjectionRecordIndex>();
const selectionProjectionCorpora = new WeakMap<object, SelectionProjectionCorpus>();
const selectionProjectionOrigins = new WeakMap<object, NormalizedGraph>();
const selectionProjectionRecordOwners = new WeakMap<object, SelectionProjectionCorpus>();
const selectionProjectionRecordIndexes = new WeakMap<object, ProjectionRecordIndex>();

function invalidIdentity(message: string): never {
  throw new Error(message);
}

function createProjectionRecordIndex(records: readonly ProjectionRecord[]): ProjectionRecordIndex {
  const bySource = new Map<string, Map<number, ProjectionRecord>>();
  for (const record of records) {
    let byOrdinal = bySource.get(record.ref.source);
    if (byOrdinal === undefined) {
      byOrdinal = new Map<number, ProjectionRecord>();
      bySource.set(record.ref.source, byOrdinal);
    }
    byOrdinal.set(record.ref.ordinal, record);
  }
  return bySource;
}

export function createSelectionProjectionCorpus(
  input: SelectionProjectionCorpusInput,
): SelectionProjectionCorpus {
  const records = Object.freeze(input.records);
  const corpus = Object.freeze({
    capture: input.capture,
    entities: Object.freeze(input.entities),
    records,
    winlinks: Object.freeze(input.winlinks),
  }) as unknown as SelectionProjectionCorpus;
  const index = createProjectionRecordIndex(records);
  authenticatedSelectionProjectionCorpora.add(corpus);
  selectionProjectionCorpusIndexes.set(corpus, index);
  for (const record of records) selectionProjectionRecordOwners.set(record, corpus);
  return corpus;
}

export function createSelectionProjectionView(
  graph: NormalizedGraph,
  corpus: SelectionProjectionCorpus,
  roots: readonly GraphRecord[],
): SelectionProjection {
  if (!authenticatedSelectionProjectionCorpora.has(corpus)) {
    return invalidIdentity("selection projection corpus is not authentic");
  }
  const index = selectionProjectionCorpusIndexes.get(corpus);
  if (index === undefined) {
    return invalidIdentity("selection projection corpus index is unavailable");
  }
  const members = roots.map((record) => {
    const projected = index.get(record.ref.source)?.get(record.ref.ordinal);
    if (projected === undefined) {
      return invalidIdentity("projection member does not exist in the corpus");
    }
    return projected.ref;
  });
  const projection = Object.freeze({
    capture: corpus.capture,
    entities: corpus.entities,
    winlinks: corpus.winlinks,
    records: corpus.records,
    members: Object.freeze(members),
  }) as unknown as SelectionProjection;
  authenticatedSelectionProjections.add(projection);
  selectionProjectionOrigins.set(projection, graph);
  selectionProjectionCorpora.set(projection, corpus);
  selectionProjectionRecordIndexes.set(projection, index);
  return projection;
}

export function isSelectionProjection(value: unknown): value is SelectionProjection {
  return (
    typeof value === "object" && value !== null && authenticatedSelectionProjections.has(value)
  );
}

export function originGraphForSelectionProjection(value: unknown): NormalizedGraph | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return selectionProjectionOrigins.get(value);
}

export function selectionProjectionOwnsRecord(
  projection: unknown,
  record: unknown,
): record is ProjectionRecord {
  if (
    (typeof projection !== "object" && typeof projection !== "function") ||
    projection === null ||
    (typeof record !== "object" && typeof record !== "function") ||
    record === null
  ) {
    return false;
  }
  return (
    selectionProjectionOrigins.has(projection) &&
    selectionProjectionRecordOwners.get(record) === selectionProjectionCorpora.get(projection)
  );
}

export function selectionProjectionRecordForRef(
  projection: unknown,
  ref: GraphRecordRef,
): ProjectionRecord | undefined {
  if (!isSelectionProjection(projection) || !graphRecordRefsEqual(ref, ref)) return undefined;
  return selectionProjectionRecordIndexes.get(projection)?.get(ref.source)?.get(ref.ordinal);
}
