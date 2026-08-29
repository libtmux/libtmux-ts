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
import {
  runSupervisor,
  sweepStaleRunRoots,
  testParallelism,
} from "../../libtmux/src/_internal/test/testkit.js";

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

// Cleanup is a finally, and SIGKILL skips it. A run killed that way left its
// tmux daemon behind under a name no later run revisits; this is where one
// still can. Once per suite process, before anything creates a root of its own.
await sweepStaleRunRoots();

// Under the same supervisor the library's own real-tmux suite uses. It
// publishes one run root for every fixture here instead of one per test,
// forwards SIGINT and SIGTERM to the child, and reaps what it owns afterwards.
// Without it a Ctrl-C left the servers running and nothing to collect them.
// Arguments naming files replace the default target rather than adding to it.
// Appending them ran the whole suite and then the named file again, so asking
// for one test cost every test — three minutes to answer a five-second question.
const forwarded = Bun.argv.slice(2);
const selectsFiles = forwarded[0] !== undefined && !forwarded[0].startsWith("-");

process.exitCode = await runSupervisor({
  command: [
    "bun",
    "test",
    `--parallel=${String(testParallelism())}`,
    "--no-orphans",
    ...(selectsFiles ? forwarded : ["tests", ...forwarded]),
  ],
  cwd: new URL("..", import.meta.url).pathname,
});
