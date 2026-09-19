import { describe, expect, test } from "bun:test";

import {
  compareTmuxVersions,
  parseTmuxVersion,
  tmuxVersionAtLeast,
  tmuxVersionIsExact,
} from "../../src/_internal/runtime/tmux_version.js";

describe("tmux versions", () => {
  test("orders final and lettered releases chronologically", () => {
    const versions = ["3.10", "3.7b", "3.7", "3.7a", "3.6a"]
      .map(parseTmuxVersion)
      .sort(compareTmuxVersions)
      .map(({ raw }) => raw);

    expect(versions).toEqual(["3.6a", "3.7", "3.7a", "3.7b", "3.10"]);
  });

  test("retains a frozen normalized representation", () => {
    const version = parseTmuxVersion("3.7b");

    expect(version).toEqual({ major: 3, minor: 7, raw: "3.7b", suffix: "b" });
    expect(Object.isFrozen(version)).toBe(true);
  });

  test("lets an untargeted development build outrank every tagged release", () => {
    const latestTagged = parseTmuxVersion("99.9z");

    // Bare "master", or "<tag>-master", names no release it is heading
    // toward, so nothing bounds it.
    expect(compareTmuxVersions(parseTmuxVersion("master"), latestTagged)).toBeGreaterThan(0);
    expect(compareTmuxVersions(parseTmuxVersion("3.6a-master"), latestTagged)).toBeGreaterThan(0);
    expect(parseTmuxVersion("3.6a-master").raw).toBe("3.6a-master");
  });

  test("parses every shape it is willing to rank", () => {
    // A version this file ranks has to be one it can also read: `-master`
    // and `next-` are stripped independently, in the order classification
    // tests them, so a string carrying both parses and ranks consistently.
    // No tmux emits this shape.
    const both = parseTmuxVersion("next-3.9-master");

    expect(both).toMatchObject({ major: 3, minor: 9, raw: "next-3.9-master" });
    // `-master` wins, as the classification says: a build naming no release
    // it is heading toward, so nothing bounds it.
    expect(compareTmuxVersions(both, parseTmuxVersion("99.9z"))).toBeGreaterThan(0);
  });

  test("bounds a named-next build to the release it names", () => {
    // `next-X.Y` is a real tmux version string: a build heading toward
    // release X.Y, which it has not shipped. It ranks above the release
    // before it and below the one it names — not above every tagged
    // release, which is what unconditionally ranking every development
    // build above every tagged release would give it.
    expect(parseTmuxVersion("next-3.8")).toMatchObject({ major: 3, minor: 8, suffix: "" });

    expect(tmuxVersionAtLeast(parseTmuxVersion("next-3.9"), parseTmuxVersion("3.8"))).toBe(true);
    expect(tmuxVersionAtLeast(parseTmuxVersion("next-3.9"), parseTmuxVersion("3.9"))).toBe(false);
  });

  test("does not let a named-next build leak past the release it names", () => {
    // A fix that only special-cases "next-X.Y equals tagged X.Y" still gets
    // this wrong: it would leave next-3.9 outranking a later, unrelated
    // release like 4.0, or next-3.8 outranking 99.9z.
    expect(tmuxVersionAtLeast(parseTmuxVersion("next-3.9"), parseTmuxVersion("4.0"))).toBe(false);
    expect(
      compareTmuxVersions(parseTmuxVersion("next-3.8"), parseTmuxVersion("99.9z")),
    ).toBeLessThan(0);
  });

  test("compares a named-next build's suffix before its development kind", () => {
    // The parser also admits a lettered target, such as "next-3.7a": it
    // still precedes the exact release it names but follows the plain
    // release before it. Comparing development-ness before the suffix
    // (rather than after) would rank this below "3.7" too.
    expect(
      compareTmuxVersions(parseTmuxVersion("next-3.7a"), parseTmuxVersion("3.7")),
    ).toBeGreaterThan(0);
    expect(
      compareTmuxVersions(parseTmuxVersion("next-3.7a"), parseTmuxVersion("3.7a")),
    ).toBeLessThan(0);
  });

  /**
   * tmux ships a candidate as `3.8-rc`. It ranks as the release it names, not
   * below it: `3.8-rc` dumps the v2 JSON layout that arrived in 3.8, so a
   * gate asking whether this tmux has a 3.8 feature has to answer yes. That
   * is what separates a candidate from a `next-X.Y` build, which sits
   * somewhere in the cycle and may predate any of it.
   */
  test("ranks a release candidate as the release it is frozen at", () => {
    for (const raw of ["3.8-rc", "3.8-rc1", "3.0-rc3"]) {
      expect(parseTmuxVersion(raw), raw).toMatchObject({ raw, suffix: "" });
    }
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.8-rc"), parseTmuxVersion("3.8"))).toBe(true);
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.8-rc"), parseTmuxVersion("3.9"))).toBe(false);
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.0-rc3"), parseTmuxVersion("3.0"))).toBe(true);
    // A mid-cycle build still ranks below the release it names.
    expect(tmuxVersionAtLeast(parseTmuxVersion("next-3.9"), parseTmuxVersion("3.9"))).toBe(false);
  });

  test("carries ordinary version floors into later patch releases", () => {
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.7"), parseTmuxVersion("3.7"))).toBe(true);
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.7a"), parseTmuxVersion("3.7"))).toBe(true);
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.7b"), parseTmuxVersion("3.7"))).toBe(true);
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.6a"), parseTmuxVersion("3.7"))).toBe(false);
  });

  test("keeps exact-version quirks exact", () => {
    const quirkVersion = parseTmuxVersion("3.7");

    expect(tmuxVersionIsExact(parseTmuxVersion("3.7"), quirkVersion)).toBe(true);
    expect(tmuxVersionIsExact(parseTmuxVersion("3.7a"), quirkVersion)).toBe(false);
    expect(tmuxVersionIsExact(parseTmuxVersion("3.7b"), quirkVersion)).toBe(false);
  });

  test("rejects noncanonical or incomplete versions", () => {
    for (const value of [
      "3",
      "3.7aa",
      "3.7-rc0",
      "3.7-rc1-junk",
      "v3.7",
      "tmux 3.7",
      "3.7 ",
      " 3.7",
      "masterpiece",
      "3.7-master-junk",
      "next-3.8-junk",
    ]) {
      expect(() => parseTmuxVersion(value)).toThrow("invalid tmux version");
    }
  });
});
