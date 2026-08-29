import {
  WHERE_FIELDS_V1,
  WHERE_RELATIONS_V1,
  type WhereModel,
  type WhereRelation,
} from "../../_generated/where_fields.js";
import { decodeFormatValue } from "../codec/format_values.js";
import type { GraphRecordRef } from "../graph/model.js";
import type { ProjectionRecord } from "../graph/projection_identity.js";
import {
  at,
  frozenArray,
  frozenRecord,
  invalidQuery,
  isObject,
  listed,
  maximumWhereDepth,
  newParseState,
  quoted,
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

interface ParsedScalar {
  readonly query: string | null | Readonly<Record<string, unknown>>;
  readonly test: (value: string | null) => boolean;
}

/**
 * How many single-character edits separate two names.
 *
 * Only ever asked whether the answer is small, so the table is the whole cost
 * and the names it compares are criteria keys.
 */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * Name the closest few of a set too large to list.
 *
 * A model carries over a hundred criteria fields, so listing them buries the
 * answer. Two edits covers a typo, a wrong case, and a missing plural.
 */
function nearest(name: string, known: readonly string[]): string {
  const close = known
    .map(
      (candidate) =>
        [editDistance(name.toLowerCase(), candidate.toLowerCase()), candidate] as const,
    )
    .filter(([distance]) => distance <= 2)
    .sort(([left, leftName], [right, rightName]) =>
      left === right ? (leftName < rightName ? -1 : 1) : left - right,
    )
    .slice(0, 3)
    .map(([, candidate]) => quoted(candidate));
  return close.length === 0 ? "" : `; did you mean ${close.join(", ")}?`;
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
/**
 * The operators a scalar criterion takes.
 *
 * Exported because the criteria reference lists them, and a reference that
 * keeps its own copy of a vocabulary is a claim nothing checks: the generator
 * would read the copy, the committed file would match what the generator
 * wrote, and the gate would pass over an operator this compiler no longer
 * accepts.
 */
export const scalarOperatorNames: readonly string[] = Object.freeze([
  "contains",
  "endsWith",
  "equals",
  "in",
  "mode",
  "notIn",
  "regex",
  "startsWith",
] as const);
const regexFlags = new Set(["", "m", "s", "ms"]);
/** Built from the vocabulary, so a new operator cannot go unmentioned. */
const OPERATORS = listed([...scalarOperatorNames]);
const escapedRegexLiterals = new Set("^$\\.*+?()[]{}|/-".split(""));
const maximumRegexPatternLength = 512;

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

/**
 * Accept only the regular expressions this package will run.
 *
 * The offsets are reported and the pattern is not: a criterion's operand can
 * carry a pane title or a path, and these messages travel to whoever sent the
 * query.
 */
function validateRegexPattern(pattern: string, flags: string, state: ParseState): void {
  const bad = (offset: number, reason: string): never =>
    invalidQuery(state, `invalid regular expression at offset ${String(offset)}: ${reason}`);

  if (pattern.length > maximumRegexPatternLength) {
    return bad(maximumRegexPatternLength, "the pattern exceeds the 512-code-unit limit");
  }
  let alternatives = 0;
  let firstQuantifierOffset: number | undefined;
  let groupDepth = 0;
  let inClass = false;
  let classContent = 0;
  let canQuantify = false;
  let canQuantifyGroup = false;
  let quantifiers = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) return bad(index, "the pattern ended mid-character");

    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) return bad(index, "a trailing backslash escapes nothing");
      if (!escapedRegexLiterals.has(escaped)) {
        return bad(index, `only ${listed([...escapedRegexLiterals])} may be escaped`);
      }
      index += 1;
      if (inClass) classContent += 1;
      canQuantify = true;
      canQuantifyGroup = false;
      continue;
    }

    if (inClass) {
      const code = character.codePointAt(0);
      if (code === undefined || code < 0x20 || code > 0x7e) {
        return bad(index, "a character class takes printable ASCII only");
      }
      if (character === "[") return bad(index, "a nested class is not accepted");
      if (classContent === 0 && character === "^") {
        return bad(index, "a negated class is not accepted");
      }
      if (character === "]") {
        if (classContent === 0) return bad(index, "an empty character class matches nothing");
        inClass = false;
        canQuantify = true;
        canQuantifyGroup = false;
        continue;
      }
      if (
        (character === "&" && pattern[index + 1] === "&") ||
        (character === "-" && pattern[index + 1] === "-")
      ) {
        return bad(index, "a class set operator is not accepted");
      }
      classContent += 1;
      continue;
    }

    if (character === "[") {
      inClass = true;
      classContent = 0;
      canQuantify = false;
      canQuantifyGroup = false;
      continue;
    }
    if (character === "]") return bad(index, "a class was closed that was never opened");
    if (character === "}") return bad(index, "a quantifier was closed that was never opened");
    if (character === "(") {
      if (pattern[index + 1] === "?") {
        if (pattern[index + 2] !== ":") {
          return bad(index, "only a non-capturing group `(?:` takes a `?` here");
        }
        index += 2;
      }
      groupDepth += 1;
      canQuantify = false;
      canQuantifyGroup = false;
      continue;
    }
    if (character === ")") {
      if (groupDepth === 0) return bad(index, "a group was closed that was never opened");
      groupDepth -= 1;
      canQuantify = true;
      canQuantifyGroup = true;
      continue;
    }
    if (character === "{") {
      if (!canQuantify) return bad(index, "a quantifier follows nothing to repeat");
      if (canQuantifyGroup) return bad(index, "a group cannot be repeated");
      const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(index));
      if (match === null) return bad(index, "a counted quantifier reads `{n}`, `{n,}` or `{n,m}`");
      const lower = Number(match[1]);
      const upper = match[2] === undefined || match[2] === "" ? undefined : Number(match[2]);
      if (
        !Number.isSafeInteger(lower) ||
        (upper !== undefined && (!Number.isSafeInteger(upper) || upper < lower))
      ) {
        return bad(index, "counted bounds must be ascending safe integers");
      }
      const next = pattern[index + match[0].length];
      if (next === "?" || next === "+") {
        return bad(index, "a lazy or possessive quantifier is not accepted");
      }
      quantifiers += 1;
      if (quantifiers > 1) return bad(index, "a pattern can contain only one quantifier");
      firstQuantifierOffset = index;
      index += match[0].length - 1;
      canQuantify = false;
      continue;
    }
    if (character === "*" || character === "+" || character === "?") {
      if (!canQuantify) return bad(index, "a quantifier follows nothing to repeat");
      if (canQuantifyGroup) return bad(index, "a group cannot be repeated");
      if (pattern[index + 1] === "?" || pattern[index + 1] === "+") {
        return bad(index, "a lazy or possessive quantifier is not accepted");
      }
      quantifiers += 1;
      if (quantifiers > 1) return bad(index, "a pattern can contain only one quantifier");
      firstQuantifierOffset = index;
      canQuantify = false;
      continue;
    }
    if (character === "|") {
      alternatives += 1;
      if (alternatives > 1) return bad(index, "a pattern can contain only one alternative");
      canQuantify = false;
      canQuantifyGroup = false;
      continue;
    }
    if (character === "^" || character === "$") {
      canQuantify = false;
      canQuantifyGroup = false;
      continue;
    }
    if (character.codePointAt(0) !== undefined && character.codePointAt(0)! < 0x20) {
      return bad(index, "a control character is not accepted");
    }
    canQuantify = true;
    canQuantifyGroup = false;
  }

  if (inClass) return bad(pattern.length, "a character class was never closed");
  if (groupDepth !== 0) return bad(pattern.length, "a group was never closed");
  if (firstQuantifierOffset !== undefined) {
    if (pattern[0] !== "^") {
      return bad(firstQuantifierOffset, "a pattern with repetition must start with `^`");
    }
    if (alternatives !== 0) {
      return bad(firstQuantifierOffset, "a repeated pattern cannot contain an alternative");
    }
    if (flags.includes("m")) {
      return bad(firstQuantifierOffset, "a repeated pattern cannot use multiline mode");
    }
  }
}

