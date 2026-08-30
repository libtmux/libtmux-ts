import type { WhereModel } from "../../_generated/where_fields.js";
import {
  createGraphRecordRef,
  graphRecordForRef,
  isGraphRecordRef,
  isNormalizedGraph,
  type GraphEntity,
  type GraphEntityRef,
  type GraphRecord,
  type GraphRecordRef,
  type GraphSource,
  type GraphSourceId,
  type NormalizedGraph,
  type WinlinkEntity,
} from "./model.js";
import {
  invalidProjection,
  isWhereModel,
  readStrictDataRecord,
  rootModel,
  snapshotDataArray,
  snapshotDescriptors,
  type DescriptorSnapshots,
  type ProjectionDescriptor,
  type ProjectionRelationRequirement,
} from "./projection_descriptor.js";
import {
  createSelectionProjectionCorpus,
  createSelectionProjectionView,
  type ProjectionAdjacency,
  type ProjectionRecord,
  type ProjectionScalars,
  type SelectionProjection,
  type SelectionProjectionCorpus,
} from "./projection_identity.js";
import { createLogicalRef, createWinlinkRef, type WinlinkRef } from "./refs.js";

type ProjectionBuilderState = "collecting" | "complete" | "failed";

export interface SelectionProjectionCorpusBuilderInput {
  readonly descriptors: Readonly<Record<WhereModel, ProjectionDescriptor>>;
  readonly graph: NormalizedGraph;
  readonly sources: readonly GraphSourceId[];
}

interface RelationSlot {
  manyTargets: readonly GraphRecord[];
  materialized: boolean;
  oneTarget: GraphRecord | null;
  readonly requirement: ProjectionRelationRequirement;
}

function logicalEntityForRecord(record: GraphRecord): GraphEntityRef {
  if (!isWhereModel(record.model) || record.entity.kind !== record.model) {
    return invalidProjection("reachable graph record has an invalid projection model");
  }
  return record.entity;
}

/**
 * Copy an entity reference, so a projection never shares one with its graph.
 *
 * A client is not a {@link LogicalRef}: tmux gives it no id of its own, so it
 * carries the terminal's name where the others carry a branded `$n`/`@n`/`%n`.
 * It is still an entity a projection can be built from, which is why this takes
 * the wider type.
 */
function cloneLogicalRef(ref: GraphEntityRef): GraphEntityRef {
  if (ref.kind === "client") {
    return Object.freeze({
      connection: ref.connection,
      epoch: ref.epoch,
      kind: "client" as const,
      id: ref.id,
    });
  }
  switch (ref.kind) {
    case "session":
      return createLogicalRef({
        connection: ref.connection,
        epoch: ref.epoch,
        id: ref.id,
        kind: "session",
      });
    case "window":
      return createLogicalRef({
        connection: ref.connection,
        epoch: ref.epoch,
        id: ref.id,
        kind: "window",
      });
    case "pane":
      return createLogicalRef({
        connection: ref.connection,
        epoch: ref.epoch,
        id: ref.id,
        kind: "pane",
      });
  }
}

function cloneWinlinkRef(ref: WinlinkRef): WinlinkRef {
  return createWinlinkRef({
    connection: ref.connection,
    epoch: ref.epoch,
    sessionId: ref.sessionId,
    windowId: ref.windowId,
    windowIndex: ref.windowIndex,
  });
}

function logicalRefKey(ref: GraphEntityRef): string {
  return JSON.stringify([ref.connection, ref.epoch, ref.kind, ref.id]);
}

function winlinkRefKey(ref: WinlinkRef): string {
  return JSON.stringify([ref.connection, ref.epoch, ref.sessionId, ref.windowIndex, ref.windowId]);
}

function projectScalars(record: GraphRecord, descriptor: ProjectionDescriptor): ProjectionScalars {
  return Object.freeze(
    Object.fromEntries(
      descriptor.fields.map(({ token, wireName }) => [wireName, record.scalars[token]]),
    ),
  );
}

