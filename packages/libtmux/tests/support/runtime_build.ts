import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Whether Bun runs this suite, testing `src`, rather than Node or Deno, testing
 * the emitted `dist` — the artifact their consumers load.
 */
const ON_BUN = "Bun" in globalThis;

/** Deno evaluates source through a subcommand rather than a flag. */
const ON_DENO = "Deno" in globalThis;

const packageRoot = new URL("../../", import.meta.url);

/** One module of the build this runtime tests, as an importable URL: `"formats"`, `"_internal/codec/guard_codec"`. */
export function builtModuleUrl(module: string): string {
  return new URL(ON_BUN ? `src/${module}.ts` : `dist/${module}.js`, packageRoot).href;
}

/**
 * Run `source` as an ES module in a fresh process of this runtime.
 *
 * A test that needs a clean module graph — an environment variable read at
 * import time, a global a caller has patched — spawns one. Spawning `bun` from
 * both runtimes would test Bun twice and Node never.
 */
export function runModule(
  source: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5_000,
): { readonly exitCode: number | null; readonly stderr: string; readonly stdout: string } {
  const result = spawnSync(
    process.execPath,
    ON_BUN
      ? ["--eval", source]
      : ON_DENO
        ? ["eval", source]
        : ["--input-type=module", "--eval", source],
    { cwd: fileURLToPath(packageRoot), encoding: "utf8", env, timeout: timeoutMs },
  );
  return { exitCode: result.status, stderr: result.stderr, stdout: result.stdout };
}