function compileRegex(
  pattern: string,
  flags: string,
  insensitive: boolean,
  state: ParseState,
): RegExp {
  validateRegexPattern(pattern, flags, state);
  try {
    return new RegExp(pattern, `${flags}${insensitive ? "iu" : "u"}`);
  } catch (error) {
    return invalidQuery(state, "the regular expression did not compile", error);
  }
}

function parseStringArray(value: unknown, state: ParseState): readonly string[] {
  if (!isObject(value)) return invalidQuery(state, "expected an array of strings");
  return withActive(value, state, () => {
    const values = snapshotArray(value, state);
    const wrong = values.findIndex((entry) => typeof entry !== "string");
    if (wrong !== -1) return at(state, wrong, () => invalidQuery(state, "expected a string"));
    return Object.freeze([...values]) as readonly string[];
  });
}

function parseRegex(
  value: unknown,
  insensitive: boolean,
  state: ParseState,
): { readonly query: Readonly<Record<string, unknown>>; readonly regex: RegExp } {
  if (!isObject(value)) {
    return invalidQuery(state, "expected an object with a pattern and flags, not a bare string");
  }
  return withActive(value, state, () => {
    const record = snapshotObject(value, state);
    if (record.size !== 2 || !record.has("flags") || !record.has("pattern")) {
      return invalidQuery(state, 'expected exactly the keys "pattern" and "flags"');
    }
    const flags = record.get("flags");
    const pattern = record.get("pattern");
    if (typeof pattern !== "string") {
      return at(state, "pattern", () => invalidQuery(state, "expected a string"));
    }
    if (typeof flags !== "string" || !regexFlags.has(flags)) {
      return at(state, "flags", () =>
        invalidQuery(state, `expected one of ${listed([...regexFlags].map((flag) => flag))}`),
      );
    }
    return {
      query: frozenRecord([
        ["flags", flags],
        ["pattern", pattern],
      ]),
      regex: compileRegex(pattern, flags, insensitive, state),
    };
  });
}

