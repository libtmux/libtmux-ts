type DataSnapshotResult<Value, Reason extends string> =
  | {
      readonly failure: { readonly cause?: unknown; readonly reason: Reason };
      readonly ok: false;
    }
  | { readonly ok: true; readonly value: Value };

type PlainDataRecordFailure =
  | "array"
  | "inspection"
  | "keys"
  | "not-object"
  | "property"
  | "prototype";
type OwnDataArrayFailure = "element" | "inspection" | "length" | "not-array";

function failed<Reason extends string>(
  reason: Reason,
  cause?: unknown,
): DataSnapshotResult<never, Reason> {
  return cause === undefined
    ? { failure: { reason }, ok: false }
    : { failure: { cause, reason }, ok: false };
}

export function snapshotPlainDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): DataSnapshotResult<Readonly<Record<string, unknown>>, PlainDataRecordFailure> {
  if (typeof value !== "object" || value === null) return failed("not-object");

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
  } catch (cause) {
    return failed("inspection", cause);
  }

  if (isArray) return failed("array");
  if (
    prototype !== finalPrototype ||
    (prototype !== Object.prototype && prototype !== null) ||
    (finalPrototype !== Object.prototype && finalPrototype !== null)
  ) {
    return failed("prototype");
  }

  const expectedKeySet = new Set(expectedKeys);
  const finalOwnKeySet = new Set(finalOwnKeys);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeySet.has(key)) ||
    ownKeys.length !== finalOwnKeys.length ||
    ownKeys.some((key) => !finalOwnKeySet.has(key))
  ) {
    return failed("keys");
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const [index, key] of expectedKeys.entries()) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return failed("property");
    }
    entries.push([key, descriptor.value]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

export function snapshotOwnDataArray(
  value: unknown,
): DataSnapshotResult<readonly unknown[], OwnDataArrayFailure> {
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
  } catch (cause) {
    return failed("inspection", cause);
  }

  if (!isArray) return failed("not-array");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    elementDescriptors.length !== lengthDescriptor.value
  ) {
    return failed("length");
  }

  const values: unknown[] = [];
  for (const descriptor of elementDescriptors) {
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return failed("element");
    }
    values.push(descriptor.value);
  }
  return { ok: true, value: values };
}
