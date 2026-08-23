import { types as nodeTypes } from "node:util";

import {
  WHERE_FIELDS_V1,
  WHERE_RELATIONS_V1,
  type WhereModel,
  type WhereRelation,
} from "../../_generated/where_fields.js";
import { QueryValidationError } from "../../exc.js";
import type { WhereDocumentV1 } from "../../selection.js";
import { encodeFormatValue } from "../codec/format_values.js";
import type { GraphRecordRef } from "../graph/model.js";
import type { ProjectionRecord } from "../graph/selection_projection.js";

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

interface ParseState {
  readonly active: WeakSet<object>;
  /** Where in the criteria the parser currently is, for naming a failure. */
  readonly path: (string | number)[];
}

function newParseState(): ParseState {
  return { active: new WeakSet(), path: [] };
}

/** Run `read` one step deeper, and leave the path as it was however it ends. */
function at<Value>(state: ParseState, segment: string | number, read: () => Value): Value {
  state.path.push(segment);
  try {
    return read();
  } finally {
    state.path.pop();
  }
}

function renderPath(path: readonly (string | number)[]): string {
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") rendered += `[${String(segment)}]`;
    else rendered += rendered === "" ? segment : `.${segment}`;
  }
  return rendered;
}

const quoted = (name: string): string => JSON.stringify(name);

function listed(names: readonly string[]): string {
  return [...names].sort().map(quoted).join(", ");
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

const logicalNames = Object.freeze(["AND", "NOT", "OR"] as const);
/** How a relation is quantified, by whether it holds one target or many. */
const MANY_QUANTIFIERS: readonly string[] = Object.freeze(["every", "none", "some"]);
const ONE_QUANTIFIERS: readonly string[] = Object.freeze(["is", "isNot"]);
const scalarOperatorNames = Object.freeze([
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
const maximumWhereDepth = 64;
const maximumCanonicalJsonDepth = maximumWhereDepth * 2 + 4;

/**
 * Refuse a query, naming where in it the problem is and what was expected.
 *
 * Criteria arrive as data — from an MCP client, a stored document, a form —
 * where the type system cannot have caught the mistake, so the message is the
 * only thing a caller has to go on. It names keys and expectations and never an
 * operand: these travel to whoever sent the query, and a criterion's value can
 * be a pane title or a path.
 */
function invalidQuery(state: ParseState, reason: string, cause?: unknown): never {
  const where = state.path.length === 0 ? "" : ` at ${renderPath(state.path)}`;
  throw new QueryValidationError({
    ...(cause === undefined ? {} : { cause }),
    code: "invalid-query",
    message: `Invalid selection query${where}: ${reason}`,
    path: [...state.path],
  });
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function withActive<Value>(value: object, state: ParseState, read: () => Value): Value {
  if (state.active.has(value)) return invalidQuery(state, "the criteria refer to themselves");
  state.active.add(value);
  try {
    return read();
  } finally {
    state.active.delete(value);
  }
}

function snapshotObject(value: unknown, state: ParseState): ReadonlyMap<string, unknown> {
  const plain = "expected a plain object";
  if (!isObject(value) || typeof value === "function") return invalidQuery(state, plain);
  try {
    if (nodeTypes.isProxy(value) || Array.isArray(value)) return invalidQuery(state, plain);
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return invalidQuery(state, plain);
    const keys = Reflect.ownKeys(value);
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of keys) {
      // A symbol key names nothing this vocabulary has, and a getter would run
      // caller code while the query is being read.
      if (typeof key !== "string") return invalidQuery(state, "expected only string keys");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return invalidQuery(state, `expected ${quoted(key)} to be a plain enumerable value`);
      }
      entries.push([key, descriptor.value]);
    }
    return new Map(entries);
  } catch (error) {
    if (error instanceof QueryValidationError) throw error;
    return invalidQuery(state, plain, error);
  }
}

function snapshotArray(value: unknown, state: ParseState): readonly unknown[] {
  const plain = "expected an array";
  if (!isObject(value) || typeof value === "function") return invalidQuery(state, plain);
  try {
    if (nodeTypes.isProxy(value) || !Array.isArray(value)) return invalidQuery(state, plain);
    if (Object.getPrototypeOf(value) !== Array.prototype) return invalidQuery(state, plain);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return invalidQuery(state, plain);
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return invalidQuery(state, plain);
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) return invalidQuery(state, plain);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return invalidQuery(state, plain);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof QueryValidationError) throw error;
    return invalidQuery(state, plain, error);
  }
}

