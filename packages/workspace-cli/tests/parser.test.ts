import { describe, expect, test } from "bun:test";
import { createParser } from "../src/parser.ts";
import cases from "./fixtures/reference-cases.json" with { type: "json" };

function parse(argv: string[]) {
  const parser = createParser({ stdout: () => {}, stderr: () => {} });
  parser.command.parse(argv, { from: "user" });
  return parser.request();
}

describe("tmuxp argument compatibility", () => {
  for (const sample of cases) {
    test(JSON.stringify(sample.argv), () => {
      const parsed = parse(sample.argv);
      expect(parsed.command).toBe(sample.command.replace(/^tmuxp ?/, ""));
      expect(parsed.values).toMatchObject(sample.values);
    });
  }
  for (const argv of [
    ["load"],
    ["import", "teamocil"],
    ["import", "tmuxinator"],
    ["load", "a.yaml", "-2", "-8"],
    ["shell", "--code", "--ipython"],
    ["freeze", "-f", "toml"],
    ["load", "a.yaml", "--bogus"],
    ["load", "a.yaml", "--panel-lines", "no"],
  ])
    test(`rejects invalid argv: ${JSON.stringify(argv)}`, () => {
      expect(() => parse(argv)).toThrow();
    });
  const leaves = [...new Set(cases.map((c) => c.command))].filter(
    (name) => !["tmuxp", "tmuxp import"].includes(name),
  );
  for (const leaf of leaves) {
    const argv = cases.find((c) => c.command === leaf)!.argv;
    for (const flags of [["--json"], ["--ndjson"], ["--json", "--ndjson"]]) {
      for (const before of [true, false]) {
        test(`${leaf}: ${flags.join(" ")} ${before ? "before" : "after"}`, () => {
          expect(parse(before ? [...flags, ...argv] : [...argv, ...flags]).mode).toBe(
            flags.includes("--ndjson") ? "ndjson" : "json",
          );
        });
      }
    }
  }
  test("double dash preserves a hyphenated filename", () => {
    expect(parse(["load", "-d", "--", "--json"]).values.workspace_files).toEqual(["--json"]);
  });
});
