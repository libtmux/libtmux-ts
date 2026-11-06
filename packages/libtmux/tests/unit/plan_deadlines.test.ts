import { expect, test } from "bun:test";

import { withApplied } from "../../src/_internal/operations/pipeline.js";

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
