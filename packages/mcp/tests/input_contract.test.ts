import { expect, test } from "bun:test";

import { structured, withClient, withServer } from "./support/server_harness.js";

test("send_keys_batch refuses a pane with an active framed command", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string }>(
        await client.callTool({
          arguments: { name: "batch-active" },
          name: "create_session",
        }),
      );
      const running = structured<{ outcome: string; stillRunning: boolean }>(
        await client.callTool({
          arguments: { command: "sleep 2", paneId: created.paneId, timeoutMs: 50 },
          name: "run_shell_command",
        }),
      );
      expect(running).toMatchObject({ outcome: "timed_out", stillRunning: true });

      const batch = structured<{
        completed: number;
        failures: readonly { reason: string }[];
      }>(
        await client.callTool({
          arguments: {
            operations: [{ enter: false, keys: "x", paneId: created.paneId }],
          },
          name: "send_keys_batch",
        }),
      );
      expect(batch.completed).toBe(0);
      expect(batch.failures[0]?.reason).toContain("run_shell_command");
    });
  });
}, 15_000);
