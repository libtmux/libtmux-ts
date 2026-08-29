interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: readonly string[];
}

export interface ReleaseManifest {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
}

export interface ReleasePackageDescriptor {
  readonly directory: string;
  readonly internalVersionFields: readonly string[];
  readonly name: string;
}

export interface ReleaseManifestSource {
  readonly document: unknown;
  readonly path: string;
  readonly releasePackage: ReleasePackageDescriptor;
}

const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const RELEASE_PACKAGES: readonly ReleasePackageDescriptor[] = [
  { directory: "libtmux", internalVersionFields: [], name: "libtmux" },
  { directory: "mcp", internalVersionFields: ["dependencies"], name: "@libtmux/mcp" },
  {
    directory: "workspace",
    internalVersionFields: ["peerDependencies", "devDependencies"],
    name: "@libtmux/workspace",
  },
];

function parseSemanticVersion(value: string): SemanticVersion {
  const match = SEMANTIC_VERSION.exec(value);
  if (match === null) throw new Error(`${value} is not a semantic version`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    ![major, minor, patch].every(Number.isSafeInteger)
  ) {
    throw new Error(`${value} is not a semantic version`);
  }
  const prerelease = match[4]?.split(".");
  if (prerelease?.some((part) => /^0\d+$/u.test(part)) === true) {
    throw new Error(`${value} is not a semantic version`);
  }
  return prerelease === undefined ? { major, minor, patch } : { major, minor, patch, prerelease };
}

export function assertSemanticVersion(value: string): void {
  parseSemanticVersion(value);
}

export function compareSemanticVersions(leftValue: string, rightValue: string): number {
  const left = parseSemanticVersion(leftValue);
  const right = parseSemanticVersion(rightValue);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === undefined) return right.prerelease === undefined ? 0 : 1;
  if (right.prerelease === undefined) return -1;

  const numeric = /^\d+$/u;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = numeric.test(leftPart);
    const rightNumeric = numeric.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) {
        return leftPart.length < rightPart.length ? -1 : 1;
      }
      return leftPart < rightPart ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function assertMinimumNpm(value: string): void {
  const installed = parseSemanticVersion(value.trim());
  const actual = [installed.major, installed.minor, installed.patch];
  const minimum = [11, 5, 1];
  for (const [index, required] of minimum.entries()) {
    const found = actual[index];
    if (found === undefined) break;
    if (found > required) return;
    if (found < required) throw new Error(`npm 11.5.1 or newer is required; found ${value.trim()}`);
  }
  if (installed.prerelease !== undefined) {
    throw new Error(`npm 11.5.1 or newer is required; found ${value.trim()}`);
  }
}

function internalVersion(document: Record<string, unknown>, field: string): unknown {
  const dependencies = document[field];
  return typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies)
    ? (dependencies as Record<string, unknown>).libtmux
    : undefined;
}

export function validateReleaseManifests(
  sources: readonly ReleaseManifestSource[],
): readonly ReleaseManifest[] {
  const documents = sources.map(({ document: value, path, releasePackage }) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${path} must contain a package manifest object`);
    }
    const document = value as Record<string, unknown>;
    if (document.name !== releasePackage.name) {
      throw new Error(
        `${path} must name ${releasePackage.name}, not ${JSON.stringify(document.name)}`,
      );
    }
    if (typeof document.version !== "string") throw new Error(`${path} has no version`);
    parseSemanticVersion(document.version);
    return { document, path, releasePackage, version: document.version };
  });

  const versions = new Set(documents.map(({ version }) => version));
  if (versions.size !== 1) {
    throw new Error(
      `release package versions are not lockstep: ${documents.map(({ releasePackage, version }) => `${releasePackage.name}@${version}`).join(", ")}`,
    );
  }
  const version = documents[0]?.version;
  if (version === undefined) throw new Error("no release packages are configured");

  for (const { document, path, releasePackage } of documents) {
    for (const field of releasePackage.internalVersionFields) {
      const found = internalVersion(document, field);
      if (found !== version) {
        throw new Error(
          `${path} ${field}.libtmux must be ${version}, not ${JSON.stringify(found)}`,
        );
      }
    }
  }

  return documents.map(({ releasePackage, version: manifestVersion }) => ({
    directory: releasePackage.directory,
    name: releasePackage.name,
    version: manifestVersion,
  }));
}

export function selectDistTag(
  version: string,
  latestVersions: readonly (string | undefined)[],
): string {
  const release = parseSemanticVersion(version);
  if (release.prerelease === undefined) return "latest";

  const latestKinds = new Set(
    latestVersions.map((latest) =>
      latest === undefined || parseSemanticVersion(latest).prerelease !== undefined
        ? "prerelease"
        : "stable",
    ),
  );
  if (latestKinds.size > 1) {
    throw new Error("registry latest tags disagree about whether a stable release exists");
  }
  if (!latestKinds.has("stable")) return "latest";

  const channel = release.prerelease[0];
  if (
    channel === undefined ||
    channel === "latest" ||
    channel === "x" ||
    channel.startsWith("v") ||
    !/^[a-z][a-z0-9-]*$/u.test(channel)
  ) {
    throw new Error(`${version} has no safe npm dist-tag prerelease channel`);
  }
  return channel;
}
