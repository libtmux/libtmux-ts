import { decodeFormatValue } from "../codec/format_values.js";
import { parseRegex } from "./regex.js";
import {
  at,
  frozenRecord,
  invalidQuery,
  isObject,
  listed,
  nearest,
  snapshotArray,
  snapshotObject,
  withActive,
  type ParseState,
} from "./validation.js";

/**
 * The case-insensitive relation `mode` names, as `u`-mode regex defines it.
 *
 * `toLowerCase` is a different relation, and not only for rare code points: it
 * lowercases a trailing capital sigma to a final sigma, so no Greek word
 * ending in one matches the medial sigma a caller types. One `mode` covers
 * every operator in a criterion, so `equals` and `regex` have to fold alike.
 * `where.test.ts` re-derives this table from the engine.
 */
const CASE_FOLD_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ["\u00B5", "\u03BC"],
  ["\u017F", "\u0073"],
  ["\u0345", "\u03B9"],
  ["\u03C2", "\u03C3"],
  ["\u03D0", "\u03B2"],
  ["\u03D1", "\u03B8"],
  ["\u03D5", "\u03C6"],
  ["\u03D6", "\u03C0"],
  ["\u03F0", "\u03BA"],
  ["\u03F1", "\u03C1"],
  ["\u03F5", "\u03B5"],
  ["\u1C80", "\u0432"],
  ["\u1C81", "\u0434"],
  ["\u1C82", "\u043E"],
  ["\u1C83", "\u0441"],
  ["\u1C84", "\u0442"],
  ["\u1C85", "\u0442"],
  ["\u1C86", "\u044A"],
  ["\u1C87", "\u0463"],
  ["\u1C88", "\uA64B"],
  ["\u1E9B", "\u1E61"],
  ["\u1FBE", "\u03B9"],
]);

/** Fold one string into that relation. */
export function foldCase(value: string): string {
  const lowered = value.toLowerCase();
  let folded = "";
  let exceptional = false;
  for (const character of lowered) {
    const replacement = CASE_FOLD_EXCEPTIONS.get(character);
    if (replacement === undefined) {
      folded += character;
      continue;
    }
    folded += replacement;
    exceptional = true;
  }
  return exceptional ? folded : lowered;
}

interface ParsedScalarCriterion {
  readonly query: string | null | Readonly<Record<string, unknown>>;
  readonly test: (value: string | null) => boolean;
}

/** Shared with the criteria generator so its operator vocabulary cannot drift. */
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
/** Built from the vocabulary, so a new operator cannot go unmentioned. */
const OPERATORS = listed([...scalarOperatorNames]);
function parseStringArray(value: unknown, state: ParseState): readonly string[] {
  if (!isObject(value)) return invalidQuery(state, "expected an array of strings");
  return withActive(value, state, () => {
    const values = snapshotArray(value, state);
    const wrong = values.findIndex((entry) => typeof entry !== "string");
    if (wrong !== -1) return at(state, wrong, () => invalidQuery(state, "expected a string"));
    return Object.freeze([...values]) as readonly string[];
  });
}

export function parseScalarCriterion(
  token: string,
  value: unknown,
  state: ParseState,
): ParsedScalarCriterion {
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
          return insensitive ? foldCase(candidate) === foldCase(operand) : candidate === operand;
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
          const left = insensitive ? foldCase(candidate) : candidate;
          const right = insensitive ? foldCase(operand) : operand;
          if (name === "contains") return left.includes(right);
          if (name === "startsWith") return left.startsWith(right);
          return left.endsWith(right);
        });
        continue;
      }
      if (name === "in" || name === "notIn") {
        const values = at(state, name, () => parseStringArray(operand, state));
        queryEntries.push([name, values]);
        const comparable = new Set(insensitive ? values.map((entry) => foldCase(entry)) : values);
        operations.push((candidate) => {
          if (candidate === null) return false;
          const present = comparable.has(insensitive ? foldCase(candidate) : candidate);
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
  return parseScalarCriterion(token, value, state).query;
}
