import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { runWithCleanup } from "../../packages/libtmux/src/_internal/test/run_root.js";
import { withServer } from "../test-support/with-server.js";
import {
  buildWorkspace as buildMcpWorkspace,
  connectAgent,
  runAndCheck,
  waitFor,
  watch as watchPane,
} from "./mcp-agent.js";

describe("mcp-agent", () => {
  test("the mcp example reports a command's own output and its status", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      const client = await connectAgent(server);
      await runWithCleanup(
        async () => {
          const [paneId = ""] = await buildMcpWorkspace(client, "mcp-example", ["shell"]);

          // The echo trap: the text waited for is also in the command sent.
          const ran = await runAndCheck(client, paneId, "echo hello");
          expect(ran.outcome).toBe("completed");
          expect(ran.exitStatus).toBe(0);
          expect(ran.output).toBe("hello");

          // A wait that misses is still an answer, not an empty hand.
          const missed = await waitFor(client, paneId, "never-printed-here", 1_500);
          expect(missed.outcome).toBe("timed_out");
          expect(missed.screen).toContain("hello");

          const failed = await runAndCheck(client, paneId, "exit 3");
          expect(failed.exitStatus).toBe(3);

          // And a repeated read is charged only for what is new.
          const next = await watchPane(client, paneId);
          await runAndCheck(client, paneId, "echo delta");
          const delta = await next(5_000);
          expect(delta.text).toContain("delta");
        },
        () => client.close(),
      );
    });
  }, 90_000);
});
