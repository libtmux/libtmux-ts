import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { npmPack } from "./npm_pack.js";

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: readonly string[];
}

export interface RegistryPackageState {
  readonly distTags: Readonly<Record<string, string>>;
}

export interface RegistryVersionState {
  readonly integrity: string;
}

interface PackedArtifact {
  readonly entries: readonly string[];
  readonly filename: string;
  readonly integrity: string;
  readonly name: string;
  readonly tarballPath: string;
  readonly version: string;
}

export interface ReleaseIO {
  npmVersion(): Promise<string>;
  pack(packageRoot: string, destination: string): Promise<PackedArtifact>;
  publish(tarballPath: string, tag: string, dryRun: boolean): Promise<void>;
  queryPackage(name: string): Promise<RegistryPackageState>;
  queryVersion(name: string, version: string): Promise<RegistryVersionState | undefined>;
  wait(milliseconds: number): Promise<void>;
}

export interface CoordinateReleaseOptions {
  readonly artifactDirectory: string;
  readonly dryRun: boolean;
  readonly eventName: string;
  readonly refName?: string;
  readonly repositoryRoot: string;
}

export interface ReleaseReport {
  readonly distTag: string;
  readonly dryRun: boolean;
  readonly published: readonly string[];
  readonly skipped: readonly string[];
  readonly version: string;
}

export interface NpmCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type NpmCommandRunner = (arguments_: readonly string[]) => Promise<NpmCommandResult>;

export function createNpmCommandRunner(
  command: readonly string[] = ["npm"],
  timeoutMilliseconds = 60_000,
): NpmCommandRunner {
  if (command.length === 0) throw new Error("npm command cannot be empty");
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new Error("npm command timeout must be a positive integer");
  }
  return async (arguments_) => {
    const child = Bun.spawn([...command, ...arguments_], {
      env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
      stderr: "pipe",
      stdout: "pipe",
    });
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      child.kill("SIGTERM");
    }, timeoutMilliseconds);
    const hardDeadline = setTimeout(() => child.kill("SIGKILL"), timeoutMilliseconds + 5_000);
    deadline.unref?.();
    hardDeadline.unref?.();
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return {
        exitCode: expired && exitCode === 0 ? 1 : exitCode,
        stderr: expired
          ? `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}npm command exceeded ${String(timeoutMilliseconds)}ms\n`
          : stderr,
        stdout,
      };
    } finally {
      clearTimeout(deadline);
      clearTimeout(hardDeadline);
    }
  };
}

export class RegistryPackageNotFound extends Error {
  readonly packageName: string;

  constructor(packageName: string) {
    super(`registry package ${packageName} was not found`);
    this.name = "RegistryPackageNotFound";
    this.packageName = packageName;
  }
}

const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const releasePackages = [
  { directory: "libtmux", name: "libtmux" },
  { directory: "mcp", name: "@libtmux/mcp" },
  { directory: "workspace", name: "@libtmux/workspace" },
] as const;

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

