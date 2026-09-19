/**
 * The Bun version this repository claims to run, checked across every place
 * it is written down: the CI gates matrix, the regex corpus, the
 * `packageManager` pin, the `engines.bun` floor in every manifest, and the
 * CONTRIBUTING prose that describes all of them. Nothing else ties the four
 * non-manifest places together, so any one of them can drift from the rest
 * until a build off an untested Bun ships. That drift already happened once
 * between the matrix and the corpus, and was fixed by hand.
 */

const VERSION_LITERAL = /\d+\.\d+\.\d+/gu;
const ENGINE_FLOOR = /^>=(\d+\.\d+\.\d+)$/u;
const PACKAGE_MANAGER_BUN = /^bun@(\d+\.\d+\.\d+)$/u;

/** Every `X.Y.Z` version literal in a piece of text, in the order it appears. */
export function extractVersionLiterals(text: string): readonly string[] {
  return [...text.matchAll(VERSION_LITERAL)].map((match) => match[0]);
}

/** The Bun version a `packageManager` field pins, or `undefined` if it does not pin Bun. */
export function bunFromPackageManager(packageManager: string): string | undefined {
  return PACKAGE_MANAGER_BUN.exec(packageManager)?.[1];
}

function sameVersions(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((version) => rightSet.has(version));
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function extremeVersion(
  versions: readonly string[],
  pick: "newest" | "oldest",
): string | undefined {
  if (versions.length === 0) return undefined;
  return [...versions].sort(compareVersions).at(pick === "newest" ? -1 : 0);
}

export interface BunEngineManifest {
  /** The manifest's path, for the failure message. */
  readonly path: string;
  /** The manifest's `engines.bun` field, verbatim (expected shape: `>=X.Y.Z`). */
  readonly spec: string;
}

export interface BunVersionSources {
  /** Version literals in CONTRIBUTING.md's packageManager-pin paragraph. */
  readonly contributingPin: readonly string[];
  /** The regex corpus's `runtimes.bun` list — the Bun versions it is evidence for. */
  readonly corpus: readonly string[];
  /** Every manifest's `engines.bun` field. */
  readonly engines: readonly BunEngineManifest[];
  /** The CI gates matrix's `bun-version` list. */
  readonly matrix: readonly string[];
  /** The Bun version `package.json`'s `packageManager` field pins. */
  readonly packageManager: string;
}

/**
 * Cross-checks the five places above and returns one message per
 * disagreement, or an empty array when they all agree.
 */
export function checkBunVersionAgreement(sources: BunVersionSources): readonly string[] {
  const { contributingPin, corpus, engines, matrix, packageManager } = sources;
  const failures: string[] = [];

  if (!sameVersions(matrix, corpus)) {
    failures.push(
      `the gates matrix runs Bun ${matrix.join(", ")} but the regex corpus records Bun ` +
        `${corpus.join(", ")} — the corpus is evidence only for the Bun versions it recorded ` +
        "results on, and every recorded version should be one CI actually runs",
    );
  }

  if (!sameVersions(matrix, contributingPin)) {
    failures.push(
      `CONTRIBUTING.md's packageManager-pin paragraph names Bun ${contributingPin.join(", ")} ` +
        `but the gates matrix runs Bun ${matrix.join(", ")} — the prose should name exactly the ` +
        "versions CI runs",
    );
  }

  if (!matrix.includes(packageManager)) {
    failures.push(
      `packageManager pins Bun ${packageManager}, which the gates matrix (${matrix.join(", ")}) ` +
        "does not run",
    );
  } else {
    // CONTRIBUTING states this as "the exact pin; CI also runs the floor and
    // the mid-range version" — packageManager tracks development on the
    // newest Bun the matrix has evidence for, not an arbitrary member of it.
    const newest = extremeVersion(matrix, "newest");
    if (newest !== packageManager) {
      failures.push(
        `packageManager pins Bun ${packageManager}, but the newest Bun the gates matrix runs is ` +
          `${newest} — the pin should track development on the newest tested Bun`,
      );
    }
  }

  const floor = extremeVersion(matrix, "oldest");
  for (const manifest of engines) {
    const engineFloor = ENGINE_FLOOR.exec(manifest.spec)?.[1];
    if (engineFloor === undefined) {
      failures.push(
        `${manifest.path}: engines.bun is ${JSON.stringify(manifest.spec)}, not a >=X.Y.Z floor`,
      );
      continue;
    }
    if (engineFloor !== floor) {
      failures.push(
        `${manifest.path}: engines.bun requires >=${engineFloor}, but the oldest Bun the gates ` +
          `matrix runs is ${floor ?? "none"}`,
      );
    }
  }

  return failures;
}
