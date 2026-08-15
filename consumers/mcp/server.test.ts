import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "bun:test";

import { createTmuxMcpServer } from "./server.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import { Server } from "../../src/server.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "ltx-mcp-"));
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "mcp" });
        await runWithCleanup(
          () => body(fixture),
          () => fixture.dispose(),
        );
      },
      async () => {
        if (published === undefined) await reapOwnedRunRoot(runRoot);
        done = true;
      },
    );
  } finally {
    if (done) await rm(parent, { force: true, recursive: true });
  }
}

/** Text content from a tool result, which is what every tool here returns. */
function toolText(result: unknown): string {
  const { content } = result as { content: readonly { text?: string }[] };
  return content.map((entry) => entry.text ?? "").join("\n");
}

/**
 * Talk to the server the way a client does: as a subprocess, over stdio.
 *
 * In-process construction proves the tools were registered; it does not prove
 * an argument survives JSON, that a result is shaped the way the protocol wants,
 * or that the process can be pointed at a socket by environment alone — which is
 * the only configuration an MCP client gives it.
 */
async function withClient(
  fixture: TestServer,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ name: "libtmux-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    args: [fileURLToPath(new URL("./server.ts", import.meta.url))],
    command: process.execPath,
    env: {
      ...(process.env as Record<string, string>),
      ...fixture.controllerEnvironment,
      LIBTMUX_SOCKET_PATH: fixture.socketPath,
      LIBTMUX_TMUX_BIN: fixture.tmuxExecutable,
    },
  });
  await runWithCleanup(
    async () => {
      await client.connect(transport);
      await body(client);
    },
    () => client.close(),
  );
}

describe("MCP consumer", () => {
  test("serves its tools over stdio to a real client", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "capture_pane",
          "list_panes",
          "list_sessions",
          "new_session",
          "send_keys",
          "wait_for_output",
        ]);

        const sessions = JSON.parse(
          toolText(await client.callTool({ arguments: {}, name: "list_sessions" })),
        ) as { name: string; windows: number }[];
        expect(sessions.map((session) => session.name)).toContain("mcp");

        // An optional argument has to survive the crossing as an argument, not
        // as the string "undefined" or a dropped key.
        const panes = JSON.parse(
          toolText(await client.callTool({ arguments: { session: "mcp" }, name: "list_panes" })),
        ) as { id: string }[];
        expect(panes.length).toBeGreaterThan(0);
        const paneId = panes[0]?.id ?? "";
        expect(paneId).toStartWith("%");

        await client.callTool({
          arguments: { keys: "printf 'over-the-wire\\n'", paneId },
          name: "send_keys",
        });
        // Bounded for liveness: a shell that never echoes still fails, just
        // later, while one that was merely slow to start no longer does.
        const deadline = Date.now() + 30_000;
        let captured = "";
        while (!captured.includes("over-the-wire") && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop -- each capture follows the last.
          const result = await client.callTool({ arguments: { paneId }, name: "capture_pane" });
          captured = toolText(result);
          // eslint-disable-next-line no-await-in-loop -- the wait follows its capture.
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(captured).toContain("over-the-wire");

        const created = await client.callTool({
          arguments: { name: "born-over-the-wire" },
          name: "new_session",
        });
        expect(toolText(created)).toContain("born-over-the-wire");

        // A tool that fails reports it in the result rather than as a protocol
        // error, which is the difference between the model seeing the reason and
        // the client seeing a transport fault.
        const missing = await client.callTool({
          arguments: { paneId: "%99999" },
          name: "capture_pane",
        });
        expect((missing as { isError?: boolean }).isError).toBe(true);
        expect(toolText(missing)).toContain("%99999");
      });
    });
  }, 60_000);

  test("registers the tmux tool surface", async () => {
    await withServer(async (fixture) => {
      const mcp = createTmuxMcpServer(serverFor(fixture));

      expect(mcp).toBeDefined();
      expect(typeof mcp.connect).toBe("function");
    });
  }, 40_000);

  test("drives real tmux through the library it consumes", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      createTmuxMcpServer(tmux);

      // The same calls the tools make, exercised directly against real tmux.
      const snapshot = await tmux.snapshot();
      const pane = snapshot.panes.one();
      await pane.sendKeys("mcp-marker", { literal: true });

      let captured: readonly string[] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- Polling is sequential.
        captured = await pane.capture();
        if (captured.some((line) => line.includes("mcp-marker"))) break;
        // eslint-disable-next-line no-await-in-loop -- Each wait follows its capture.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(captured.some((line) => line.includes("mcp-marker"))).toBe(true);

      const created = await tmux.newSession({ name: "from-mcp" });
      expect(created.name).toBe("from-mcp");
      expect((await tmux.snapshot()).sessions.count({ name: "from-mcp" })).toBe(1);
    });
  }, 40_000);

  test("waits for pane output without polling the pane", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      createTmuxMcpServer(tmux);

      // The sequence wait_for_output performs: watch first, then act, then read
      // what tmux reports. The capture loop above is what this replaces.
      const events = tmux.watch();
      const pane = (await tmux.snapshot()).panes.one();
      // A control client hears nothing that happened before it attached, so the
      // send has to wait for the attach rather than for a duration that hopes to
      // outlast it.
      await events.ready();
      await pane.sendKeys("printf 'streamed-marker\\n'");

      let seen = "";
      for await (const event of events) {
        if (event.kind !== "output" || event.paneId !== pane.id) continue;
        seen += event.data;
        if (seen.includes("streamed-marker")) break;
      }

      expect(seen).toContain("streamed-marker");
    });
  }, 40_000);
});
