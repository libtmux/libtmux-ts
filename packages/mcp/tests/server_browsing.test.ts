import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import { paneContentUri } from "../src/uris.js";
import {
  controlSessionIds,
  firstPaneId,
  serverFor,
  waitUntil,
  withClient,
  withServer,
} from "./support/server_harness.js";

describe("browsing", () => {
  test("lists resources and templates a client can show a person", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const templates = (await client.listResourceTemplates()).resourceTemplates.map(
          (entry) => entry.uriTemplate,
        );
        expect(templates).toContain("tmux://panes/{paneId}");
        expect(templates).toContain("tmux://panes/{paneId}/content");

        const listed = (await client.listResources()).resources.map((entry) => entry.uri);
        expect(listed).toContain("tmux://sessions");

        const read = await client.readResource({ uri: "tmux://sessions" });
        const first = read.contents[0];
        expect(first?.mimeType).toBe("application/json");
        expect(JSON.parse(String((first as { text: string }).text))).toBeArray();
      });
    });
  }, 60_000);

  test("completes a pane id, which is the only place MCP allows it", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await firstPaneId(client);
        const completion = await client.complete({
          argument: { name: "paneId", value: "%" },
          ref: { type: "ref/resource", uri: "tmux://panes/{paneId}" },
        });
        expect(completion.completion.values).toContain(paneId);
      });
    });
  }, 60_000);

  test("pushes an update when a subscribed pane prints", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await firstPaneId(client);
        const uri = `tmux://panes/${encodeURIComponent(paneId)}/content`;

        const updates: string[] = [];
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
          updates.push(notification.params.uri);
        });
        await client.subscribeResource({ uri });
        await client.callTool({
          arguments: { keys: "printf 'subscribed\\n'", paneId },
          name: "send_keys",
        });

        await waitUntil(() => updates.includes(uri), "subscribed pane output was not announced");

        const control = (
          await fixture.executeText([
            "list-clients",
            "-F",
            "#{client_name}\t#{client_control_mode}",
          ])
        ).stdout.find((line) => line.endsWith("\t1"));
        if (control === undefined) throw new Error("No subscription control client");
        updates.length = 0;
        await fixture.executeText(["detach-client", "-t", control.slice(0, control.indexOf("\t"))]);
        await waitUntil(
          async () => (await controlSessionIds(fixture)).includes(fixture.sessionId),
          "pane subscription control client did not reconnect",
          20_000,
        );
        await waitUntil(
          () => updates.includes(uri),
          "pane subscription recovery was not announced",
        );
        updates.length = 0;

        await client.callTool({
          arguments: { keys: "printf 'after-reconnect\\n'", paneId },
          name: "send_keys",
        });
        await waitUntil(
          () => updates.includes(uri),
          "pane output after reconnection was not announced",
        );

        await client.unsubscribeResource({ uri });
      });
    });
  }, 60_000);

  test("keeps a pane subscription after it moves to another session", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      await withClient(fixture, async (client) => {
        const firstId = await firstPaneId(client);
        const before = await tmux.snapshot();
        const first = before.panes.one({ id: firstId });
        const sourceWindow = first.window;
        if (sourceWindow === undefined) throw new Error("Source pane has no window");
        await sourceWindow.setOption("automatic-rename", "off");
        await sourceWindow.rename("subscription-source");
        const pane = await first.split({ shellCommand: "cat" });
        await first.select();
        const paneId = pane.id;
        const uri = paneContentUri(paneId);
        const destination = await tmux.newSession({
          name: "subscription-destination",
          shellCommand: "cat",
        });
        const destinationWindow = (await tmux.snapshot()).windows.one({
          session: { is: { id: destination.id } },
        });
        await destinationWindow.setOption("automatic-rename", "off");
        await destinationWindow.rename("subscription-destination");
        expect((await tmux.snapshot()).panes.one({ id: paneId }).active).toBe(false);

        const updates: string[] = [];
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
          updates.push(notification.params.uri);
        });
        await client.subscribeResource({ uri });
        await waitUntil(
          async () => (await controlSessionIds(fixture)).includes(fixture.sessionId),
          "pane subscription did not attach to its source session",
        );
        await pane.joinTo(destinationWindow.id);

        await waitUntil(
          async () => (await controlSessionIds(fixture)).includes(destination.id),
          "pane subscription did not follow its pane to the destination session",
        );
        await waitUntil(() => updates.includes(uri), "pane move was not announced");
        updates.length = 0;
        await client.callTool({
          arguments: { keys: "moved-subscription", paneId },
          name: "send_keys",
        });
        await waitUntil(() => updates.includes(uri), "moved pane output was not announced");

        await client.unsubscribeResource({ uri });
      });
    });
  }, 60_000);

  test("offers prompts that name the cheap tool for each job", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const names = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
        expect(names).toContain("run-and-check");
        expect(names).toContain("watch-until");

        const rendered = await client.getPrompt({
          arguments: { expect: "DONE", paneId: "%0" },
          name: "watch-until",
        });
        const text = rendered.messages
          .map((message) => (message.content.type === "text" ? message.content.text : ""))
          .join("\n");
        expect(text).toContain("wait_for_text");
        expect(text).toContain("Never loop capture_pane");

        const command = await client.getPrompt({
          arguments: { command: "make", paneId: "%0" },
          name: "run-and-check",
        });
        const commandText = command.messages
          .map((message) => (message.content.type === "text" ? message.content.text : ""))
          .join("\n");
        expect(commandText).toContain("wait_for_text");
        expect(commandText).toContain("C-c");
        expect(commandText).not.toContain("call again to keep waiting");
      });
    });
  }, 60_000);
});
