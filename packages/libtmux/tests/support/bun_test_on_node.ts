/**
 * `bun:test` on Node, through vitest.
 *
 * The Node lane aliases `bun:test` here so one set of suites runs on both
 * runtimes. vitest supplies the jest-shaped core; the six matchers bun:test
 * adds on top of it are filled in with bun:test's meaning, so a test reads the
 * same whichever runtime runs it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

function isEmpty(value: unknown): boolean {
  if (typeof value === "string" || Array.isArray(value) || ArrayBuffer.isView(value)) {
    return (value as { length: number }).length === 0;
  }
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  if (value !== null && typeof value === "object") {
    if (Symbol.iterator in value)
      return (value as Iterable<unknown>)[Symbol.iterator]().next().done === true;
    return Object.keys(value).length === 0;
  }
  return false;
}

function verdict(pass: boolean, what: string, received: unknown) {
  return {
    message: () => `expected ${JSON.stringify(received)} ${pass ? "not " : ""}${what}`,
    pass,
  };
}

expect.extend({
  toBeArray: (received: unknown) => verdict(Array.isArray(received), "to be an array", received),
  toBeEmpty: (received: unknown) => verdict(isEmpty(received), "to be empty", received),
  toBeString: (received: unknown) =>
    verdict(typeof received === "string", "to be a string", received),
  toBeTrue: (received: unknown) => verdict(received === true, "to be true", received),
  toEndWith: (received: unknown, suffix: string) =>
    verdict(
      typeof received === "string" && received.endsWith(suffix),
      `to end with ${suffix}`,
      received,
    ),
  toStartWith: (received: unknown, prefix: string) =>
    verdict(
      typeof received === "string" && received.startsWith(prefix),
      `to start with ${prefix}`,
      received,
    ),
});

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test };
