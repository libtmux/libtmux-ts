import { types as nodeTypes } from "node:util";

import {
  WHERE_FIELDS_V1,
  WHERE_RELATIONS_V1,
  type WhereModel,
} from "../../_generated/where_fields.js";
import {
  encodeFormatValue,
  formatCriterionExpectation,
  isFormatCriterionValue,
} from "../codec/format_values.js";
import {
  at,
  frozenArray,
  frozenRecord,
  invalidQuery,
  isObject,
  maximumWhereDepth,
  snapshotArray,
  snapshotObject,
  type ParseState,
} from "./validation.js";

/** Operators whose operand is a field value rather than text to search. */
const valueOperators = new Set(["equals"]);
const encodableListOperators = new Set(["in", "notIn"]);

function encodeCriterionValue(token: string, value: unknown, state: ParseState): unknown {
  if (!isFormatCriterionValue(token, value)) {
    return invalidQuery(state, formatCriterionExpectation(token));
  }
  return encodeFormatValue(token, value);
}

export function scalarCriterionToWire(token: string, entry: unknown, state: ParseState): unknown {
  if (!isObject(entry) || nodeTypes.isDate(entry)) {
    return encodeCriterionValue(token, entry, state);
  }
  const operators: Array<readonly [string, unknown]> = [];
  for (const [operator, operand] of snapshotObject(entry, state)) {
    operators.push([
      operator,
      at(state, operator, () => {
        if (valueOperators.has(operator)) return encodeCriterionValue(token, operand, state);
        if (encodableListOperators.has(operator)) {
          return frozenArray(
            snapshotArray(operand, state).map((item, index) =>
              at(state, index, () => encodeCriterionValue(token, item, state)),
            ),
          );
        }
        // `mode` selects case folding; string operators and regex carry text
        // to search rather than a value in this field's decoded domain.
        return operand;
      }),
    ]);
  }
  return frozenRecord(operators);
}

/**
 * Spell a typed criteria value the way the row it will be compared against does.
 *
 * A caller writes `where({ active: true })` or passes an authenticated integer,
 * while a row holds `"1"` or `"2334787"`. Comparison uses that wire text.
 *
 * This is why the wire format did not need a second version. A stored
 * `WhereDocumentV1` still holds strings, and `criteriaFromWire` still reads
 * one; only the shapes a caller may write in TypeScript grew.
 */
export function criteriaToWireValues(
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
  const translated: Array<readonly [string, unknown]> = [];
  for (const [key, entry] of snapshotObject(value, state)) {
    translated.push([
      key,
      at(state, key, () => {
        const relation = relations.get(key);
        if (relation !== undefined && isObject(entry)) {
          const inner: Array<readonly [string, unknown]> = [];
          for (const [operator, nested] of snapshotObject(entry, state)) {
            inner.push([
              operator,
              at(state, operator, () =>
                criteriaToWireValues(relation.targetModel, nested, state, depth + 1),
              ),
            ]);
          }
          return frozenRecord(inner);
        }
        if (key === "AND" || key === "OR" || key === "NOT") {
          return snapshotArray(entry, state).map((child, index) =>
            at(state, index, () => criteriaToWireValues(model, child, state, depth + 1)),
          );
        }
        const token = tokens.get(key);
        if (token === undefined) return entry;
        return scalarCriterionToWire(token, entry, state);
      }),
    ]);
  }
  return frozenRecord(translated);
}
