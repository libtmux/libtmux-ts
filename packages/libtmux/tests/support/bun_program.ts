import { accessSync, constants } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The `bun` that runs fixture programs: this process under Bun, else the first one on `PATH`. */
function bunExecutable(): string {
  if (process.versions.bun !== undefined) return process.execPath;
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(directory, "bun");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  throw new Error("bun is required on PATH to run fixture programs");
}

/**
 * Writes `destination` as an executable that runs the default export of
 * `program` under Bun, with `config` and the command-line arguments, and exits
 * with the status it returns. The shebang names bun by path, so the file starts
 * whatever `PATH` or environment the caller hands it.
 */
export async function writeBunProgram<Config>(
  destination: string,
  program: URL,
  config: Config,
): Promise<string> {
  await writeFile(
    destination,
    [
      `#!${bunExecutable()}`,
      `import main from ${JSON.stringify(fileURLToPath(program))};`,
      `process.exitCode = (await main(${JSON.stringify(config)}, process.argv.slice(2))) ?? 0;`,
      "",
    ].join("\n"),
  );
  await chmod(destination, 0o700);
  return destination;
}

/**
 * Replaces this process with `executable`, as `exec` does in a shell, so the
 * caller's pid, signals and exit status are the real program's.
 */
export function execProgram(executable: string, argv: readonly string[]): never {
  if (process.execve === undefined)
    throw new Error("process.execve is unavailable on this platform");
  process.execve(executable, [executable, ...argv], process.env);
  throw new Error("execve returned");
}
