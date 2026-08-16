/**
 * Read the emitted package the suite was handed, rather than building it here.
 *
 * `bun run build` begins `rm -rf dist`, so a test that runs it races every
 * other test reading `dist` — for most of a build the source map is simply
 * absent. `test:unit` builds once before any test runs, as `test:node`,
 * `test:package` and `typecheck:ambient-free` do; these call sites assert that
 * happened instead of doing it again.
 */

const builtSourceMapUrl = new URL("../../dist/index.js.map", import.meta.url);

/**
 * Fail with the command to run rather than with whatever a missing `dist`
 * happens to break first.
 */
export async function requireBuiltPackage(): Promise<void> {
  if (await Bun.file(builtSourceMapUrl).exists()) return;
  throw new Error(
    "dist is missing. These tests read the emitted package rather than building it: " +
      "run `bun run build` first, or run them through `bun run test:unit`, which builds once up front.",
  );
}
