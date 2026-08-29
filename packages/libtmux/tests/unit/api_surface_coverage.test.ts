import { describe, expect, test } from "bun:test";

import {
  requireSymbolExamples,
  readApiSurface,
  type PublicMember,
} from "../../scripts/api_surface.js";
import * as index from "../../src/index.js";

/**
 * The API surface reader sees every handle the package exports.
 *
 * Three gates read it and all three protect what it found: the reference is
 * generated from it, every member it reports must carry an example, and every
 * example it reports must run against tmux. None of them protects that it
 * found everything — and `check-symbol-examples.ts` says so itself, one file
 * over: "a member the parser fails to see is silently exempt, which is the
 * quietest way for this check to stop meaning anything."
 *
 * So a handle class added in a file `SOURCES` does not list would be exempt
 * from documentation, from needing an example, and from running one, with
 * every gate still green. This is the assertion that notices.
 *
 * Errors are deliberately outside it. `SOURCES` is "the handle classes a
 * consumer actually holds", and an exception is not one — which is a rule
 * about what a class *is*, so it is read from the class rather than from a
 * second list that would drift the way the first one could.
 */

function isError(value: unknown): boolean {
  let prototype: unknown = value;
  while (typeof prototype === "function") {
    if (prototype === Error) return true;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

describe("api surface coverage", () => {
  test("rejects every public member missing an example", () => {
    const members: readonly PublicMember[] = [
      {
        example: undefined,
        file: "src/window.ts",
        kind: "method",
        line: 160,
        name: "showHooks",
        owner: "Window",
        prose: "Read hooks set on this window itself.",
        signature: "showHooks(): Promise<ReadonlyMap<string, readonly string[]>>",
      },
    ];

    expect(() => requireSymbolExamples(members)).toThrow("src/window.ts:160  Window.showHooks");
  });

  test("every handle class the package exports is read by the surface", async () => {
    const parsed = new Set((await readApiSurface()).map((entry) => entry.name));
    const handles = Object.entries(index)
      .filter(([, value]) => typeof value === "function" && !isError(value))
      .filter(([, value]) => /^class\s/u.test(Function.prototype.toString.call(value)))
      .map(([name]) => name);

    // A sweep that finds nothing would make the assertion below vacuous.
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.filter((name) => !parsed.has(name))).toEqual([]);
  });
});