function frozenRecord(
  entries: readonly (readonly [string, unknown])[],
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

function frozenArray(values: readonly unknown[]): readonly unknown[] {
  return Object.freeze([...values]);
}

function relationFor(model: WhereModel, name: string): WhereRelation | undefined {
  return WHERE_RELATIONS_V1[model].find((relation) => relation.name === name);
}

/**
 * Criteria are written with idiomatic camelCase keys and serialized under
 * tmux-stable wire names, so a stored document stays readable by the CLI, the
 * MCP surface, and a future Rust port even as the TypeScript surface evolves.
 */
function criteriaFromWire(
  model: WhereModel,
  value: unknown,
  state: ParseState,
  depth = 0,
): unknown {
  // Stop at the criteria depth budget and hand the original value on, so an
  // over-deep or cyclic document is rejected by the validator rather than here.
  if (depth > maximumWhereDepth || !isObject(value)) return value;
  const byWire = new Map(
    WHERE_FIELDS_V1[model].map(({ criteriaName, wireName }) => [wireName, criteriaName]),
  );
  const relations = new Map(
    WHERE_RELATIONS_V1[model].map((relation) => [relation.name as string, relation] as const),
  );
  const translated: Record<string, unknown> = {};
  for (const [key, entry] of snapshotObject(value, state)) {
    const relation = relations.get(key);
    if (relation !== undefined && isObject(entry)) {
      const inner: Record<string, unknown> = {};
      for (const [operator, nested] of snapshotObject(entry, state)) {
        inner[operator] = criteriaFromWire(relation.targetModel, nested, state, depth + 1);
      }
      translated[key] = inner;
      continue;
    }
    if (key === "AND" || key === "OR" || key === "NOT") {
      translated[key] = snapshotArray(entry, state).map((child) =>
        criteriaFromWire(model, child, state, depth + 1),
      );
      continue;
    }
    translated[byWire.get(key) ?? key] = entry;
  }
  return translated;
}

/** Operators whose operand is a value tmux will compare, rather than a modifier. */
const encodableOperators = new Set(["contains", "endsWith", "equals", "startsWith"]);
const encodableListOperators = new Set(["in", "notIn"]);

/**
 * Spell a typed criteria value the way the row it will be compared against does.
 *
 * A caller writes `where({ active: true })` or `where({ pid: 2334787 })`, and a
 * row holds `"1"` and `"2334787"`. The comparison happens on text — that is
 * what tmux sent and what a serialized query has to survive as — so the typed
 * value is spelled out here, once, before anything else looks at it.
 *
 * This is why the wire format did not need a second version. A stored
 * `WhereDocumentV1` still holds strings, and `criteriaFromWire` still reads
 * one; only the shapes a caller may write in TypeScript grew.
 */
function criteriaToWireValues(
  model: WhereModel,
  value: unknown,
  state: ParseState,
  depth = 0,
): unknown {
  // As in `criteriaFromWire`: hand an over-deep or cyclic document on unchanged
  // and let the validator reject it, rather than rejecting it here.
  if (depth > maximumWhereDepth || !isObject(value)) return value;
  const tokens = new Map(
    WHERE_FIELDS_V1[model].map(({ criteriaName, token }) => [criteriaName as string, token]),
  );
  const relations = new Map(
    WHERE_RELATIONS_V1[model].map((relation) => [relation.name as string, relation] as const),
  );
  const translated: Record<string, unknown> = {};
  for (const [key, entry] of snapshotObject(value, state)) {
    const relation = relations.get(key);
    if (relation !== undefined && isObject(entry)) {
      const inner: Record<string, unknown> = {};
      for (const [operator, nested] of snapshotObject(entry, state)) {
        inner[operator] = criteriaToWireValues(relation.targetModel, nested, state, depth + 1);
      }
      translated[key] = inner;
      continue;
    }
    if (key === "AND" || key === "OR" || key === "NOT") {
      translated[key] = snapshotArray(entry, state).map((child) =>
        criteriaToWireValues(model, child, state, depth + 1),
      );
      continue;
    }
    const token = tokens.get(key);
    if (token === undefined) {
      translated[key] = entry;
      continue;
    }
    if (!isObject(entry)) {
      translated[key] = encodeFormatValue(token, entry);
      continue;
    }
    const operators: Record<string, unknown> = {};
    for (const [operator, operand] of snapshotObject(entry, state)) {
      if (encodableOperators.has(operator)) {
        operators[operator] = encodeFormatValue(token, operand);
      } else if (encodableListOperators.has(operator) && Array.isArray(operand)) {
        operators[operator] = operand.map((item) => encodeFormatValue(token, item));
      } else {
        // `mode` selects case folding and `regex` carries a pattern; neither is
        // a value tmux holds, so neither is spelled out.
        operators[operator] = operand;
      }
    }
    translated[key] = operators;
  }
  return translated;
}

function scalarWireNamesFor(model: WhereModel): ReadonlyMap<string, string> {
  return new Map(
    WHERE_FIELDS_V1[model].map(({ criteriaName, wireName }) => [criteriaName, wireName]),
  );
}

/**
 * Accept only the regular expressions this package will run.
 *
 * The offsets are reported and the pattern is not: a criterion's operand can
 * carry a pane title or a path, and these messages travel to whoever sent the
 * query.
 */
function validateRegexPattern(pattern: string, state: ParseState): void {
  const bad = (offset: number, reason: string): never =>
    invalidQuery(state, `invalid regular expression at offset ${String(offset)}: ${reason}`);

  let groupDepth = 0;
  let inClass = false;
  let classContent = 0;
  let canQuantify = false;

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
      continue;
    }
    if (character === ")") {
      if (groupDepth === 0) return bad(index, "a group was closed that was never opened");
      groupDepth -= 1;
      canQuantify = true;
      continue;
    }
    if (character === "{") {
      if (!canQuantify) return bad(index, "a quantifier follows nothing to repeat");
      const match = /^\{\d+(?:,\d*)?\}/u.exec(pattern.slice(index));
      if (match === null) return bad(index, "a counted quantifier reads `{n}`, `{n,}` or `{n,m}`");
      const next = pattern[index + match[0].length];
      if (next === "?" || next === "+") {
        return bad(index, "a lazy or possessive quantifier is not accepted");
      }
      index += match[0].length - 1;
      canQuantify = false;
      continue;
    }
    if (character === "*" || character === "+" || character === "?") {
      if (!canQuantify) return bad(index, "a quantifier follows nothing to repeat");
      if (pattern[index + 1] === "?" || pattern[index + 1] === "+") {
        return bad(index, "a lazy or possessive quantifier is not accepted");
      }
      canQuantify = false;
      continue;
    }
    if (character === "|") {
      canQuantify = false;
      continue;
    }
    if (character === "^" || character === "$") {
      canQuantify = false;
      continue;
    }
    if (character.codePointAt(0) !== undefined && character.codePointAt(0)! < 0x20) {
      return bad(index, "a control character is not accepted");
    }
    canQuantify = true;
  }

  if (inClass) return bad(pattern.length, "a character class was never closed");
  if (groupDepth !== 0) return bad(pattern.length, "a group was never closed");
}

