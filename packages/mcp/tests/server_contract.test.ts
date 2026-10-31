import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildInstructions } from "../src/instructions.js";
import { describeStartupFailure } from "../src/server.js";
import { describeStartup } from "../src/startup.js";
import { serverFor, structured, withClient, withServer } from "./support/server_harness.js";
import { testControl } from "../../libtmux/tests/support/tmux_release.js";

testControl(
  "the stdio server executes the retained capability surface end to end",
  async () => {
    await withServer(async (fixture) => {
      await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
      await withClient(fixture, async (client) => {
        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(50);
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
        expect(
          structured<{ matched: string | null; outcome: string }>(await waiting),
        ).toMatchObject({
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
        // The MCP tool passes a caller's layout straight to
        // `Window.selectLayout`, so it inherits the `--` guard against tmux
        // reading a bare `-o` as its own undo flag. Without the guard this call
        // would silently succeed and revert the window's layout.
        const beforeUndoAttempt = (await serverFor(fixture).snapshot()).windows.one({
          id: created.windowId,
        }).format.window_layout;
        const undoAttempt = await client.callTool({
          arguments: { layout: "-o", windowId: created.windowId },
          name: "select_layout",
        });
        expect(undoAttempt.isError).toBe(true);
        const afterUndoAttempt = (await serverFor(fixture).snapshot()).windows.one({
          id: created.windowId,
        }).format.window_layout;
        expect(afterUndoAttempt).toBe(beforeUndoAttempt);
        await call("resize_pane", { amount: 1, direction: "right", paneId: created.paneId });
        await call("resize_window", { height: 32, width: 104, windowId: created.windowId });
        await call("swap_pane", { otherPaneId: split.pane.id, paneId: created.paneId });
        await call("set_pane_title", { paneId: created.paneId, title: "contract-pane" });
        await call("move_window", { index: 7, windowId: extraWindow.window.id });
        await call("select_window", { windowId: extraWindow.window.id });
        await call("set_mouse_enabled", { enabled: true });
        await call("set_history_limit", { lines: 4_000 });

        const channelWait = call("wait_for_channel", {
          channel: "mcp-contract-ready",
          timeoutMs: 2_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await call("signal_channel", { channel: "mcp-contract-ready" });
        await channelWait;

        // Both tools pass the channel straight to tmux's own `wait-for`, so a
        // name starting with `-` proves the same `--` guard `select_layout`
        // gets above. `-e` is not one of `wait-for`'s own flags (`-L`, `-S`,
        // `-U`): without the guard tmux's parser would refuse it outright as
        // an unknown option before any wait was even registered, and either
        // call below would reject instead of resolving.
        const dashChannelWait = call("wait_for_channel", { channel: "-e", timeoutMs: 2_000 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await call("signal_channel", { channel: "-e" });
        await dashChannelWait;

        await call("set_synchronize_panes", { enabled: true, windowId: created.windowId });
        const synchronizedAnswer = await call("send_keys", {
          enter: false,
          keys: "C-l",
          paneId: created.paneId,
        });
        const synchronized = structured<{ resolvedPaneIds: readonly string[] }>(synchronizedAnswer);
        expect(new Set(synchronized.resolvedPaneIds)).toEqual(
          new Set([created.paneId, split.pane.id]),
        );
        const synchronizedText = (
          synchronizedAnswer as { content: readonly { text?: string; type: string }[] }
        ).content[0];
        expect(synchronizedText?.type === "text" ? synchronizedText.text : "").toContain(
          "configured input cohort",
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
  },
  60_000,
);

// `tile`/`even-h` are unique preset prefixes tmux's own `select-layout`
// applies (`layout_set_lookup`), so `select_layout`'s "ignored" heuristic
// must recognise a prefix form rather than only the full preset names.
test("select_layout applies a unique preset prefix without reporting it ignored", async () => {
  await withServer(async (fixture) => {
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string; windowId: string }>(
        await client.callTool({ arguments: { name: "prefix-layout" }, name: "create_session" }),
      );
      await client.callTool({
        arguments: { direction: "right", paneId: created.paneId },
        name: "split_window",
      });

      const answer = await client.callTool({
        arguments: { layout: "tile", windowId: created.windowId },
        name: "select_layout",
      });
      expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
      const text = (answer as { content: readonly { text?: string; type: string }[] }).content[0];
      expect(text?.type === "text" ? text.text : "").not.toContain("was not applied");

      const result = structured<{ window: { layout: string | null } }>(answer);
      expect(result.window.layout).not.toBeNull();
    });
  });
}, 40_000);

// `wait_for_text` must never match keys the caller typed but never ran. A
// pane whose reader has not started yet queues type-ahead with echo off; once
// the reader starts, it re-prints the queue as genuinely new bytes arriving
// after a wait subscribes. `stty raw -echo; sleep; cat` reproduces that
// deterministically instead of depending on the caller's own zsh.
test("wait_for_text does not match its own unsubmitted type-ahead", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText([
      "set-option",
      "-g",
      "default-command",
      "stty raw -echo; sleep 0.4; exec cat",
    ]);
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string }>(
        await client.callTool({
          arguments: { height: 24, name: "echo-trap", width: 80 },
          name: "create_session",
        }),
      );
      const marker = `QAMARK-${String(Date.now())}`;

      const sent = await client.callTool({
        arguments: { enter: false, keys: marker, literal: true, paneId: created.paneId },
        name: "send_keys",
      });
      expect(sent.isError, JSON.stringify(sent)).not.toBe(true);

      const waited = structured<{ alreadyOnScreen: boolean; outcome: string }>(
        await client.callTool({
          arguments: { paneId: created.paneId, patterns: [marker], timeoutMs: 1_200 },
          name: "wait_for_text",
        }),
      );

      // Never a plain match on text this server typed but never submitted —
      // the pane's own delayed reader re-printing it does not change that.
      expect(waited.outcome).not.toBe("matched");
      expect(waited.outcome).toBe("timed_out");
      expect(waited.alreadyOnScreen).toBe(true);
    });
  });
}, 20_000);

// A wait continued from an earlier cursor reads exactly the bytes after that
// cursor, so unlike a fresh subscribe it carries no ambiguity about whether
// they are a redraw of old content. Suppressing them the same way as a fresh
// wait's entry screen defeats the retry the tool's own hint recommends: text
// that printed between two calls reads as already on screen instead of as
// what the caller asked to be told about.
testControl(
  "wait_for_text matches new output on a cursor continued from a timed-out wait",
  async () => {
    await withServer(async (fixture) => {
      await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
      await withClient(fixture, async (client) => {
        const created = structured<{ paneId: string }>(
          await client.callTool({
            arguments: { height: 24, name: "cursor-continue", width: 80 },
            name: "create_session",
          }),
        );
        const marker = `QACONT-${String(Date.now())}`;

        const first = structured<{ cursor: string | null; outcome: string }>(
          await client.callTool({
            arguments: { paneId: created.paneId, patterns: [marker], timeoutMs: 300 },
            name: "wait_for_text",
          }),
        );
        expect(first.outcome).toBe("timed_out");
        expect(first.cursor).toBeString();

        await fixture.executeText([
          "send-keys",
          "-t",
          created.paneId,
          `printf '${marker}\\n'`,
          "Enter",
        ]);
        await new Promise((resolve) => setTimeout(resolve, 200));

        const second = structured<{ matched: string | null; outcome: string }>(
          await client.callTool({
            arguments: {
              cursor: first.cursor,
              paneId: created.paneId,
              patterns: [marker],
              timeoutMs: 1_000,
            },
            name: "wait_for_text",
          }),
        );
        expect(second.outcome).toBe("matched");
        expect(second.matched).toBe(marker);
      });
    });
  },
  20_000,
);

// `attachedClients` is an accurate raw tmux count, but it includes this
// server's own control-mode observers - a `wait_for_text` in flight opens
// one. `humanAttachedClients` excludes them.
testControl(
  "list_sessions separates a raw attached count from a human-only one",
  async () => {
    await withServer(async (fixture) => {
      await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
      await withClient(fixture, async (client) => {
        const created = structured<{ paneId: string; session: { id: string } }>(
          await client.callTool({ arguments: { name: "attach-count" }, name: "create_session" }),
        );

        const before = structured<{
          sessions: readonly {
            attachedClients: number;
            humanAttachedClients: number;
            id: string;
          }[];
        }>(await client.callTool({ arguments: {}, name: "list_sessions" }));
        const beforeSession = before.sessions.find((session) => session.id === created.session.id);
        expect(beforeSession).toMatchObject({ attachedClients: 0, humanAttachedClients: 0 });

        const waiting = client.callTool({
          arguments: { paneId: created.paneId, patterns: ["NEVER-MATCHES-D2"], timeoutMs: 3_000 },
          name: "wait_for_text",
        });
        // Let the control connection actually attach before reading its effect.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const during = structured<{
          sessions: readonly {
            attachedClients: number;
            humanAttachedClients: number;
            id: string;
          }[];
        }>(await client.callTool({ arguments: {}, name: "list_sessions" }));
        const duringSession = during.sessions.find((session) => session.id === created.session.id);
        expect(duringSession).toMatchObject({ attachedClients: 1, humanAttachedClients: 0 });

        await waiting;
      });
    });
  },
  20_000,
);

// The trailer that removes the private mkdtemp directory (`command.ts`
// `deliverFramedScript`) runs only once the sourced script exits, so a call
// that returns first, or finds its pane killed, removes the directory itself.
test("a run past its timeout no longer needs its private directory", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    const scratchTmp = await mkdtemp(join(tmpdir(), "ltxscratch-"));
    try {
      await withClient(
        fixture,
        async (client) => {
          const created = structured<{ paneId: string }>(
            await client.callTool({
              arguments: { height: 24, name: "outlives", width: 80 },
              name: "create_session",
            }),
          );
          const result = structured<{ outcome: string }>(
            await client.callTool({
              arguments: { command: "sleep 3", paneId: created.paneId, timeoutMs: 1_000 },
              name: "run_shell_command",
            }),
          );
          expect(result.outcome).toBe("timed_out");
          // The shell holds the script open once it starts, so nothing waits on its trailer.
          const leftover = await readdir(scratchTmp);
          expect(leftover.filter((name) => name.startsWith("ltx-"))).toEqual([]);
        },
        { TMPDIR: scratchTmp },
      );
    } finally {
      await rm(scratchTmp, { force: true, recursive: true });
    }
  });
}, 20_000);