export class SelectionProjectionBuilder {
  private readonly descriptors: DescriptorSnapshots;
  private readonly graph: NormalizedGraph;
  private readonly reachableRecords: GraphRecord[] = [];
  private readonly reachableSet: Set<GraphRecord> = new Set<GraphRecord>();
  private readonly rootRecordsBySource: ReadonlyMap<GraphSourceId, readonly GraphRecord[]>;
  private readonly slots: Map<GraphRecord, Map<string, RelationSlot>> = new Map<
    GraphRecord,
    Map<string, RelationSlot>
  >();
  private builderState: ProjectionBuilderState = "collecting";
  private completedViews: ReadonlyMap<GraphSourceId, SelectionProjection> | undefined;
  private failureCause: unknown;

  private constructor(
    descriptors: DescriptorSnapshots,
    graph: NormalizedGraph,
    rootSources: readonly GraphSource[],
  ) {
    this.descriptors = descriptors;
    this.graph = graph;
    const rootsBySource = new Map<GraphSourceId, readonly GraphRecord[]>();
    for (const rootSource of rootSources) {
      const sourceRoots: GraphRecord[] = [];
      const expectedRootModel = rootModel(rootSource);
      for (const ref of rootSource.records) {
        const record = this.resolveRecord(ref);
        if (record.model !== expectedRootModel) {
          invalidProjection("source contains a record with the wrong root model");
        }
        sourceRoots.push(record);
        this.addReachable(record);
      }
      rootsBySource.set(rootSource.id, Object.freeze(sourceRoots));
    }
    this.rootRecordsBySource = rootsBySource;
  }

  static createCorpus(input: SelectionProjectionCorpusBuilderInput): SelectionProjectionBuilder {
    const values = readStrictDataRecord(
      input,
      ["descriptors", "graph", "sources"],
      "selection projection corpus builder input",
    );
    const graph = values.graph;
    if (!isNormalizedGraph(graph)) {
      return invalidProjection("selection projection requires an authentic normalized graph");
    }
    const sourceIds = snapshotDataArray(values.sources, "selection projection corpus sources");
    if (sourceIds.length === 0) {
      return invalidProjection("selection projection corpus requires graph sources");
    }
    const seen = new Set<string>();
    const sources = sourceIds.map((sourceId) => {
      if (typeof sourceId !== "string" || sourceId.length === 0) {
        return invalidProjection(
          "selection projection corpus source must be a nonempty graph source ID",
        );
      }
      if (seen.has(sourceId)) {
        return invalidProjection("selection projection corpus has a duplicate graph source");
      }
      seen.add(sourceId);
      const source = graph.sources.find(({ id }) => id === sourceId);
      if (source === undefined) {
        return invalidProjection("selection projection source does not exist in the graph");
      }
      return source;
    });
    return new SelectionProjectionBuilder(snapshotDescriptors(values.descriptors), graph, sources);
  }

  abort(cause: unknown): never {
    if (this.builderState === "failed") throw this.failureCause;
    if (this.builderState === "complete") {
      return invalidProjection("selection projection is already complete");
    }
    this.builderState = "failed";
    this.failureCause = cause;
    throw cause;
  }

  materializeOne(source: GraphRecordRef, relation: string, target: GraphRecordRef | null): void {
    this.requireCollecting();
    const slot = this.resolveReachableSlot(source, relation);
    if (slot.requirement.cardinality !== "one") {
      return invalidProjection("projection relation cardinality does not accept one target");
    }
    if (slot.materialized) {
      return invalidProjection("projection relation slot is already materialized");
    }

    let targetRecord: GraphRecord | null = null;
    if (target !== null) {
      targetRecord = this.resolveRecord(target);
      if (targetRecord.model !== slot.requirement.targetModel) {
        return invalidProjection("projection relation target model does not match");
      }
    }

    slot.oneTarget = targetRecord;
    slot.materialized = true;
    if (targetRecord !== null) this.addReachable(targetRecord);
  }

