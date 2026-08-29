import { types as nodeTypes } from "node:util";

import { Client } from "../../client.js";
import { MultipleMatchesError, NoMatchError, QueryValidationError } from "../../exc.js";
import { Pane } from "../../pane.js";
import type { Selection, WhereOf } from "../../selection.js";
import { Session } from "../../session.js";
import { Window } from "../../window.js";
import { WHERE_FIELDS_V1, WHERE_RELATIONS_V1 } from "../../_generated/where_fields.js";
import { graphRecordRefsEqual, type GraphRecordRef, type NormalizedGraph } from "../graph/model.js";
import { graphEntityRefsEqual, winlinkRefsEqual } from "../graph/refs.js";
import {
  corpusForSelectionProjection,
  isSelectionProjection,
  originGraphForSelectionProjection,
  resolverForSelectionProjection,
  selectionProjectionOwnsRecord,
  type ProjectionRecord,
  type SelectionProjection,
} from "../graph/projection_identity.js";
import type { ModelForKind } from "../runtime/model_kind.js";
import {
  entityRefForHandle,
  graphRecordRefForHandle,
  originGraphForHandle,
  snapshotForHandle,
  winlinkRefForHandle,
} from "../runtime/live_handle.js";
import { compileWhere, type CompiledWhere } from "./compile.js";
import { refuseFieldsNewerThanServer } from "./version_gate.js";

type ProjectedKind = "client" | "pane" | "session" | "window";
type ProjectedModel = Client | Pane | Session | Window;

interface SelectionEntry<Model> {
  readonly record: ProjectionRecord;
  readonly value: Model;
}

/** Which scalar carries a model's own id, for the models that can share one. */
const ID_SCALARS: Readonly<Partial<Record<ProjectedKind, string>>> = Object.freeze({
  pane: "pane_id",
  window: "window_id",
});

/**
 * Name the sessions a shared id spans, when that is why several matched.
 *
 * Undefined for every other reason there can be more than one, so the ordinary
 * message still describes those.
 */
function sharedPlacementHint<Model>(
  kind: ProjectedKind,
  entries: readonly SelectionEntry<Model>[],
): string | undefined {
  const scalar = ID_SCALARS[kind];
  if (scalar === undefined || entries.length < 2) return undefined;
  const ids = new Set<string>();
  const sessions: string[] = [];
  for (const entry of entries) {
    const id = entry.record.scalars[scalar];
    // The winlink is the placement: which session holds this one.
    const session = entry.record.winlink?.sessionId;
    if (typeof id !== "string" || session === undefined) return undefined;
    ids.add(id);
    const named = String(session);
    if (!sessions.includes(named)) sessions.push(named);
  }
  if (ids.size !== 1 || sessions.length < 2) return undefined;
  const [id] = [...ids];
  return (
    `${String(id)} names ${String(entries.length)} placements, in sessions ` +
    `${sessions.join(", ")}. A ${kind} that linked or grouped sessions share has ` +
    `one id and a placement in each, so add the session to say which: ` +
    `{ id: "${String(id)}", session: { is: { id: "${sessions[0]!}" } } }`
  );
}

interface ProjectedSelectionState {
  readonly kind: ProjectedKind;
  readonly projection: SelectionProjection;
  readonly resolve: (reference: GraphRecordRef) => ProjectionRecord | undefined;
}

const emptyQuery: Readonly<Record<string, unknown>> = Object.freeze({});
const selectionConstructionToken: object = Object.freeze({});
const validatedProjectionCorpora = new WeakSet<object>();

function invalidSelection(cause?: unknown): never {
  throw new QueryValidationError({
    ...(cause === undefined ? {} : { cause }),
    code: "invalid-query",
    message: "Invalid selection construction",
  });
}

