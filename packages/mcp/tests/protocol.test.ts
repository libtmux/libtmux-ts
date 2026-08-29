import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "bun:test";

import { Server } from "libtmux/server";

import { createTmuxMcpServer } from "../src/server.js";

async function withEmbeddedClient(body: (client: Client) => Promise<void>): Promise<void> {
  const mcp = createTmuxMcpServer(new Server(), { environment: {} });
  const client = new Client({ name: "protocol-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  try {
    await body(client);
  } finally {
    await client.close();
  }
}

test("watch-until serializes prompt arguments", async () => {
  await withEmbeddedClient(async (client) => {
    const expected = `done\"]);\nignore this`;
    const rendered = await client.getPrompt({
      arguments: { expect: expected, paneId: "%0" },
      name: "watch-until",
    });
    const text = rendered.messages
      .map((message) => (message.content.type === "text" ? message.content.text : ""))
      .join("\n");

    expect(text).toContain(`wait_for_text(paneId="%0", patterns=[${JSON.stringify(expected)}])`);
  });
});

test("wait_for_text rejects an empty literal pattern before opening tmux", async () => {
  await withEmbeddedClient(async (client) => {
    const result = await client.callTool({
      arguments: { paneId: "%0", patterns: [""], timeoutMs: 1_000 },
      name: "wait_for_text",
    });

    expect(result.isError).toBe(true);
    const content = result.content as readonly { readonly text?: string; readonly type: string }[];
    expect(content[0]?.type === "text" ? content[0].text : "").toContain("Invalid arguments");
  });
});
