import {
  WHERE_FIELDS_V1,
  WHERE_RELATIONS_V1,
  type WhereModel,
} from "../../_generated/where_fields.js";
import type {
  GraphRecord,
  GraphRecordRef,
  GraphSourceId,
  NormalizedGraph,
} from "../graph/model.js";
import {
  SelectionProjectionBuilder,
  type ProjectionDescriptor,
  type SelectionProjection,
} from "../graph/selection_projection.js";

/**
 * Criteria fields and relations both come from the generated metadata, so the
 * projection contract cannot drift from the criteria surface. Selection
 * validates adjacency against the same generated relations, and a descriptor
 * that understates a model's relations produces a projection it will reject.
 */
const DESCRIPTORS: Readonly<Record<WhereModel, ProjectionDescriptor>> = Object.freeze({
  client: { fields: WHERE_FIELDS_V1.client, model: "client", relations: WHERE_RELATIONS_V1.client },
  pane: { fields: WHERE_FIELDS_V1.pane, model: "pane", relations: WHERE_RELATIONS_V1.pane },
  session: {
    fields: WHERE_FIELDS_V1.session,
    model: "session",
    relations: WHERE_RELATIONS_V1.session,
  },
  window: { fields: WHERE_FIELDS_V1.window, model: "window", relations: WHERE_RELATIONS_V1.window },
});

type Winlink = NonNullable<GraphRecord["winlink"]>;

const placementKey = (sessionId: string, windowId: string, windowIndex: string): string =>
  `${sessionId}\0${windowId}\0${windowIndex}`;

const winlinkKey = (winlink: Winlink): string =>
  placementKey(winlink.sessionId, winlink.windowId, winlink.windowIndex);

const isActive = (record: GraphRecord, field: "pane_active" | "window_active"): boolean =>
  record.scalars[field] === "1";

interface Index {
  readonly panesByWinlink: ReadonlyMap<string, readonly GraphRecord[]>;
  readonly panesBySession: ReadonlyMap<string, readonly GraphRecord[]>;
  readonly sessionByEntity: ReadonlyMap<string, GraphRecord>;
  readonly windowByWinlink: ReadonlyMap<string, GraphRecord>;
  readonly windowsBySession: ReadonlyMap<string, readonly GraphRecord[]>;
  readonly windowsByEntity: ReadonlyMap<string, readonly GraphRecord[]>;
}

function push<Key>(map: Map<Key, GraphRecord[]>, key: Key, record: GraphRecord): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [record]);
  else bucket.push(record);
}

function indexGraph(graph: NormalizedGraph): Index {
  const panesByWinlink = new Map<string, GraphRecord[]>();
  const panesBySession = new Map<string, GraphRecord[]>();
  const sessionByEntity = new Map<string, GraphRecord>();
  const windowByWinlink = new Map<string, GraphRecord>();
  const windowsBySession = new Map<string, GraphRecord[]>();
  const windowsByEntity = new Map<string, GraphRecord[]>();

  for (const record of graph.records) {
    const winlink = record.winlink;
    switch (record.model) {
      case "session":
        sessionByEntity.set(String(record.entity.id), record);
        break;
      case "window":
        if (winlink === null) continue;
        windowByWinlink.set(winlinkKey(winlink), record);
        push(windowsBySession, String(winlink.sessionId), record);
        push(windowsByEntity, String(record.entity.id), record);
        break;
      case "pane":
        if (winlink === null) continue;
        push(panesByWinlink, winlinkKey(winlink), record);
        push(panesBySession, String(winlink.sessionId), record);
        break;
      default:
        break;
    }
  }

  return {
    panesBySession,
    panesByWinlink,
    sessionByEntity,
    windowByWinlink,
    windowsByEntity,
    windowsBySession,
  };
}

function refsOf(records: readonly GraphRecord[] | undefined): readonly GraphRecordRef[] {
  return (records ?? []).map(({ ref }) => ref);
}

const recordKey = (reference: GraphRecordRef): string =>
  `${String(reference.source)} ${String(reference.ordinal)}`;

const present = (...references: readonly (GraphRecordRef | null | undefined)[]): GraphRecordRef[] =>
  references.filter((reference): reference is GraphRecordRef => reference != null);

/**
 * Build a projection whose members come from `source`.
 *
 * Every record the projection can reach is hydrated, not only the members,
 * because Selection validates each reachable record against its own model's
 * full relation set. Relations follow winlinks rather than window identity, so
 * a window linked into two sessions contributes each placement separately and
 * a pane belongs to the placement it was listed under.
 */
