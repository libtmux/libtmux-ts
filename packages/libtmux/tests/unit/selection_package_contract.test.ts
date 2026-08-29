import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

interface PackageManifest {
  readonly exports: Readonly<Record<string, unknown>>;
  readonly files: readonly string[];
}

describe("selection package boundary", () => {
  test("exports the query codecs without shipping a Selection class", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;
    const rootModule = await import("../../src/index.js");
    const selectionModule = await import("../../src/selection.js");

    expect(Object.keys(rootModule)).toContain("Server");
    expect(Object.keys(rootModule)).not.toContain("Selection");
    expect(Object.keys(selectionModule).sort()).toEqual([
      "decodeWhereDocument",
      "encodeWhereDocument",
      "parseLegacyWhere",
    ]);
    expect(rootModule.decodeWhereDocument).toBe(selectionModule.decodeWhereDocument);
    expect(rootModule.encodeWhereDocument).toBe(selectionModule.encodeWhereDocument);
    expect(Reflect.get(selectionModule, "Selection")).toBeUndefined();
    expect(Object.keys(manifest.exports)).toContain("./selection");
    expect(manifest.files).toEqual([
      "CHANGELOG.md",
      "dist",
      "!dist/_internal/test",
      "src",
      "!src/_internal/test",
    ]);
  });
});
