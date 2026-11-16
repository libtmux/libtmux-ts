import { spawnSync } from "node:child_process";

/**
 * Whether `text` matches a shell glob in which `*` is any run of characters and
 * `?` is any one. The plan writes the expectation that way: `tmux next-*` for
 * an unreleased tmux, `tmux 3.8` for a release.
 */
export function matchesGlob(text: string, pattern: string): boolean {
  const source = pattern
    .replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${source}$`, "su").test(text);
}

/** The error to report when `actual` is not what `expected` allows, or `undefined`. */
export function versionMismatch(actual: string, expected: string): string | undefined {
  return matchesGlob(actual, expected) ? undefined : `expected ${expected}, got ${actual}`;
}

if (import.meta.main) {
  const prefix = process.env["TMUX_PREFIX"];
  const expected = process.env["TMUX_EXPECT"];
  if (prefix === undefined || prefix === "" || expected === undefined || expected === "") {
    process.stderr.write("usage: TMUX_PREFIX=<dir> TMUX_EXPECT=<glob> check_tmux_version.ts\n");
    process.exit(2);
  }
  const run = spawnSync(`${prefix}/bin/tmux`, ["-V"], { encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0) {
    process.stderr.write(
      `::error::${prefix}/bin/tmux -V failed: ${run.error?.message ?? run.stderr}\n`,
    );
    process.exit(1);
  }
  const actual = run.stdout.trim();
  process.stdout.write(`${actual}\n`);
  const mismatch = versionMismatch(actual, expected);
  if (mismatch !== undefined) {
    process.stderr.write(`::error::${mismatch}\n`);
    process.exit(1);
  }
}
