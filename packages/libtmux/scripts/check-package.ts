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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "../../../scripts/bounded_process.js";
import { npmPack } from "../../../scripts/npm_pack.js";
import { declarationClosureErrors, packageDeclarationExports } from "./declaration-closure.js";

const tsRoot = fileURLToPath(new URL("..", import.meta.url));
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

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
  const result = await runBoundedCommand(command, {
    cwd: tsRoot,
    env: { ...process.env },
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    timeoutMilliseconds: 60_000,
  });
  if (result.termination === "timed_out") {
    fail(`${command[0] ?? "command"} exceeded 60000ms`);
  }
  if (result.termination === "output_limit_exceeded") {
    fail(`${command[0] ?? "command"} exceeded ${String(MAX_COMMAND_OUTPUT_BYTES)} output bytes`);
  }
  if (result.exitCode !== 0) {
    fail(
      `${command.join(" ")} exited ${String(result.exitCode)}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

async function runtimeImportCycles(entries: readonly string[]): Promise<readonly string[][]> {
  const modules = entries.filter((entry) => entry.endsWith(".js")).sort();
  const moduleSet = new Set(modules);
  const graph = new Map<string, readonly string[]>();
  await Promise.all(
    modules.map(async (module) => {
      const path = join(tsRoot, module);
      const source = await readFile(path, "utf8");
      const dependencies = new Set<string>();
      const specifiers = [
        ...source.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];\s*$/gmu),
        ...source.matchAll(/^export\s+(?:\*|\{)[\s\S]*?\s+from\s+["']([^"']+)["'];\s*$/gmu),
      ];
      for (const match of specifiers) {
        const specifier = match[1];
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        const dependency = relative(tsRoot, resolve(dirname(path), specifier)).replaceAll(
          "\\",
          "/",
        );
        if (moduleSet.has(dependency)) dependencies.add(dependency);
      }
      graph.set(module, [...dependencies].sort());
    }),
  );

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const cycles: string[][] = [];
  const visit = (module: string): void => {
    indices.set(module, nextIndex);
    lowLinks.set(module, nextIndex);
    nextIndex += 1;
    stack.push(module);
    active.add(module);
    for (const dependency of graph.get(module) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(module, Math.min(lowLinks.get(module)!, lowLinks.get(dependency)!));
      } else if (active.has(dependency)) {
        lowLinks.set(module, Math.min(lowLinks.get(module)!, indices.get(dependency)!));
      }
    }
    if (lowLinks.get(module) !== indices.get(module)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      component.push(member);
    } while (member !== module);
    component.sort();
    if (component.length > 1 || (graph.get(module) ?? []).includes(module)) cycles.push(component);
  };
  for (const module of modules) if (!indices.has(module)) visit(module);
  return cycles.sort(
    (left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!),
  );
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

const runtimeCycles = await runtimeImportCycles(entries);
if (runtimeCycles.length > 0) {
  fail(
    `packed runtime has static import cycles:\n${runtimeCycles
      .map((component) => `${String(component.length)}-module SCC:\n  ${component.join("\n  ")}`)
      .join("\n")}`,
  );
}

await rm(packDirectory, { force: true, recursive: true });
packDirectory = undefined;

process.stdout.write(
  `${JSON.stringify({
    entries: entries.length,
    protocol: "libtmux-package-artifact-v1",
    runtimeCycles: runtimeCycles.length,
    status: "passed",
  })}\n`,
);