function parseScalar(token: string, value: unknown, state: ParseState): ParsedScalar {
  if (typeof value === "string" || value === null) {
    return {
      query: value,
      test: (candidate) =>
        value === null ? decodeFormatValue(token, candidate) === null : candidate === value,
    };
  }
  if (!isObject(value)) {
    return invalidQuery(state, `expected a string, null, or an object of ${OPERATORS}`);
  }

  return withActive(value, state, () => {
    const record = snapshotObject(value, state);
    if (record.size === 0) return invalidQuery(state, `expected one of ${OPERATORS}`);
    for (const key of record.keys()) {
      if (scalarOperatorNames.includes(key)) continue;
      return at(state, key, () =>
        invalidQuery(
          state,
          `unknown operator; expected one of ${OPERATORS}${nearest(key, scalarOperatorNames)}`,
        ),
      );
    }
    const mode = record.get("mode");
    if (record.has("mode") && mode !== "insensitive") {
      return at(state, "mode", () => invalidQuery(state, `expected "insensitive"`));
    }
    if ([...record.keys()].every((key) => key === "mode")) {
      return invalidQuery(
        state,
        `"mode" folds case for another operator and matches nothing alone`,
      );
    }
    const insensitive = mode === "insensitive";
    const queryEntries: Array<readonly [string, unknown]> = [];
    const operations: Array<(candidate: string | null) => boolean> = [];

    for (const [name, operand] of record) {
      if (name === "mode") {
        queryEntries.push([name, mode]);
        continue;
      }
      if (name === "equals") {
        if (typeof operand !== "string" && operand !== null) {
          return at(state, name, () => invalidQuery(state, "expected a string or null"));
        }
        queryEntries.push([name, operand]);
        operations.push((candidate) => {
          if (operand === null) return decodeFormatValue(token, candidate) === null;
          if (candidate === null) return false;
          return insensitive
            ? candidate.toLowerCase() === operand.toLowerCase()
            : candidate === operand;
        });
        continue;
      }
      if (name === "contains" || name === "startsWith" || name === "endsWith") {
        if (typeof operand !== "string") {
          return at(state, name, () => invalidQuery(state, "expected a string"));
        }
        queryEntries.push([name, operand]);
        operations.push((candidate) => {
          if (candidate === null) return false;
          const left = insensitive ? candidate.toLowerCase() : candidate;
          const right = insensitive ? operand.toLowerCase() : operand;
          if (name === "contains") return left.includes(right);
          if (name === "startsWith") return left.startsWith(right);
          return left.endsWith(right);
        });
        continue;
      }
      if (name === "in" || name === "notIn") {
        const values = at(state, name, () => parseStringArray(operand, state));
        queryEntries.push([name, values]);
        const comparable = new Set(
          insensitive ? values.map((entry) => entry.toLowerCase()) : values,
        );
        operations.push((candidate) => {
          if (candidate === null) return false;
          const present = comparable.has(insensitive ? candidate.toLowerCase() : candidate);
          return name === "in" ? present : !present;
        });
        continue;
      }
      if (name === "regex") {
        const parsed = at(state, name, () => parseRegex(operand, insensitive, state));
        queryEntries.push([name, parsed.query]);
        operations.push((candidate) => candidate !== null && parsed.regex.test(candidate));
        continue;
      }
      return at(state, name, () => invalidQuery(state, `expected one of ${OPERATORS}`));
    }

    return {
      query: frozenRecord(queryEntries),
      test: (candidate) => operations.every((operation) => operation(candidate)),
    };
  });
}

export function canonicalizeScalarCriterion(
  token: string,
  value: unknown,
  state: ParseState,
): unknown {
  return parseScalar(token, value, state).query;
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
        const parsed = at(state, name, () => parseScalar(field.token, criterion, state));
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
