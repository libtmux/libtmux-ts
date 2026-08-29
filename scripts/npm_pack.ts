import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

interface NpmPackFile {
  readonly path?: unknown;
}

interface NpmPackRecord {
  readonly filename?: unknown;
  readonly files?: unknown;
}

export interface NpmPackedArtifact {
  readonly entries: readonly string[];
  readonly filename: string;
  readonly tarballPath: string;
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
  const child = Bun.spawn(["npm", "pack", "--json", "--pack-destination", resolve(destination)], {
    cwd: packageRoot,
    env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
    stderr: "pipe",
    stdout: "pipe",
  });
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    child.kill("SIGTERM");
  }, 60_000);
  const hardDeadline = setTimeout(() => child.kill("SIGKILL"), 65_000);
  deadline.unref?.();
  hardDeadline.unref?.();
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (expired) throw new Error(`npm pack exceeded 60000ms in ${packageRoot}`);
    if (exitCode !== 0) {
      throw new Error(`npm pack exited ${String(exitCode)} in ${packageRoot}\n${stdout}${stderr}`);
    }

    let records: unknown;
    try {
      records = JSON.parse(stdout);
    } catch {
      throw new Error(`npm pack returned invalid JSON in ${packageRoot}\n${stdout}${stderr}`);
    }
    if (!Array.isArray(records) || records.length !== 1) {
      throw new Error(`npm pack returned ${Array.isArray(records) ? records.length : 0} artifacts`);
    }
    const record = records[0] as NpmPackRecord;
    if (typeof record.filename !== "string" || basename(record.filename) !== record.filename) {
      throw new Error("npm pack returned an invalid tarball filename");
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
      tarballPath,
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardDeadline);
  }
}
