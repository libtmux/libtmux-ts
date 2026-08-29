import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface SourceMap {
  readonly file?: unknown;
  readonly sourceRoot?: unknown;
  readonly sources?: unknown;
  readonly sourcesContent?: unknown;
}

function fail(message: string): never {
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
if (javascript.length === 0) fail("dist contains no JavaScript files");

async function validateJavaScript(javascriptPath: string): Promise<void> {
  const absoluteJavascriptPath = join(distRoot, javascriptPath);
  const mapPath = `${absoluteJavascriptPath}.map`;
  const expectedReference = `//# sourceMappingURL=${basename(mapPath)}`;
  const source = await readFile(absoluteJavascriptPath, "utf8");
  if (!source.trimEnd().endsWith(expectedReference)) {
    fail(`${javascriptPath} does not reference ${basename(mapPath)}`);
  }

  let map: SourceMap;
  try {
    map = JSON.parse(await readFile(mapPath, "utf8")) as SourceMap;
  } catch {
    fail(`${relative(packageRoot, mapPath)} is missing or invalid`);
  }
  if (map.sourceRoot !== undefined && map.sourceRoot !== "") {
    fail(`${javascriptPath}.map must not set a sourceRoot`);
  }
  if (map.file !== basename(absoluteJavascriptPath)) {
    fail(`${javascriptPath}.map names the wrong JavaScript file`);
  }
  if (!Array.isArray(map.sources) || map.sources.some((entry) => typeof entry !== "string")) {
    fail(`${javascriptPath}.map has invalid sources`);
  }
  if (
    !Array.isArray(map.sourcesContent) ||
    map.sourcesContent.length !== map.sources.length ||
    map.sourcesContent.some((entry) => typeof entry !== "string")
  ) {
    fail(`${javascriptPath}.map has incomplete sourcesContent`);
  }

  const sources = map.sources as string[];
  const sourcesContent = map.sourcesContent as string[];
  await Promise.all(
    sources.map(async (entry, index) => {
      if (isAbsolute(entry)) fail(`${javascriptPath}.map contains an absolute source path`);
      const sourcePath = resolve(dirname(mapPath), entry);
      if (!contained(packageRoot, sourcePath)) {
        fail(`${javascriptPath}.map contains a source outside the package`);
      }
      if (sourcesContent[index] !== (await readFile(sourcePath, "utf8"))) {
        fail(`${javascriptPath}.map does not embed the exact source`);
      }
    }),
  );
}

await Promise.all(javascript.map(validateJavaScript));

process.stdout.write(
  `${JSON.stringify({ files: javascript.length, protocol: "source-map-contract-v1", status: "passed" })}\n`,
);
