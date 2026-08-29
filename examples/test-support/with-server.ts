// The library's real-tmux fixture harness, which is internal and unpublished.
// In-repo consumers use it directly; external ones have no need for it.
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../packages/libtmux/src/_internal/test/testkit.js";
import { TestServer } from "../../packages/libtmux/src/_internal/test/test_server.js";
import {
  assertOwnedSocketPath,
  makeTestDirectory,
} from "../../packages/libtmux/src/_internal/test/temp_root.js";

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
  const parent = await makeTestDirectory("ltx-examples-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "examples" });
        assertOwnedSocketPath(fixture.socketPath);
        await runWithCleanup(
          () => body(fixture),
          () => fixture.dispose(),
        );
      },
      async () => {
        if (published === undefined) await reapOwnedRunRoot(runRoot);
        done = true;
      },
    );
  } finally {
    if (done) await rm(parent, { force: true, recursive: true });
  }
}
