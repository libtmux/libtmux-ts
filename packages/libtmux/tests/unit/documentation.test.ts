import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

/**
 * The README is the package's documentation, so it is gated like the rest of
 * the surface. An operation a caller can reach that the README never names is
 * undiscoverable, and nothing else in the build would notice it was added.
 */

const handleModules = ["server", "session", "window", "pane", "client"] as const;

/** Operations declared on a handle, excluding the generated field accessors. */
async function operationsOf(module: string): Promise<readonly string[]> {
  const source = await readFile(new URL(`../../src/${module}.ts`, import.meta.url), "utf8");
  return [...source.matchAll(/^ {2}([a-zA-Z][a-zA-Z]*)\(/gmu)]
    .map((match) => match[1]!)
    .filter((name) => name !== "constructor");
}

describe("README coverage", () => {
  test("shows every operation in a code block, not just a list", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    // Naming an operation proves it exists; showing a call proves what it takes
    // and what it gives back. A bare list of names is an index, not
    // documentation.
    const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/gu)]
      .map((match) => match[1])
      .join("\n");

    const declared = await Promise.all(
      handleModules.map(async (module) =>
        (await operationsOf(module)).map((operation) => `${module}.${operation}`),
      ),
    );

    const unshown = declared
      .flat()
      .map((entry) => entry.slice(entry.indexOf(".") + 1))
      .filter((operation) => !blocks.includes(`${operation}(`));

    expect([...new Set(unshown)]).toEqual([]);
  });

  test("names every operation a handle exposes", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const declared = await Promise.all(
      handleModules.map(async (module) =>
        (await operationsOf(module)).map((operation) => `${module}.${operation}`),
      ),
    );

    const missing = declared
      .flat()
      .filter((entry) => !readme.includes(entry.slice(entry.indexOf(".") + 1)));

    expect(missing).toEqual([]);
  });

  test("documents every runtime export", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const root = (await import("../../src/index.js")) as Record<string, unknown>;

    const missing = Object.keys(root).filter((name) => !readme.includes(name));

    expect(missing).toEqual([]);
  });

  test("shows the entrypoints the package publishes", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };

    // A subpath nobody documents is a subpath nobody can find.
    const subpaths = Object.keys(manifest.exports).filter(
      (name) => name !== "." && name !== "./package.json",
    );
    const missing = subpaths.filter((name) => !readme.includes(name.replace("./", "libtmux/")));

    expect(missing).toEqual([]);
  });
});

describe("generated API reference", () => {
  test("covers root helpers and behavioral scalar types", async () => {
    const api = await readFile(new URL("../../docs/api.md", import.meta.url), "utf8");
    const rootEntries = [...api.matchAll(/^### (`[^`]+`(?: type)?)$/gmu)].map((match) => match[1]!);

    expect(rootEntries).toEqual([
      "`encodeWhereDocument`",
      "`decodeWhereDocument`",
      "`parseLegacyWhere`",
      "`isSafeInteger`",
      "`safeInteger`",
      "`isSplitSize`",
      "`splitSize`",
      "`SafeInteger` type",
      "`SplitCellSize` type",
      "`SplitPercentage` type",
      "`SplitSize` type",
    ]);
  });

  test("gives every member one heading and anchor", async () => {
    const api = await readFile(new URL("../../docs/api.md", import.meta.url), "utf8");
    const headings = [...api.matchAll(/^#### `([^`]+)`$/gmu)].map((match) => match[1]!);
    const duplicates = headings.filter((heading, index) => headings.indexOf(heading) !== index);

    expect(duplicates).toEqual([]);
  });
});
