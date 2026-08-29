import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { runBoundedCommand } from "./bounded_process.js";

interface NpmPackFile {
  readonly path?: unknown;
}

interface NpmPackRecord {
  readonly filename?: unknown;
  readonly files?: unknown;
  readonly integrity?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
}

export interface NpmPackedArtifact {
  readonly entries: readonly string[];
  readonly filename: string;
  readonly integrity: string;
  readonly name: string;
  readonly tarballPath: string;
  readonly version: string;
}

function contained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith("../") && !isAbsolute(fromRoot);
}

/** Pack once with npm and return the exact tarball plus npm's file inventory. */
export async function npmPack(
  packageRoot: string,
  destination: string,
): Promise<NpmPackedArtifact> {
  await mkdir(destination, { recursive: true });
  const result = await runBoundedCommand(
    ["npm", "pack", "--json", "--pack-destination", resolve(destination)],
    {
      cwd: packageRoot,
      env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
      timeoutMilliseconds: 60_000,
    },
  );
  if (result.timedOut) throw new Error(`npm pack exceeded 60000ms in ${packageRoot}`);
  if (result.exitCode !== 0) {
    throw new Error(
      `npm pack exited ${String(result.exitCode)} in ${packageRoot}\n${result.stdout}${result.stderr}`,
    );
  }

  let records: unknown;
  try {
    records = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `npm pack returned invalid JSON in ${packageRoot}\n${result.stdout}${result.stderr}`,
    );
  }
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error(`npm pack returned ${Array.isArray(records) ? records.length : 0} artifacts`);
  }
  const record = records[0] as NpmPackRecord;
  if (typeof record.filename !== "string" || basename(record.filename) !== record.filename) {
    throw new Error("npm pack returned an invalid tarball filename");
  }
  if (typeof record.name !== "string" || record.name === "") {
    throw new Error("npm pack returned an invalid package name");
  }
  if (typeof record.version !== "string" || record.version === "") {
    throw new Error("npm pack returned an invalid package version");
  }
  if (
    typeof record.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(record.integrity)
  ) {
    throw new Error("npm pack returned an invalid integrity digest");
  }
  if (!Array.isArray(record.files)) throw new Error("npm pack returned no file inventory");
  const entries = (record.files as NpmPackFile[]).map(({ path }) => {
    if (typeof path !== "string" || path === "" || isAbsolute(path)) {
      throw new Error("npm pack returned an invalid file entry");
    }
    return path.replaceAll("\\", "/");
  });
  const tarballPath = resolve(destination, record.filename);
  if (!contained(resolve(destination), tarballPath)) {
    throw new Error("npm pack placed its tarball outside the destination");
  }
  if (!(await Bun.file(tarballPath).exists()))
    throw new Error("npm pack did not create its tarball");

  return {
    entries: entries.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    filename: record.filename,
    integrity: record.integrity,
    name: record.name,
    tarballPath,
    version: record.version,
  };
}
