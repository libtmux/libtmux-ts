// The library's real-tmux fixture harness is unpublished. This runner is the
// examples suite's bridge to the supervision the package suites already use.
import {
  runSupervisor,
  sweepStaleRunRoots,
} from "../../packages/libtmux/src/_internal/test/testkit.js";

// Cleanup is a finally, and SIGKILL skips it. A run killed that way left its
// tmux daemon behind under a name no later run revisits; this is where one
// still can. Once per suite process, before anything creates a root of its own.
await sweepStaleRunRoots();

// Every example is a package of its own and the umbrella runs each sibling, so
// one supervisor covers all of them: one run root, forwarded signals, and a
// reap that a Ctrl-C cannot skip.
const forwarded = Bun.argv.slice(2);
const selectsFiles = forwarded[0] !== undefined && !forwarded[0].startsWith("-");

process.exitCode = await runSupervisor({
  command: ["bun", "test", "--no-orphans", ...(selectsFiles ? forwarded : [".", ...forwarded])],
  cwd: new URL("..", import.meta.url).pathname,
});
