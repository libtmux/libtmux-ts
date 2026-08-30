import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { makeTestDirectory } from "../../src/_internal/test/testkit.js";

const gate = fileURLToPath(new URL("../../../../scripts/check-source-maps.ts", import.meta.url));
const source = "export const answer = 42;\n";
const declarationMap = `${JSON.stringify({
  file: "index.d.ts",
  mappings: "",
  names: [],
  sourceRoot: "",
  sources: ["../src/declaration.ts"],
  version: 3,
})}\n`;

interface FixtureOptions {
  readonly corruption?: "absolute-source" | "nonempty-source-root" | "outside-source";
  readonly declarationMap: boolean;
  readonly embeddedSources?: boolean;
  readonly shipDeclarationSource: boolean;
  readonly shipMaps: boolean;
}

async function runGate(options: FixtureOptions): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
}> {
  const root = await makeTestDirectory("ltx-source-map-gate-");
  try {
    const javascriptMap = `${JSON.stringify({
      file: "index.js",
      mappings: "",
      names: [],
      sourceRoot: options.corruption === "nonempty-source-root" ? "../src" : "",
      sources: [
        options.corruption === "absolute-source"
          ? "/tmp/index.ts"
          : options.corruption === "outside-source"
            ? "../../outside.ts"
            : "../src/index.ts",
      ],
      ...(options.embeddedSources ? { sourcesContent: [source] } : {}),
      version: 3,
    })}\n`;
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

test("rejects source text duplicated in a packed map", async () => {
  const result = await runGate({
    declarationMap: true,
    embeddedSources: true,
    shipDeclarationSource: true,
    shipMaps: true,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("duplicates its packed source");
});

test("rejects unsafe map paths", async () => {
  for (const [corruption, message] of [
    ["absolute-source", "absolute source path"],
    ["outside-source", "source outside the package"],
    ["nonempty-source-root", "must set an empty sourceRoot"],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- each fixture proves one independent refusal.
    const result = await runGate({
      corruption,
      declarationMap: true,
      shipDeclarationSource: true,
      shipMaps: true,
    });
    expect(result.exitCode, corruption).toBe(1);
    expect(result.stderr, corruption).toContain(message);
  }
});
