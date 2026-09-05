import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

import {
  assertOwnedSocketPath,
  runWithCleanup,
  TestServer,
  withOwnedRunRoot,
} from "../../../libtmux/src/_internal/test/testkit.js";
import { Server } from "libtmux/server";

export function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

export async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  return withOwnedRunRoot("ltx-mcp-", async (runRoot) => {
    const fixture = await TestServer.create({ runRoot, sessionName: "mcp" });
    assertOwnedSocketPath(fixture.socketPath);
    await runWithCleanup(
      () => body(fixture),
      () => fixture.dispose(),
    );
  });
}

export async function withClient(
  fixture: TestServer,
  body: (client: Client) => Promise<void>,
  callerEnvironment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const client = new Client({ name: "libtmux-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    args: [fileURLToPath(new URL("../../src/server.ts", import.meta.url))],
    command: process.execPath,
    env: {
      ...(process.env as Record<string, string>),
      ...fixture.controllerEnvironment,
      LIBTMUX_SOCKET_PATH: fixture.socketPath,
      LIBTMUX_TMUX_BIN: fixture.tmuxExecutable,
      LIBTMUX_TOOLSETS: "inspect,manage,execute,teardown",
      TMUX: "",
      TMUX_PANE: "",
      ...callerEnvironment,
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

export function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}
