import { describe, expect, test } from "bun:test";

import { v, ValidationFailure } from "../../src/_internal/validate.js";

/**
 * The validator replaced Zod, so it carries what Zod carried: rejecting
 * malformed tmux output, and saying enough about the rejection to debug it.
 * These pin the behaviour the three call sites depend on.
 */

describe("string checks", () => {
  test("rejects a non-string, naming what arrived", () => {
    const result = v.string().safeParse(5);

    if (result.success) throw new Error("expected failure");
    expect(result.issues[0]).toMatchObject({
      code: "invalid_type",
      expected: "string",
      received: "5",
    });
  });

  test("reports the pattern in the reader's words, not as a regex", () => {
    const result = v
      .string()
      .regex(/^%\d+$/u, "a pane id like %0")
      .safeParse("nope");

    if (result.success) throw new Error("expected failure");
    // "expected a pane id like %0" beats "must match /^%\d+$/u" for anyone who
    // did not write the pattern.
    expect(result.issues[0]?.message).toBe('expected a pane id like %0, received "nope"');
  });

  test("applies a length floor and a refinement together", () => {
    const name = v
      .string()
      .min(1)
      .refine((value) => !/^[%$@]/u.test(value), "a client name without a tmux id sigil");

    expect(name.safeParse("/dev/pts/3").success).toBe(true);
    expect(name.safeParse("").success).toBe(false);
    expect(name.safeParse("%1").success).toBe(false);
  });

  test("accepts null only where nullable was asked for", () => {
    expect(v.string().nullable().safeParse(null).success).toBe(true);
    expect(v.string().safeParse(null).success).toBe(false);
  });
});

describe("strict objects", () => {
  const row = v.strictObject({
    pane_id: v.string(),
    pane_title: v.string().nullable(),
  });

  test("reports every bad field, not only the first", () => {
    const result = row.safeParse({ pane_id: 1, pane_title: 2 });

    if (result.success) throw new Error("expected failure");
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((issue) => issue.path.join("."))).toEqual(["pane_id", "pane_title"]);
  });

  test("rejects a key the schema does not declare", () => {
    // This is how a tmux build that reports a field this package does not know
    // gets caught, rather than silently ignored.
    const result = row.safeParse({ pane_id: "%1", pane_title: null, pane_future: "x" });

    if (result.success) throw new Error("expected failure");
    expect(result.issues[0]).toMatchObject({ code: "unrecognized_keys", received: "pane_future" });
  });

  test("rejects arrays and null, which are objects to typeof", () => {
    expect(row.safeParse([]).success).toBe(false);
    expect(row.safeParse(null).success).toBe(false);
  });
});

describe("records", () => {
  test("does not let an inherited key reach the result", () => {
    const parsed = v
      .record(v.unknown())
      .safeParse(JSON.parse('{"__proto__":{"polluted":1},"a":2}'));

    if (!parsed.success) throw new Error("expected success");
    expect(Object.getPrototypeOf(parsed.value)).toBeNull();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("discriminated unions", () => {
  const member = (model: "pane" | "session") =>
    v.strictObject({ model: v.literal(model), version: v.literal(1) });
  const document = v.discriminatedUnion(
    "model",
    [member("session"), member("pane")],
    ["session", "pane"],
  );

  test("names the discriminators it would have accepted", () => {
    const result = document.safeParse({ model: "window", version: 1 });

    if (result.success) throw new Error("expected failure");
    expect(result.issues[0]).toMatchObject({
      code: "invalid_union",
      expected: "model to be one of session | pane",
      path: ["model"],
    });
  });

  test("validates the member the discriminator selected", () => {
    const result = document.safeParse({ model: "pane", version: 2 });

    if (result.success) throw new Error("expected failure");
    expect(result.issues[0]).toMatchObject({ code: "invalid_literal", path: ["version"] });
  });
});

describe("failures", () => {
  test("throws one error carrying every issue, formatted per line", () => {
    const row = v.strictObject({ a: v.string(), b: v.string() });

    let thrown: unknown;
    try {
      row.parse({ a: 1, b: 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationFailure);
    const failure = thrown as ValidationFailure;
    expect(failure.issues).toHaveLength(2);
    expect(failure.format().split("\n")).toEqual([
      "a: expected string, received 1",
      "b: expected string, received 2",
    ]);
  });

  test("caps a long received value rather than pasting it into the message", () => {
    const result = v.string().regex(/^x$/u, "x").safeParse("y".repeat(500));

    if (result.success) throw new Error("expected failure");
    expect(result.issues[0]!.received.length).toBeLessThanOrEqual(60);
  });
});