function snapshotValues<Model>(input: readonly Model[]): readonly Model[] {
  try {
    if (nodeTypes.isProxy(input) || !Array.isArray(input)) return invalidSelection();
    if (Object.getPrototypeOf(input) !== Array.prototype) return invalidSelection();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return invalidSelection();
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1 || !keys.includes("length")) return invalidSelection();
    const result: Model[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return invalidSelection();
      }
      result.push(descriptor.value as Model);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof QueryValidationError) throw error;
    return invalidSelection(error);
  }
}

function validateProjectionCorpus(
  projection: SelectionProjection,
  corpus: object,
  resolve: (reference: GraphRecordRef) => ProjectionRecord | undefined,
): void {
  if (validatedProjectionCorpora.has(corpus)) return;
  for (const record of projection.records) validateProjectionRecord(projection, record, resolve);
  validatedProjectionCorpora.add(corpus);
}

function validateProjectionRecord(
  projection: SelectionProjection,
  record: ProjectionRecord,
  resolve: (reference: GraphRecordRef) => ProjectionRecord | undefined,
): void {
  if (
    !Object.isFrozen(record) ||
    !Object.isFrozen(record.adjacency) ||
    !Object.isFrozen(record.scalars) ||
    record.adjacency.some(
      (adjacency) =>
        !Object.isFrozen(adjacency) ||
        (adjacency.cardinality === "many" && !Object.isFrozen(adjacency.targets)),
    )
  ) {
    return invalidSelection();
  }
  const expectedFields = WHERE_FIELDS_V1[record.model];
  const scalarKeys = Reflect.ownKeys(record.scalars);
  if (
    scalarKeys.length !== expectedFields.length ||
    scalarKeys.some(
      (key) => typeof key !== "string" || !expectedFields.some(({ wireName }) => wireName === key),
    )
  ) {
    return invalidSelection();
  }
  for (const { wireName } of expectedFields) {
    const value = record.scalars[wireName];
    if (typeof value !== "string" && value !== null) return invalidSelection();
  }

  const expectedRelations = WHERE_RELATIONS_V1[record.model];
  if (record.adjacency.length !== expectedRelations.length) return invalidSelection();
  for (const relation of expectedRelations) {
    const matches = record.adjacency.filter(
      (adjacency) =>
        adjacency.name === relation.name &&
        adjacency.cardinality === relation.cardinality &&
        adjacency.targetModel === relation.targetModel,
    );
    if (matches.length !== 1) return invalidSelection();
    const adjacency = matches[0];
    if (adjacency === undefined) return invalidSelection();
    const references =
      adjacency.cardinality === "many"
        ? adjacency.targets
        : adjacency.target === null
          ? []
          : [adjacency.target];
    for (const reference of references) {
      const target = resolve(reference);
      if (
        target === undefined ||
        target.model !== relation.targetModel ||
        !selectionProjectionOwnsRecord(projection, target)
      ) {
        return invalidSelection();
      }
    }
  }
}

function hasProjectedClass(model: ProjectedKind, value: unknown): value is ProjectedModel {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  if (nodeTypes.isProxy(value)) return false;
  switch (model) {
    case "client":
      return value instanceof Client;
    case "pane":
      return value instanceof Pane;
    case "session":
      return value instanceof Session;
    case "window":
      return value instanceof Window;
  }
}

function authenticateProjectedValue(
  model: ProjectedKind,
  value: unknown,
  record: ProjectionRecord,
  projectionGraph: NormalizedGraph,
): asserts value is ProjectedModel {
  if (!hasProjectedClass(model, value) || record.model !== model) return invalidSelection();
  try {
    const entity = entityRefForHandle(value);
    const graph = originGraphForHandle(value);
    const graphRecord = graphRecordRefForHandle(value);
    const snapshot = snapshotForHandle(value);
    const winlink = winlinkRefForHandle(value);
    if (
      graph !== projectionGraph ||
      !graphRecordRefsEqual(graphRecord, record.ref) ||
      entity.kind !== model ||
      !graphEntityRefsEqual(record.entity, entity)
    )
      return invalidSelection();
    for (const field of WHERE_FIELDS_V1[model]) {
      if (snapshot[field.token] !== record.scalars[field.wireName]) return invalidSelection();
    }
    if (
      (record.winlink === null && winlink !== null) ||
      (record.winlink !== null && winlink === null) ||
      (record.winlink !== null && winlink !== null && !winlinkRefsEqual(record.winlink, winlink))
    ) {
      return invalidSelection();
    }
  } catch (error) {
    if (error instanceof QueryValidationError) throw error;
    return invalidSelection(error);
  }
}

