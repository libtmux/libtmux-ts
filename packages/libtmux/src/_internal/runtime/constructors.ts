import type { ModelKind } from "./model_kind.js";

export type RuntimeConstructors = Readonly<Record<ModelKind, object>>;

const constructors = new WeakMap<object, RuntimeConstructors>();

export function registerRuntimeConstructors(owner: object, value: RuntimeConstructors): void {
  if (constructors.has(owner)) throw new TypeError("runtime constructors are already registered");
  constructors.set(owner, Object.freeze({ ...value }));
}

export function runtimePrototype(owner: object, model: ModelKind): object {
  const prototype = constructors.get(owner)?.[model];
  if (prototype === undefined) {
    throw new TypeError("runtime constructors are not registered");
  }
  return prototype;
}
