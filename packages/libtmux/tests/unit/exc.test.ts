import { describe, expect, test } from "bun:test";

import {
  LibTmuxException,
  MultipleMatchesError,
  MultipleObjectsReturned,
  NoMatchError,
  ObjectDoesNotExist,
  QueryValidationError,
  TmuxObjectDoesNotExist,
} from "../../src/exc.js";

function nestedQuery(edges: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 0; index < edges; index += 1) {
    const child: Record<string, unknown> = {};
    current.AND = [child];
    current = child;
  }
  current.name = { regex: { flags: "", pattern: "^alpha$" } };
  return root;
}

function prefixedQueryCycle(edges: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 0; index < edges; index += 1) {
    const child: Record<string, unknown> = {};
    current.AND = [child];
    current = child;
  }
  current.AND = [root];
  return root;
}

function arrayQueryDepth(depth: number): Record<string, unknown> {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = [value];
  return { value };
}

describe("query exceptions", () => {
  test("preserve query, count, subcommand, message, and cause", () => {
    const cause = new Error("transport detail");
    const error = new MultipleObjectsReturned({
      cause,
      count: 2,
      query: { pane_id: "%3" },
      subcommand: "list-panes",
    });

    expect(error).toBeInstanceOf(LibTmuxException);
    expect(error.name).toBe("MultipleObjectsReturned");
    expect(error.count).toBe(2);
    expect(error.query).toEqual({ pane_id: "%3" });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Multiple objects returned (2): pane_id='%3'");
    expect(String(error)).toBe("list-panes: Multiple objects returned (2): pane_id='%3'");
  });

  test("keeps canonical query errors in the compatibility hierarchy", () => {
    expect(new NoMatchError({ query: { window_id: "@2" } })).toBeInstanceOf(ObjectDoesNotExist);
    expect(new MultipleMatchesError({ count: 2 })).toBeInstanceOf(MultipleObjectsReturned);
    expect(new TmuxObjectDoesNotExist()).toBeInstanceOf(ObjectDoesNotExist);
  });

  test("formats every valid depth-64 criterion without a depth sentinel", () => {
    const query = nestedQuery(64);
    const error = new NoMatchError({ query });

    expect(error.message).toBe(`No objects found: AND=${JSON.stringify(query.AND)}`);
    expect(error.message).not.toContain("[query value exceeds maximum depth]");
  });

  test("formats exactly 256 nested containers before using the depth sentinel", () => {
    const atLimit = new NoMatchError({ query: arrayQueryDepth(256) });
    const beyondLimit = new NoMatchError({ query: arrayQueryDepth(257) });

    expect(atLimit.message).not.toContain("[query value exceeds maximum depth]");
    expect(beyondLimit.message).toContain('"[query value exceeds maximum depth]"');
  });

  test("bounds deeply nested acyclic public query formatting", () => {
    const query = nestedQuery(20_000);
    const noMatch = new NoMatchError({ query });
    const multiple = new MultipleMatchesError({ count: 2, query });
    const formatted = noMatch.message.slice("No objects found: ".length);

    expect(noMatch.message).toContain('"[query value exceeds maximum depth]"');
    expect(noMatch.message.length).toBeLessThan(10_000);
    expect(multiple.message).toBe(`Multiple objects returned (2): ${formatted}`);
  });

  test("bounds deep prefixed cycles while retaining shallow cycle evidence", () => {
    const deep = new NoMatchError({ query: prefixedQueryCycle(20_000) });
    const shallow = new NoMatchError({ query: prefixedQueryCycle(32) });

    expect(deep.message).toContain('"[query value exceeds maximum depth]"');
    expect(deep.message.length).toBeLessThan(10_000);
    expect(shallow.message).toContain('"[circular query value]"');
    expect(shallow.message).not.toContain("[query value exceeds maximum depth]");
  });

  test("wraps validation failures behind a stable package error", () => {
    const cause = new Error("regex implementation detail");
    const error = new QueryValidationError({
      cause,
      code: "invalid-id",
      message: "Invalid pane ID",
    });

    expect(error.name).toBe("QueryValidationError");
    expect(error.code).toBe("invalid-id");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Invalid pane ID");
    expect(error.message).not.toContain("regex");
    expect(error.message).not.toContain("Zod");
  });
});
