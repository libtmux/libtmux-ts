import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { verifyBaseline, verifyEvidencePaths, verifyManualProvenance } from "./parity/evidence.js";
import {
  baselineSymbol,
  fail,
  parseBaseline,
  parseManifest,
  publicSymbolEvidenceApplicability,
  symbolKey,
} from "./parity/manifest.js";
import type { ParityManifest, PublicSymbol } from "./parity/manifest.js";
import { derivePythonInventory, runPythonGit } from "./parity/python_inventory.js";
import { verifyTypeScriptSymbols } from "./parity/typescript_symbols.js";

const packageRoot = join(import.meta.dir, "..");
const defaultManifestPath = join(packageRoot, "parity/python-0.62.0.json");
const defaultBaselinePath = join(packageRoot, "parity/python-0.62.0.baseline.json");
const defaultPackageManifestPath = join(packageRoot, "package.json");

function mergeSymbols(generated: PublicSymbol[], existing: PublicSymbol[]): PublicSymbol[] {
  const previous = new Map(existing.map((entry) => [symbolKey(entry), entry]));
  return generated.map((entry) => {
    const found = previous.get(symbolKey(entry));
    if (!found) return entry;
    return {
      ...entry,
      adaptation: found.adaptation,
      declarationTest: found.declarationTest,
      evidenceApplicability: found.evidenceApplicability,
      realTmuxScenario: found.realTmuxScenario,
      reason: found.reason,
      status: found.status,
      typescript: found.typescript,
      typescriptSymbols: found.typescriptSymbols,
      unitTest: found.unitTest,
    };
  });
}

function publicSymbolsBounds(raw: string): { end: number; start: number } {
  const marker = '"publicSymbols":';
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) fail("manifest.publicSymbols text boundary is missing");
  const start = raw.indexOf("[", markerIndex + marker.length);
  if (start < 0) fail("manifest.publicSymbols array is missing");
  let depth = 0;
  let escaped = false;
  let quoted = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return { end: index + 1, start };
    }
  }
  fail("manifest.publicSymbols array is unterminated");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function renderUpdatedManifest(raw: string, symbols: PublicSymbol[]): string {
  const { end, start } = publicSymbolsBounds(raw);
  const rendered = JSON.stringify(symbols, null, 2).replaceAll("\n", "\n  ");
  return `${raw.slice(0, start)}${rendered}${raw.slice(end)}`;
}

function validateInventory(manifest: ParityManifest, expected: PublicSymbol[]): string[] {
  const problems: string[] = [];
  const actual = new Map(manifest.publicSymbols.map((entry) => [symbolKey(entry), entry]));
  const expectedByKey = new Map(expected.map((entry) => [symbolKey(entry), entry]));
  for (const [key, expectedEntry] of expectedByKey) {
    const actualEntry = actual.get(key);
    if (!actualEntry) {
      problems.push(`missing: ${key}`);
      continue;
    }
    for (const field of ["kind", "owner", "python", "source"] as const) {
      if (actualEntry[field] !== expectedEntry[field]) problems.push(`${key} has invalid ${field}`);
    }
  }
  for (const key of actual.keys()) {
    if (!expectedByKey.has(key)) problems.push(`unexpected: ${key}`);
  }
  return problems;
}

function validateSymbolPolicies(manifest: ParityManifest, expected: PublicSymbol[]): string[] {
  const expectedByKey = new Map(expected.map((entry) => [symbolKey(entry), entry]));
  const problems: string[] = [];
  for (const entry of manifest.publicSymbols) {
    const expectedEntry = expectedByKey.get(symbolKey(entry));
    const expectedApplicability =
      expectedEntry &&
      publicSymbolEvidenceApplicability(expectedEntry.kind, expectedEntry.python, entry.status);
    if (
      expectedApplicability &&
      JSON.stringify(entry.evidenceApplicability) !== JSON.stringify(expectedApplicability)
    ) {
      problems.push(`${symbolKey(entry)} has invalid evidence applicability`);
    }
  }
  return problems;
}

