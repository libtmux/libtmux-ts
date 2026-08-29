import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

/**
 * The parity manifest is an evidence ledger against libtmux 0.62.0. Every one
 * of the release's public symbols carries a decision: `implemented` and
 * `adapted` name the TypeScript that covers it and the test that proves it,
 * and `unsupported` gives the reason it was not ported.
 *
 * These tests check that a recorded mapping is true. `bun run parity` validates
 * the file's own shape — schema, evidence lanes — and never compares a claim to
 * the code, so a mapping could name a symbol the package does not export and
 * stay green.
 */

interface ParitySymbol {
  readonly python: string;
  readonly status: string;
  readonly typescript: string | null;
  readonly typescriptSymbols: readonly string[];
}

const modelClasses = ["Client", "Pane", "Selection", "Server", "Session", "Window"] as const;

async function manifest(): Promise<readonly ParitySymbol[]> {
  const parsed = JSON.parse(
    await readFile(new URL("../../parity/python-0.62.0.json", import.meta.url), "utf8"),
  ) as { publicSymbols: readonly ParitySymbol[] };
  return parsed.publicSymbols;
}

const publicModules = [
  "index",
  "common",
  "constants",
  "exc",
  "formats",
  "server",
  "session",
  "window",
  "pane",
  "client",
  "selection",
] as const;

/** Every name the package offers, across all its entrypoints. */
async function surface(): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  for (const module of publicModules) {
    // eslint-disable-next-line no-await-in-loop -- a fixed, small set of entrypoints.
    const loaded = (await import(`../../src/${module}.js`)) as Record<string, unknown>;
    for (const name of Object.keys(loaded)) names.add(name);
  }
  const root = (await import("../../src/index.js")) as Record<string, unknown>;
  for (const model of modelClasses) {
    const value = root[model];
    if (typeof value !== "function") continue;
    for (const member of Object.getOwnPropertyNames(value.prototype as object)) {
      if (member !== "constructor") names.add(`${model}.${member}`);
    }
  }
  return names;
}

/**
 * The `./module#kind:Name` form the manifest uses.
 *
 * `instance` carries a member as well as its class — `Window.resize` — which
 * is the qualified shape `surface()` produces, so pinning a member rather than
 * only its class resolves here rather than reading as a name nothing offers.
 */
function symbolName(reference: string): string {
  const named =
    /#(?<kind>value|type|class|function|instance):(?<name>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/u.exec(
      reference,
    );
  const name = named?.groups?.name;
  if (name === undefined) return reference;
  // Only an `instance` reference names a member. Everywhere else the dotted
  // tail belongs to the export rather than to the name the package offers, so
  // an enum member resolves through the enum it lives on.
  return named?.groups?.kind === "instance" ? name : (name.split(".")[0] ?? name);
}

/**
 * Names the package exports as types only.
 *
 * `Selection` is deliberately a type with no runtime class, so a claim naming
 * it cannot be resolved by importing the module. Reading the declarations is
 * how a type-only claim gets checked at all.
 */
async function exportedTypes(): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  const sources = await Promise.all(
    publicModules.map(async (module) =>
      readFile(new URL(`../../src/${module}.ts`, import.meta.url), "utf8"),
    ),
  );
  for (const source of sources) {
    for (const match of source.matchAll(
      /^export (?:declare )?(?:interface|type|class) (?<name>[A-Za-z_$][\w$]*)/gmu,
    )) {
      const name = match.groups?.name;
      if (name !== undefined) names.add(name);
    }
    for (const match of source.matchAll(/^ {2}(?<name>[A-Za-z_$][\w$]*),$/gmu)) {
      const name = match.groups?.name;
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

describe("parity claims", () => {
  test("every claimed TypeScript symbol exists in the package", async () => {
    const offered = new Set([...(await surface()), ...(await exportedTypes())]);
    const rows = await manifest();
    const claimed = rows.filter((row) => row.typescriptSymbols.length > 0);

    expect(claimed.length).toBeGreaterThan(0);
    const missing = claimed
      .flatMap((row) => row.typescriptSymbols.map((reference) => ({ reference, row })))
      .filter(({ reference }) => {
        const name = symbolName(reference);
        // A model member is claimed as `Class.member`; anything else is a
        // module-level export.
        return !offered.has(name) && !offered.has(name.split(".").at(-1) ?? name);
      })
      .map(({ reference, row }) => `${row.python} -> ${reference}`);

    expect(missing).toEqual([]);
  });

  test("a row claiming a port names what it ported to", async () => {
    const rows = await manifest();

    // "implemented" and "adapted" assert the symbol exists here, and a row that
    // asserts it without naming it is a claim nothing can check.
    const unnamed = rows
      .filter((row) => row.status === "implemented" || row.status === "adapted")
      .filter((row) => row.typescript === null || row.typescriptSymbols.length === 0)
      .map((row) => row.python);

    expect(unnamed).toEqual([]);
  });

  test("states how much of the Python surface it actually tracks", async () => {
    const rows = await manifest();
    const tracked = rows.filter((row) => row.typescriptSymbols.length > 0);

    // Nineteen inert Python exception classes are now explicitly unsupported.
    // Keep the remaining ported surface as a floor so further loss stays red.
    expect(tracked.length).toBeGreaterThanOrEqual(240);
    // The Python surface is pinned by the baseline tag, so this one is exact.
    expect(rows.length).toBe(513);
  });
});
