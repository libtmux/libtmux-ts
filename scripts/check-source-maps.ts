import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { npmPack } from "./npm_pack.js";

interface SourceMap {
  readonly file?: unknown;
  readonly sourceRoot?: unknown;
  readonly sources?: unknown;
  readonly sourcesContent?: unknown;
}

let packDirectory: string | undefined;

function fail(message: string): never {
  if (packDirectory !== undefined) rmSync(packDirectory, { force: true, recursive: true });
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function contained(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith("../") && !isAbsolute(pathFromRoot);
}

const packageRoot = process.cwd();
const distRoot = join(packageRoot, "dist");
const javascript = Array.from(new Bun.Glob("**/*.js").scanSync({ cwd: distRoot })).toSorted(
  (left, right) => (left < right ? -1 : left > right ? 1 : 0),
);
const declarations = Array.from(new Bun.Glob("**/*.d.ts").scanSync({ cwd: distRoot })).toSorted(
  (left, right) => (left < right ? -1 : left > right ? 1 : 0),
);
if (javascript.length === 0) fail("dist contains no JavaScript files");
if (declarations.length === 0) fail("dist contains no declaration files");

packDirectory = await mkdtemp(join(tmpdir(), "ltx-source-map-pack-"));
const packed = new Set(
  await npmPack(packageRoot, packDirectory)
    .then(({ entries }) => entries)
    .catch((error: unknown) => fail(error instanceof Error ? error.message : "npm pack failed")),
);
if (packed.size === 0) fail("packing produced no entries");

async function validateMap(artifactPath: string, requireEmbeddedSources: boolean): Promise<void> {
  const absoluteArtifactPath = join(distRoot, artifactPath);
  const mapPath = `${absoluteArtifactPath}.map`;
  const expectedReference = `//# sourceMappingURL=${basename(mapPath)}`;
  const source = await readFile(absoluteArtifactPath, "utf8");
  if (!source.trimEnd().endsWith(expectedReference)) {
    fail(`${artifactPath} does not reference ${basename(mapPath)}`);
  }

  let map: SourceMap;
  try {
    map = JSON.parse(await readFile(mapPath, "utf8")) as SourceMap;
  } catch {
    fail(`${relative(packageRoot, mapPath)} is missing or invalid`);
  }
  if (map.sourceRoot !== "") {
    fail(`${artifactPath}.map must set an empty sourceRoot`);
  }
  if (map.file !== basename(absoluteArtifactPath)) {
    fail(`${artifactPath}.map names the wrong artifact`);
  }
  if (!Array.isArray(map.sources) || map.sources.some((entry) => typeof entry !== "string")) {
    fail(`${artifactPath}.map has invalid sources`);
  }
  let sourcesContent: string[] | undefined;
  if (map.sourcesContent === undefined) {
    if (requireEmbeddedSources) fail(`${artifactPath}.map has incomplete sourcesContent`);
  } else {
    if (
      !Array.isArray(map.sourcesContent) ||
      map.sourcesContent.length !== map.sources.length ||
      map.sourcesContent.some((entry) => typeof entry !== "string")
    ) {
      fail(`${artifactPath}.map has incomplete sourcesContent`);
    }
    sourcesContent = map.sourcesContent as string[];
  }

  const sources = map.sources as string[];
  const packageArtifactPath = relative(packageRoot, absoluteArtifactPath).replaceAll("\\", "/");
  const packageMapPath = relative(packageRoot, mapPath).replaceAll("\\", "/");
  const mapIsPacked = packed.has(packageMapPath);
  if (packed.has(packageArtifactPath) && !mapIsPacked) {
    fail(`${artifactPath} references ${packageMapPath}, which is not packed`);
  }
  await Promise.all(
    sources.map(async (entry, index) => {
      if (isAbsolute(entry)) fail(`${artifactPath}.map contains an absolute source path`);
      const sourcePath = resolve(dirname(mapPath), entry);
      if (!contained(packageRoot, sourcePath)) {
        fail(`${artifactPath}.map contains a source outside the package`);
      }
      if (
        sourcesContent !== undefined &&
        sourcesContent[index] !== (await readFile(sourcePath, "utf8"))
      ) {
        fail(`${artifactPath}.map does not embed the exact source`);
      }
      const packageSourcePath = relative(packageRoot, sourcePath).replaceAll("\\", "/");
      if (mapIsPacked && !packed.has(packageSourcePath)) {
        fail(`${artifactPath}.map maps to ${packageSourcePath}, which is not packed`);
      }
    }),
  );
}

await Promise.all([
  ...javascript.map((path) => validateMap(path, true)),
  ...declarations.map((path) => validateMap(path, false)),
]);
await rm(packDirectory, { force: true, recursive: true });
packDirectory = undefined;

process.stdout.write(
  `${JSON.stringify({
    declarations: declarations.length,
    files: javascript.length,
    protocol: "source-map-contract-v2",
    status: "passed",
  })}\n`,
);
