import { expect, test } from "bun:test";

import { tighterDeadline, withApplied } from "../../src/_internal/operations/pipeline.js";

test("the tighter deadline wins, and a plan's null never relaxes the batch's number", () => {
  expect(tighterDeadline(500, 2_000)).toBe(500);
  expect(tighterDeadline(2_000, 500)).toBe(500);
  expect(tighterDeadline(null, 500)).toBe(500);
  expect(tighterDeadline(500, null)).toBe(500);
});

test("null stands only when neither side names a number", () => {
  expect(tighterDeadline(null, undefined)).toBeNull();
  expect(tighterDeadline(undefined, null)).toBeNull();
  expect(tighterDeadline(undefined, undefined)).toBeUndefined();
  expect(tighterDeadline(undefined, 500)).toBe(500);
});

test("withApplied keeps the error's class and message, and tolerates frozen errors", () => {
  class Mine extends Error {}
  const error = withApplied(new Mine("boom"), 3);
  expect(error).toBeInstanceOf(Mine);
  expect(error.message).toBe("boom");
  expect((error as { applied?: number }).applied).toBe(3);
  expect(Object.keys(error)).not.toContain("applied");
  const frozen = Object.freeze(new Error("frozen"));
  expect(withApplied(frozen, 1)).toBe(frozen);
  expect(withApplied("text", 1)).toBe("text");
});
