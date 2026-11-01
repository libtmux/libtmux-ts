import { afterAll, beforeAll } from "bun:test";

import { enterSandbox, type Sandbox } from "../../src/_internal/test/testkit.js";

// Bun reads bunfig.toml from the directory it starts in and from no other, so
// every directory a suite starts in names this file.
let sandbox: Sandbox | undefined = await enterSandbox();
let leaving: Sandbox | undefined;

// A `--rerun-each` round releases the sandbox, so the next one enters again.
beforeAll(async () => {
  sandbox ??= await enterSandbox();
});

// Past the release's own bound, so a stalled call is named rather than cut off by the hook.
afterAll(async () => {
  leaving = sandbox;
  sandbox = undefined;
  await leaving?.release();
}, 90_000);

// A signal skips `afterAll`, so release first, waiting for a release already under way,
// and let the default action follow.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      try {
        await (sandbox ?? leaving)?.release();
      } catch (error) {
        // Nothing awaits this handler, so a failed release would otherwise go unsaid.
        process.stderr.write(`${String(error)}\n`);
      } finally {
        process.kill(process.pid, signal);
      }
    })();
  });
}
