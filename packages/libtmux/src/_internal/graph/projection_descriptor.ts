import {
  WHERE_FIELDS_V1,
  type WhereField,
  type WhereModel,
} from "../../_generated/where_fields.js";
import { snapshotOwnDataArray, snapshotPlainDataRecord } from "./data_snapshot.js";
import type { GraphSource } from "./model.js";

export interface ProjectionRelationRequirement {
  readonly cardinality: "many" | "one";
  readonly name: string;
  readonly targetModel: WhereModel;
}

export interface ProjectionDescriptor {
  readonly fields: readonly WhereField[];
  readonly model: WhereModel;
  readonly relations: readonly ProjectionRelationRequirement[];
}

export type DescriptorSnapshots = Readonly<Record<WhereModel, ProjectionDescriptor>>;

export function invalidProjection(message: string, cause?: unknown): never {
  throw cause === undefined ? new Error(message) : new Error(message, { cause });
}

export function readStrictDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  const snapshot = snapshotPlainDataRecord(value, expectedKeys);
  if (snapshot.ok) return snapshot.value;

  switch (snapshot.failure.reason) {
    case "not-object":
      return invalidProjection(`${label} must be an object`);
    case "array":
    case "prototype":
      return invalidProjection(`${label} must be a plain data object`);
    case "inspection":
      return invalidProjection(`${label} could not be inspected`, snapshot.failure.cause);
    case "keys":
      return invalidProjection(`${label} has invalid keys`);
    case "property":
      return invalidProjection(`${label} must contain enumerable data properties`);
  }
}

export function snapshotDataArray(value: unknown, label: string): readonly unknown[] {
  const snapshot = snapshotOwnDataArray(value);
  if (snapshot.ok) return snapshot.value;

  switch (snapshot.failure.reason) {
    case "not-array":
      return invalidProjection(`${label} must be an array`);
    case "inspection":
      return invalidProjection(`${label} could not be inspected`, snapshot.failure.cause);
    case "length":
      return invalidProjection(`${label} must have a valid array length`);
    case "element":
      return invalidProjection(`${label} must contain own enumerable data elements`);
  }
}

export function isWhereModel(value: unknown): value is WhereModel {
  return value === "session" || value === "window" || value === "pane" || value === "client";
}

function snapshotDescriptor(model: WhereModel, value: unknown): ProjectionDescriptor {
  const descriptor = readStrictDataRecord(
    value,
    ["fields", "model", "relations"],
    `${model} descriptor`,
  );
  if (descriptor.model !== model) {
    return invalidProjection(`${model} descriptor model does not match its key`);
  }

  const fields: WhereField[] = [];
  const seenTokens = new Set<string>();
  const seenWireNames = new Set<string>();
  for (const value of snapshotDataArray(descriptor.fields, `${model} descriptor fields`)) {
    const field = readStrictDataRecord(
      value,
      ["criteriaName", "domain", "since", "token", "wireName"],
      `${model} field`,
    );
    if (
      typeof field.domain !== "string" ||
      typeof field.token !== "string" ||
      typeof field.wireName !== "string" ||
      typeof field.criteriaName !== "string" ||
      typeof field.since !== "string"
    ) {
      return invalidProjection(`${model} field is invalid`);
    }
    if (seenTokens.has(field.token)) {
      return invalidProjection(`${model} descriptor has a duplicate field token`);
    }
    if (seenWireNames.has(field.wireName)) {
      return invalidProjection(`${model} descriptor has a duplicate field wire name`);
    }
    const canonical = WHERE_FIELDS_V1[model].find(
      ({ criteriaName, domain, since, token, wireName }) =>
        domain === field.domain &&
        token === field.token &&
        wireName === field.wireName &&
        criteriaName === field.criteriaName &&
        since === field.since,
    );
    if (canonical === undefined) {
      return invalidProjection(`${model} field does not belong to the generated descriptor`);
    }
    seenTokens.add(canonical.token);
    seenWireNames.add(canonical.wireName);
    fields.push(
      Object.freeze({
        criteriaName: canonical.criteriaName,
        domain: canonical.domain,
        since: canonical.since,
        token: canonical.token,
        wireName: canonical.wireName,
      }),
    );
  }

  const relations: ProjectionRelationRequirement[] = [];
  const seenRelationNames = new Set<string>();
  for (const value of snapshotDataArray(descriptor.relations, `${model} descriptor relations`)) {
    const relation = readStrictDataRecord(
      value,
      ["cardinality", "name", "targetModel"],
      `${model} relation`,
    );
    if (typeof relation.name !== "string" || relation.name.length === 0) {
      return invalidProjection(`${model} relation name must be a nonempty string`);
    }
    if (seenRelationNames.has(relation.name)) {
      return invalidProjection(`${model} descriptor has a duplicate relation name`);
    }
    if (relation.cardinality !== "one" && relation.cardinality !== "many") {
      return invalidProjection(`${model} relation cardinality is invalid`);
    }
    if (!isWhereModel(relation.targetModel)) {
      return invalidProjection(`${model} relation target model is invalid`);
    }
    seenRelationNames.add(relation.name);
    relations.push(
      Object.freeze({
        cardinality: relation.cardinality,
        name: relation.name,
        targetModel: relation.targetModel,
      }),
    );
  }

  return Object.freeze({
    fields: Object.freeze(fields),
    model,
    relations: Object.freeze(relations),
  });
}

export function snapshotDescriptors(value: unknown): DescriptorSnapshots {
  const descriptors = readStrictDataRecord(
    value,
    ["client", "pane", "session", "window"],
    "projection descriptors",
  );
  return Object.freeze({
    client: snapshotDescriptor("client", descriptors.client),
    pane: snapshotDescriptor("pane", descriptors.pane),
    session: snapshotDescriptor("session", descriptors.session),
    window: snapshotDescriptor("window", descriptors.window),
  });
}

export function rootModel(source: GraphSource): WhereModel {
  switch (source.listCommand) {
    case "list-clients":
      return "client";
    case "list-panes":
      return "pane";
    case "list-sessions":
      return "session";
    case "list-windows":
      return "window";
  }
}
