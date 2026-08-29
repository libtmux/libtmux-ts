/**
 * Gate the artifact a consumer actually installs.
 *
 * The other gates read the source tree. This one packs the tarball and asks
 * three questions about it: does it resolve for the runtimes we claim, is the
 * manifest well formed, and does it carry anything a consumer has no use for.
 */
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { npmPack } from "../../../scripts/npm_pack.js";
import { declarationClosureErrors, packageDeclarationExports } from "./declaration-closure.js";

const tsRoot = fileURLToPath(new URL("..", import.meta.url));

/** Paths that must never reach a consumer, with the reason each is excluded. */
const forbiddenEntries: readonly (readonly [prefix: string, reason: string])[] = [
  ["dist/_internal/test/", "the tmux test harness is for this repository's own suites"],
  ["dist/tests/", "tests are not part of the published surface"],
  ["dist/scripts/", "build tooling is not part of the published surface"],
];

let packDirectory: string | undefined;

function fail(message: string): never {
  if (packDirectory !== undefined) rmSync(packDirectory, { force: true, recursive: true });
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Find an installed command, wherever the workspace put it.
 *
 * A workspace hoists shared tooling to its root, so a package's own
 * `node_modules/.bin` is not where the binary reliably is.
 */
function resolveBinary(name: string): string {
  let directory = tsRoot;
  for (;;) {
    const candidate = join(directory, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) fail(`${name} is not installed anywhere above ${tsRoot}`);
    directory = parent;
  }
}

async function run(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], { cwd: tsRoot, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) fail(`${command.join(" ")} exited ${exitCode}\n${stdout}${stderr}`);
  return stdout;
}

packDirectory = await mkdtemp(join(tmpdir(), "ltx-package-pack-"));
const entries = await npmPack(tsRoot, packDirectory)
  .then(({ entries: packed }) => packed.filter((entry) => entry.startsWith("dist/")))
  .catch((error: unknown) => fail(error instanceof Error ? error.message : "npm pack failed"));
if (entries.length === 0) fail("packing produced no dist entries; run `bun run build` first");

for (const [prefix, reason] of forbiddenEntries) {
  const found = entries.filter((entry) => entry.startsWith(prefix));
  if (found.length > 0) {
    fail(
      `${found.length} packed ${prefix}* entries: ${reason}\n  ${found.slice(0, 5).join("\n  ")}`,
    );
  }
}

// A root import must not pull the whole package in; entry points are separate
// files precisely so a consumer pays for what it names.
if (!entries.includes("dist/index.js")) fail("the packed tarball has no root entrypoint");
if (!entries.includes("dist/index.d.ts")) fail("the packed tarball has no root declaration");

const shipped = JSON.parse(await readFile(join(tsRoot, "package.json"), "utf8")) as {
  exports: unknown;
  name: string;
  version: string;
};
const declarationEntries = entries.filter((entry) => entry.endsWith(".d.ts"));
const exportedDeclarations = packageDeclarationExports(shipped.exports);
const resolvedOutput = await run([
  resolveBinary("tsc"),
  "--ignoreConfig",
  "--noEmit",
  "--listFilesOnly",
  "--module",
  "NodeNext",
  "--moduleResolution",
  "NodeNext",
  "--skipLibCheck",
  ...exportedDeclarations.map((entry) => join(tsRoot, entry)),
]);
const resolvedDeclarations = resolvedOutput
  .split("\n")
  .map((path) => relative(tsRoot, path.trim()).replaceAll("\\", "/"))
  .filter((path) => path.startsWith("dist/") && path.endsWith(".d.ts"));
const declarationErrors = declarationClosureErrors(
  declarationEntries,
  exportedDeclarations,
  resolvedDeclarations,
);
if (declarationErrors.length > 0) {
  fail(
    `published declarations are not closed over package exports:\n${declarationErrors.join("\n")}`,
  );
}

await rm(packDirectory, { force: true, recursive: true });
packDirectory = undefined;

process.stdout.write(
  `${JSON.stringify({
    entries: entries.length,
    protocol: "libtmux-package-artifact-v1",
    status: "passed",
  })}\n`,
);
