import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { layoutIsValid } from "../../src/_internal/operations/layout.js";
import { parseTmuxVersion } from "../../src/_internal/runtime/tmux_version.js";

type LayoutCase = {
  id: string;
  layout: string;
  pane_count: number;
  expected_valid: Record<string, boolean>;
};
const corpus = JSON.parse(
  await readFile(new URL("../fixtures/layout-preflight.json", import.meta.url), "utf8"),
) as LayoutCase[];
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
  expect(accepts("10000x10000,0,0,4294967295")).toBe(true);
  for (const body of [
    "4294967295x0,0,0,4294967295",
    "10001x1,0,0",
    "1x10001,0,0",
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

test("JSON layout preflight checks the version, pane count and native structure", () => {
  const pane = { t: "p", w: 40, h: 24, x: 0, y: 0, i: 0 };
  const layout = {
    V: 2,
    L: { t: "h", w: 81, h: 24, x: 0, y: 0, c: [pane, { ...pane, x: 41, i: 1 }] },
  };
  const encoded = JSON.stringify(layout);
  for (const raw of ["3.2a", "3.7c", "next-3.8"])
    expect(layoutIsValid(encoded, 2, parseTmuxVersion(raw)), raw).toBe(false);
  const version = parseTmuxVersion("3.8-rc");
  expect(layoutIsValid(encoded, 2, version)).toBe(true);
  expect(layoutIsValid(encoded, 1, version)).toBe(true);
  expect(layoutIsValid(encoded, 3, version)).toBe(false);
  for (const invalid of [
    encoded.replace('"V":2', '"V":2e0'),
    encoded.replace('"V":2', '"V":2.0'),
    encoded.replace('"V":2', '"V":2,"V":2'),
    encoded.replace('"V":2', '"\\u0056":2'),
    encoded.replace('"t":"p"', '"t":"\\u0070"'),
    encoded.replace('"V":2', '"extra":null,"V":2'),
    encoded.replace('"V":2', '"extra":"","V":2'),
    encoded.replace('"V":2', '"extra":[1],"V":2'),
  ])
    expect(layoutIsValid(invalid, 1, version), invalid).toBe(false);
  for (const invalid of [
    { V: 3, L: pane },
    { V: 2, L: { ...pane, t: "unknown" } },
    { V: 2, L: { ...pane, w: 10_001 } },
    { V: 2, L: { ...pane, h: 0 } },
    { V: 2, L: { ...pane, x: -10_001 } },
    { V: 2, L: { ...pane, i: 1.5 } },
    { V: 2, L: { ...pane, i: -1 } },
    { V: 2, L: { ...pane, c: [] } },
    { V: 2, L: { ...layout.L, c: [pane] } },
    { V: 2, L: { ...layout.L, c: [pane, pane] } },
    {
      V: 2,
      L: {
        ...layout.L,
        c: [
          { ...pane, a: true },
          { ...pane, i: 1, a: true },
        ],
      },
    },
    {
      V: 2,
      L: {
        ...layout.L,
        c: [
          { ...pane, l: 0 },
          { ...pane, i: 1, l: 0 },
        ],
      },
    },
    {
      V: 2,
      L: {
        ...layout.L,
        c: [
          { ...pane, z: 0 },
          { ...pane, i: 1, z: 0 },
        ],
      },
    },
    { V: 2, L: { ...pane, a: "true" } },
  ])
    expect(layoutIsValid(JSON.stringify(invalid), 1, version), JSON.stringify(invalid)).toBe(false);
});
