import { describe, expect, test } from "bun:test";

import { compileWhere } from "../../src/_internal/selection/compile.js";
import { QueryValidationError } from "../../src/exc.js";

function refused(pattern: string, flags: "" | "ms" = ""): QueryValidationError {
  try {
    compileWhere("session", { name: { regex: { flags, pattern } } });
  } catch (error) {
    if (error instanceof QueryValidationError) return error;
    throw error;
  }
  throw new Error("the regular expression was accepted");
}

describe("selection regex work limit", () => {
  test("rejects patterns with attacker-controlled backtracking paths", () => {
    for (const [pattern, flags] of [
      ["^x|a+$", ""],
      ["^a+a+$", ""],
      ["^(a+)+$", ""],
      [`^${"(a|aa)".repeat(12)}!$`, ""],
      ["^.*X$", "ms"],
    ] as const) {
      const error = refused(pattern, flags);

      expect(error.code).toBe("invalid-query");
      expect(error.message).not.toContain(pattern);
    }
  });

  test("keeps fixed patterns and one anchored repetition", () => {
    for (const pattern of ["plain", "^(cat|dog)$", "^a+b$", "^[A-C]+$"]) {
      expect(() =>
        compileWhere("session", { name: { regex: { flags: "", pattern } } }),
      ).not.toThrow();
    }
  });

  test("rejects counted bounds outside the portable integer range", () => {
    for (const pattern of ["^a{2,1}$", "^a{99999999999999999999}$"]) {
      expect(refused(pattern).message).toContain("counted bounds must be ascending safe integers");
    }
  });
});
