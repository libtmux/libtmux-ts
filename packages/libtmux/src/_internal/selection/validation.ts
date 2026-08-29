import { types as nodeTypes } from "node:util";

import { QueryValidationError } from "../../exc.js";

export interface ParseState {
  readonly active: WeakSet<object>;
  /** Where in the criteria the parser currently is, for naming a failure. */
  readonly path: (string | number)[];
}

const maximumCriteriaKeyLength = 128;
export const maximumWhereDepth = 64;

export function newParseState(): ParseState {
  return { active: new WeakSet(), path: [] };
}

/** Run `read` one step deeper, and leave the path as it was however it ends. */
export function at<Value>(state: ParseState, segment: string | number, read: () => Value): Value {
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

export const quoted = (name: string): string => JSON.stringify(name);

export function listed(names: readonly string[]): string {
  return [...names].sort().map(quoted).join(", ");
}

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

/** Suggest nearby query keys instead of listing the complete vocabulary. */
export function nearest(name: string, known: readonly string[]): string {
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

/**
 * Refuse a query, naming where in it the problem is and what was expected.
 *
 * Criteria arrive as data — from an MCP client, a stored document, a form —
 * where the type system cannot have caught the mistake, so the message is the
 * only thing a caller has to go on. It names keys and expectations and never an
 * operand: these travel to whoever sent the query, and a criterion's value can
 * be a pane title or a path.
 */
export function invalidQuery(state: ParseState, reason: string, cause?: unknown): never {
  const where = state.path.length === 0 ? "" : ` at ${renderPath(state.path)}`;
  throw new QueryValidationError({
    ...(cause === undefined ? {} : { cause }),
    code: "invalid-query",
    message: `Invalid selection query${where}: ${reason}`,
    path: [...state.path],
  });
}

export function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

export function withActive<Value>(value: object, state: ParseState, read: () => Value): Value {
  if (state.active.has(value)) return invalidQuery(state, "the criteria refer to themselves");
  state.active.add(value);
  try {
    return read();
  } finally {
    state.active.delete(value);
  }
}

export function snapshotObject(value: unknown, state: ParseState): ReadonlyMap<string, unknown> {
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
      if (key.length > maximumCriteriaKeyLength) {
        return invalidQuery(
          state,
          `expected keys no longer than ${String(maximumCriteriaKeyLength)} code units`,
        );
      }
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

export function snapshotArray(value: unknown, state: ParseState): readonly unknown[] {
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
    const keys = new Set(Reflect.ownKeys(value));
    if (keys.size !== length + 1 || !keys.delete("length")) return invalidQuery(state, plain);
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.delete(key)) return invalidQuery(state, plain);
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

export function frozenRecord(
  entries: readonly (readonly [string, unknown])[],
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

export function frozenArray(values: readonly unknown[]): readonly unknown[] {
  return Object.freeze([...values]);
}