function projectedEntries<Kind extends ProjectedKind>(
  model: Kind,
  values: readonly ModelForKind<Kind>[],
  projection: SelectionProjection,
): {
  readonly entries: readonly SelectionEntry<ModelForKind<Kind>>[];
  readonly state: ProjectedSelectionState;
} {
  if (!isSelectionProjection(projection)) return invalidSelection();
  const projectionGraph = originGraphForSelectionProjection(projection);
  const corpus = corpusForSelectionProjection(projection);
  const resolve = resolverForSelectionProjection(projection);
  if (projectionGraph === undefined || corpus === undefined || resolve === undefined) {
    return invalidSelection();
  }
  const copiedValues = snapshotValues(values);
  if (copiedValues.length !== projection.members.length) return invalidSelection();
  validateProjectionCorpus(projection, corpus, resolve);

  const entries: Array<SelectionEntry<ModelForKind<Kind>>> = [];
  for (const [index, member] of projection.members.entries()) {
    const value = copiedValues[index];
    const record = resolve(member);
    if (value === undefined || record === undefined || record.model !== model) {
      return invalidSelection();
    }
    authenticateProjectedValue(model, value, record, projectionGraph);
    entries.push(Object.freeze({ record, value: value as ModelForKind<Kind> }));
  }
  return {
    entries: Object.freeze(entries),
    state: Object.freeze({ kind: model, projection, resolve }),
  };
}

class SelectionImpl<Model> implements Selection<Model> {
  readonly #entries: readonly SelectionEntry<Model>[];
  readonly #state: ProjectedSelectionState;
  readonly #values: readonly Model[];

  constructor(
    token: object,
    entries: readonly SelectionEntry<Model>[],
    state: ProjectedSelectionState,
  ) {
    if (token !== selectionConstructionToken) invalidSelection();
    this.#entries = entries;
    this.#state = state;
    this.#values = Object.freeze(entries.map(({ value }) => value));
    Object.freeze(this);
  }

  get length(): number {
    return this.#entries.length;
  }

  [Symbol.iterator](): IterableIterator<Model> {
    return this.#values[Symbol.iterator]();
  }

  at(index: number): Model | undefined {
    return this.#values.at(index);
  }

