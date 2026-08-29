import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { killIfRunning, processExists, waitForProcessExit } from "../support/converge.js";
import {
  RegistryPackageNotFound,
  coordinateRelease,
  createNpmCommandRunner,
  createReleaseIO,
  type NpmCommandRunner,
  type RegistryPackageState,
  type RegistryVersionState,
  type ReleaseIO,
} from "../../../../scripts/publish-release.js";
import { selectDistTag } from "../../../../scripts/release_policy.js";

const packages = [
  ["libtmux", "libtmux"],
  ["mcp", "@libtmux/mcp"],
  ["workspace", "@libtmux/workspace"],
] as const;

interface RegistryFixture {
  readonly distTags: Record<string, string>;
  readonly versions: Map<string, string>;
}

interface RecordedPublish {
  readonly dryRun: boolean;
  readonly name: string;
  readonly tag: string;
  readonly tarballPath: string;
}

function localIntegrity(name: string): string {
  return `sha512-${Buffer.from(name).toString("base64")}`;
}

async function makeReleaseFixture(version: string): Promise<{
  readonly artifacts: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ltx-release-"));
  await Promise.all(
    packages.map(async ([directory, name]) => {
      const packageRoot = join(root, "packages", directory);
      await mkdir(packageRoot, { recursive: true });
      const internalVersions =
        directory === "mcp"
          ? { dependencies: { libtmux: version } }
          : directory === "workspace"
            ? {
                devDependencies: { libtmux: version },
                peerDependencies: { libtmux: version },
              }
            : {};
      await writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ name, version, ...internalVersions })}\n`,
      );
    }),
  );
  const artifacts = join(root, "artifacts");
  await mkdir(artifacts);
  return { artifacts, root };
}

function makeRegistry(version = "0.9.0-alpha.1"): Map<string, RegistryFixture> {
  return new Map(
    packages.map(([, name]) => [
      name,
      { distTags: { latest: version }, versions: new Map<string, string>() },
    ]),
  );
}

function makeReleaseIO(
  registry: Map<string, RegistryFixture>,
  options: {
    readonly npmVersion?: string;
    readonly publishUpdatesRegistry?: boolean;
    readonly queryVersionError?: Error;
    readonly queryVersionErrorPackage?: string;
  } = {},
): {
  readonly calls: string[];
  readonly io: ReleaseIO;
  readonly packed: string[];
  readonly publishes: RecordedPublish[];
} {
  const calls: string[] = [];
  const packed: string[] = [];
  const publishes: RecordedPublish[] = [];
  const artifactsByPath = new Map<
    string,
    { readonly integrity: string; readonly name: string; readonly version: string }
  >();
  const initialVersionQueries = new Set<string>();

  const io: ReleaseIO = {
    npmVersion: async () => options.npmVersion ?? "11.5.1",
    pack: async (packageRoot, destination) => {
      const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as {
        name: string;
        version: string;
      };
      const tarballPath = join(destination, `${basename(packageRoot)}.tgz`);
      const artifact = {
        entries: ["dist/index.js", "package.json"],
        filename: basename(tarballPath),
        integrity: localIntegrity(manifest.name),
        name: manifest.name,
        tarballPath,
        version: manifest.version,
      };
      artifactsByPath.set(tarballPath, artifact);
      packed.push(manifest.name);
      calls.push(`pack:${manifest.name}`);
      return artifact;
    },
    queryPackage: async (name): Promise<RegistryPackageState> => {
      calls.push(`package:${name}`);
      const found = registry.get(name);
      if (found === undefined) throw new RegistryPackageNotFound(name);
      return { distTags: { ...found.distTags } };
    },
    queryVersion: async (name, target): Promise<RegistryVersionState | undefined> => {
      calls.push(`version:${name}`);
      initialVersionQueries.add(name);
      if (options.queryVersionError !== undefined && options.queryVersionErrorPackage === name) {
        throw options.queryVersionError;
      }
      const integrity = registry.get(name)?.versions.get(target);
      return integrity === undefined ? undefined : { integrity };
    },
    wait: async () => {},
    publish: async (tarballPath, tag, dryRun) => {
      if (initialVersionQueries.size !== packages.length) {
        throw new Error("registry mutation began before every version query completed");
      }
      const artifact = artifactsByPath.get(tarballPath);
      if (artifact === undefined) throw new Error(`unknown artifact ${tarballPath}`);
      publishes.push({ dryRun, name: artifact.name, tag, tarballPath });
      calls.push(`publish:${artifact.name}`);
      if (dryRun || options.publishUpdatesRegistry === false) return;
      const target = registry.get(artifact.name);
      if (target === undefined) throw new Error(`missing registry package ${artifact.name}`);
      target.versions.set(artifact.version, artifact.integrity);
      target.distTags[tag] = artifact.version;
    },
  };
  return { calls, io, packed, publishes };
}

describe("coordinated release", () => {
  test.each([
    ["1.0.0", ["0.9.0", "0.9.0", "0.9.0"], "latest"],
    ["1.1.0-alpha.1", ["1.0.0", "1.0.0", "1.0.0"], "alpha"],
    ["1.0.0-alpha.2", ["1.0.0-alpha.1", "1.0.0-alpha.1", "1.0.0-alpha.1"], "latest"],
    ["1.0.0-alpha.1", [undefined, undefined, undefined], "latest"],
    ["1.0.0-alpha.1", [undefined, "0.9.0-alpha.4", undefined], "latest"],
  ] as const)("selects the dist-tag for %s", (version, latestVersions, expected) => {
    expect(selectDistTag(version, latestVersions)).toBe(expected);
  });

  test.each(["1.0.0-alpha.01", "1.0.0-01"])("rejects the noncanonical prerelease %s", (version) => {
    expect(() => selectDistTag(version, [undefined, undefined, undefined])).toThrow(
      "not a semantic version",
    );
  });

  test("rejects a partial stable latest state", () => {
    expect(() => selectDistTag("1.1.0-alpha.1", ["1.0.0", undefined, undefined])).toThrow(
      "registry latest tags disagree",
    );
  });

  test.each(["1.1.0-latest.1", "1.1.0-Alpha.1", "1.1.0--alpha.1", "1.1.0-v1.1", "1.1.0-x.1"])(
    "rejects the unsafe prerelease channel %s after stable",
    (version) => {
      expect(() => selectDistTag(version, ["1.0.0", "1.0.0", "1.0.0"])).toThrow(
        "safe npm dist-tag",
      );
    },
  );

  test("publishes the three stable tarballs after every preflight and verifies them", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const registry = makeRegistry();
    const { calls, io, publishes } = makeReleaseIO(registry);
    try {
      const report = await coordinateRelease(
        {
          artifactDirectory: fixture.artifacts,
          dryRun: false,
          eventName: "push",
          refName: "v1.0.0",
          repositoryRoot: fixture.root,
        },
        io,
      );

      expect(report).toEqual({
        distTag: "latest",
        dryRun: false,
        published: packages.map(([, name]) => name),
        skipped: [],
        version: "1.0.0",
      });
      expect(publishes).toEqual(
        packages.map(([directory, name]) => ({
          dryRun: false,
          name,
          tag: "latest",
          tarballPath: join(fixture.artifacts, `${directory}.tgz`),
        })),
      );
      const firstPublish = calls.findIndex((call) => call.startsWith("publish:"));
      expect(
        calls.slice(0, firstPublish).filter((call) => call.startsWith("package:")),
      ).toHaveLength(3);
      expect(
        calls.slice(0, firstPublish).filter((call) => call.startsWith("version:")),
      ).toHaveLength(3);
      expect(calls.filter((call) => call.startsWith("package:"))).toHaveLength(6);
      expect(calls.filter((call) => call.startsWith("version:"))).toHaveLength(6);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("resumes only matching artifacts already carrying the intended tag", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const registry = makeRegistry("1.0.0");
    for (const [, name] of packages) {
      registry.get(name)?.versions.set("1.0.0", localIntegrity(name));
    }
    const { io, publishes } = makeReleaseIO(registry);
    try {
      const report = await coordinateRelease(
        {
          artifactDirectory: fixture.artifacts,
          dryRun: false,
          eventName: "push",
          refName: "v1.0.0",
          repositoryRoot: fixture.root,
        },
        io,
      );

      expect(report.published).toEqual([]);
      expect(report.skipped).toEqual(packages.map(([, name]) => name));
      expect(publishes).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("resumes a partially published first stable release", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const registry = makeRegistry();
    const publishedPrefix = registry.get("libtmux");
    if (publishedPrefix === undefined) throw new Error("missing libtmux registry fixture");
    publishedPrefix.distTags.latest = "1.0.0";
    publishedPrefix.versions.set("1.0.0", localIntegrity("libtmux"));
    const { io, publishes } = makeReleaseIO(registry);
    try {
      const report = await coordinateRelease(
        {
          artifactDirectory: fixture.artifacts,
          dryRun: false,
          eventName: "push",
          refName: "v1.0.0",
          repositoryRoot: fixture.root,
        },
        io,
      );

      expect(report).toEqual({
        distTag: "latest",
        dryRun: false,
        published: ["@libtmux/mcp", "@libtmux/workspace"],
        skipped: ["libtmux"],
        version: "1.0.0",
      });
      expect(publishes.map(({ name }) => name)).toEqual(["@libtmux/mcp", "@libtmux/workspace"]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects an existing artifact with different bytes before publishing", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const registry = makeRegistry("1.0.0");
    registry.get("libtmux")?.versions.set("1.0.0", localIntegrity("libtmux"));
    registry.get("@libtmux/mcp")?.versions.set("1.0.0", "sha512-different");
    const { io, publishes } = makeReleaseIO(registry);
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("@libtmux/mcp@1.0.0 already exists with different integrity");
      expect(publishes).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test.each([
    ["0.9.0", "latest", "1.0.0", undefined],
    ["1.0.0-alpha.1", "latest", "1.0.0-alpha.2", undefined],
    ["1.1.0-alpha.1", "alpha", "1.0.0", "1.1.0-alpha.2"],
    ["1.1.0-alpha.2", "alpha", "1.0.0", "1.1.0-alpha.10"],
  ] as const)(
    "rejects %s before moving %s backward",
    async (version, distTag, latest, taggedVersion) => {
      const fixture = await makeReleaseFixture(version);
      const registry = makeRegistry(latest);
      if (taggedVersion !== undefined) {
        for (const state of registry.values()) state.distTags[distTag] = taggedVersion;
      }
      const { io, publishes } = makeReleaseIO(registry);
      try {
        await expect(
          coordinateRelease(
            {
              artifactDirectory: fixture.artifacts,
              dryRun: false,
              eventName: "push",
              refName: `v${version}`,
              repositoryRoot: fixture.root,
            },
            io,
          ),
        ).rejects.toThrow(`would move ${distTag} backward from ${taggedVersion ?? latest}`);
        expect(publishes).toEqual([]);
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    },
  );

  test("rejects a different build at equal tag precedence", async () => {
    const fixture = await makeReleaseFixture("1.0.0+next");
    const registry = makeRegistry("1.0.0+current");
    const { io, publishes } = makeReleaseIO(registry);
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0+next",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("would replace latest 1.0.0+current at equal precedence");
      expect(publishes).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a matching artifact with the wrong tag before publishing", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const registry = makeRegistry("0.9.0-alpha.1");
    for (const [, name] of packages) {
      registry.get(name)?.versions.set("1.0.0", localIntegrity(name));
    }
    const { io, publishes } = makeReleaseIO(registry);
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("repair the latest dist-tag with an authenticated npm session");
      expect(publishes).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("forces workflow dispatch to dry-run the exact tarballs", async () => {
    const fixture = await makeReleaseFixture("1.0.0-alpha.2");
    const registry = makeRegistry();
    const { io, publishes } = makeReleaseIO(registry);
    try {
      const report = await coordinateRelease(
        {
          artifactDirectory: fixture.artifacts,
          dryRun: true,
          eventName: "workflow_dispatch",
          repositoryRoot: fixture.root,
        },
        io,
      );

      expect(report.dryRun).toBe(true);
      expect(publishes).toEqual(
        packages.map(([directory, name]) => ({
          dryRun: true,
          name,
          tag: "latest",
          tarballPath: join(fixture.artifacts, `${directory}.tgz`),
        })),
      );
      expect(registry.get("libtmux")?.versions.has("1.0.0-alpha.2")).toBe(false);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a live workflow dispatch before packing", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const { io, packed, publishes } = makeReleaseIO(makeRegistry());
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "workflow_dispatch",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("workflow_dispatch is dry-run only");
      expect(packed).toEqual([]);
      expect(publishes).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects npm below the trusted-publishing floor before packing", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const { io, packed } = makeReleaseIO(makeRegistry(), { npmVersion: "11.5.0" });
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("npm 11.5.1 or newer is required");
      expect(packed).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a prerelease of the minimum npm version", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const { io, packed } = makeReleaseIO(makeRegistry(), { npmVersion: "11.5.1-beta.1" });
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("npm 11.5.1 or newer is required");
      expect(packed).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects manifest version disagreement before packing", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    await writeFile(
      join(fixture.root, "packages/workspace/package.json"),
      `${JSON.stringify({ name: "@libtmux/workspace", version: "1.0.1" })}\n`,
    );
    const { io, packed } = makeReleaseIO(makeRegistry());
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("release package versions are not lockstep");
      expect(packed).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test.each([
    ["mcp", "dependencies"],
    ["workspace", "peerDependencies"],
    ["workspace", "devDependencies"],
  ] as const)("rejects a stale %s %s libtmux edge before packing", async (directory, field) => {
    const fixture = await makeReleaseFixture("1.0.0");
    const manifestPath = join(fixture.root, "packages", directory, "package.json");
    const manifest = (await Bun.file(manifestPath).json()) as Record<string, unknown>;
    manifest[field] = { libtmux: "0.9.0" };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const { io, packed } = makeReleaseIO(makeRegistry());
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow(`${field}.libtmux must be 1.0.0, not "0.9.0"`);
      expect(packed).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects tag disagreement before packing", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const { io, packed } = makeReleaseIO(makeRegistry());
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.1",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("expected v1.0.0");
      expect(packed).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects package-level 404 before publishing", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const registry = makeRegistry();
    registry.delete("@libtmux/mcp");
    const { io, publishes } = makeReleaseIO(registry);
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("established package @libtmux/mcp is missing from the registry");
      expect(publishes).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects registry errors before publishing", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const { io, publishes } = makeReleaseIO(makeRegistry(), {
      queryVersionError: new Error("registry unavailable"),
      queryVersionErrorPackage: "@libtmux/mcp",
    });
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("registry unavailable");
      expect(publishes).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("fails when the final three-package postcondition is incomplete", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const { io, publishes } = makeReleaseIO(makeRegistry(), {
      publishUpdatesRegistry: false,
    });
    try {
      await expect(
        coordinateRelease(
          {
            artifactDirectory: fixture.artifacts,
            dryRun: false,
            eventName: "push",
            refName: "v1.0.0",
            repositoryRoot: fixture.root,
          },
          io,
        ),
      ).rejects.toThrow("release postcondition failed");
      expect(publishes).toHaveLength(3);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("waits for bounded registry convergence before accepting the postcondition", async () => {
    const fixture = await makeReleaseFixture("1.0.0");
    const { io } = makeReleaseIO(makeRegistry());
    const originalQueryVersion = io.queryVersion.bind(io);
    const queries = new Map<string, number>();
    const waits: number[] = [];
    io.queryVersion = async (name, version) => {
      const count = (queries.get(name) ?? 0) + 1;
      queries.set(name, count);
      const result = await originalQueryVersion(name, version);
      return count === 2 ? undefined : result;
    };
    io.wait = async (milliseconds) => {
      waits.push(milliseconds);
    };
    try {
      await coordinateRelease(
        {
          artifactDirectory: fixture.artifacts,
          dryRun: false,
          eventName: "push",
          refName: "v1.0.0",
          repositoryRoot: fixture.root,
        },
        io,
      );

      expect(waits).toEqual([1_000]);
      expect([...queries.values()]).toEqual([3, 3, 3]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("treats only a structured version E404 as an unpublished version", async () => {
    const runner: NpmCommandRunner = async () => ({
      exitCode: 1,
      stderr: JSON.stringify({ error: { code: "E404", detail: "missing", summary: "missing" } }),
      stdout: "",
    });
    const io = createReleaseIO(runner);

    expect(await io.queryVersion("libtmux", "9.9.9")).toBeUndefined();
  });

  test("fails closed on E404 from an abnormally terminated command", async () => {
    const prefix = `process.stdout.write(JSON.stringify({ error: { code: "E404" } })); `;
    await Promise.all(
      (
        [
          [
            'process.stderr.write("x".repeat(65)); await Bun.sleep(60_000);',
            1_000,
            64,
            "64 output bytes",
          ],
          ["await Bun.sleep(60_000);", 20, 1_024, "20ms"],
          ['process.kill(process.pid, "SIGKILL");', 1_000, 1_024, "SIGKILL"],
        ] as const
      ).map(async ([suffix, timeoutMilliseconds, maxOutputBytes, diagnostic]) => {
        const runner = createNpmCommandRunner(
          [process.execPath, "-e", `${prefix}${suffix}`],
          timeoutMilliseconds,
          maxOutputBytes,
        );
        const io = createReleaseIO(runner);

        await expect(io.queryVersion("libtmux", "9.9.9")).rejects.toThrow(diagnostic);
      }),
    );
  });

  test("fails closed on a package-level E404", async () => {
    const runner: NpmCommandRunner = async () => ({
      exitCode: 1,
      stderr: JSON.stringify({ error: { code: "E404", detail: "missing", summary: "missing" } }),
      stdout: "",
    });
    const io = createReleaseIO(runner);

    await expect(io.queryPackage("libtmux")).rejects.toBeInstanceOf(RegistryPackageNotFound);
  });

  test("does not mistake registry failure text containing E404 for absence", async () => {
    const runner: NpmCommandRunner = async () => ({
      exitCode: 1,
      stderr: "gateway failed after an E404 response",
      stdout: "",
    });
    const io = createReleaseIO(runner);

    await expect(io.queryVersion("libtmux", "9.9.9")).rejects.toThrow(
      "gateway failed after an E404 response",
    );
  });

  test("passes the packed tarball and explicit tag to npm publish", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: NpmCommandRunner = async (arguments_) => {
      mutableCalls.push([...arguments_]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const io = createReleaseIO(runner);

    await io.publish("/tmp/release/libtmux.tgz", "alpha", false);
    await io.publish("/tmp/release/libtmux.tgz", "alpha", true);

    expect(calls).toEqual([
      ["publish", "/tmp/release/libtmux.tgz", "--tag", "alpha"],
      ["publish", "/tmp/release/libtmux.tgz", "--tag", "alpha", "--dry-run"],
    ]);
  });

  test("rejects non-version dist-tag values from npm", async () => {
    const runner: NpmCommandRunner = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ latest: "not-a-version" }),
    });
    const io = createReleaseIO(runner);

    await expect(io.queryPackage("libtmux")).rejects.toThrow(
      "npm returned an invalid latest dist-tag",
    );
  });

  test("rejects malformed registry integrity", async () => {
    const runner: NpmCommandRunner = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify("sha1-not-the-published-sha512"),
    });
    const io = createReleaseIO(runner);

    await expect(io.queryVersion("libtmux", "1.0.0")).rejects.toThrow(
      "npm returned invalid integrity",
    );
  });

  test("terminates an npm command that exceeds its deadline", async () => {
    const runner = createNpmCommandRunner([process.execPath, "-e", "await Bun.sleep(60_000)"], 20);

    const result = await runner([]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("npm command exceeded 20ms\n");
  });

  test("terminates an npm command that exceeds its output limit", async () => {
    const runner = createNpmCommandRunner(
      [process.execPath, "-e", 'process.stdout.write("x".repeat(65)); await Bun.sleep(60_000);'],
      1_000,
      64,
    );

    const result = await runner([]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(result.stderr).toContain("npm command exceeded 64 output bytes");
  });

  test.skipIf(process.platform === "win32")(
    "bounds a descendant that inherits npm command output",
    async () => {
      const descendantScript = 'process.on("SIGTERM", () => {}); await Bun.sleep(2_000);';
      const parentScript = `
        const descendant = Bun.spawn(${JSON.stringify([
          process.execPath,
          "-e",
          descendantScript,
        ])}, { stderr: "inherit", stdout: "inherit" });
        console.log(descendant.pid);
        await Bun.sleep(60_000);
      `;
      const runner = createNpmCommandRunner([process.execPath, "-e", parentScript], 250);
      const startedAt = performance.now();
      const result = await runner([]);
      const descendantPid = Number(result.stdout.trim());

      try {
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        await waitForProcessExit(descendantPid);
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(processExists(descendantPid)).toBe(false);
        expect(result.stderr).toContain("npm command exceeded 250ms");
      } finally {
        if (Number.isSafeInteger(descendantPid) && descendantPid > 0) {
          killIfRunning(descendantPid);
        }
      }
    },
  );
});
