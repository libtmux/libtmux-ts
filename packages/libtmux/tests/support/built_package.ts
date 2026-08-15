/**
 * Read the emitted package the suite was handed, rather than building it here.
 *
 * Three unit files need `dist`, and each used to spawn `bun run build` to get
 * it. That script begins `rm -rf dist`, so under `--parallel=4` the three raced
 * each other and every other test reading `dist`: measured over one build, the
 * source map is absent for about two thirds of it. The suite went red on
 * whichever file lost — once as a 5000ms timeout inside a test that never
 * declared a bound large enough to hold a TypeScript build, once as a
 * wall-clock assertion in an unrelated file.
 *
 * `test:unit` builds once before any test runs, which is the same shape as
 * `test:node`, `test:package` and `typecheck:ambient-free`. These call sites
 * assert that happened instead of doing it again.
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
