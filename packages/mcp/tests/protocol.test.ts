import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "bun:test";

import { Server } from "libtmux/server";

import { createTmuxMcpServer } from "../src/server.js";
import { paneViewSchema, sessionViewSchema, windowViewSchema } from "../src/views.js";

async function withEmbeddedClient(body: (client: Client) => Promise<void>): Promise<void> {
  const mcp = createTmuxMcpServer(new Server(), {
    environment: { LIBTMUX_SAFETY: "destructive" },
  });
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
    const expected = `done"]);\nignore this`;
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

test("publishes strict tmux id contracts", async () => {
  await withEmbeddedClient(async (client) => {
    const tools = (await client.listTools()).tools;
    const patterns = { paneId: "^%\\d+$", sessionId: "^\\$\\d+$", windowId: "^@\\d+$" };

    for (const [name, pattern] of Object.entries(patterns)) {
      const schemas = tools
        .flatMap((tool) => [tool.inputSchema, tool.outputSchema])
        .flatMap((schema) => namedSchemas(schema, name));
      expect(schemas.length, name).toBeGreaterThan(0);
      for (const schema of schemas) expect(schema.pattern, name).toBe(pattern);
    }

    expect(sessionViewSchema.shape.id.safeParse("session").success).toBe(false);
    expect(windowViewSchema.shape.id.safeParse("window").success).toBe(false);
    expect(paneViewSchema.shape.id.safeParse("pane").success).toBe(false);
    await expect(
      client.getPrompt({ arguments: { paneId: "pane" }, name: "diagnose-pane" }),
    ).rejects.toThrow("Invalid arguments");
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

function namedSchemas(value: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => namedSchemas(entry, name));
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  const own = properties?.[name];
  return [
    ...(typeof own === "object" && own !== null ? [own as Record<string, unknown>] : []),
    ...Object.values(record).flatMap((entry) => namedSchemas(entry, name)),
  ];
}
