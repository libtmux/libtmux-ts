import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every published package keeps its own `CHANGELOG.md`.
 *
 * One file once held all four packages' history, and nothing noticed a package
 * without one: its tarball simply carried none. Each claim below is answerable
 * from the package directory:
 *
 * - the file exists;
 * - it opens with the name of the package it sits in, so a copy of another
 *   package's changelog fails where it was pasted;
 * - it has an `Unreleased` section for the next release to land under; and
 * - the manifest's `files` ships it.
 */
export interface PackageChangelog {
  /** The file's text, or `undefined` when the package has none. */
  readonly changelog: string | undefined;
  /** The package's directory under `packages/`. */
  readonly directory: string;
  /** The manifest's `files` field, verbatim. */
  readonly files: unknown;
  /** The package's npm name. */
  readonly name: string;
}

const OPENING = /^Notable changes to `([^`]+)`\.$/mu;

function hasHeading(markdown: string, heading: string): boolean {
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/u.test(line)) fenced = !fenced;
    else if (!fenced && line === heading) return true;
  }
  return false;
}

/** Every way the packages' changelogs fall short of the policy above. */
export function changelogFailures(packages: readonly PackageChangelog[]): readonly string[] {
  const failures: string[] = [];
  for (const { changelog, directory, files, name } of packages) {
    const path = `packages/${directory}/CHANGELOG.md`;
    if (!Array.isArray(files) || !files.includes("CHANGELOG.md")) {
      failures.push(`packages/${directory}/package.json: \`files\` does not ship CHANGELOG.md`);
    }
    if (changelog === undefined) {
      failures.push(`${path}: ${name} is published and has no changelog`);
      continue;
    }
    const opening = OPENING.exec(changelog)?.[1];
    if (opening === undefined) {
      failures.push(`${path}: does not open with "Notable changes to \`${name}\`."`);
    } else if (opening !== name) {
      failures.push(`${path}: is the changelog of ${opening}, not ${name}`);
    }
    if (!hasHeading(changelog, "## Unreleased")) {
      failures.push(`${path}: has no "## Unreleased" section`);
    }
  }
  return failures;
}

/** The changelog state of every non-private package under `packages/`, in directory order. */
export async function readPackageChangelogs(
  repositoryRoot: string,
): Promise<readonly PackageChangelog[]> {
  const directories = (await readdir(join(repositoryRoot, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
  const packages: PackageChangelog[] = [];
  for (const directory of directories) {
    const root = join(repositoryRoot, "packages", directory);
    // eslint-disable-next-line no-await-in-loop -- a handful of packages, read in order.
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      readonly files?: unknown;
      readonly name?: unknown;
      readonly private?: unknown;
    };
    if (typeof manifest.name !== "string" || manifest.private === true) continue;
    // eslint-disable-next-line no-await-in-loop -- as above.
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8").catch(() => undefined);
    packages.push({ changelog, directory, files: manifest.files, name: manifest.name });
  }
  return packages;
}
