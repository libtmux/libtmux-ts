import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

const gate = fileURLToPath(new URL("../../../../scripts/check-source-maps.ts", import.meta.url));
const source = "export const answer = 42;\n";
const javascriptMap = `${JSON.stringify({
  file: "index.js",
  mappings: "",
  names: [],
  sourceRoot: "",
  sources: ["../src/index.ts"],
  sourcesContent: [source],
  version: 3,
})}\n`;
const declarationMap = `${JSON.stringify({
  file: "index.d.ts",
  mappings: "",
  names: [],
  sourceRoot: "",
  sources: ["../src/declaration.ts"],
  sourcesContent: [source],
  version: 3,
})}\n`;

interface FixtureOptions {
  readonly declarationMap: boolean;
  readonly shipDeclarationSource: boolean;
  readonly shipMaps: boolean;
}

async function runGate(options: FixtureOptions): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
}> {
  const root = await makeTestDirectory("ltx-source-map-gate-");
  try {
    await Promise.all([mkdir(join(root, "dist")), mkdir(join(root, "src"))]);
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        `${JSON.stringify({
          files: [
            ...(options.shipMaps
              ? ["dist"]
              : ["dist/index.d.ts", "dist/index.js", "dist/index.js.map"]),
            ...(options.shipDeclarationSource ? ["src"] : ["src/index.ts"]),
          ],
          name: "ltx-source-map-fixture",
          type: "module",
          version: "0.0.0",
        })}\n`,
      ),
      writeFile(join(root, "src/declaration.ts"), source),
      writeFile(join(root, "src/index.ts"), source),
      writeFile(
        join(root, "dist/index.js"),
        "export const answer = 42;\n//# sourceMappingURL=index.js.map\n",
      ),
      writeFile(join(root, "dist/index.js.map"), javascriptMap),
      writeFile(
        join(root, "dist/index.d.ts"),
        options.declarationMap
          ? "export declare const answer = 42;\n//# sourceMappingURL=index.d.ts.map\n"
          : "export declare const answer = 42;\n",
      ),
      ...(options.declarationMap
        ? [writeFile(join(root, "dist/index.d.ts.map"), declarationMap)]
        : []),
    ]);

    const child = Bun.spawn(["bun", gate], { cwd: root, stderr: "pipe", stdout: "pipe" });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return { exitCode, stderr };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("rejects an emitted declaration without a declaration map", async () => {
  const result = await runGate({
    declarationMap: false,
    shipDeclarationSource: true,
    shipMaps: true,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("index.d.ts does not reference index.d.ts.map");
});

test("rejects a mapped source omitted from the tarball", async () => {
  const result = await runGate({
    declarationMap: true,
    shipDeclarationSource: false,
    shipMaps: true,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("index.d.ts.map maps to src/declaration.ts, which is not packed");
});

test("rejects a map omitted from the tarball", async () => {
  const result = await runGate({
    declarationMap: true,
    shipDeclarationSource: true,
    shipMaps: false,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("index.d.ts references dist/index.d.ts.map, which is not packed");
});