test("a run its shell never read takes its private directory once the pane goes", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    const scratchTmp = await mkdtemp(join(tmpdir(), "ltxscratch-"));
    const scripts = async (): Promise<string[]> =>
      (await readdir(scratchTmp)).filter((name) => name.startsWith("ltx-"));
    try {
      await withClient(
        fixture,
        async (client) => {
          const created = structured<{ paneId: string }>(
            await client.callTool({
              arguments: { height: 24, name: "unread", width: 80 },
              name: "create_session",
            }),
          );
          // A shell busy with builtins still reads as a shell, so the command is typed and
          // waits unread: it may yet run, and its script must stay while the pane does.
          await fixture.executeText([
            "send-keys",
            "-t",
            created.paneId,
            "while :; do :; done",
            "Enter",
          ]);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const result = structured<{ outcome: string; stillRunning: boolean }>(
            await client.callTool({
              arguments: { command: "true", paneId: created.paneId, timeoutMs: 1_000 },
              name: "run_shell_command",
            }),
          );
          expect(result).toMatchObject({ outcome: "timed_out", stillRunning: true });
          expect(await scripts()).toHaveLength(1);

          await fixture.executeText(["kill-pane", "-t", created.paneId]);
          const deadline = performance.now() + 8_000;
          // eslint-disable-next-line no-await-in-loop -- each poll follows the previous observation.
          while ((await scripts()).length > 0 && performance.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop -- the monitor samples liveness over time.
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          expect(await scripts()).toEqual([]);
        },
        { TMPDIR: scratchTmp },
      );
    } finally {
      await rm(scratchTmp, { force: true, recursive: true });
    }
  });
}, 20_000);

