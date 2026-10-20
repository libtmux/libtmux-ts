import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { renderCapabilityManifest } from "../src/_internal/support/capabilities.js";

/** The manifest the docs read, committed at the repository root. */
export const MANIFEST_PATH = fileURLToPath(new URL("../../../capabilities.json", import.meta.url));

const usage = "usage: emit-capabilities.ts (--check|--write)";

async function main(argv: readonly string[]): Promise<number> {
  const [mode] = argv;
  if (argv.length !== 1 || (mode !== "--check" && mode !== "--write")) {
    console.error(usage);
    return 2;
  }
  const expected = renderCapabilityManifest();
  if (mode === "--write") {
    await writeFile(MANIFEST_PATH, expected);
    return 0;
  }
  const committed = await readFile(MANIFEST_PATH, "utf8").catch(() => undefined);
  if (committed === expected) return 0;
  console.error(`${MANIFEST_PATH} differs from support.capabilities; run bun run capabilities`);
  return 1;
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