  toArray(): Model[] {
    return [...this.#values];
  }

  map<Result>(
    transform: (value: Model, index: number, values: readonly Model[]) => Result,
    thisArg?: unknown,
  ): Result[] {
    if (typeof transform !== "function") throw new TypeError("transform must be a function");
    return this.#values.map((value, index) => transform.call(thisArg, value, index, this.#values));
  }

  filter(
    predicate: (value: Model, index: number, values: readonly Model[]) => unknown,
    thisArg?: unknown,
  ): Selection<Model> {
    if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
    const entries = this.#entries.filter(({ value }, index) =>
      Boolean(predicate.call(thisArg, value, index, this.#values)),
    );
    return new SelectionImpl(selectionConstructionToken, Object.freeze(entries), this.#state);
  }

  where(criteria: WhereOf<Model>): Selection<Model> {
    if (criteria === undefined) return invalidSelection();
    const matched = this.#matchingEntries(criteria);
    return new SelectionImpl(selectionConstructionToken, matched, this.#state);
  }

  first(criteria?: WhereOf<Model>): Model | undefined {
    return this.#scan(criteria, 1).entries[0]?.value;
  }

  one(criteria?: WhereOf<Model>): Model {
    // Two is enough to know it is not one, so a server with a thousand panes
    // costs the same as one with two.
    const { entries, query } = this.#scan(criteria, 2);
    if (entries.length === 0) throw new NoMatchError({ query });
    if (entries.length !== 1) throw this.#tooMany(criteria, query);
    return entries[0]!.value;
  }

  oneOrUndefined(criteria?: WhereOf<Model>): Model | undefined {
    const { entries, query } = this.#scan(criteria, 2);
    if (entries.length > 1) throw this.#tooMany(criteria, query);
    return entries[0]?.value;
  }

  /**
   * Say how many matched, and where a shared id is the reason.
   *
   * A window linked into two sessions, or shared by two grouped sessions, has a
   * placement in each and one id between them — so asking by id alone raises
   * for an id that is perfectly good, and the fix is a criterion the caller has
   * not thought to add. Naming the sessions turns the refusal into it.
   *
   * The whole set is only counted here, on the way to raising. The fast path
   * still stops at two.
   */
  #tooMany(criteria: unknown, query: Readonly<Record<string, unknown>>): MultipleMatchesError {
    const all = this.#matchingEntries(criteria);
    const shared = sharedPlacementHint(this.#state.kind, all);
    return new MultipleMatchesError({
      count: all.length,
      ...(shared === undefined ? {} : { message: shared }),
      query,
    });
  }

  exists(criteria?: WhereOf<Model>): boolean {
    return this.#scan(criteria, 1).entries.length > 0;
  }

  count(criteria?: WhereOf<Model>): number {
    return this.#matchingEntries(criteria).length;
  }

  #compile(criteria: unknown): CompiledWhere | null {
    if (criteria === undefined) return null;
    const compiled = compileWhere(this.#state.kind, criteria);
    refuseFieldsNewerThanServer(
      compiled.model,
      compiled.query,
      this.#state.projection.capture.tmuxVersion,
    );
    return compiled;
  }

  #matchingEntries(criteria: unknown): readonly SelectionEntry<Model>[] {
    return this.#matchingWithQuery(criteria).entries;
  }

  #matchingWithQuery(criteria: unknown): {
    readonly entries: readonly SelectionEntry<Model>[];
    readonly query: Readonly<Record<string, unknown>>;
  } {
    return this.#scan(criteria, Number.POSITIVE_INFINITY);
  }

  /**
   * Members matching `criteria`, stopping once `limit` of them are found.
   *
   * `first` and `exists` want one, `one` wants to know whether there are two;
   * only `count` and `where` genuinely need the whole set. Matching a member
   * can mean resolving its relations, so stopping early is not merely fewer
   * comparisons.
   */
  #scan(
    criteria: unknown,
    limit: number,
  ): {
    readonly entries: readonly SelectionEntry<Model>[];
    readonly query: Readonly<Record<string, unknown>>;
  } {
    const compiled = this.#compile(criteria);
    if (compiled === null) {
      const unfiltered =
        limit >= this.#entries.length
          ? this.#entries
          : Object.freeze(this.#entries.slice(0, limit));
      return { entries: unfiltered, query: emptyQuery };
    }
    const state = this.#state;
    const entries: SelectionEntry<Model>[] = [];
    for (const entry of this.#entries) {
      if (!compiled.matches(entry.record, state.resolve)) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return { entries: Object.freeze(entries), query: compiled.query };
  }
}

Object.freeze(SelectionImpl.prototype);
Object.freeze(SelectionImpl);

export function createProjectedSelection<Kind extends ProjectedKind>(
  model: Kind,
  values: readonly ModelForKind<Kind>[],
  projection: SelectionProjection,
): Selection<ModelForKind<Kind>> {
  if (model !== "pane" && model !== "session" && model !== "window" && model !== "client") {
    return invalidSelection();
  }
  const { entries, state } = projectedEntries(model, values, projection);
  return new SelectionImpl(selectionConstructionToken, entries, state);
}