test("a pane killed mid-run returns what it printed and takes its private directory", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    const scratchTmp = await mkdtemp(join(tmpdir(), "ltxscratch-"));
    try {
      await withClient(
        fixture,
        async (client) => {
          const created = structured<{ paneId: string }>(
            await client.callTool({
              arguments: { height: 24, name: "kill-mid-run", width: 80 },
              name: "create_session",
            }),
          );
          const running = client.callTool({
            arguments: {
              command: "echo one; echo two; sleep 30",
              paneId: created.paneId,
              timeoutMs: 15_000,
            },
            name: "run_shell_command",
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
          await fixture.executeText(["kill-pane", "-t", created.paneId]);
          const killed = performance.now();

          const result = structured<{ outcome: string; output: string }>(await running);
          expect(result.outcome).toBe("pane_died");
          expect(result.output).toBe("one\ntwo\n");
          // Answered once the pane is seen gone, not at the timeout.
          expect(performance.now() - killed).toBeLessThan(5_000);
        },
        { TMPDIR: scratchTmp },
      );

      // The trailer that would remove it runs only in the pane, so the run that saw it die does.
      const leftover = await readdir(scratchTmp);
      expect(leftover.filter((name) => name.startsWith("ltx-"))).toEqual([]);
    } finally {
      await rm(scratchTmp, { force: true, recursive: true });
    }
  });
}, 20_000);
test.each(["prefix", "mirrored", "uppercase-saved", "pruned-saved"] as const)(
  "select_layout reports native readback for %s input",
  async (form) => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call = async (name: string, arguments_: Readonly<Record<string, unknown>> = {}) => {
          const result = await client.callTool({ arguments: arguments_, name });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          return result;
        };
        const server = structured<{ minimumVersion: string; pid: string; version: string }>(
          await call("get_server_info"),
        );
        expect(server.pid).toMatch(/^\d+$/u);
        expect(server.minimumVersion).toBe("3.3a");
        const hasMirroredLayouts = await serverFor(fixture).versionAtLeast("3.5");
        const created = structured<{ paneId: string; windowId: string }>(
          await call("create_session", {
            height: 30,
            name: "layout-forms",
            width: 100,
          }),
        );
        await call("split_window", { direction: "right", paneId: created.paneId });
        await call("select_layout", { layout: "even-vertical", windowId: created.windowId });
        const before = structured<{ window: { layout: string; metadataComplete: boolean } }>(
          await call("get_window_info", { windowId: created.windowId }),
        ).window;
        expect(before.metadataComplete).toBe(true);
        let layout = "even-h";
        if (form === "mirrored") {
          layout = hasMirroredLayouts ? "main-horizontal-mirrored" : "main-horizontal";
        } else if (form === "uppercase-saved") {
          layout = before.layout.slice(0, 4).toUpperCase() + before.layout.slice(4);
        } else if (form === "pruned-saved") {
          const extra = structured<{ pane: { id: string } }>(
            await call("split_window", { direction: "below", paneId: created.paneId }),
          );
          layout = structured<{ window: { layout: string } }>(
            await call("get_window_info", { windowId: created.windowId }),
          ).window.layout;
          await call("kill_pane", { force: true, paneId: extra.pane.id });
        }
        const result = await call("select_layout", { layout, windowId: created.windowId });
        const actual = structured<{ window: { layout: string; metadataComplete: boolean } }>(
          result,
        ).window;
        const reread = structured<{ window: { layout: string } }>(
          await call("get_window_info", { windowId: created.windowId }),
        ).window;
        expect(actual.metadataComplete).toBe(true);
        expect(actual.layout).toBe(reread.layout);
        if (form === "prefix") expect(actual.layout).not.toBe(before.layout);
        if (form === "pruned-saved") expect(actual.layout).not.toBe(layout);
        expect(JSON.stringify(result.content)).not.toContain("not applied");
        expect(structured<{ pid: string }>(await call("get_server_info")).pid).toBe(server.pid);

        const invalidName = hasMirroredLayouts ? "main-h" : "main-horizontal-mirrored";
        await Promise.all(
          ["not-a-layout", "ffff,80x24,0,0,0", invalidName].map(async (invalid) => {
            const rejected = await client.callTool({
              arguments: { layout: invalid, windowId: created.windowId },
              name: "select_layout",
            });
            expect(rejected.isError).toBe(true);
            expect(rejected.structuredContent).toBeUndefined();
            expect(JSON.stringify(rejected.content)).toContain(invalid);
            expect(
              structured<{ window: { layout: string } }>(
                await call("get_window_info", { windowId: created.windowId }),
              ).window.layout,
            ).toBe(actual.layout);
          }),
        );
        expect(structured<{ pid: string }>(await call("get_server_info")).pid).toBe(server.pid);
      });
    });
  },
  20_000,
);

