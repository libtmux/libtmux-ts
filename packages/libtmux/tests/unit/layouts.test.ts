import { expect, test } from "bun:test";
import { layoutIsValid } from "../../src/_internal/operations/layout.js";
import { parseTmuxVersion } from "../../src/_internal/runtime/tmux_version.js";

type LayoutCase = {
  id: string;
  layout: string;
  pane_count: number;
  expected_valid: Record<string, boolean>;
};
const corpus = (await Bun.file(
  new URL("../fixtures/layout-preflight.json", import.meta.url),
).json()) as LayoutCase[];
const geometryErrors = new Set(["bad-inner-size", "nested-invalid-width", "nested-short-parent"]);

test.each(["3.2a", "3.3a", "3.7c"])("layout syntax corpus on tmux %s", (raw) => {
  const version = parseTmuxVersion(raw);
  for (const item of corpus) {
    const expected =
      item.layout !== "" && (item.expected_valid[raw] || geometryErrors.has(item.id));
    expect(layoutIsValid(item.layout, item.pane_count, version), item.id).toBe(expected);
  }
});

function serialized(body: string): string {
  let checksum = 0;
  for (const character of body)
    checksum = (((checksum >>> 1) | ((checksum & 1) << 15)) + character.charCodeAt(0)) & 0xffff;
  return `${checksum.toString(16).padStart(4, "0")},${body}`;
}

test("layout parser bounds unsigned fields and nesting", () => {
  const version = parseTmuxVersion("3.7c");
  const accepts = (body: string): boolean => layoutIsValid(serialized(body), 1, version);
  expect(accepts("4294967295x0,0,0,4294967295")).toBe(true);
  for (const body of [
    "4294967296x1,0,0",
    "1x1,0,4294967296",
    "1x1,0,0,4294967296",
    "١x1,0,0",
    "1x1,0,0{}",
    "1x1,0,0[]",
  ])
    expect(accepts(body), body).toBe(false);
  const nested = "1x1,0,0{".repeat(256) + "1x1,0,0" + "}".repeat(256);
  expect(accepts(nested)).toBe(true);
  expect(accepts("1x1,0,0{" + nested + "}")).toBe(false);
  expect(layoutIsValid("0".repeat(8193), 1, version)).toBe(false);
  for (const panes of [0, -1, 1.5, NaN, Infinity])
    expect(layoutIsValid("t", panes, version)).toBe(false);
});