function assertMinimumNpm(value: string): void {
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

interface ReleaseManifest {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
}

async function readReleaseManifests(repositoryRoot: string): Promise<readonly ReleaseManifest[]> {
  return await Promise.all(
    releasePackages.map(async ({ directory, name }) => {
      const path = `${repositoryRoot}/packages/${directory}/package.json`;
      const value = (await Bun.file(path).json()) as { readonly name?: unknown; version?: unknown };
      if (value.name !== name) {
        throw new Error(`${path} must name ${name}, not ${JSON.stringify(value.name)}`);
      }
      if (typeof value.version !== "string") throw new Error(`${path} has no version`);
      parseSemanticVersion(value.version);
      return { directory, name, version: value.version };
    }),
  );
}

async function queryPackages(
  manifests: readonly ReleaseManifest[],
  io: ReleaseIO,
): Promise<readonly RegistryPackageState[]> {
  try {
    return await Promise.all(manifests.map(async ({ name }) => await io.queryPackage(name)));
  } catch (error) {
    if (error instanceof RegistryPackageNotFound) {
      throw new Error(`established package ${error.packageName} is missing from the registry`, {
        cause: error,
      });
    }
    throw error;
  }
}

function existingArtifactFailure(
  artifact: PackedArtifact,
  state: RegistryVersionState,
  packageState: RegistryPackageState,
  distTag: string,
): string | undefined {
  if (state.integrity !== artifact.integrity) {
    return `${artifact.name}@${artifact.version} already exists with different integrity`;
  }
  if (packageState.distTags[distTag] !== artifact.version) {
    return `${artifact.name}@${artifact.version} matches the local tarball, but ${distTag} points to ${packageState.distTags[distTag] ?? "nothing"}; trusted publishing cannot change dist-tags, so repair the ${distTag} dist-tag with an authenticated npm session`;
  }
  return undefined;
}

async function verifyPostcondition(
  manifests: readonly ReleaseManifest[],
  artifacts: readonly PackedArtifact[],
  distTag: string,
  io: ReleaseIO,
): Promise<void> {
  const packageStates = await queryPackages(manifests, io);
  const versionStates = await Promise.all(
    manifests.map(async ({ name, version }) => await io.queryVersion(name, version)),
  );
  const failures: string[] = [];
  for (const [index, manifest] of manifests.entries()) {
    const packageState = packageStates[index];
    const versionState = versionStates[index];
    const artifact = artifacts[index];
    if (packageState === undefined || artifact === undefined) {
      failures.push(`${manifest.name}: release state was not read`);
      continue;
    }
    if (versionState === undefined) {
      failures.push(`${manifest.name}@${manifest.version}: version is missing`);
    } else if (versionState.integrity !== artifact.integrity) {
      failures.push(`${manifest.name}@${manifest.version}: integrity differs from the tarball`);
    }
    if (packageState.distTags[distTag] !== manifest.version) {
      failures.push(`${manifest.name}@${distTag}: expected ${manifest.version}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `release postcondition failed:\n${failures.map((failure) => `  ${failure}`).join("\n")}`,
    );
  }
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
  if (channel === undefined || channel === "latest" || !/^[a-z][a-z0-9-]*$/u.test(channel)) {
    throw new Error(`${version} has no safe npm dist-tag prerelease channel`);
  }
  return channel;
}

function npmErrorCode(result: NpmCommandResult): string | undefined {
  for (const source of [result.stderr, result.stdout]) {
    try {
      const document = JSON.parse(source) as { readonly error?: { readonly code?: unknown } };
      if (typeof document.error?.code === "string") return document.error.code;
    } catch {
      // npm emits ordinary text for some local failures.
    }
  }
  return undefined;
}

function npmFailure(arguments_: readonly string[], result: NpmCommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic";
  return new Error(
    `npm ${arguments_[0] ?? "command"} exited ${String(result.exitCode)}: ${detail}`,
  );
}

function parseNpmJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`npm returned invalid JSON for ${description}: ${value}`);
  }
}

export function createReleaseIO(runner: NpmCommandRunner): ReleaseIO {
  return {
    npmVersion: async () => {
      const arguments_ = ["--version"];
      const result = await runner(arguments_);
      if (result.exitCode !== 0) throw npmFailure(arguments_, result);
      const version = result.stdout.trim();
      if (version === "") throw new Error("npm --version returned no version");
      return version;
    },
    pack: npmPack,
    publish: async (tarballPath, tag, dryRun) => {
      const arguments_ = ["publish", tarballPath, "--tag", tag];
      if (dryRun) arguments_.push("--dry-run");
      const result = await runner(arguments_);
      if (result.exitCode !== 0) throw npmFailure(arguments_, result);
    },
    queryPackage: async (name) => {
      const arguments_ = ["view", name, "dist-tags", "--json", "--loglevel=silent"];
      const result = await runner(arguments_);
      if (result.exitCode !== 0) {
        if (npmErrorCode(result) === "E404") throw new RegistryPackageNotFound(name);
        throw npmFailure(arguments_, result);
      }
      const document = parseNpmJson(result.stdout, `${name} dist-tags`);
      if (typeof document !== "object" || document === null || Array.isArray(document)) {
        throw new Error(`npm returned invalid dist-tags for ${name}`);
      }
      const distTags: Record<string, string> = {};
      for (const [tag, version] of Object.entries(document)) {
        if (typeof version !== "string") {
          throw new Error(`npm returned an invalid ${tag} dist-tag for ${name}`);
        }
        try {
          parseSemanticVersion(version);
        } catch {
          throw new Error(`npm returned an invalid ${tag} dist-tag for ${name}`);
        }
        distTags[tag] = version;
      }
      return { distTags };
    },
    queryVersion: async (name, version) => {
      const specifier = `${name}@${version}`;
      const arguments_ = ["view", specifier, "dist.integrity", "--json", "--loglevel=silent"];
      const result = await runner(arguments_);
      if (result.exitCode !== 0) {
        if (npmErrorCode(result) === "E404") return undefined;
        throw npmFailure(arguments_, result);
      }
      const integrity = parseNpmJson(result.stdout, `${specifier} integrity`);
      if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
        throw new Error(`npm returned invalid integrity for ${specifier}`);
      }
      return { integrity };
    },
    wait: async (milliseconds) => await Bun.sleep(milliseconds),
  };
}

export async function coordinateRelease(
  options: CoordinateReleaseOptions,
  io: ReleaseIO,
): Promise<ReleaseReport> {
  if (options.eventName === "workflow_dispatch" && !options.dryRun) {
    throw new Error("workflow_dispatch is dry-run only");
  }
  if (options.eventName !== "push" && options.eventName !== "workflow_dispatch") {
    throw new Error(`unsupported release event ${options.eventName}`);
  }

  assertMinimumNpm(await io.npmVersion());
  const manifests = await readReleaseManifests(options.repositoryRoot);
  const versions = new Set(manifests.map(({ version }) => version));
  if (versions.size !== 1) {
    throw new Error(
      `release package versions are not lockstep: ${manifests.map(({ name, version }) => `${name}@${version}`).join(", ")}`,
    );
  }
  const version = manifests[0]?.version;
  if (version === undefined) throw new Error("no release packages are configured");
  if (options.eventName === "push" && options.refName !== `v${version}`) {
    throw new Error(`release tag ${options.refName ?? "is missing"}; expected v${version}`);
  }

  const artifacts = await Promise.all(
    manifests.map(
      async ({ directory }) =>
        await io.pack(`${options.repositoryRoot}/packages/${directory}`, options.artifactDirectory),
    ),
  );
  for (const [index, artifact] of artifacts.entries()) {
    const manifest = manifests[index];
    if (manifest === undefined) throw new Error("packed an unknown release package");
    if (artifact.name !== manifest.name || artifact.version !== manifest.version) {
      throw new Error(
        `${artifact.filename} is ${artifact.name}@${artifact.version}; expected ${manifest.name}@${manifest.version}`,
      );
    }
    if (!artifact.entries.some((entry) => entry.startsWith("dist/"))) {
      throw new Error(`${artifact.name}@${artifact.version} tarball has no dist output`);
    }
  }

  const packageStates = await queryPackages(manifests, io);
  const versionStates = await Promise.all(
    manifests.map(async ({ name }) => await io.queryVersion(name, version)),
  );
  const distTag = selectDistTag(
    version,
    packageStates.map(({ distTags }) => distTags.latest),
  );
  const skipped: string[] = [];
  const pending: PackedArtifact[] = [];
  const failures: string[] = [];
  for (const [index, artifact] of artifacts.entries()) {
    const versionState = versionStates[index];
    const packageState = packageStates[index];
    if (packageState === undefined) {
      failures.push(`${artifact.name}: package state was not read`);
    } else if (versionState === undefined) {
      pending.push(artifact);
    } else {
      const failure = existingArtifactFailure(artifact, versionState, packageState, distTag);
      if (failure === undefined) skipped.push(artifact.name);
      else failures.push(failure);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));

  const published: string[] = [];
  for (const artifact of pending) {
    // eslint-disable-next-line no-await-in-loop -- leave one recoverable published prefix.
    await io.publish(artifact.tarballPath, distTag, options.dryRun);
    published.push(artifact.name);
  }
  if (!options.dryRun) {
    let postconditionError: unknown;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each read follows the prior delay.
        await verifyPostcondition(manifests, artifacts, distTag, io);
        postconditionError = undefined;
        break;
      } catch (error) {
        postconditionError = error;
        // eslint-disable-next-line no-await-in-loop -- bound registry convergence between reads.
        if (attempt < 5) await io.wait(1_000);
      }
    }
    if (postconditionError !== undefined) throw postconditionError;
  }
  return { distTag, dryRun: options.dryRun, published, skipped, version };
}

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const refName = process.env.GITHUB_REF_NAME;
  const artifactDirectory = await mkdtemp(join(tmpdir(), "ltx-release-"));
  try {
    const report = await coordinateRelease(
      {
        artifactDirectory,
        dryRun: eventName === "workflow_dispatch",
        eventName,
        repositoryRoot: fileURLToPath(new URL("..", import.meta.url)),
        ...(refName === undefined ? {} : { refName }),
      },
      createReleaseIO(createNpmCommandRunner()),
    );
    process.stdout.write(
      `${report.dryRun ? "dry-run" : "release"} ${report.version} under ${report.distTag}: ${String(report.published.length)} tarballs, ${String(report.skipped.length)} already published\n`,
    );
  } finally {
    await rm(artifactDirectory, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `::error::${error instanceof Error ? error.message : "release coordination failed"}\n`,
    );
    process.exitCode = 1;
  }
}
