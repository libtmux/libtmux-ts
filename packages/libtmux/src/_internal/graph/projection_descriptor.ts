import {
  WHERE_FIELDS_V1,
  type WhereField,
  type WhereModel,
} from "../../_generated/where_fields.js";
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
  if (typeof value !== "object" || value === null) {
    return invalidProjection(`${label} must be an object`);
  }

  let isArray: boolean;
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  let descriptors: readonly (PropertyDescriptor | undefined)[];
  let finalPrototype: object | null;
  let finalOwnKeys: readonly PropertyKey[];
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = expectedKeys.map((key) => Object.getOwnPropertyDescriptor(value, key));
    finalPrototype = Object.getPrototypeOf(value);
    finalOwnKeys = Reflect.ownKeys(value);
  } catch (error) {
    return invalidProjection(`${label} could not be inspected`, error);
  }

  if (
    isArray ||
    prototype !== finalPrototype ||
    (prototype !== Object.prototype && prototype !== null) ||
    (finalPrototype !== Object.prototype && finalPrototype !== null)
  ) {
    return invalidProjection(`${label} must be a plain data object`);
  }
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    ownKeys.length !== finalOwnKeys.length ||
    ownKeys.some((key) => !finalOwnKeys.includes(key))
  ) {
    return invalidProjection(`${label} has invalid keys`);
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const [index, key] of expectedKeys.entries()) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return invalidProjection(`${label} must contain enumerable data properties`);
    }
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

export function snapshotDataArray(value: unknown, label: string): readonly unknown[] {
  let isArray: boolean;
  let lengthDescriptor: PropertyDescriptor | undefined;
  const elementDescriptors: Array<PropertyDescriptor | undefined> = [];
  try {
    isArray = Array.isArray(value);
    if (isArray) {
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (typeof length === "number" && Number.isSafeInteger(length) && length >= 0) {
        for (let index = 0; index < length; index += 1) {
          elementDescriptors.push(Object.getOwnPropertyDescriptor(value, String(index)));
        }
      }
    }
  } catch (error) {
    return invalidProjection(`${label} could not be inspected`, error);
  }

  if (!isArray) return invalidProjection(`${label} must be an array`);
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    elementDescriptors.length !== lengthDescriptor.value
  ) {
    return invalidProjection(`${label} must have a valid array length`);
  }

  const values: unknown[] = [];
  for (const descriptor of elementDescriptors) {
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return invalidProjection(`${label} must contain own enumerable data elements`);
    }
    values.push(descriptor.value);
  }
  return values;
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
