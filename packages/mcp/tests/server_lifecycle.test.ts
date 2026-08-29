import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";

import { createTmuxMcpServer } from "../src/server.js";
import { paneContentUri } from "../src/uris.js";
import { serverFor, withServer } from "./support/server_harness.js";

describe("cleaning up after itself", () => {
  test("drops its control connections when an embedded client goes away", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const controlClients = async (): Promise<number> =>
        (await tmux.clients()).toArray().filter((entry) => entry.controlMode === true).length;

      // In-process, not over stdio: a stdio server dies with its transport and
      // takes its `tmux -C attach` child along, so that case cannot show a leak
      // whether or not one exists. An embedded host outlives its client.
      const before = await controlClients();
      const mcp = createTmuxMcpServer(tmux, { environment: {} });
      const client = new Client({ name: "embedded", version: "0.0.0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);

      const paneId = (await tmux.snapshot()).panes.one().id;
      const uri = paneContentUri(paneId);
      // Exercise every resource owner sharing the connection: catalog,
      // subscription, and an observed tail.
      await client.listResources();
      await client.subscribeResource({ uri });
      await client.callTool({ arguments: { paneId }, name: "observe" });
      expect(await controlClients()).toBeGreaterThan(before);

      await client.close();
      await mcp.close();
      await mcp.close();

      expect(await controlClients()).toBe(before);
    });
  }, 60_000);
});

describe("the library underneath", () => {
  test("registers against a real server without a transport", async () => {
    await withServer(async (fixture) => {
      const mcp = createTmuxMcpServer(serverFor(fixture), { environment: {} });
      expect(typeof mcp.connect).toBe("function");
    });
  }, 40_000);
});
