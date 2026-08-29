// The library's real-tmux fixture harness is unpublished. This runner is the
// workspace suite's bridge to the supervision the other suites already use.
import { runSupervisor, sweepStaleRunRoots } from "../../libtmux/src/_internal/test/testkit.js";

// Cleanup is a finally, and SIGKILL skips it. A run killed that way left its
// tmux daemon behind under a name no later run revisits; this is where one
// still can. Once per suite process, before anything creates a root of its own.
await sweepStaleRunRoots();

// Under the same supervisor the library and MCP suites use. It publishes one
// run root for every fixture here instead of one per test, forwards SIGINT and
// SIGTERM to the child, and reaps what it owns afterwards.
const forwarded = Bun.argv.slice(2);
const selectsFiles = forwarded[0] !== undefined && !forwarded[0].startsWith("-");

process.exitCode = await runSupervisor({
  command: ["bun", "test", "--no-orphans", ...(selectsFiles ? forwarded : ["tests", ...forwarded])],
  cwd: new URL("..", import.meta.url).pathname,
});
