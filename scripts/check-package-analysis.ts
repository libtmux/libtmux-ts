import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "./bounded_process.js";
import { npmPack } from "./npm_pack.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = process.cwd();

function binary(name: string): string {
  const path = join(repositoryRoot, "node_modules", ".bin", name);
  if (!existsSync(path)) throw new Error(`${name} is not installed at the workspace root`);
  return path;
}

async function run(command: readonly string[]): Promise<void> {
  const result = await runBoundedCommand(command, {
    cwd: packageRoot,
    env: { ...process.env },
    timeoutMilliseconds: 60_000,
  });
  if (result.timedOut) throw new Error(`${command[0] ?? "analyzer"} exceeded 60000ms`);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${String(result.exitCode)}\n${result.stdout}${result.stderr}`,
    );
  }
}

const directory = await mkdtemp(join(tmpdir(), "ltx-package-analysis-"));
try {
  const artifact = await npmPack(packageRoot, directory);
  await run([binary("publint"), "run", artifact.tarballPath]);
  await run([binary("attw"), artifact.tarballPath, "--profile", "esm-only"]);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly name: string;
    readonly version: string;
  };
  process.stdout.write(
    `${JSON.stringify({
      analyzed: `${manifest.name}@${manifest.version}`,
      protocol: "package-analysis-v1",
      status: "passed",
    })}\n`,
  );
} finally {
  await rm(directory, { force: true, recursive: true });
}
