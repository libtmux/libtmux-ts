import { posix } from "node:path";

function normalizePackagePath(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function collectStrings(value: unknown, targets: string[]): void {
  if (typeof value === "string") {
    targets.push(normalizePackagePath(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, targets);
  }
}

function collectTypeConditions(value: unknown, targets: string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [condition, target] of Object.entries(value)) {
    if (condition === "types") collectStrings(target, targets);
    else collectTypeConditions(target, targets);
  }
}

/** Return every declaration file named by a package export's `types` condition. */
export function packageDeclarationExports(exports: unknown): string[] {
  const targets: string[] = [];
  collectTypeConditions(exports, targets);
  return [...new Set(targets)].toSorted();
}

/**
 * Compare TypeScript's resolved declaration graph with the declarations a
 * packed package exposes through `exports`.
 */
export function declarationClosureErrors(
  packedDeclarations: readonly string[],
  exportedDeclarations: readonly string[],
  resolvedDeclarations: readonly string[],
): string[] {
  const packed = new Set(packedDeclarations.map(normalizePackagePath));
  const exported = new Set(exportedDeclarations.map(normalizePackagePath));
  const resolved = new Set(resolvedDeclarations.map(normalizePackagePath));
  const errors: string[] = [];

  if (exported.size === 0) errors.push("package has no declaration exports");

  for (const target of exported) {
    if (!packed.has(target)) errors.push(`package export ${target} is not packed`);
    if (!resolved.has(target)) errors.push(`package export ${target} was not resolved`);
  }
  for (const target of resolved) {
    if (!packed.has(target)) errors.push(`resolved declaration ${target} is not packed`);
    else if (!exported.has(target)) {
      errors.push(`resolved declaration ${target} is not a package export`);
    }
  }

  return errors.toSorted();
}
