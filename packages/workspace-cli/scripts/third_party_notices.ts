/* eslint-disable no-await-in-loop -- The dependency walk reads one manifest at a time. */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const noticesPath = join(packageRoot, "THIRD-PARTY-NOTICES.md");

/**
 * Bare specifiers the bundle inlines. `libtmux` stays external and keeps its
 * own package, so its notice travels with it; every other import is copied
 * into `dist/` and its licence has to travel with ours.
 */
export const bundledRoots = ["cli-truncate", "commander", "string-width", "yaml"] as const;

const licenseNames = new Set(["LICENSE", "LICENCE", "COPYING", "NOTICE"]);

export type BundledPackage = {
  name: string;
  version: string;
  license: string;
  text: string;
};

async function licenseText(directory: string, name: string): Promise<string> {
  const entries = await readdir(directory);
  const file = entries.find((entry) => {
    const stem = entry.replace(/\.(md|txt)$/iu, "").toUpperCase();
    return licenseNames.has(stem);
  });
  if (file === undefined) throw new Error(`${name} ships no licence file`);
  return (await readFile(join(directory, file), "utf8")).replace(/\s+$/u, "");
}

/**
 * Every package the bundle inlines, in name order: the roots plus the runtime
 * dependencies they pull in, each resolved from the importer that names it so
 * a duplicated version is read from the copy that is actually bundled.
 */
export async function collectBundledPackages(
  roots: readonly string[] = bundledRoots,
): Promise<BundledPackage[]> {
  const found = new Map<string, BundledPackage>();
  const queue: { specifier: string; from: string }[] = roots.map((specifier) => ({
    specifier,
    from: join(packageRoot, "package.json"),
  }));
  while (queue.length > 0) {
    const { specifier, from } = queue.shift()!;
    const manifestPath = Bun.resolveSync(`${specifier}/package.json`, dirname(from));
    const directory = dirname(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name: string;
      version: string;
      license?: string;
      dependencies?: Record<string, string>;
    };
    const key = `${manifest.name}@${manifest.version}`;
    if (found.has(key)) continue;
    if (!manifest.license) throw new Error(`${key} declares no licence`);
    found.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      text: await licenseText(directory, key),
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      queue.push({ specifier: dependency, from: manifestPath });
  }
  return [...found.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

export function renderNotices(packages: readonly BundledPackage[]): string {
  const sections = packages.map(
    (entry) =>
      `## ${entry.name} ${entry.version}\n\nLicense: ${entry.license}\n\n\`\`\`text\n${entry.text}\n\`\`\`\n`,
  );
  return [
    "# Third-party notices",
    "",
    "`tmux-workspace` is distributed as a bundle: the packages below are compiled",
    "into `dist/` and their license terms are reproduced here in full, as those",
    "terms require. `libtmux` is not bundled and carries its own notice.",
    "",
    ...sections,
  ].join("\n");
}

/** Packages `text` fails to name at the version that is bundled. */
export function missingNotices(
  text: string,
  packages: readonly BundledPackage[],
): BundledPackage[] {
  return packages.filter((entry) => !text.includes(`## ${entry.name} ${entry.version}`));
}

if (import.meta.main) {
  const packages = await collectBundledPackages();
  const rendered = renderNotices(packages);
  if (process.argv.includes("--check")) {
    const current = await readFile(noticesPath, "utf8").catch(() => "");
    const missing = missingNotices(current, packages);
    if (missing.length > 0 || current !== rendered) {
      process.stderr.write(
        missing.length > 0
          ? `THIRD-PARTY-NOTICES.md omits ${missing.map((entry) => `${entry.name} ${entry.version}`).join(", ")}; run bun scripts/third_party_notices.ts\n`
          : "THIRD-PARTY-NOTICES.md is stale; run bun scripts/third_party_notices.ts\n",
      );
      process.exit(1);
    }
    process.stdout.write(`Third-party notices cover ${String(packages.length)} bundled packages\n`);
  } else {
    await Bun.write(noticesPath, rendered);
    process.stdout.write(`Wrote notices for ${String(packages.length)} bundled packages\n`);
  }
}
