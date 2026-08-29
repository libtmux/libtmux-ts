import { describe, expect, test } from "bun:test";

import {
  declarationClosureErrors,
  packageDeclarationExports,
} from "../../scripts/declaration-closure.js";

describe("published declaration closure", () => {
  test("accepts TypeScript's recursive graph when every declaration is exported", () => {
    expect(
      declarationClosureErrors(
        ["dist/index.d.ts", "dist/server.d.ts", "dist/types.d.ts"],
        ["./dist/index.d.ts", "./dist/server.d.ts", "./dist/types.d.ts"],
        ["dist/index.d.ts", "dist/server.d.ts", "dist/types.d.ts"],
      ),
    ).toEqual([]);
  });

  test("rejects a packed declaration hidden behind an unexported generated path", () => {
    expect(
      declarationClosureErrors(
        ["dist/index.d.ts", "dist/server.d.ts", "dist/generated/field_types.d.ts"],
        ["./dist/index.d.ts", "./dist/server.d.ts"],
        ["dist/index.d.ts", "dist/server.d.ts", "dist/generated/field_types.d.ts"],
      ),
    ).toEqual(["resolved declaration dist/generated/field_types.d.ts is not a package export"]);
  });

  test("rejects an exported declaration omitted from the packed artifact", () => {
    expect(
      declarationClosureErrors(
        ["dist/index.d.ts"],
        ["./dist/index.d.ts", "./dist/server.d.ts"],
        ["dist/index.d.ts"],
      ),
    ).toEqual([
      "package export dist/server.d.ts is not packed",
      "package export dist/server.d.ts was not resolved",
    ]);
  });

  test("rejects a resolver that returns no public declarations", () => {
    expect(
      declarationClosureErrors(
        ["dist/index.d.ts", "dist/server.d.ts"],
        ["./dist/index.d.ts", "./dist/server.d.ts"],
        [],
      ),
    ).toEqual([
      "package export dist/index.d.ts was not resolved",
      "package export dist/server.d.ts was not resolved",
    ]);
  });

  test("rejects a manifest with no declaration exports", () => {
    expect(declarationClosureErrors(["dist/index.d.ts"], [], [])).toEqual([
      "package has no declaration exports",
    ]);
  });

  test("extracts only declaration targets from conditional package exports", () => {
    expect(
      packageDeclarationExports({
        ".": {
          default: "./dist/index.js",
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
        "./package.json": "./package.json",
        "./server": {
          default: "./dist/server.js",
          import: "./dist/server.js",
          types: "./dist/server.d.ts",
        },
      }),
    ).toEqual(["dist/index.d.ts", "dist/server.d.ts"]);
  });
});
