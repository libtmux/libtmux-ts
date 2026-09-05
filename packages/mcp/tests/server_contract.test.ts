import { expect, test } from "bun:test";

import { serverFor, structured, withClient, withServer } from "./support/server_harness.js";

test("the stdio server executes the retained capability surface end to end", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(47);
      expect((await client.listResources()).resources.map(({ uri }) => uri)).toEqual([
        "tmux://capabilities",
      ]);
      const capabilityResource = await client.readResource({ uri: "tmux://capabilities" });
      const capabilityContent = capabilityResource.contents[0];
      const capabilityText =
        capabilityContent !== undefined && "text" in capabilityContent
          ? capabilityContent.text
          : "";
      const capabilityReport = JSON.parse(capabilityText) as {
        readonly connection: {
          readonly attachCommand: string;
          readonly resolvedSocketPath: string;
        };
        readonly frozen: boolean;
      };
      expect(capabilityReport).toMatchObject({
        connection: {
          attachCommand: expect.stringContaining(" -N -S "),
          resolvedSocketPath: fixture.socketPath,
        },
        frozen: true,
      });

      const created = structured<{
        paneId: string;
        session: { id: string };
        windowId: string;
      }>(
        await client.callTool({
          arguments: { height: 30, name: "mcp-contract", width: 100, windowName: "main" },
          name: "create_session",
        }),
      );
      expect(created.paneId).toMatch(/^%\d+$/u);
      expect(created.session.id).toMatch(/^\$\d+$/u);
      expect(created.windowId).toMatch(/^@\d+$/u);
      const direct = (await serverFor(fixture).snapshot()).sessions.one({ name: "mcp-contract" });
      expect(typeof direct.id, JSON.stringify(direct.format)).toBe("string");
      expect(typeof created.session.id).toBe("string");

      const renameAnswer = await client.callTool({
        arguments: { name: "mcp-renamed", session: created.session.id },
        name: "rename_session",
      });
      expect(renameAnswer.isError, JSON.stringify(renameAnswer)).not.toBe(true);
      const renamed = structured<{ session: { name: string } }>(renameAnswer);
      expect(renamed.session.name).toBe("mcp-renamed");

      const command = structured<{ exitStatus: number | null; outcome: string; output: string }>(
        await client.callTool({
          arguments: { command: "printf 'regex-42\\n'", paneId: created.paneId },
          name: "run_shell_command",
        }),
      );
      expect(command).toMatchObject({ exitStatus: 0, outcome: "completed", output: "regex-42" });

      const search = structured<{ matches: readonly { paneId: string; text: string }[] }>(
        await client.callTool({
          arguments: {
            pattern: "^regex-[0-9]+$",
            regex: true,
            session: created.session.id,
          },
          name: "search_panes",
        }),
      );
      expect(search.matches).toContainEqual(
        expect.objectContaining({ paneId: created.paneId, text: "regex-42" }),
      );

      const seeded = structured<{ cursor: string | null }>(
        await client.callTool({ arguments: { paneId: created.paneId }, name: "capture_since" }),
      );
      expect(seeded.cursor).toBeString();
      const waiting = client.callTool({
        arguments: {
          cursor: seeded.cursor,
          paneId: created.paneId,
          patterns: ["wait-[0-9][0-9]"],
          regex: true,
          timeoutMs: 2_000,
        },
        name: "wait_for_text",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fixture.executeText([
        "send-keys",
        "-t",
        created.paneId,
        "printf 'wait-77\\n'",
        "Enter",
      ]);
      expect(structured<{ matched: string | null; outcome: string }>(await waiting)).toMatchObject({
        matched: "wait-[0-9][0-9]",
        outcome: "matched",
      });

      const batch = structured<{
        failed: number;
        results: readonly { result: { content: readonly unknown[] }; tool: string }[];
        stoppedAt: number | null;
        succeeded: number;
        truncated: boolean;
        truncatedBytes: number;
      }>(
        await client.callTool({
          arguments: {
            operations: [
              { tool: "list_sessions" },
              { arguments: { paneId: created.paneId }, tool: "get_pane_info" },
            ],
          },
          name: "call_read_tools_batch",
        }),
      );
      expect(batch).toMatchObject({
        failed: 0,
        stoppedAt: null,
        succeeded: 2,
        truncated: false,
        truncatedBytes: 0,
      });
      expect(batch.results.map(({ tool }) => tool)).toEqual(["list_sessions", "get_pane_info"]);
      expect(batch.results.every(({ result }) => result.content.length > 0)).toBe(true);

      const call = async (name: string, arguments_: Readonly<Record<string, unknown>> = {}) => {
        const answer = await client.callTool({ arguments: arguments_, name });
        expect(answer.isError, `${name}: ${JSON.stringify(answer.content)}`).not.toBe(true);
        return answer;
      };

      const extraWindow = structured<{ paneId: string; window: { id: string } }>(
        await call("create_window", { name: "extra", session: created.session.id }),
      );
      const split = structured<{ pane: { id: string } }>(
        await call("split_window", { direction: "right", paneId: created.paneId }),
      );

      await call("list_windows", { session: created.session.id });
      await call("list_panes", { session: created.session.id });
      await call("get_server_info");
      await call("get_session_info", { session: created.session.id });
      await call("get_window_info", { windowId: created.windowId });
      await call("capture_pane", { paneId: created.paneId });
      await call("snapshot_pane", { paneId: created.paneId });
      await call("find_pane_by_position", {
        corner: "top-left",
        windowId: created.windowId,
      });
      await call("get_tmux_variables", {
        names: ["session_name", "pane_id"],
        paneId: created.paneId,
      });
      await call("show_option", { name: "history-limit" });
      await call("show_environment", { session: created.session.id });
      await call("show_hooks", { session: created.session.id });

      await call("rename_window", { name: "renamed-extra", windowId: extraWindow.window.id });
      await call("select_pane", { paneId: split.pane.id });
      await call("select_layout", { layout: "even-horizontal", windowId: created.windowId });
      await call("resize_pane", { amount: 1, direction: "right", paneId: created.paneId });
      await call("resize_window", { height: 32, width: 104, windowId: created.windowId });
      await call("swap_pane", { otherPaneId: split.pane.id, paneId: created.paneId });
      await call("set_pane_title", { paneId: created.paneId, title: "contract-pane" });
      await call("move_window", { index: 7, windowId: extraWindow.window.id });
      await call("select_window", { windowId: extraWindow.window.id });
      await call("enter_copy_mode", { paneId: created.paneId, scrollUp: 1 });
      await call("exit_copy_mode", { paneId: created.paneId });
      await call("set_mouse_enabled", { enabled: true });
      await call("set_history_limit", { lines: 4_000 });

      const channelWait = call("wait_for_channel", {
        channel: "mcp-contract-ready",
        timeoutMs: 2_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await call("signal_channel", { channel: "mcp-contract-ready" });
      await channelWait;

      await call("set_synchronize_panes", { enabled: true, windowId: created.windowId });
      const synchronized = structured<{ resolvedPaneIds: readonly string[] }>(
        await call("send_keys", {
          enter: false,
          keys: "C-l",
          paneId: created.paneId,
        }),
      );
      expect(new Set(synchronized.resolvedPaneIds)).toEqual(
        new Set([created.paneId, split.pane.id]),
      );
      await call("send_keys_batch", {
        operations: [
          { enter: false, keys: "C-l", paneId: created.paneId },
          { enter: false, keys: "C-l", paneId: split.pane.id },
        ],
      });
      await call("set_synchronize_panes", { enabled: false, windowId: created.windowId });
      await call("paste_text", { enter: true, paneId: created.paneId, text: "true" });
      await call("respawn_pane", {
        force: true,
        killFirst: true,
        paneId: extraWindow.paneId,
      });

      await call("clear_pane_scrollback", { paneId: created.paneId });
      await call("kill_pane", { force: true, paneId: split.pane.id });
      await call("kill_window", { force: true, windowId: extraWindow.window.id });

      const removed = structured<{ killed: string }>(
        await client.callTool({
          arguments: { force: true, session: created.session.id },
          name: "kill_session",
        }),
      );
      expect(removed.killed).toBe(created.session.id);
      expect((await client.callTool({ arguments: {}, name: "kill_server" })).isError).toBe(true);
    });
  });
}, 60_000);