export function hydrateProjection(
  graph: NormalizedGraph,
  source: GraphSourceId,
): SelectionProjection {
  const builder = SelectionProjectionBuilder.create({ descriptors: DESCRIPTORS, graph, source });
  const index = indexGraph(graph);
  const byRef = new Map(graph.records.map((record) => [recordKey(record.ref), record]));
  const members = graph.sources.find(({ id }) => id === source)?.records ?? [];

  // A relation can only be materialized once its subject is reachable from the
  // members, so walk outward from them instead of over the whole graph.
  const seen = new Set(members.map(recordKey));
  const queue = [...members];
  let cursor = 0;

  const visit = (targets: readonly GraphRecordRef[]): void => {
    for (const target of targets) {
      const key = recordKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(target);
    }
  };

  while (cursor < queue.length) {
    const reference = queue[cursor]!;
    cursor += 1;
    const record = byRef.get(recordKey(reference));
    if (record === undefined) continue;
    const winlink = record.winlink;
    switch (record.model) {
      case "session": {
        const sessionId = String(record.entity.id);
        const windows = index.windowsBySession.get(sessionId) ?? [];
        const panes = index.panesBySession.get(sessionId) ?? [];
        const activeWindow = windows.find((candidate) => isActive(candidate, "window_active"));
        const activePane = panes.find(
          (candidate) => isActive(candidate, "window_active") && isActive(candidate, "pane_active"),
        );
        builder.materializeMany(record.ref, "windows", refsOf(windows));
        builder.materializeMany(record.ref, "panes", refsOf(panes));
        builder.materializeOne(record.ref, "activeWindow", activeWindow?.ref ?? null);
        builder.materializeOne(record.ref, "activePane", activePane?.ref ?? null);
        visit([
          ...refsOf(windows),
          ...refsOf(panes),
          ...present(activeWindow?.ref, activePane?.ref),
        ]);
        break;
      }
      case "window": {
        if (winlink === null) break;
        const key = winlinkKey(winlink);
        const panes = index.panesByWinlink.get(key) ?? [];
        const owning = index.sessionByEntity.get(String(winlink.sessionId));
        const placements = index.windowsByEntity.get(String(record.entity.id)) ?? [];
        const linked = placements
          .map((placement) =>
            placement.winlink === null
              ? undefined
              : index.sessionByEntity.get(String(placement.winlink.sessionId)),
          )
          .filter((session): session is GraphRecord => session !== undefined);
        builder.materializeOne(record.ref, "session", owning?.ref ?? null);
        builder.materializeMany(record.ref, "linkedSessions", refsOf(linked));
        builder.materializeMany(record.ref, "panes", refsOf(panes));
        const activePane = panes.find((candidate) => isActive(candidate, "pane_active"));
        builder.materializeOne(record.ref, "activePane", activePane?.ref ?? null);
        visit([...refsOf(panes), ...refsOf(linked), ...present(owning?.ref, activePane?.ref)]);
        break;
      }
      case "client": {
        // A client record carries no winlink of its own — tmux lists what the
        // client is *looking at*, which is a session, a window placement, and a
        // pane it does not own. Each is resolved from the row rather than from
        // a placement this record is part of.
        const scalars = record.scalars;
        const sessionId = scalars.session_id;
        const windowId = scalars.window_id;
        const windowIndex = scalars.window_index;
        const owningSession = sessionId === null ? undefined : index.sessionByEntity.get(sessionId);
        const shownWindow =
          sessionId === null || windowId === null || windowIndex === null
            ? undefined
            : index.windowByWinlink.get(placementKey(sessionId, windowId, windowIndex));
        const shownPanes =
          sessionId === null || windowId === null || windowIndex === null
            ? []
            : (index.panesByWinlink.get(placementKey(sessionId, windowId, windowIndex)) ?? []);
        const activePane =
          scalars.pane_id === null
            ? undefined
            : shownPanes.find(
                (candidate) => String(candidate.entity.id) === String(scalars.pane_id),
              );
        builder.materializeOne(record.ref, "session", owningSession?.ref ?? null);
        builder.materializeOne(record.ref, "window", shownWindow?.ref ?? null);
        builder.materializeOne(record.ref, "pane", activePane?.ref ?? null);
        visit(present(owningSession?.ref, shownWindow?.ref, activePane?.ref));
        break;
      }
      case "pane": {
        if (winlink === null) break;
        const owningWindow = index.windowByWinlink.get(winlinkKey(winlink));
        const owningSession = index.sessionByEntity.get(String(winlink.sessionId));
        builder.materializeOne(record.ref, "window", owningWindow?.ref ?? null);
        builder.materializeOne(record.ref, "session", owningSession?.ref ?? null);
        visit(present(owningWindow?.ref, owningSession?.ref));
        break;
      }
      default:
        break;
    }
  }

  return builder.seal();
}
