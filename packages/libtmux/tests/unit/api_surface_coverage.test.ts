import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  classesOf,
  requireRootExamples,
  requireSymbolExamples,
  readApiSurface,
  readRootApiSurface,
  readRootExports,
  rootExportNames,
  type ApiDeclaration,
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

test("class and interface examples remain available to all documentation gates", () => {
  const example = 'import { Server } from "libtmux";\nconst server = new Server();';
  const doc = `/**\n * Setup.\n * \`\`\`ts\n${example
    .split("\n")
    .map((line) => ` * ${line}`)
    .join("\n")}\n * \`\`\`\n */`;
  for (const declaration of ["export class Server {}", "export interface Selection {}"] as const) {
    const parsed = classesOf(`${doc}\n${declaration}`, "fixture.ts");
    expect(parsed[0]?.prose).toContain(`\`\`\`ts\n${example}\n\`\`\``);
  }
});

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

describe("root export derivation", () => {
  test("follows named re-exports, with aliases, type markers and comments", () => {
    const source = [
      '// export * from "./comment.js";',
      "/* export const hidden = 1; */",
      'export { A, type B as C } from "./a.js";',
      "export type {",
      "  D,",
      '} from "./d.js";',
    ].join("\n");
    expect(rootExportNames(source)).toEqual([
      { from: "./a.js", name: "A" },
      { from: "./a.js", name: "C" },
      { from: "./d.js", name: "D" },
    ]);
  });

  test.each([
    'export * from "./all.js";',
    'export * as ns from "./all.js";',
    'export type * from "./all.js";',
    "export { local };",
    "export const answer = 42;",
    "export function make() {}",
    "export default class {}",
    "export type Local = string;",
  ])("refuses %s instead of dropping it", (statement) => {
    const source = `export { A } from "./a.js";\n${statement}\n`;
    expect(() => rootExportNames(source)).toThrow(/cannot trace/u);
  });

  test("reads the real root without refusing it", async () => {
    const names = rootExportNames(
      await readFile(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), "utf8"),
    );
    expect(names.length).toBeGreaterThan(50);
  });
});

describe("api surface coverage", () => {
  test("rejects every public member missing an example", () => {
    const member = (example: string | undefined): PublicMember => ({
      example,
      file: "src/window.ts",
      kind: "method",
      line: 160,
      name: "showHooks",
      owner: "Window",
      prose: "Read hooks set on this window itself.",
      signature: "showHooks(): Promise<ReadonlyMap<string, readonly string[]>>",
    });

    for (const example of [undefined, "", " \n "] as const) {
      expect(() => requireSymbolExamples([member(example)])).toThrow(
        "src/window.ts:160  Window.showHooks",
      );
    }
  });

  test("rejects every root declaration missing an example", () => {
    const declaration = (example: string | undefined): ApiDeclaration => ({
      example,
      file: "src/common.ts",
      kind: "function",
      line: 40,
      name: "safeInteger",
      prose: "Authenticate an integer.",
      signatures: ["function safeInteger(value: number): SafeInteger;"],
    });

    for (const example of [undefined, "", " \n "] as const) {
      expect(() => requireRootExamples([declaration(example)])).toThrow(
        "src/common.ts:40  safeInteger",
      );
    }
  });

  test("collects members with an explicit public modifier", () => {
    const [entry] = classesOf(
      `export class Explicit {
  public async read(): Promise<void> {}
  public readonly server: unknown;
}`,
      "src/explicit.ts",
    );

    expect(entry?.members.map(({ name }) => name)).toEqual(["read", "server"]);
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
      "function splitSize(value: number): SplitCellSize;",
      "function splitSize(value: SplitPercentage): SplitPercentage;",
      "function splitSize(value: SplitSize): SplitSize;",
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

  test("the reference lists every name the root module exports", async () => {
    const exported = await rootExports();
    const read = (await readRootExports()).map((entry) => entry.name).sort();
    // Cross-checked against the compiler's reading of the root, so the reader
    // cannot lose a name and agree with itself.
    expect(read).toEqual([...exported.types, ...exported.values].sort());
    expect(read).toContain("compileBoundedRegex");
    expect(read).toContain("assertSupportedTmux");
    expect(read).toContain("MINIMUM_TMUX");

    const reference = await readFile(
      fileURLToPath(new URL("../../docs/api.md", import.meta.url)),
      "utf8",
    );
    const missing = read.filter(
      (name) => !reference.includes(`\`${name}\``) && !reference.includes(`## ${name}\n`),
    );
    expect(missing).toEqual([]);
  }, 30_000);

  test("refuses a root export with no declaration or no doc comment", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-api-surface-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "src/index.ts"),
        'export { documented, bare } from "./a.js";\nexport { missing } from "./a.js";\n',
      );
      await writeFile(
        join(root, "src/a.ts"),
        "/** Does a thing. */\nexport function documented(): void {}\nexport function bare(): void {}\n",
      );
      await expect(readRootExports(root)).rejects.toThrow(
        /bare: no doc comment[^]*missing: no declaration/u,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