  materializeMany(
    source: GraphRecordRef,
    relation: string,
    targets: readonly GraphRecordRef[],
  ): void {
    this.requireCollecting();
    const slot = this.resolveReachableSlot(source, relation);
    if (slot.requirement.cardinality !== "many") {
      return invalidProjection("projection relation cardinality does not accept many targets");
    }
    if (slot.materialized) {
      return invalidProjection("projection relation slot is already materialized");
    }

    let targetValues: readonly unknown[];
    try {
      targetValues = snapshotDataArray(targets, "projection target record array");
    } catch (error) {
      this.requireCollecting();
      throw error;
    }

    const targetRecords: GraphRecord[] = [];
    for (const target of targetValues) {
      const targetRecord = this.resolveRecord(target as GraphRecordRef);
      if (targetRecord.model !== slot.requirement.targetModel) {
        return invalidProjection("projection relation target model does not match");
      }
      targetRecords.push(targetRecord);
    }

    this.requireCollecting();
    if (slot.materialized) {
      return invalidProjection("projection relation slot is already materialized");
    }
    slot.manyTargets = Object.freeze(targetRecords);
    slot.materialized = true;
    for (const targetRecord of targetRecords) this.addReachable(targetRecord);
  }

  sealViews(): ReadonlyMap<GraphSourceId, SelectionProjection> {
    if (this.builderState === "failed") throw this.failureCause;
    if (this.builderState === "complete") {
      if (this.completedViews === undefined) {
        return invalidProjection("completed selection projection views are unavailable");
      }
      return this.completedViews;
    }
    this.requireComplete();
    const corpus = this.buildCorpus();
    const views = new Map<GraphSourceId, SelectionProjection>();
    for (const [source, roots] of this.rootRecordsBySource) {
      views.set(source, createSelectionProjectionView(this.graph, corpus, roots));
    }
    this.completedViews = views;
    this.builderState = "complete";
    return views;
  }

  private addReachable(record: GraphRecord): void {
    if (this.reachableSet.has(record)) return;
    if (!isWhereModel(record.model)) {
      return invalidProjection("record has no queryable model");
    }
    this.reachableSet.add(record);
    this.reachableRecords.push(record);
    const relationSlots = new Map<string, RelationSlot>();
    for (const requirement of this.descriptors[record.model].relations) {
      relationSlots.set(requirement.name, {
        requirement,
        materialized: false,
        oneTarget: null,
        manyTargets: [],
      });
    }
    this.slots.set(record, relationSlots);
  }

