// The library's real-tmux fixture harness, which is internal and unpublished.
// In-repo consumers use it directly; external ones have no need for it.

import {
  runWithCleanup,
  withOwnedRunRoot,
  TestServer,
  assertOwnedSocketPath,
} from "../../packages/libtmux/src/_internal/test/testkit.js";

/**
 * Hand a test an isolated, real tmux server and reap it afterwards.
 *
 * Shared by every per-example test, so an example's own code never imports the
 * fixture harness — only the test that drives it does. `LIBTMUX_TEST_RUN_ROOT`
 * lets one process host several fixtures under a run root a parent test
 * already prepared and will reap itself; unset, this function owns the whole
 * lifecycle: prepare, reap, and remove the parent directory it made.
 */
export async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  return withOwnedRunRoot("ltx-examples-", async (runRoot) => {
    const fixture = await TestServer.create({ runRoot, sessionName: "examples" });
    assertOwnedSocketPath(fixture.socketPath);
    await runWithCleanup(
      () => body(fixture),
      () => fixture.dispose(),
    );
  });
}
