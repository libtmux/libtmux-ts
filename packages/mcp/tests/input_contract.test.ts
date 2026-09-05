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

test("paste_text keeps its Enter and payload target-only", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string; windowId: string }>(
        await client.callTool({
          arguments: { name: "paste-target" },
          name: "create_session",
        }),
      );
      const split = structured<{ pane: { id: string } }>(
        await client.callTool({
          arguments: { paneId: created.paneId },
          name: "split_window",
        }),
      );
      await client.callTool({
        arguments: { enabled: true, windowId: created.windowId },
        name: "set_synchronize_panes",
      });

      const marker = "LTX_PASTE_TARGET_ONLY_42";
      const pasted = await client.callTool({
        arguments: {
          enter: true,
          paneId: created.paneId,
          text: `printf '${marker}\\n'`,
        },
        name: "paste_text",
      });
      expect(pasted.isError, JSON.stringify(pasted.content)).not.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const source = structured<{ text: string }>(
        await client.callTool({
          arguments: { paneId: created.paneId },
          name: "capture_pane",
        }),
      );
      const peer = structured<{ text: string }>(
        await client.callTool({
          arguments: { paneId: split.pane.id },
          name: "capture_pane",
        }),
      );
      expect(source.text).toContain(marker);
      expect(peer.text).not.toContain(marker);

      const buffers = await fixture.executeText(["list-buffers", "-F", "#{buffer_name}"]);
      expect(buffers.stdout.filter((name) => name.startsWith("ltx-mcp-paste-"))).toEqual([]);
    });
  });
}, 15_000);
