import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedCommand, type BoundedCommandTermination } from "./bounded_process.js";
import { npmPack } from "./npm_pack.js";
import {
  assertMinimumNpm,
  assertSemanticVersion,
  compareSemanticVersions,
  RELEASE_PACKAGES,
  selectDistTag,
  type ReleaseManifest,
  validateReleaseManifests,
} from "./release_policy.js";

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
  readonly firstPublication?: string;
  readonly refName?: string;
  readonly repositoryRoot: string;
}

export interface ReleaseReport {
  readonly warnings: readonly string[];
  readonly distTag: string;
  readonly dryRun: boolean;
  readonly published: readonly string[];
  readonly skipped: readonly string[];
  readonly version: string;
}

interface NpmCommandOutput {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type NpmCommandResult =
  | (NpmCommandOutput & { readonly signalCode?: undefined; readonly termination?: undefined })
  | (NpmCommandOutput & {
      readonly signalCode?: string;
      readonly termination: Exclude<BoundedCommandTermination, "exited">;
    });

export type NpmCommandRunner = (arguments_: readonly string[]) => Promise<NpmCommandResult>;

const DEFAULT_NPM_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function createNpmCommandRunner(
  command: readonly string[] = ["npm"],
  timeoutMilliseconds = 60_000,
  maxOutputBytes = DEFAULT_NPM_MAX_OUTPUT_BYTES,
): NpmCommandRunner {
  if (command.length === 0) throw new Error("npm command cannot be empty");
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new Error("npm command timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("npm command output limit must be a positive integer");
  }
  return async (arguments_) => {
    const result = await runBoundedCommand([...command, ...arguments_], {
      env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
      maxOutputBytes,
      timeoutMilliseconds,
    });
    const diagnostic =
      result.termination === "timed_out"
        ? `npm command exceeded ${String(timeoutMilliseconds)}ms\n`
        : result.termination === "output_limit_exceeded"
          ? `npm command exceeded ${String(maxOutputBytes)} output bytes\n`
          : result.termination === "signaled"
            ? `npm command terminated by ${result.signalCode ?? "an unknown signal"}\n`
            : "";
    const output: NpmCommandOutput = {
      exitCode: result.termination !== "exited" && result.exitCode === 0 ? 1 : result.exitCode,
      stderr:
        diagnostic === ""
          ? result.stderr
          : `${result.stderr}${result.stderr.endsWith("\n") || result.stderr === "" ? "" : "\n"}${diagnostic}`,
      stdout: result.stdout,
    };
    if (result.termination === "exited") return output;
    return {
      ...output,
      ...(result.signalCode === null ? {} : { signalCode: result.signalCode }),
      termination: result.termination,
    };
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

async function queryPackages(
  manifests: readonly ReleaseManifest[],
  io: ReleaseIO,
  firstPublicationName?: string,
): Promise<readonly (RegistryPackageState | undefined)[]> {
  return await Promise.all(
    manifests.map(async ({ name }) => {
      try {
        return await io.queryPackage(name);
      } catch (error) {
        if (error instanceof RegistryPackageNotFound) {
          if (name === firstPublicationName && error.packageName === name) return undefined;
          throw new Error(`established package ${error.packageName} is missing from the registry`, {
            cause: error,
          });
        }
        throw error;
      }
    }),
  );
}

async function readReleaseManifests(repositoryRoot: string): Promise<readonly ReleaseManifest[]> {
  const sources = await Promise.all(
    RELEASE_PACKAGES.map(async (releasePackage) => {
      const path = `${repositoryRoot}/packages/${releasePackage.directory}/package.json`;
      return { document: await Bun.file(path).json(), path, releasePackage };
    }),
  );
  return validateReleaseManifests(sources);
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

/**
 * npm accepts a publish and reveals it to readers later, and the delay is not
 * bounded by anything npm documents. zod's release workflow records versions
 * that sat unreadable for 16 and 25 minutes, so the wait is minutes-scale.
 */
const POSTCONDITION_ATTEMPTS = 60;
const POSTCONDITION_INTERVAL_MS = 30_000;

interface PostconditionFindings {
  /** The release did not land: a version is absent or is not our tarball. */
  readonly absent: readonly string[];
  /** The release landed; only the dist-tag has not caught up yet. */
  readonly lagging: readonly string[];
}

async function verifyPostcondition(
  manifests: readonly ReleaseManifest[],
  artifacts: readonly PackedArtifact[],
  distTag: string,
  io: ReleaseIO,
  firstPublicationName?: string,
): Promise<PostconditionFindings> {
  const packageStates = await queryPackages(manifests, io, firstPublicationName);
  const versionStates = await Promise.all(
    manifests.map(async ({ name, version }) => await io.queryVersion(name, version)),
  );
  const absent: string[] = [];
  const lagging: string[] = [];
  for (const [index, manifest] of manifests.entries()) {
    const packageState = packageStates[index];
    const versionState = versionStates[index];
    const artifact = artifacts[index];
    if (packageState === undefined || artifact === undefined) {
      absent.push(`${manifest.name}: release state was not read`);
      continue;
    }
    if (versionState === undefined) {
      absent.push(`${manifest.name}@${manifest.version}: version is missing`);
    } else if (versionState.integrity !== artifact.integrity) {
      absent.push(`${manifest.name}@${manifest.version}: integrity differs from the tarball`);
    }
    if (packageState.distTags[distTag] !== manifest.version) {
      lagging.push(`${manifest.name}@${distTag}: expected ${manifest.version}`);
    }
  }
  return { absent, lagging };
}

function npmErrorCode(result: NpmCommandResult): string | undefined {
  if (result.termination !== undefined || result.signalCode !== undefined) return undefined;
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
          assertSemanticVersion(version);
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
  const version = manifests[0]?.version;
  if (version === undefined) throw new Error("no release packages are configured");
  if (options.eventName === "push" && options.refName !== `v${version}`) {
    throw new Error(`release tag ${options.refName ?? "is missing"}; expected v${version}`);
  }
  const firstPublicationName =
    options.firstPublication === undefined ? undefined : "@libtmux/workspace-cli";
  if (
    firstPublicationName !== undefined &&
    options.firstPublication !== `${firstPublicationName}@${version}`
  ) {
    throw new Error(`first publication must name ${firstPublicationName}@${version}`);
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

  const packageStates = await queryPackages(manifests, io, firstPublicationName);
  const versionStates = await Promise.all(
    manifests.map(async ({ name }) => await io.queryVersion(name, version)),
  );
  const distTag = selectDistTag(
    version,
    packageStates.flatMap((state) => (state === undefined ? [] : [state.distTags.latest])),
  );
  if (distTag !== "latest" && packageStates.some((state) => state === undefined)) {
    throw new Error("first CLI publication must use the coordinated latest channel");
  }
  const skipped: string[] = [];
  const pending: PackedArtifact[] = [];
  const failures: string[] = [];
  for (const [index, artifact] of artifacts.entries()) {
    const versionState = versionStates[index];
    const packageState =
      packageStates[index] ??
      (artifact.name === firstPublicationName ? { distTags: {} } : undefined);
    if (packageState === undefined) {
      failures.push(`${artifact.name}: package state was not read`);
    } else if (versionState === undefined) {
      const taggedVersion = packageState.distTags[distTag];
      const tagComparison =
        taggedVersion === undefined
          ? undefined
          : compareSemanticVersions(artifact.version, taggedVersion);
      if (tagComparison !== undefined && tagComparison < 0) {
        failures.push(
          `${artifact.name}@${artifact.version} would move ${distTag} backward from ${taggedVersion}`,
        );
      } else if (
        tagComparison === 0 &&
        taggedVersion !== undefined &&
        artifact.version !== taggedVersion
      ) {
        failures.push(
          `${artifact.name}@${artifact.version} would replace ${distTag} ${taggedVersion} at equal precedence`,
        );
      } else {
        pending.push(artifact);
      }
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
  const warnings: string[] = [];
  if (!options.dryRun) {
    let findings: PostconditionFindings = { absent: [], lagging: [] };
    for (let attempt = 1; attempt <= POSTCONDITION_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- each read follows the prior delay.
      findings = await verifyPostcondition(manifests, artifacts, distTag, io, firstPublicationName);
      if (findings.absent.length === 0 && findings.lagging.length === 0) break;
      // eslint-disable-next-line no-await-in-loop -- bound registry convergence between reads.
      if (attempt < POSTCONDITION_ATTEMPTS) await io.wait(POSTCONDITION_INTERVAL_MS);
    }
    if (findings.absent.length > 0) {
      throw new Error(
        `release postcondition failed:\n${[...findings.absent, ...findings.lagging].map((failure) => `  ${failure}`).join("\n")}`,
      );
    }
    warnings.push(...findings.lagging);
  }
  return { distTag, dryRun: options.dryRun, published, skipped, version, warnings };
}

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const refName = process.env.GITHUB_REF_NAME;
  const firstPublication = process.env.LIBTMUX_FIRST_PUBLICATION;
  const artifactDirectory = await mkdtemp(join(tmpdir(), "ltx-release-"));
  try {
    const report = await coordinateRelease(
      {
        artifactDirectory,
        dryRun: eventName === "workflow_dispatch",
        eventName,
        repositoryRoot: fileURLToPath(new URL("..", import.meta.url)),
        ...(refName === undefined ? {} : { refName }),
        ...(firstPublication === undefined ? {} : { firstPublication }),
      },
      createReleaseIO(createNpmCommandRunner()),
    );
    // A dist-tag the registry has not caught up on is reported, not fatal: the
    // packages are published by here and failing the job cannot unpublish them.
    for (const warning of report.warnings) {
      process.stdout.write(`::warning::${warning}; the release itself succeeded\n`);
    }
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
