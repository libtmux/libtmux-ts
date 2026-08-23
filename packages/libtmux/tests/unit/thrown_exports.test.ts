import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import * as index from "../../src/index.js";

/**
 * Every error a doc comment promises can be caught by its name.
 *
 * A caller who reads `@throws WaitTimeout` reaches for
 * `import { WaitTimeout } from "libtmux"`, at the same import site as every
 * other error they catch. `WaitTimeout` was not there: it sat in `exc.ts` for
 * parity long before anything threw it, so when `waitFor` began throwing it
 * and its doc comment began promising it, nobody added the export — the
 * behaviour moved, the sentence moved, and the export stayed where it was.
 *
 * Catching by type is the only way to tell a deadline from a failure, so an
 * error a caller is told to expect and cannot import is a promise they have no
 * way to keep.
 */

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

/** The class names doc comments promise, wherever in the source they promise them. */
async function promisedErrors(): Promise<ReadonlySet<string>> {
  const promised = new Set<string>();
  // Scanned rather than shelled out for: a listing that silently comes back
  // empty turns this into a test that passes because it checked nothing.
  for await (const file of new Bun.Glob("**/*.ts").scan(sourceRoot)) {
    const source = await readFile(join(sourceRoot, file), "utf8");
    for (const match of source.matchAll(/@throws\s+(?<name>[A-Z]\w+)/gu)) {
      const name = match.groups?.["name"];
      if (name !== undefined) promised.add(name);
    }
  }
  return promised;
}

describe("thrown errors", () => {
  test("every error a doc comment promises is importable from the index", async () => {
    const promised = await promisedErrors();
    // The scan finding nothing would make every assertion below vacuous.
    expect(promised.size).toBeGreaterThan(0);

    const exported = new Set(Object.keys(index));
    const declared = new Set(
      (await readFile(join(sourceRoot, "exc.ts"), "utf8"))
        .split("\n")
        .flatMap((line) => /^export class (?<name>\w+)/u.exec(line)?.groups?.["name"] ?? []),
    );

    // Only what this package defines: a `@throws TypeError` is the platform's.
    const missing = [...promised]
      .filter((name) => declared.has(name))
      .filter((name) => !exported.has(name))
      .sort();

    expect(missing).toEqual([]);
  });
});
