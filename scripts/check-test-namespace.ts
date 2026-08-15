import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every temporary directory the suites create carries this package's prefix.
 *
 * Other libtmux ports run their suites on this machine, and `/tmp/libtmux-*`
 * is not this package's to take — `/tmp/libtmux-java-test` and
 * `/tmp/libtmux-swift-dev` were both sitting there when this was written,
 * while nineteen call sites here reached for exactly that shape. A cleanup
 * sweep in either direction could reap the other's tmux servers.
 *
 * The invariant is the name, not the helper that applies it: anything this
 * package leaves in the temporary directory has to be identifiable as its own,
 * whether it came from `makeTestDirectory` or from a bare `mkdtemp`. Requiring
 * the helper instead would be enforcing an implementation, and the one place
 * that cannot use it — the supervisor, which runs across a subprocess
 * boundary — is exactly the place a leaked directory is hardest to trace.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** Everything this package creates under the temporary directory starts here. */
const TEST_PREFIX = "ltx";

const creations = [
  // mkdtemp(join(tmpdir(), "<prefix>"))
  /mkdtemp\(\s*join\(\s*tmpdir\(\),\s*(["'`])([^"'`]*)\1/gu,
  // makeTestDirectory("<prefix>")
  /makeTestDirectory\(\s*(["'`])([^"'`]*)\1/gu,
];

const listed = await new Bun.$.Shell()`git ls-files "*.ts" "*.mts" "*.mjs"`
  .cwd(repositoryRoot)
  .text();
const files = listed.split("\n").filter((line) => line !== "");

const failures: string[] = [];
let checked = 0;

for (const file of files) {
  // eslint-disable-next-line no-await-in-loop -- one source at a time; failures read in file order.
  const source = await Bun.file(join(repositoryRoot, file)).text();
  for (const [index, line] of source.split("\n").entries()) {
    for (const pattern of creations) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const prefix = match[2] ?? "";
        checked += 1;
        if (prefix.startsWith(TEST_PREFIX)) continue;
        failures.push(
          `${file}:${String(index + 1)}: temporary directory prefix ${JSON.stringify(prefix)} does not start with ${JSON.stringify(TEST_PREFIX)}, so a sweep cannot tell it from another libtmux port's`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Temporary directories outside this package's namespace:\n${failures
      .map((failure) => `  ${failure}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write(
  `Test namespace holds: ${String(checked)} temporary directories all named ${TEST_PREFIX}*\n`,
);
