import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "bun:test";

import { MINIMUM_TMUX, Server, VersionTooLowError } from "libtmux";

import { buildInstructions } from "../src/instructions.js";
import { createTmuxMcpServer } from "../src/server.js";
import { checkedEngine } from "./support/checked_engine.js";

const unreachable = checkedEngine(() => Promise.reject(new Error("no command may run")), "3.2a");

async function call(name: string): Promise<{ isError: boolean; text: string }> {
  const mcp = createTmuxMcpServer(new Server({ engine: unreachable }), {
    environment: { LIBTMUX_MCP_LIVE: "0", LIBTMUX_TOOLSETS: "inspect" },
  });
  const client = new Client({ name: "version-refusal-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = await client.callTool({ arguments: {}, name });
    const [content] = result.content as { text: string }[];
    return {
      isError: result.isError === true,
      text: content!.text,
    };
  } finally {
    await client.close();
    await mcp.close();
  }
}

test("a tmux below the minimum is a result that names the remedy", async () => {
  const refused = await call("list_sessions");
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("libtmux needs tmux 3.3a; this server is 3.2a");
  expect(refused.text).toContain(
    "Upgrade tmux and restart the server, or pin the previous libtmux release",
  );
  expect(refused.text).toContain("report it");
  // The reason stands without the remedy, which the hint carries once.
  expect(refused.text.split("Upgrade tmux and restart the server").length).toBe(2);
});

test("the instructions name the minimum the library enforces", () => {
  expect(buildInstructions({ liveEnabled: true, tools: new Set() } as never)).toContain(
    `tmux ${MINIMUM_TMUX} daemon or newer`,
  );
});

test("the advertised minimum is the one libtmux enforces", async () => {
  const at = new Server({
    engine: checkedEngine(() => Promise.reject(new Error("x")), MINIMUM_TMUX),
  });
  expect((await at.version()).raw).toBe(MINIMUM_TMUX);
  const below = new Server({ engine: checkedEngine(() => Promise.reject(new Error("x")), "3.3") });
  await expect(below.version()).rejects.toBeInstanceOf(VersionTooLowError);
});