/**
 * Run the server as a program, the way a client launches it, and report what a
 * failed launch wrote. `bun` rather than the emitted build: the failure is in
 * the entry guard, which the source and the build share.
 */
async function launchFailing(environment: Record<string, string>): Promise<{
  readonly code: number | null;
  readonly stderr: string;
}> {
  const entry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stderr };
}

test("a launch that cannot reach tmux names the executable instead of a stack", async () => {
  const { code, stderr } = await launchFailing({ LIBTMUX_TMUX_BIN: "/nonexistent/tmux" });

  expect(code).not.toBe(0);
  expect(stderr).toContain("cannot execute /nonexistent/tmux");
  expect(stderr).toContain("install tmux, or set LIBTMUX_TMUX_BIN");
  // The whole point is that a person reads one line: no frames, no `throw` dump.
  expect(stderr).not.toContain("    at ");
  expect(stderr.trimEnd().split("\n")).toHaveLength(1);
}, 30_000);

test("a retired variable refuses with its own message and no stack", async () => {
  const { code, stderr } = await launchFailing({ LIBTMUX_SAFETY: "readonly" });

  expect(code).not.toBe(0);
  expect(stderr).toContain("LIBTMUX_SAFETY");
  expect(stderr).not.toContain("    at ");
  expect(stderr.trimEnd().split("\n")).toHaveLength(1);
}, 30_000);

