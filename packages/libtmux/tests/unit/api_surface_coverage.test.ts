import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  requireSymbolExamples,
  readApiSurface,
  readRootApiSurface,
  type PublicMember,
} from "../../scripts/api_surface.js";
import * as index from "../../src/index.js";
import { runTypeScriptApi } from "../support/typescript_api.js";

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

interface RootExports {
  readonly types: readonly string[];
  readonly values: readonly string[];
}

const rootExportsScript = String.raw`
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";

const rootFile = process.argv.at(-1);
const api = new API({ cwd: process.cwd() });
try {
  const snapshot = api.updateSnapshot({ openFiles: [rootFile] });
  const project = snapshot.getDefaultProjectForFile(rootFile);
  const sourceFile = project?.program.getSourceFile(rootFile);
  if (sourceFile === undefined) throw new Error("root source was not parsed");
  const types = [];
  const values = [];
  for (const statement of sourceFile.statements) {
    if (statement.kind !== SyntaxKind.ExportDeclaration) continue;
    for (const element of statement.exportClause?.elements ?? []) {
      const name = element.name?.text;
      if (name === undefined) continue;
      if (statement.isTypeOnly === true || element.isTypeOnly === true) types.push(name);
      else values.push(name);
    }
  }
  process.stdout.write(JSON.stringify({ types: types.sort(), values: values.sort() }));
} finally {
  api.close();
}
`;

async function rootExports(): Promise<RootExports> {
  const rootPath = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const { exitCode, stderr, stdout } = await runTypeScriptApi(
    rootExportsScript,
    [rootPath],
    packageRoot,
  );
  expect(exitCode, stderr).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as RootExports;
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

  test("keeps every root overload and omits its implementation", async () => {
    const splitSize = (await readRootApiSurface()).find((entry) => entry.name === "splitSize");

    expect(splitSize?.signatures).toEqual([
      "function splitSize(value: number): SplitCellSize",
      "function splitSize(value: SplitPercentage): SplitPercentage",
      "function splitSize(value: SplitSize): SplitSize",
    ]);
  });

  test("root reference types are type-only exports and helpers are values", async () => {
    const declarations = await readRootApiSurface();
    const typeNames = declarations
      .filter((entry) => entry.kind === "type")
      .map((entry) => entry.name)
      .sort();
    const functionNames = declarations
      .filter((entry) => entry.kind === "function")
      .map((entry) => entry.name)
      .sort();
    const exported = await rootExports();

    expect(exported.types.filter((name) => typeNames.includes(name))).toEqual(typeNames);
    expect(exported.values.filter((name) => functionNames.includes(name))).toEqual(functionNames);
  }, 30_000);
});