async function regenerateBaseline(
  manifest: ParityManifest,
  baselinePath: string,
  pythonRepository: string,
): Promise<number> {
  const { commit, tag } = manifest.baseline;
  let resolved: string;
  try {
    resolved = runPythonGit(pythonRepository, ["rev-parse", `${tag}^{commit}`]);
  } catch {
    fail(`Unable to resolve ${tag}; fetch tags and unshallow the checkout before regenerating`);
  }
  if (resolved !== commit) fail(`${tag} resolves to ${resolved}, not the manifest's ${commit}`);

  const cited = new Set<string>();
  for (const record of [...manifest.observableBehaviors, ...manifest.internalExclusions]) {
    for (const value of record.pythonEvidence) {
      const path =
        /^https:\/\/github\.com\/tmux-python\/libtmux\/(?:blob|tree)\/[0-9a-f]{40}\/(.+)$/.exec(
          value,
        )?.[1];
      if (path !== undefined) cited.add(path);
    }
  }
  const objects: Record<string, string> = {};
  for (const path of [...cited].sort()) {
    objects[path] = runPythonGit(pythonRepository, ["cat-file", "-t", `${commit}:${path}`]);
  }

  const baseline = {
    schemaVersion: 1,
    generatedFrom: {
      repository: "https://github.com/tmux-python/libtmux",
      tag,
      commit,
    },
    objects,
    symbols: derivePythonInventory(pythonRepository).map(({ kind, owner, python, source }) => ({
      kind,
      owner,
      python,
      source,
    })),
  };
  await atomicWrite(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline.symbols.length;
}

interface Arguments {
  allowBoundaryChange: boolean;
  baselinePath: string;
  manifestPath: string;
  packageManifestPath: string;
  pythonRepository: string | undefined;
  regenerate: boolean;
  write: boolean;
}

function parseArguments(arguments_: string[]): Arguments {
  let allowBoundaryChange = false;
  let baselinePath = defaultBaselinePath;
  let manifestPath = defaultManifestPath;
  let packageManifestPath = defaultPackageManifestPath;
  let pythonRepository: string | undefined;
  let regenerate = false;
  let write = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--write") write = true;
    else if (argument === "--allow-boundary-change") allowBoundaryChange = true;
    else if (argument === "--regenerate-baseline") regenerate = true;
    else if (argument === "--python-repo") {
      const value = arguments_[index + 1];
      if (!value) fail("--python-repo requires a path");
      pythonRepository = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
    } else if (argument === "--baseline") {
      const value = arguments_[index + 1];
      if (!value) fail("--baseline requires a path");
      baselinePath = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
    } else if (argument === "--manifest") {
      const value = arguments_[index + 1];
      if (!value) fail("--manifest requires a path");
      manifestPath = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
    } else if (argument === "--package-manifest") {
      const value = arguments_[index + 1];
      if (!value) fail("--package-manifest requires a path");
      packageManifestPath = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
    } else fail(`unknown argument: ${argument}`);
  }
  if (allowBoundaryChange && !write) fail("--allow-boundary-change requires --write");
  if (regenerate && write) fail("--regenerate-baseline and --write are separate steps");
  return {
    allowBoundaryChange,
    baselinePath,
    manifestPath,
    packageManifestPath,
    pythonRepository,
    regenerate,
    write,
  };
}

try {
  const {
    allowBoundaryChange,
    baselinePath,
    manifestPath,
    packageManifestPath,
    pythonRepository,
    regenerate,
    write,
  } = parseArguments(process.argv.slice(2));
  if (!existsSync(manifestPath)) fail(`missing parity manifest: ${manifestPath}`);
  const raw = await readFile(manifestPath, "utf8");
  const manifest = parseManifest(JSON.parse(raw) as unknown);

  if (regenerate) {
    if (pythonRepository === undefined) {
      fail("regenerating the baseline requires --python-repo <path to a libtmux checkout>");
    }
    const count = await regenerateBaseline(manifest, baselinePath, pythonRepository);
    console.log(`Parity baseline regenerated: ${count} public symbols`);
    process.exit(0);
  }

  if (!existsSync(baselinePath)) fail(`missing parity baseline: ${baselinePath}`);
  const baseline = parseBaseline(JSON.parse(await readFile(baselinePath, "utf8")) as unknown);
  verifyBaseline(manifest, baseline);
  verifyManualProvenance(manifest, baseline.objects);
  verifyEvidencePaths(manifest, packageRoot);
  await verifyTypeScriptSymbols(manifest, packageManifestPath, packageRoot);
  const expected = baseline.symbols.map(baselineSymbol);
  const policyProblems = validateSymbolPolicies(manifest, expected);
  if (policyProblems.length > 0) fail(policyProblems.join("\n"));

  if (write) {
    const expectedKeys = new Set(expected.map(symbolKey));
    const removed = manifest.publicSymbols.map(symbolKey).filter((key) => !expectedKeys.has(key));
    if (removed.length > 0 && !allowBoundaryChange) {
      fail(
        `removed public symbol keys require --allow-boundary-change:\n${removed
          .map((key) => `- ${key}`)
          .join("\n")}`,
      );
    }
    const updated = renderUpdatedManifest(raw, mergeSymbols(expected, manifest.publicSymbols));
    const updatedManifest = parseManifest(JSON.parse(updated) as unknown);
    verifyManualProvenance(updatedManifest, baseline.objects);
    await atomicWrite(manifestPath, updated);
    console.log(`Parity manifest updated: ${expected.length} public symbols`);
  } else {
    const problems = validateInventory(manifest, expected);
    if (problems.length > 0) fail(problems.join("\n"));
    console.log(
      `Parity manifest valid: ${manifest.publicSymbols.length} public symbols, ${manifest.observableBehaviors.length} behaviors, ${manifest.typescriptExtensions.length} TypeScript extensions, ${manifest.internalExclusions.length} exclusions`,
    );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