/**
 * Joining a daemon somebody else started is the one startup fact an operator
 * meets later: the agent is sharing a tmux with whoever else is on that socket.
 * The line says so, and names the socket tmux picked when none was chosen.
 */
test("the startup line says whether a server was already there, and which", () => {
  const facts = (
    server: object,
    environment: Record<string, string>,
    serverState: "absent" | "existing" = "absent",
  ): Parameters<typeof describeStartup>[0] =>
    ({
      caller: {},
      environment,
      policy: { excludeTools: new Set(), tools: new Set(), toolsets: new Set(["inspect"]) },
      server,
      serverState,
      version: "0.0.0",
    }) as unknown as Parameters<typeof describeStartup>[0];

  const absent = describeStartup(facts({ socketName: "agent" }, {}));
  const existing = describeStartup(facts({ socketName: "agent" }, {}, "existing"));

  expect(absent).toContain("serving agent,");
  expect(existing).toContain("serving existing agent,");
  expect(absent).not.toEqual(existing);

  // With no socket chosen the line names the one tmux picks.
  expect(describeStartup(facts({}, {}))).toContain("serving default,");
  expect(describeStartup(facts({}, { TMUX: "/tmp/tmux-1000/work,123,0" }))).toContain(
    "serving /tmp/tmux-1000/work,",
  );
  expect(
    describeStartup(facts({ socketName: "agent" }, { TMUX: "/tmp/tmux-1000/work,123,0" })),
  ).toContain("serving agent,");
});

test("the startup line names the server of the pane it was launched from", () => {
  const facts = {
    caller: {
      paneId: "%0",
      socketPath: "/tmp/tmux-1000/work",
    },
    environment: {},
    policy: { excludeTools: new Set(), tools: new Set(), toolsets: new Set(["inspect"]) },
    server: { socketName: "agent" },
    serverState: "existing",
    version: "0.0.0",
  } as unknown as Parameters<typeof describeStartup>[0];

  expect(describeStartup(facts)).toMatch(/, from pane %0 on \/tmp\/tmux-1000\/work$/u);
  expect(describeStartup({ ...facts, caller: {} } as typeof facts)).not.toContain("from pane");
});

test("the server instructions name the server of the pane they were launched from", () => {
  const policy = { liveEnabled: true, tools: new Set() } as never;
  const attached = buildInstructions(policy, {
    paneId: "%0",
    socketPath: "/tmp/tmux-1000/work",
  } as never);

  expect(attached).toContain("launched from tmux pane %0 on the server at /tmp/tmux-1000/work;");
  expect(buildInstructions(policy, {} as never)).not.toContain("launched from");
});

test("describeStartupFailure falls back to the message for an unrecognized failure", () => {
  expect(describeStartupFailure(new TypeError("LIBTMUX_SOCKET_PATH must be absolute"), {})).toBe(
    "LIBTMUX_SOCKET_PATH must be absolute",
  );
  expect(describeStartupFailure("not an error", {})).toBe("not an error");
});

test("resize_pane treats zoom as a state rather than passing tmux's toggle through", async () => {
  await withServer(async (fixture) => {
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string; windowId: string }>(
        await client.callTool({
          arguments: { height: 30, name: "mcp-zoom", width: 100, windowName: "main" },
          name: "create_session",
        }),
      );
      await client.callTool({
        arguments: { paneId: created.paneId, vertical: true },
        name: "split_window",
      });

      const zoomed = async (): Promise<boolean> =>
        structured<{ window: { zoomed: boolean } }>(
          await client.callTool({
            arguments: { windowId: created.windowId },
            name: "get_window_info",
          }),
        ).window.zoomed;

      const setZoom = async (zoom: boolean): Promise<void> => {
        const answer = await client.callTool({
          arguments: { paneId: created.paneId, zoom },
          name: "resize_pane",
        });
        expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
      };

      expect(await zoomed()).toBe(false);
      await setZoom(true);
      expect(await zoomed()).toBe(true);
      // A toggle would undo the first call; a state does not.
      await setZoom(true);
      expect(await zoomed()).toBe(true);

      await setZoom(false);
      expect(await zoomed()).toBe(false);
      await setZoom(false);
      expect(await zoomed()).toBe(false);

      // tmux unzooms before applying a size, so the two cannot both hold.
      const both = await client.callTool({
        arguments: { height: 5, paneId: created.paneId, zoom: true },
        name: "resize_pane",
      });
      expect(both.isError).toBe(true);
      expect(JSON.stringify(both)).toContain("zoom cannot be combined with a size");
    });
  });
}, 60_000);
