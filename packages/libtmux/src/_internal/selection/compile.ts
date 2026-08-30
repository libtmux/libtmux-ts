import {
  WHERE_FIELDS_V1,
  WHERE_RELATIONS_V1,
  type WhereModel,
  type WhereRelation,
} from "../../_generated/where_fields.js";
import type { GraphRecordRef } from "../graph/model.js";
import type { ProjectionRecord } from "../graph/projection_identity.js";
import { parseScalarCriterion } from "./scalar.js";
import {
  at,
  frozenArray,
  frozenRecord,
  invalidQuery,
  isObject,
  listed,
  maximumWhereDepth,
  nearest,
  newParseState,
  snapshotArray,
  snapshotObject,
  withActive,
  type ParseState,
} from "./validation.js";
import { criteriaToWireValues } from "./wire.js";

type RecordResolver = (reference: GraphRecordRef) => ProjectionRecord | undefined;
type RecordPredicate = (record: ProjectionRecord, resolve: RecordResolver) => boolean;

interface ParsedCriteria {
  readonly query: Readonly<Record<string, unknown>>;
  readonly test: RecordPredicate;
}

export interface CompiledWhere {
  readonly model: WhereModel;
  readonly query: Readonly<Record<string, unknown>>;
  matches(record: ProjectionRecord, resolve: RecordResolver): boolean;
}

const logicalNames = Object.freeze(["AND", "NOT", "OR"]);
/** How a relation is quantified, by whether it holds one target or many. */
const MANY_QUANTIFIERS: readonly string[] = Object.freeze(["every", "none", "some"]);
const ONE_QUANTIFIERS: readonly string[] = Object.freeze(["is", "isNot"]);

function relationFor(model: WhereModel, name: string): WhereRelation | undefined {
  return WHERE_RELATIONS_V1[model].find((relation) => relation.name === name);
}

function scalarFieldsFor(
  model: WhereModel,
): ReadonlyMap<string, { readonly token: string; readonly wireName: string }> {
  return new Map(
    WHERE_FIELDS_V1[model].map(({ criteriaName, token, wireName }) => [
      criteriaName,
      { token, wireName },
    ]),
  );
}

function findAdjacency(record: ProjectionRecord, relation: WhereRelation) {
  return record.adjacency.find(
    (candidate) =>
      candidate.name === relation.name &&
      candidate.cardinality === relation.cardinality &&
      candidate.targetModel === relation.targetModel,
  );
}

function parseManyRelation(
  relation: WhereRelation,
  value: unknown,
  state: ParseState,
  depth: number,
): { readonly query: Readonly<Record<string, unknown>>; readonly test: RecordPredicate } {
  const quantifiers = `${listed(MANY_QUANTIFIERS)} over its ${relation.targetModel}s`;
  if (!isObject(value)) return invalidQuery(state, `expected an object of ${quantifiers}`);
  return withActive(value, state, () => {
    const record = snapshotObject(value, state);
    if (record.size === 0) return invalidQuery(state, `expected one of ${quantifiers}`);
    for (const key of record.keys()) {
      if (MANY_QUANTIFIERS.includes(key)) continue;
      return at(state, key, () =>
        invalidQuery(
          state,
          `unknown quantifier; ${relation.name} holds many, so expected one of ${quantifiers}${nearest(key, MANY_QUANTIFIERS)}`,
        ),
      );
    }
    const entries: Array<readonly [string, unknown]> = [];
    const operations: Array<{
      readonly name: string;
      readonly parsed: ParsedCriteria;
    }> = [];
    for (const [name, child] of record) {
      const parsed = at(state, name, () =>
        parseCriteria(relation.targetModel, child, state, depth + 1),
      );
      entries.push([name, parsed.query]);
      operations.push({ name, parsed });
    }
    return {
      query: frozenRecord(entries),
      test: (source, resolve) => {
        const adjacency = findAdjacency(source, relation);
        if (adjacency === undefined || adjacency.cardinality !== "many") return false;
        const targets = adjacency.targets.map(resolve);
        if (targets.some((target) => target === undefined)) return false;
        return operations.every(({ name, parsed }) => {
          const matches = (target: ProjectionRecord | undefined): boolean =>
            target !== undefined && parsed.test(target, resolve);
          if (name === "some") return targets.some(matches);
          if (name === "every") return targets.every(matches);
          return targets.every((target) => !matches(target));
        });
      },
    };
  });
}

