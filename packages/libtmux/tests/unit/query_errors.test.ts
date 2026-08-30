/**
 * What a refused query tells the person who wrote it.
 *
 * Criteria are data, so they arrive from places the type system never sees — an
 * MCP client, a stored document, a form. There the message is the whole of what
 * a caller has to work with, and "Invalid selection query" names neither the
 * field, the reason, nor the vocabulary that would have worked.
 *
 * Two rules the assertions here hold to. The path is structured as well as
 * rendered, so a caller can point at the offending field rather than parse a
 * sentence. And no operand is ever quoted back: a criterion's value can be a
 * pane title or a path, and these messages travel to whoever sent the query.
 */

import { describe, expect, test } from "bun:test";

import { compileWhere } from "../../src/_internal/selection/compile.js";
import { QueryValidationError } from "../../src/exc.js";

function refusal(model: string, criteria: unknown): QueryValidationError {
  try {
    compileWhere(model as never, criteria);
  } catch (error) {
    if (error instanceof QueryValidationError) return error;
    throw error;
  }
  throw new Error("the query was accepted");
}

describe("a refused query", () => {
  test("names the quantifier a relation takes", () => {
    // Reaching for `any` is the natural mistake: it is the word most other
    // query languages use for what this calls `some`.
    const error = refusal("session", { windows: { any: { name: "build" } } });

    expect(error.path).toEqual(["windows", "any"]);
    expect(error.message).toContain("at windows.any");
    expect(error.message).toContain(`"every", "none", "some"`);
  });

  test("distinguishes a relation holding one from one holding many", () => {
    const error = refusal("window", { session: { some: { name: "work" } } });

    expect(error.message).toContain("holds one");
    expect(error.message).toContain(`"is", "isNot"`);
  });

  test("suggests the field a near miss was reaching for", () => {
    for (const wrong of ["nmae", "Name", "names"]) {
      const error = refusal("window", { [wrong]: "build" });
      expect(error.path).toEqual([wrong]);
      expect(error.message).toContain(`did you mean "name"`);
    }
  });

  test("offers a relation to a caller who wrote a field, and the reverse", () => {
    expect(refusal("session", { window: { is: { name: "a" } } }).message).toContain(
      `did you mean "windows"`,
    );
  });

  test("lists the operator vocabulary, which is small enough to read", () => {
    const error = refusal("window", { name: { startswith: "log" } });

    expect(error.path).toEqual(["name", "startswith"]);
    for (const operator of [
      "contains",
      "endsWith",
      "equals",
      "in",
      "notIn",
      "regex",
      "startsWith",
    ]) {
      expect(error.message).toContain(operator);
    }
    expect(error.message).toContain(`did you mean "startsWith"`);
  });

  test("says a regex needs a pattern and flags rather than a bare string", () => {
    const error = refusal("window", { name: { regex: "^build$" } });

    expect(error.path).toEqual(["name", "regex"]);
    expect(error.message).toContain("pattern and flags");
    // The pattern is the caller's data and stays out of the message.
    expect(error.message).not.toContain("build");
  });

  test("names where a regular expression stopped making sense, not what it was", () => {
    const error = refusal("window", { name: { regex: { flags: "", pattern: "(secret" } } });

    // The offset is where the pattern ran out, not where the group opened.
    expect(error.message).toContain("offset 7");
    expect(error.message).toContain("never closed");
    expect(error.message).not.toContain("secret");
  });

  test("explains that case folding is not a criterion on its own", () => {
    expect(refusal("window", { name: { mode: "insensitive" } }).message).toContain(
      "matches nothing alone",
    );
  });

  test("points into an array by index", () => {
    const error = refusal("window", { OR: [{ name: "a" }, { nmae: "b" }] });

    expect(error.path).toEqual(["OR", 1, "nmae"]);
    expect(error.message).toContain("at OR[1].nmae");
  });

  test("points through a relation into the model on its far side", () => {
    const error = refusal("session", {
      windows: { some: { panes: { every: { currentCommand: { in: [1] } } } } },
    });

    expect(error.path).toEqual(["windows", "some", "panes", "every", "currentCommand", "in", 0]);
    expect(error.message).toContain("expected a string");
  });

  test("keeps an operand out of the message whatever its shape", () => {
    for (const criteria of [
      { name: { contains: 5 } },
      { name: { equals: { secret: "value" } } },
      { name: { in: [{ secret: 1 }] } },
      { index: { equals: { secret: "value" } } },
    ]) {
      expect(refusal("window", criteria).message).not.toContain("secret");
    }
  });

  test("names the model when the criteria are not criteria at all", () => {
    expect(refusal("window", "build").message).toContain("window criteria");
    expect(refusal("window", "build").path).toEqual([]);
  });

  test("keeps the code every caller already switches on", () => {
    expect(refusal("window", { nmae: "x" }).code).toBe("invalid-query");
  });
});