function compileRegex(
  pattern: string,
  flags: string,
  insensitive: boolean,
  state: ParseState,
): RegExp {
  validateRegexPattern(pattern, state);
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

function parseScalar(value: unknown, state: ParseState): ParsedScalar {
  if (typeof value === "string" || value === null) {
    return { query: value, test: (candidate) => candidate === value };
  }
  if (!isObject(value)) {
    return invalidQuery(state, `expected a string, null, or an object of ${OPERATORS}`);
  }

  return withActive(value, state, () => {
    const record = snapshotObject(value, state);
    if (record.size === 0) return invalidQuery(state, `expected one of ${OPERATORS}`);
    for (const key of record.keys()) {
      if (scalarOperatorNames.includes(key as never)) continue;
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
          if (candidate === null || operand === null) return candidate === operand;
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
        const comparable = insensitive ? values.map((entry) => entry.toLowerCase()) : values;
        operations.push((candidate) => {
          if (candidate === null) return false;
          const present = comparable.includes(insensitive ? candidate.toLowerCase() : candidate);
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
    const scalarWireNames = scalarWireNamesFor(model);
    const entries: Array<readonly [string, unknown]> = [];
    const predicates: RecordPredicate[] = [];

    for (const [name, criterion] of record) {
      const wireName = scalarWireNames.get(name);
      if (wireName !== undefined) {
        const parsed = at(state, name, () => parseScalar(criterion, state));
        entries.push([wireName, parsed.query]);
        predicates.push((source) => parsed.test(source.scalars[wireName] ?? null));
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
          ...scalarWireNames.keys(),
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

function parseModel(value: unknown, state: ParseState): WhereModel {
  if (value !== "session" && value !== "window" && value !== "pane" && value !== "client") {
    return invalidQuery(
      state,
      `expected one of ${listed(["client", "pane", "session", "window"])}`,
    );
  }
  return value;
}

function canonicalizeWhere(
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

export function canonicalizeWhereDocument(input: unknown): WhereDocumentV1 {
  const state = newParseState();
  const envelope = snapshotObject(input, state);
  if (
    envelope.size !== 3 ||
    !envelope.has("model") ||
    !envelope.has("version") ||
    !envelope.has("where")
  ) {
    return invalidQuery(
      state,
      `expected exactly the keys ${listed(["model", "version", "where"])}`,
    );
  }
  if (envelope.get("version") !== 1) {
    return at(state, "version", () => invalidQuery(state, "expected 1"));
  }
  const model = at(state, "model", () => parseModel(envelope.get("model"), state));
  // A stored document is written in wire names; criteria are written in the
  // idiomatic ones. Translate before compiling so a document round-trips
  // without the criteria surface having to accept tmux spellings.
  const where = at(state, "where", () =>
    canonicalizeWhere(model, criteriaFromWire(model, envelope.get("where"), state), state),
  );
  return Object.freeze({ model, version: 1, where }) as WhereDocumentV1;
}

/**
 * Serializing a query that has already been validated.
 *
 * Reached only through {@link canonicalJson}, whose input is a parser's own
 * output, so these refusals describe a value this module built. They carry no
 * path because there is no caller's document to point into.
 */
const NOT_SERIALIZABLE = "the canonical query holds a value that cannot be written";

function jsonString(value: string, state: ParseState): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? invalidQuery(state, NOT_SERIALIZABLE) : encoded;
}

function canonicalJsonValue(value: unknown, depth: number, state: ParseState): string {
  if (value === null) return "null";
  if (typeof value === "string") return jsonString(value, state);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (depth > maximumCanonicalJsonDepth || !isObject(value) || typeof value === "function") {
    return invalidQuery(state, NOT_SERIALIZABLE);
  }
  if (Array.isArray(value)) {
    return `[${snapshotArray(value, state)
      .map((entry) => canonicalJsonValue(entry, depth + 1, state))
      .join(",")}]`;
  }
  return `{${[...snapshotObject(value, state)]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, entry]) => `${jsonString(key, state)}:${canonicalJsonValue(entry, depth + 1, state)}`,
    )
    .join(",")}}`;
}

export function canonicalJson(value: Readonly<Record<string, unknown>>): string {
  return canonicalJsonValue(value, 0, newParseState());
}