function parseOneRelation(
  relation: WhereRelation,
  value: unknown,
  state: ParseState,
  depth: number,
): { readonly query: Readonly<Record<string, unknown>>; readonly test: RecordPredicate } {
  const quantifiers = `${listed(ONE_QUANTIFIERS)} over its ${relation.targetModel}`;
  if (!isObject(value)) return invalidQuery(state, `expected an object of ${quantifiers}`);
  return withActive(value, state, () => {
    const record = snapshotObject(value, state);
    if (record.size === 0) return invalidQuery(state, `expected one of ${quantifiers}`);
    for (const key of record.keys()) {
      if (ONE_QUANTIFIERS.includes(key)) continue;
      return at(state, key, () =>
        invalidQuery(
          state,
          `unknown quantifier; ${relation.name} holds one, so expected ${quantifiers}${nearest(key, ONE_QUANTIFIERS)}`,
        ),
      );
    }
    const entries: Array<readonly [string, unknown]> = [];
    const operations: Array<{
      readonly name: string;
      readonly parsed: ParsedCriteria | null;
    }> = [];
    for (const [name, child] of record) {
      const parsed =
        child === null
          ? null
          : at(state, name, () => parseCriteria(relation.targetModel, child, state, depth + 1));
      entries.push([name, parsed?.query ?? null]);
      operations.push({ name, parsed });
    }
    return {
      query: frozenRecord(entries),
      test: (source, resolve) => {
        const adjacency = findAdjacency(source, relation);
        if (adjacency === undefined || adjacency.cardinality !== "one") return false;
        const target = adjacency.target === null ? null : resolve(adjacency.target);
        if (target === undefined) return false;
        return operations.every(({ name, parsed }) => {
          const matches =
            parsed === null ? target === null : target !== null && parsed.test(target, resolve);
          return name === "is" ? matches : !matches;
        });
      },
    };
  });
}

function parseCriteria(
  model: WhereModel,
  value: unknown,
  state: ParseState,
  depth = 0,
): ParsedCriteria {
  if (depth > maximumWhereDepth) {
    return invalidQuery(state, `the criteria nest deeper than ${String(maximumWhereDepth)}`);
  }
  if (!isObject(value)) return invalidQuery(state, `expected an object of ${model} criteria`);
  return withActive(value, state, () => {
    const record = snapshotObject(value, state);
    const scalarFields = scalarFieldsFor(model);
    const entries: Array<readonly [string, unknown]> = [];
    const predicates: RecordPredicate[] = [];

    for (const [name, criterion] of record) {
      const field = scalarFields.get(name);
      if (field !== undefined) {
        const parsed = at(state, name, () => parseScalarCriterion(field.token, criterion, state));
        entries.push([field.wireName, parsed.query]);
        predicates.push((source) => parsed.test(source.scalars[field.wireName] ?? null));
        continue;
      }
      if (logicalNames.includes(name as never)) {
        if (!isObject(criterion)) {
          return at(state, name, () => invalidQuery(state, "expected an array of criteria"));
        }
        const children = at(state, name, () =>
          withActive(criterion, state, () =>
            snapshotArray(criterion, state).map((child, index) =>
              at(state, index, () => parseCriteria(model, child, state, depth + 1)),
            ),
          ),
        );
        entries.push([name, frozenArray(children.map(({ query }) => query))]);
        if (name === "AND") {
          predicates.push((source, resolve) => children.every(({ test }) => test(source, resolve)));
        } else if (name === "OR") {
          predicates.push((source, resolve) => children.some(({ test }) => test(source, resolve)));
        } else {
          predicates.push((source, resolve) =>
            children.every(({ test }) => !test(source, resolve)),
          );
        }
        continue;
      }
      const relation = relationFor(model, name);
      if (relation === undefined) {
        // Both vocabularies, because a caller reaching for one may have wanted
        // the other: `windows` is a relation and `windowName` a field.
        const known = [
          ...scalarFields.keys(),
          ...WHERE_RELATIONS_V1[model].map((candidate) => candidate.name),
          ...logicalNames,
        ];
        return at(state, name, () =>
          invalidQuery(state, `no ${model} criterion of that name${nearest(name, known)}`),
        );
      }
      const parsed = at(state, name, () =>
        relation.cardinality === "many"
          ? parseManyRelation(relation, criterion, state, depth)
          : parseOneRelation(relation, criterion, state, depth),
      );
      entries.push([name, parsed.query]);
      predicates.push(parsed.test);
    }

    return {
      query: frozenRecord(entries),
      test: (source, resolve) => predicates.every((predicate) => predicate(source, resolve)),
    };
  });
}

export function parseModel(value: unknown, state: ParseState): WhereModel {
  if (value !== "session" && value !== "window" && value !== "pane" && value !== "client") {
    return invalidQuery(
      state,
      `expected one of ${listed(["client", "pane", "session", "window"])}`,
    );
  }
  return value;
}

export function canonicalizeWhere(
  model: WhereModel,
  criteria: unknown,
  state: ParseState = newParseState(),
): Readonly<Record<string, unknown>> {
  const parsedModel = parseModel(model, state);
  return parseCriteria(parsedModel, criteriaToWireValues(parsedModel, criteria, state), state)
    .query;
}

export function compileWhere(model: WhereModel, criteria: unknown): CompiledWhere {
  const state = newParseState();
  const parsedModel = parseModel(model, state);
  const spelled = criteriaToWireValues(parsedModel, criteria, state);
  const parsed = parseCriteria(parsedModel, spelled, state);
  return Object.freeze({
    model: parsedModel,
    query: parsed.query,
    matches(record: ProjectionRecord, resolve: RecordResolver): boolean {
      return record.model === parsedModel && parsed.test(record, resolve);
    },
  });
}
