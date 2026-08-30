import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evidenceRecords, exactKeys, fail, objectAt, stringAt } from "./manifest.js";
import type { ParityKind, ParityManifest } from "./manifest.js";

function claimsMember(kind: ParityKind | null, typescript: string | null): boolean {
  if (kind === "method" || kind === "property") return true;
  return typescript !== null && /^[A-Z][A-Za-z0-9_]*\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(typescript);
}

const typescriptSymbolPattern =
  /^(?:\.|\.\/[a-z][a-z0-9_-]*)#(?:type|value|instance|well-known-instance):[A-Za-z_$][A-Za-z0-9_$]*(?:<[A-Za-z_$][A-Za-z0-9_$]*(?:,\s*[A-Za-z_$][A-Za-z0-9_$]*)*>)?(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

interface TypeScriptSymbolLocator {
  kind: "instance" | "type" | "value" | "well-known-instance";
  moduleName: string;
  path: string[];
  raw: string;
  typeArguments: string;
}

function parseTypeScriptSymbol(key: string, locator: string): TypeScriptSymbolLocator {
  if (!typescriptSymbolPattern.test(locator)) {
    fail(`${key} has invalid TypeScript symbol locator: ${locator}`);
  }
  const separator = locator.indexOf("#");
  const moduleName = locator.slice(0, separator);
  const [kind, symbol] = locator.slice(separator + 1).split(":", 2) as [
    TypeScriptSymbolLocator["kind"],
    string,
  ];
  const opening = symbol.indexOf("<");
  const closing = symbol.indexOf(">");
  const typeArguments = opening === -1 ? "" : symbol.slice(opening, closing + 1);
  const bare = opening === -1 ? symbol : `${symbol.slice(0, opening)}${symbol.slice(closing + 1)}`;
  const path = bare.split(".");
  if (typeArguments !== "" && kind !== "type") {
    fail(`${key} type arguments are only meaningful on a type locator: ${locator}`);
  }
  if (typeArguments !== "" && path.length < 2) {
    fail(`${key} type arguments say nothing without a member to read: ${locator}`);
  }
  if (kind === "instance" && path.length < 2) {
    fail(`${key} instance symbol locator requires a member: ${locator}`);
  }
  if (
    kind === "well-known-instance" &&
    (path.length !== 2 || !["asyncDispose", "dispose", "iterator"].includes(path[1]!))
  ) {
    fail(`${key} has invalid well-known TypeScript symbol locator: ${locator}`);
  }
  return { kind, moduleName, path, raw: locator, typeArguments };
}

function probeType(locator: TypeScriptSymbolLocator, index: number): string {
  const [top, ...members] = locator.path;
  const indexedMembers = members.map((member) => `["${member}"]`).join("");
  if (locator.kind === "type") {
    if (members.length === 0) return "";
    return `type ParityTarget${index} = ParityTypes${index}.${top}${locator.typeArguments}${indexedMembers};`;
  }
  if (locator.kind === "instance") {
    return `type ParityTarget${index} = (typeof ParityValues${index}.${top}.prototype)${indexedMembers};`;
  }
  if (locator.kind === "well-known-instance") {
    return `type ParityTarget${index} = (typeof ParityValues${index}.${top}.prototype)[typeof Symbol.${members[0]}];`;
  }
  return `type ParityTarget${index} = (typeof ParityValues${index}.${top})${indexedMembers};`;
}

interface ExportSource {
  importPath: string;
  relativePath: string;
}

function exportSource(moduleName: string, value: unknown): ExportSource {
  const path = `package.exports[${JSON.stringify(moduleName)}]`;
  const conditions = objectAt(value, path);
  exactKeys(conditions, ["types", "bun", "import", "default"], path);
  const typesTarget = stringAt(conditions, "types", path);
  const bunTarget = stringAt(conditions, "bun", path);
  const importTarget = stringAt(conditions, "import", path);
  const defaultTarget = stringAt(conditions, "default", path);
  const typesMatch = /^\.\/dist\/([a-z][a-z0-9_/-]*)\.d\.ts$/.exec(typesTarget);
  const bunMatch = /^\.\/src\/([a-z][a-z0-9_/-]*)\.ts$/.exec(bunTarget);
  const importMatch = /^\.\/dist\/([a-z][a-z0-9_/-]*)\.js$/.exec(importTarget);
  const defaultMatch = /^\.\/dist\/([a-z][a-z0-9_/-]*)\.js$/.exec(defaultTarget);
  if (
    !typesMatch?.[1] ||
    !bunMatch?.[1] ||
    !importMatch?.[1] ||
    !defaultMatch?.[1] ||
    typesMatch[1] !== bunMatch[1] ||
    bunMatch[1] !== importMatch[1] ||
    importMatch[1] !== defaultMatch[1]
  ) {
    fail(`${path} must have aligned ./dist types, ./src bun, import, and default targets`);
  }
  return {
    importPath: `${bunTarget.slice(0, -3)}.js`,
    relativePath: bunTarget,
  };
}

