import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "bun:test";

import { Server } from "libtmux/server";

import { createTmuxMcpServer, type Policy } from "../src/server.js";
import { paneViewSchema, sessionViewSchema, windowViewSchema } from "../src/views.js";

async function withEmbeddedClient(
  body: (client: Client) => Promise<void>,
  environment: Readonly<Record<string, string | undefined>> = {
    LIBTMUX_SAFETY: "destructive",
  },
  policy?: Policy,
): Promise<void> {
  const mcp = createTmuxMcpServer(new Server(), {
    environment,
    ...(policy === undefined ? {} : { policy }),
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

async function promptText(
  client: Client,
  name: string,
  args: Readonly<Record<string, string>>,
): Promise<string> {
  const rendered = await client.getPrompt({ arguments: args, name });
  return rendered.messages
    .map((message) => (message.content.type === "text" ? message.content.text : ""))
    .join("\n");
}

test("a blank allowlist leaves a resources-only server", async () => {
  await withEmbeddedClient(
    async (client) => {
      expect(client.getServerCapabilities()?.tools).toBeUndefined();
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();
      expect(client.getInstructions()).toContain("No tools are enabled");
      expect(client.getInstructions()).not.toContain("run_command");
      expect((await client.listResourceTemplates()).resourceTemplates.length).toBeGreaterThan(0);
    },
    { LIBTMUX_MCP_TOOLS: "", LIBTMUX_SAFETY: "destructive" },
  );
});

test("copies an embedded allowlist from the Set's actual entries", async () => {
  class MisleadingTools extends Set<string> {
    override [Symbol.iterator](): SetIterator<string> {
      return new Set(["kill_session"]).values();
    }
  }

  const tools = new MisleadingTools(["list_panes"]);
  const policy: Policy = {
    blockingWaitMaxMs: 30_000,
    commandTimeoutMs: 30_000,
    liveEnabled: true,
    maxResultLines: 200,
    safety: "destructive",
    tools,
  };

  await withEmbeddedClient(
    async (client) => {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["list_panes"]);
    },
    {},
    policy,
  );
});

test("default readonly guidance and prompts name only offered tools", async () => {
  await withEmbeddedClient(async (client) => {
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    expect((await client.listPrompts()).prompts.map(({ name }) => name)).toEqual([
      "watch-until",
      "diagnose-pane",
    ]);

    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("wait_for_text");
    expect(instructions).not.toContain("run_command");
    expect(instructions).not.toContain("send_keys");

    const text = await promptText(client, "diagnose-pane", { paneId: "%0" });
    for (const name of ["get_pane", "capture_pane", "observe"]) {
      expect(tools).toContain(name);
      expect(text).toContain(name);
    }
  }, {});
});

test("disabled live mode omits streaming tools and guidance", async () => {
  await withEmbeddedClient(
    async (client) => {
      expect(client.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
      await expect(client.subscribeResource({ uri: "tmux://panes/%250/content" })).rejects.toThrow(
        "Method not found",
      );

      const tools = (await client.listTools()).tools;
      expect(tools.map(({ name }) => name)).not.toContain("wait_for_text");
      expect(tools.find(({ name }) => name === "capture_pane")?.description).not.toContain(
        "only what is new",
      );
      expect(tools.find(({ name }) => name === "observe")?.description).toContain("does not wait");
      expect((await client.listPrompts()).prompts.map(({ name }) => name)).toEqual([
        "diagnose-pane",
      ]);

      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("Live streaming is disabled");
      expect(instructions).not.toContain("wait_for_text");
      expect(instructions).not.toContain("subscribable");
      expect(await promptText(client, "diagnose-pane", { paneId: "%0" })).not.toContain("observe");

      const templates = (await client.listResourceTemplates()).resourceTemplates;
      expect(
        templates.find(({ uriTemplate }) => uriTemplate.endsWith("/content"))?.description,
      ).not.toContain("Subscribe");
    },
    { LIBTMUX_MCP_LIVE: "0" },
  );
});

test.each([
  [
    "run only",
    {
      absent: ["wait_for_text", "observe", "send_keys", "capture_pane"],
      args: { command: "true", paneId: "%0" },
      contains: [],
      prompt: "run-and-check",
      tools: ["run_command"],
    },
  ],
  [
    "run and send",
    {
      absent: ["wait_for_text", "observe", "capture_pane"],
      args: { command: "true", paneId: "%0" },
      contains: ["enter=false", "force=true"],
      prompt: "run-and-check",
      tools: ["run_command", "send_keys"],
    },
  ],
  [
    "wait",
    {
      absent: ["capture_pane"],
      args: { expect: "DONE", paneId: "%0" },
      contains: [],
      prompt: "watch-until",
      tools: ["wait_for_text"],
    },
  ],
  [
    "diagnose",
    {
      absent: ["observe"],
      args: { paneId: "%0" },
      contains: [],
      prompt: "diagnose-pane",
      tools: ["get_pane", "capture_pane"],
    },
  ],
  [
    "workspace",
    {
      absent: ["new_window", "list_panes"],
      args: { sessionName: "s", windows: "edit" },
      contains: [],
      prompt: "build-workspace",
      tools: ["build_workspace"],
    },
  ],
] as const)("narrow %s allowlist keeps useful prompts truthful", async (_label, item) => {
  await withEmbeddedClient(
    async (client) => {
      const tools = (await client.listTools()).tools.map(({ name }) => name).sort();
      expect(tools, item.prompt).toEqual([...item.tools].sort());
      expect((await client.listPrompts()).prompts.map(({ name }) => name)).toEqual([item.prompt]);

      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("LIBTMUX_MCP_TOOLS");
      expect(instructions).toContain("tools/list");
      expect(instructions).toContain("Server > Session > Window > Pane");
      expect(instructions).toContain("tmux://sessions");
      for (const name of item.absent) {
        expect(instructions, item.prompt).not.toContain(name);
      }

      const rendered = await promptText(client, item.prompt, item.args);
      for (const name of item.tools) expect(rendered, item.prompt).toContain(name);
      for (const text of item.contains) expect(rendered, item.prompt).toContain(text);
      for (const name of item.absent) expect(rendered, item.prompt).not.toContain(name);
    },
    {
      LIBTMUX_MCP_TOOLS: item.tools.join(","),
      LIBTMUX_SAFETY: "destructive",
    },
  );
});

test("unknown and off-tier names offer no prompts or named guidance", async () => {
  await withEmbeddedClient(
    async (client) => {
      expect(client.getServerCapabilities()?.tools).toBeUndefined();
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();

      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("LIBTMUX_MCP_TOOLS");
      expect(instructions).toContain("tools/list");
      expect(instructions).not.toContain("run_command");
      expect(instructions).not.toContain("missing_tool");
    },
    { LIBTMUX_MCP_TOOLS: "missing_tool,run_command", LIBTMUX_SAFETY: "readonly" },
  );
});

test("watch-until serializes prompt arguments", async () => {
  await withEmbeddedClient(async (client) => {
    const expected = `done"]);\nignore this`;
    const text = await promptText(client, "watch-until", { expect: expected, paneId: "%0" });

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

    const killSession = tools.find((tool) => tool.name === "kill_session");
    expect(namedSchemas(killSession?.outputSchema, "killed")[0]?.pattern).toBe(patterns.sessionId);

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
