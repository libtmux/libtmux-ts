import { describe, expect, test } from "bun:test";

import {
  bunFromPackageManager,
  checkBunVersionAgreement,
  extractVersionLiterals,
  type BunVersionSources,
} from "../../../../scripts/bun_version_pins.js";

const agreeing: BunVersionSources = {
  contributingPin: ["1.4.2", "1.3.14", "1.4.0"],
  corpus: ["1.3.14", "1.4.0", "1.4.2"],
  engines: [
    { path: "package.json", spec: ">=1.3.14" },
    { path: "packages/libtmux/package.json", spec: ">=1.3.14" },
  ],
  matrix: ["1.3.14", "1.4.0", "1.4.2"],
  packageManager: "1.4.2",
};

describe("extractVersionLiterals", () => {
  test("finds every X.Y.Z literal, in order, ignoring surrounding prose", () => {
    expect(
      extractVersionLiterals("Bun 1.4.2 `packageManager` pin; the 1.3.14 floor; no version here."),
    ).toEqual(["1.4.2", "1.3.14"]);
    expect(extractVersionLiterals("nothing to see")).toEqual([]);
  });
});

describe("bunFromPackageManager", () => {
  test("reads the pinned version out of a bun@ packageManager field", () => {
    expect(bunFromPackageManager("bun@1.4.2")).toBe("1.4.2");
  });

  test("refuses a packageManager field that does not pin bun", () => {
    expect(bunFromPackageManager("npm@10.0.0")).toBeUndefined();
    expect(bunFromPackageManager("bun@latest")).toBeUndefined();
    expect(bunFromPackageManager("")).toBeUndefined();
  });
});

describe("checkBunVersionAgreement", () => {
  test("finds nothing to report when all five sources agree", () => {
    expect(checkBunVersionAgreement(agreeing)).toEqual([]);
  });

  test("catches the gates matrix recording a Bun the regex corpus does not", () => {
    const failures = checkBunVersionAgreement({ ...agreeing, corpus: ["1.3.14", "1.4.0"] });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("regex corpus records Bun");
  });

  test("catches CONTRIBUTING naming a Bun the gates matrix does not run", () => {
    const failures = checkBunVersionAgreement({
      ...agreeing,
      contributingPin: ["1.3.14", "1.4.0"],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("packageManager-pin paragraph names Bun");
  });

  test("catches a packageManager pin the gates matrix does not run", () => {
    const failures = checkBunVersionAgreement({ ...agreeing, packageManager: "1.4.3" });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("does not run");
  });

  test("catches a packageManager pin that is not the newest tested Bun", () => {
    const failures = checkBunVersionAgreement({ ...agreeing, packageManager: "1.4.0" });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("newest tested Bun");
  });

  test("catches a manifest's engines.bun floor drifting from the matrix floor", () => {
    const failures = checkBunVersionAgreement({
      ...agreeing,
      engines: [{ path: "packages/mcp/package.json", spec: ">=1.4.0" }],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("packages/mcp/package.json");
    expect(failures[0]).toContain("engines.bun requires >=1.4.0");
  });

  test("catches an engines.bun field that is not a >=X.Y.Z floor", () => {
    const failures = checkBunVersionAgreement({
      ...agreeing,
      engines: [{ path: "packages/workspace/package.json", spec: "1.3.14" }],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("not a >=X.Y.Z floor");
  });
});
