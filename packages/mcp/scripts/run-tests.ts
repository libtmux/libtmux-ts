/**
 * What this suite needs from the machine, checked once and reported once.
 *
 * `run_command` frames a command in POSIX shell and refuses a shell it cannot
 * address. Proving that refusal needs a shell that is genuinely not POSIX, so
 * the suite runs one — and without it the failure was a `TypeError` reading a
 * property of an error result, three layers from the missing package.
 *
 * Named rather than skipped: a test that quietly does not run is a guarantee
 * that quietly stops being one, and this is the only test covering a refusal
 * `force` deliberately cannot override.
 */
const NON_POSIX_SHELL = "fish";

if (Bun.which(NON_POSIX_SHELL) === null) {
  process.stderr.write(
    `This suite needs something this machine does not have:\n` +
      `  ${NON_POSIX_SHELL}, to prove run_command refuses a shell its framing cannot address.\n` +
      `  Install it (apt install ${NON_POSIX_SHELL}) — the test is not skipped without it,\n` +
      `  because a refusal nothing exercises is a refusal nobody knows is gone.\n`,
  );
  process.exit(1);
}

const result = Bun.spawnSync({
  cmd: ["bun", "test", "--no-orphans", "tests", ...Bun.argv.slice(2)],
  cwd: new URL("..", import.meta.url).pathname,
  stderr: "inherit",
  stdout: "inherit",
});

process.exitCode = result.exitCode;