export async function verifyTypeScriptSymbols(
  manifest: ParityManifest,
  packageManifestPath: string,
  packageRoot: string,
): Promise<void> {
  const parsed = evidenceRecords(manifest).flatMap(({ key, kind, record }) =>
    record.typescriptSymbols.map((raw) => ({
      activated: record.status === "implemented" || record.status === "adapted",
      claimsMember: claimsMember(kind, record.typescript),
      key,
      locator: parseTypeScriptSymbol(key, raw),
    })),
  );
  const activated = parsed.filter(({ activated }) => activated);
  if (activated.length === 0) return;

  const unpinned = activated.filter((entry) => entry.claimsMember && entry.locator.path.length < 2);
  if (unpinned.length > 0) {
    fail(
      `${String(unpinned.length)} member rows cite only their class, which proves nothing about the member:\n${unpinned
        .map(({ key, locator }) => `  ${key} -> ${locator.raw}\n`)
        .join("")}`,
    );
  }

  const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const exports = packageManifest.exports ?? {};
  const locators: TypeScriptSymbolLocator[] = [];
  const sources: ExportSource[] = [];
  const keys: string[] = [];
  for (const { key, locator } of activated) {
    if (!Object.hasOwn(exports, locator.moduleName)) {
      fail(`${key} TypeScript module is not exported: ${locator.moduleName}`);
    }
    const source = exportSource(locator.moduleName, exports[locator.moduleName]);
    const sourcePath = join(packageRoot, source.relativePath);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      fail(`TypeScript module source does not exist for export target: ${source.relativePath}`);
    }
    locators.push(locator);
    sources.push(source);
    keys.push(key);
  }

  const imports = locators.flatMap((locator, index) => {
    const source = sources[index]!.importPath;
    if (locator.kind === "type" && locator.path.length === 1) {
      return [`import type { ${locator.path[0]} as ParityImportedType${index} } from "${source}";`];
    }
    return locator.kind === "type"
      ? [`import type * as ParityTypes${index} from "${source}";`]
      : [`import * as ParityValues${index} from "${source}";`];
  });
  const probe = `${imports.join("\n")}\n\n${locators.map(probeType).join("\n")}\n\nexport {};\n`;
  const identifier = randomUUID();
  const probeName = `.parity-symbols-${identifier}.ts`;
  const configName = `.parity-symbols-${identifier}.json`;
  const probePath = join(packageRoot, probeName);
  const configPath = join(packageRoot, configName);
  const config = `${JSON.stringify(
    {
      extends: "./tsconfig.json",
      compilerOptions: {
        declaration: false,
        isolatedDeclarations: false,
        noEmit: true,
        rootDir: ".",
      },
      files: [probeName],
    },
    null,
    2,
  )}\n`;
  try {
    await Promise.all([writeFile(probePath, probe, { flag: "wx" }), writeFile(configPath, config)]);
    const result = Bun.spawnSync(
      [join(packageRoot, "node_modules/.bin/tsc"), "-p", configPath, "--pretty", "false"],
      { cwd: packageRoot, stderr: "pipe", stdout: "pipe" },
    );
    if (result.exitCode !== 0) {
      const diagnostics = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
      const blamed = new Map<string, string>();
      for (const [, line] of diagnostics.matchAll(
        new RegExp(`^${probeName.replaceAll(".", "\\.")}\\((\\d+),\\d+\\)`, "gmu"),
      )) {
        const reported = Number(line);
        const index = reported <= imports.length ? reported - 1 : reported - (imports.length + 2);
        const locator = locators[index];
        if (locator !== undefined) blamed.set(locator.raw, keys[index] ?? "");
      }
      const attribution =
        blamed.size > 0
          ? `${[...blamed].map(([raw, key]) => `  ${key} -> ${raw}\n`).join("")}`
          : "  (no row could be blamed; the probe itself may be malformed)\n";
      fail(
        `TypeScript symbols that do not exist or do not typecheck:\n${attribution}\n${diagnostics}`,
      );
    }
  } finally {
    await Promise.all([
      unlink(probePath).catch(() => undefined),
      unlink(configPath).catch(() => undefined),
    ]);
  }
}
