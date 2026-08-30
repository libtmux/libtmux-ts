import {
  WHERE_FIELDS_V1,
  WHERE_RELATIONS_V1,
  type WhereModel,
} from "../../_generated/where_fields.js";
import type { WhereDocumentV1 } from "../../selection.js";
import { canonicalizeWhere, parseModel } from "./compile.js";
import { canonicalizeScalarCriterion } from "./scalar.js";
import {
  at,
  frozenArray,
  frozenRecord,
  invalidQuery,
  isObject,
  listed,
  maximumWhereDepth,
  newParseState,
  snapshotArray,
  snapshotObject,
  type ParseState,
} from "./validation.js";
import { scalarCriterionToWire } from "./wire.js";

interface CanonicalWireDocument {
  readonly model: WhereModel;
  readonly version: 1;
  readonly where: Readonly<Record<string, unknown>>;
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
    WHERE_FIELDS_V1[model].map(({ criteriaName, token, wireName }) => [
      wireName,
      { criteriaName, token },
    ]),
  );
  const relations = new Map(
    WHERE_RELATIONS_V1[model].map((relation) => [relation.name as string, relation] as const),
  );
  const translated: Array<readonly [string, unknown]> = [];
  const seen = new Set<string>();
  for (const [key, entry] of snapshotObject(value, state)) {
    const field = byWire.get(key);
    const translatedKey = field?.criteriaName ?? key;
    if (seen.has(translatedKey)) {
      return at(state, key, () =>
        invalidQuery(state, "the field is already present under its other spelling"),
      );
    }
    seen.add(translatedKey);
    translated.push([
      translatedKey,
      at(state, key, () => {
        const relation = relations.get(key);
        if (relation !== undefined && isObject(entry)) {
          const inner: Array<readonly [string, unknown]> = [];
          for (const [operator, nested] of snapshotObject(entry, state)) {
            inner.push([
              operator,
              at(state, operator, () =>
                criteriaFromWire(relation.targetModel, nested, state, depth + 1),
              ),
            ]);
          }
          return frozenRecord(inner);
        }
        if (key === "AND" || key === "OR" || key === "NOT") {
          return frozenArray(
            snapshotArray(entry, state).map((child, index) =>
              at(state, index, () => criteriaFromWire(model, child, state, depth + 1)),
            ),
          );
        }
        if (field !== undefined) {
          return canonicalizeScalarCriterion(
            field.token,
            scalarCriterionToWire(field.token, entry, state),
            state,
          );
        }
        return entry;
      }),
    ]);
  }
  return frozenRecord(translated);
}

function canonicalizeWhereDocumentForWire(
  input: unknown,
  state: ParseState,
): CanonicalWireDocument {
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
  return Object.freeze({ model, version: 1, where });
}

/** Validate authored or serialized criteria and return the stable wire form. */
function canonicalizeWhereDocumentWire(input: unknown): CanonicalWireDocument {
  return canonicalizeWhereDocumentForWire(input, newParseState());
}

/** Validate a document and return criteria with the public camelCase keys. */
function canonicalizeWhereDocument(input: unknown): WhereDocumentV1 {
  const state = newParseState();
  const wire = canonicalizeWhereDocumentForWire(input, state);
  const where = at(state, "where", () => criteriaFromWire(wire.model, wire.where, state));
  return Object.freeze({ model: wire.model, version: 1, where }) as WhereDocumentV1;
}

/**
 * Serializing a query that has already been validated.
 *
 * Reached only through {@link canonicalJson}, whose input is a parser's own
 * output, so these refusals describe a value this module built. They carry no
 * path because there is no caller's document to point into.
 */
const NOT_SERIALIZABLE = "the canonical query holds a value that cannot be written";
const maximumCanonicalJsonDepth = maximumWhereDepth * 2 + 4;

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

function canonicalJson(value: object): string {
  return canonicalJsonValue(value, 0, newParseState());
}

export function encodeWhereDocument(document: WhereDocumentV1): string {
  return canonicalJson(canonicalizeWhereDocumentWire(document));
}

export function decodeWhereDocument(input: unknown): WhereDocumentV1 {
  return canonicalizeWhereDocument(input);
}