  private buildCorpus(): SelectionProjectionCorpus {
    const projectedRefs = new Map<GraphRecord, GraphRecordRef>();
    for (const record of this.reachableRecords) {
      projectedRefs.set(record, createGraphRecordRef(record.ref.source, record.ref.ordinal));
    }
    const projectedRef = (record: GraphRecord): GraphRecordRef => {
      const ref = projectedRefs.get(record);
      if (ref === undefined)
        return invalidProjection("reachable projection record is missing a ref");
      return ref;
    };

    const records: ProjectionRecord[] = this.reachableRecords.map((record) => {
      const model = record.model;
      if (!isWhereModel(model)) {
        return invalidProjection("client records cannot be projected");
      }
      const descriptor = this.descriptors[model];
      const recordSlots = this.slots.get(record);
      if (recordSlots === undefined) {
        return invalidProjection("reachable projection record is missing relation slots");
      }
      const adjacency: ProjectionAdjacency[] = descriptor.relations.map((requirement) => {
        const slot = recordSlots.get(requirement.name);
        if (slot === undefined || !slot.materialized) {
          return invalidProjection("reachable projection record has incomplete adjacency");
        }
        if (requirement.cardinality === "one") {
          return Object.freeze({
            cardinality: "one",
            name: requirement.name,
            targetModel: requirement.targetModel,
            target: slot.oneTarget === null ? null : projectedRef(slot.oneTarget),
          });
        }
        return Object.freeze({
          cardinality: "many",
          name: requirement.name,
          targetModel: requirement.targetModel,
          targets: Object.freeze(slot.manyTargets.map(projectedRef)),
        });
      });
      return Object.freeze({
        ref: projectedRef(record),
        model,
        entity: cloneLogicalRef(logicalEntityForRecord(record)),
        winlink: record.winlink === null ? null : cloneWinlinkRef(record.winlink),
        scalars: projectScalars(record, descriptor),
        adjacency: Object.freeze(adjacency),
      });
    });

    const graphEntities = new Map<string, GraphEntity<GraphEntityRef>>();
    for (const entity of [
      ...this.graph.sessions,
      ...this.graph.windows,
      ...this.graph.panes,
      ...this.graph.clients,
    ]) {
      graphEntities.set(logicalRefKey(entity.ref), entity);
    }
    const entities: GraphEntity<GraphEntityRef>[] = [];
    const seenEntities = new Set<string>();
    for (const record of this.reachableRecords) {
      const ref = logicalEntityForRecord(record);
      const key = logicalRefKey(ref);
      if (seenEntities.has(key)) continue;
      seenEntities.add(key);
      const graphEntity = graphEntities.get(key);
      if (graphEntity === undefined) {
        return invalidProjection("reachable projection entity does not exist in the graph");
      }
      const occurrences: GraphRecordRef[] = [];
      for (const occurrence of graphEntity.occurrences) {
        const occurrenceRecord = this.resolveRecord(occurrence);
        if (this.reachableSet.has(occurrenceRecord))
          occurrences.push(projectedRef(occurrenceRecord));
      }
      entities.push(
        Object.freeze({
          ref: cloneLogicalRef(graphEntity.ref),
          occurrences: Object.freeze(occurrences),
        }),
      );
    }

    const graphWinlinks = new Map<string, WinlinkEntity>();
    for (const winlink of this.graph.winlinks) {
      graphWinlinks.set(winlinkRefKey(winlink.ref), winlink);
    }
    const winlinks: WinlinkEntity[] = [];
    const seenWinlinks = new Set<string>();
    for (const record of this.reachableRecords) {
      if (record.winlink === null) continue;
      const key = winlinkRefKey(record.winlink);
      if (seenWinlinks.has(key)) continue;
      seenWinlinks.add(key);
      const graphWinlink = graphWinlinks.get(key);
      if (graphWinlink === undefined) {
        return invalidProjection("reachable projection winlink does not exist in the graph");
      }
      const occurrences: GraphRecordRef[] = [];
      for (const occurrence of graphWinlink.occurrences) {
        const occurrenceRecord = this.resolveRecord(occurrence);
        if (this.reachableSet.has(occurrenceRecord))
          occurrences.push(projectedRef(occurrenceRecord));
      }
      winlinks.push(
        Object.freeze({
          ref: cloneWinlinkRef(graphWinlink.ref),
          occurrences: Object.freeze(occurrences),
        }),
      );
    }

    const capture = Object.freeze({
      connection: this.graph.capture.connection,
      epoch: this.graph.capture.epoch,
      capabilityFingerprint: this.graph.capture.capabilityFingerprint,
      ...(this.graph.capture.daemon === undefined ? {} : { daemon: this.graph.capture.daemon }),
      // Carried so a query can be told a field is newer than the server that
      // answered. Rebuilding the capture field by field is why it was lost.
      ...(this.graph.capture.tmuxVersion === undefined
        ? {}
        : { tmuxVersion: this.graph.capture.tmuxVersion }),
    });
    return createSelectionProjectionCorpus({
      capture,
      entities,
      winlinks,
      records,
    });
  }

  private requireComplete(): void {
    for (const record of this.reachableRecords) {
      for (const slot of this.slots.get(record)?.values() ?? []) {
        if (!slot.materialized) {
          return invalidProjection("selection projection hydration is incomplete");
        }
      }
    }
  }

  private requireCollecting(): void {
    if (this.builderState === "failed") throw this.failureCause;
    if (this.builderState === "complete") {
      return invalidProjection("selection projection is already complete");
    }
  }

  private resolveReachableSlot(source: GraphRecordRef, relation: string): RelationSlot {
    const record = this.resolveRecord(source);
    if (!this.reachableSet.has(record)) {
      return invalidProjection("projection source record is not reachable");
    }
    const slot = this.slots.get(record)?.get(relation);
    if (slot === undefined) {
      return invalidProjection("projection relation does not exist for the source record");
    }
    return slot;
  }

  private resolveRecord(ref: GraphRecordRef): GraphRecord {
    if (!isGraphRecordRef(ref)) {
      return invalidProjection("projection record reference is not authentic");
    }
    const record = graphRecordForRef(this.graph, ref);
    if (record === undefined) {
      return invalidProjection("projection record does not exist in the graph");
    }
    return record;
  }
}
