/** Fail once instead of cascading from a missing test shell. */
import {
  runSupervisor,
  sweepStaleRunRoots,
  testParallelism,
} from "../../libtmux/src/_internal/test/testkit.js";

const REQUIRED_SHELLS = [
  ["fish", "non-POSIX-shell refusal"],
  ["zsh", "Zsh trap-state preservation"],
] as const;
const missingShells = REQUIRED_SHELLS.filter(([name]) => Bun.which(name) === null);

if (missingShells.length > 0) {
  const names = missingShells.map(([name]) => name).join(" ");
  const reasons = missingShells.map(([name, reason]) => `  ${name}: ${reason}`).join("\n");
  process.stderr.write(
    `This suite needs missing test shells:\n${reasons}\n` +
      `Install them (apt install ${names}); these tests are not skipped.\n`,
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
