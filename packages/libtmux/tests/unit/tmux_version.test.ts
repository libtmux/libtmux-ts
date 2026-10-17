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

  test("parses nothing that tmux does not print", () => {
    for (const raw of [
      "master",
      "3.6a-master",
      "next-3.9-master",
      "next-3.7a",
      "3.4a-rc",
      "3.3a-dev",
      "openbsd-7.6",
    ]) {
      expect(() => parseTmuxVersion(raw), raw).toThrow("invalid tmux version");
    }
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
      "3.7-rc-junk",
      "3.7-rcx",
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

  /**
   * tmux ships a candidate as `3.8-rc`, and the version probe runs before the
   * first command, so a candidate has to parse. It ranks below the release it
   * names, like a `next-X.Y` build below its candidates, so a gate that asks
   * for a feature of 3.4 refuses `3.4-rc`.
   */
  test("ranks a release candidate below the release it precedes", () => {
    for (const raw of ["3.8-rc", "3.8-rc1"]) {
      const parsed = parseTmuxVersion(raw);
      expect(parsed, raw).toMatchObject({ major: 3, minor: 8, raw, suffix: "" });
      expect(tmuxVersionAtLeast(parsed, parseTmuxVersion("3.8")), `${raw} >= 3.8`).toBe(false);
      expect(tmuxVersionAtLeast(parsed, parseTmuxVersion("3.7a")), `${raw} >= 3.7a`).toBe(true);
    }
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.4-rc"), parseTmuxVersion("3.4"))).toBe(false);
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.7-rc2"), parseTmuxVersion("3.7"))).toBe(false);
    expect(tmuxVersionAtLeast(parseTmuxVersion("3.8-rc2"), parseTmuxVersion("3.7"))).toBe(true);
    expect(tmuxVersionAtLeast(parseTmuxVersion("next-3.9"), parseTmuxVersion("3.9"))).toBe(false);
  });
});
