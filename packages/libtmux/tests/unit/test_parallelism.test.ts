import { describe, expect, test } from "bun:test";

import { testParallelism } from "../../src/_internal/test/testkit.js";

describe("test runner parallelism", () => {
  test("defaults to four and accepts a constrained-machine override", () => {
    expect(testParallelism({})).toBe(4);
    expect(testParallelism({ LIBTMUX_TEST_PARALLEL: "2" })).toBe(2);
  });

  test.each(["", "0", "-1", "1.5", "four"])("rejects %j before spawning Bun", (value) => {
    expect(() => testParallelism({ LIBTMUX_TEST_PARALLEL: value })).toThrow(
      "LIBTMUX_TEST_PARALLEL must be a positive integer",
    );
  });
});
