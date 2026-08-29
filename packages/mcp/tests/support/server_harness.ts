// The library's real-tmux fixture harness is unpublished. This repository-
// internal support module is the MCP suite's single bridge to it.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  assertOwnedSocketPath,
  makeTestDirectory,
} from "../../../libtmux/src/_internal/test/testkit.js";

import { Server } from "libtmux/server";

export { makeTestDirectory };

export function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

export async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-mcp-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({
          runRoot,
          sessionName: "mcp",
        });
        assertOwnedSocketPath(fixture.socketPath);
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

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  failure: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- bounded polling observes an external process.
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop -- each pause follows one observation.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failure);
}

export async function controlSessionIds(fixture: TestServer): Promise<string[]> {
  return (
    await fixture.executeText(["list-clients", "-F", "#{client_control_mode}\t#{session_id}"])
  ).stdout
    .filter((line) => line.startsWith("1\t"))
    .map((line) => line.slice(2));
}

/** Text content from a tool result. */
export function toolText(result: unknown): string {
  const { content } = result as { content: readonly { text?: string }[] };
  return content.map((entry) => entry.text ?? "").join("\n");
}

/** The typed half of a tool result, which is what a program reads. */
export function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

export function cursorOffset(cursor: string): number {
  return Number(cursor.slice(cursor.lastIndexOf(".") + 1));
}

/**
 * Talk to the server the way a client does: as a subprocess, over stdio.
 *
 * In-process construction proves the tools were registered; it does not prove
 * an argument survives JSON, that a result is shaped the way the protocol wants,
 * or that the process can be pointed at a socket by environment alone — which is
 * the only configuration an MCP client gives it.
 */
export async function withClient(
  fixture: TestServer,
  body: (client: Client) => Promise<void>,
  extraEnvironment: Readonly<Record<string, string>> = {},
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
      // Most integration cases exercise mutations. Production has a narrower
      // default; this harness opts in explicitly.
      LIBTMUX_SAFETY: "mutating",
      // A probe must not reach the terminal the suite is being run from.
      TMUX: "",
      TMUX_PANE: "",
      ...extraEnvironment,
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

export async function firstPaneId(client: Client): Promise<string> {
  const listed = await client.callTool({ arguments: {}, name: "list_panes" });
  const { panes } = structured<{ panes: { id: string }[] }>(listed);
  return panes[0]?.id ?? "";
}

/**
 * A pane sitting at a shell prompt.
 *
 * The fixture's own pane runs `exec cat` so it stays quiet and deterministic,
 * which is the opposite of what these tests need: a shell that echoes, runs
 * what it is sent, and has an exit status. `sh` rather than the ambient login
 * shell, so the suite does not depend on whoever is running it.
 */
let shellSessions = 0;
export async function shellPaneId(client: Client, shellCommand = "sh"): Promise<string> {
  shellSessions += 1;
  const built = structured<{ panes: { id: string }[] }>(
    await client.callTool({
      arguments: {
        session: `shell-${String(shellSessions)}`,
        windows: [{ name: "shell", shellCommand }],
      },
      name: "build_workspace",
    }),
  );
  return built.panes[0]?.id ?? "";
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Attach a terminal client, which tmux distinguishes from control clients. */
export async function withAttendedPane(
  fixture: TestServer,
  body: (paneId: string) => Promise<void>,
): Promise<void> {
  const command = [
    fixture.tmuxExecutable,
    "-S",
    fixture.socketPath,
    "attach-session",
    "-t",
    fixture.sessionId,
  ]
    .map(shellQuote)
    .join(" ");
  const terminal = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], {
    env: { ...fixture.controllerEnvironment, TERM: "xterm-256color" },
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
  });
  let attached: { name: string; paneId: string } | undefined;
  try {
    const deadline = Date.now() + 5_000;
    while (attached === undefined && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- each read observes a later attach state.
      const client = (await serverFor(fixture).snapshot()).clients
        .toArray()
        .find((candidate) => candidate.controlMode === false && candidate.pane !== undefined);
      if (client?.pane !== undefined) {
        attached = { name: client.name ?? "", paneId: client.pane.id };
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- bounded polling must wait before the next read.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (attached === undefined) throw new Error("terminal client did not attach");
    await body(attached.paneId);
  } finally {
    if (attached?.name !== undefined && attached.name !== "") {
      await fixture.executeText(["detach-client", "-t", attached.name]).catch(() => undefined);
    }
    if (terminal.exitCode === null) terminal.kill();
    await Promise.race([
      terminal.exitCode === null ? once(terminal, "close") : Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}
