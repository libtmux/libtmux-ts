import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createTmuxMcpServer } from "@libtmux/mcp";
import type { Server } from "libtmux/server";

/** The typed half of a tool result, which is what a program reads. */
async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ arguments: args, name });
  return (result as { structuredContent: T }).structuredContent;
}

/**
 * Drive tmux the way an agent's client does: over the protocol, not the API.
 *
 * Linked in-memory transports rather than a subprocess, because the point here
 * is the tool contract — what a call answers with — and not how the process was
 * launched.
 */
export async function connectAgent(server: Server): Promise<Client> {
  const client = new Client({ name: "example", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    createTmuxMcpServer(server, {
      environment: { LIBTMUX_SAFETY: "mutating" },
    }).connect(serverSide),
    client.connect(clientSide),
  ]);
  return client;
}

export interface CommandResult {
  readonly exitStatus: number | null;
  readonly outcome: string;
  readonly output: string;
}

/**
 * Run a command and learn whether it worked.
 *
 * The output is what the command printed, not the pane's echo of the command:
 * `run_command` frames what it sends so the marker it waits for cannot appear
 * in what it typed. That is why waiting for `hello` here does not match the
 * `echo hello` that produced it, which is the trap a capture loop falls into
 * every time.
 */
export async function runAndCheck(
  client: Client,
  paneId: string,
  command: string,
): Promise<CommandResult> {
  return callTool<CommandResult>(client, "run_command", { command, paneId });
}

export interface WaitResult {
  readonly cursor: number;
  readonly outcome: string;
  readonly output: string;
  readonly screen: string;
}

/**
 * Wait for output somebody else wrote, and get an answer either way.
 *
 * A wait that does not match is not an empty hand: `outcome` says why it ended,
 * `output` holds everything the pane printed meanwhile, `screen` holds what it
 * shows now, and `cursor` is where to carry on from. An agent never has to
 * guess whether to try again.
 */
export async function waitFor(
  client: Client,
  paneId: string,
  pattern: string,
  timeoutMs: number,
): Promise<WaitResult> {
  return callTool<WaitResult>(client, "wait_for_text", {
    paneId,
    patterns: [pattern],
    timeoutMs,
  });
}

export interface Delta {
  readonly cursor: number;
  readonly text: string;
}

/**
 * Read a pane repeatedly without paying for the screen each time.
 *
 * The first call starts the watch and returns what is on screen. Every call
 * after it quotes the cursor from the last one and is charged only for what
 * arrived since — which is what makes watching a build affordable.
 */
export async function watch(
  client: Client,
  paneId: string,
): Promise<(waitMs: number) => Promise<Delta>> {
  let cursor = (await callTool<Delta>(client, "observe", { paneId })).cursor;
  return async (waitMs: number) => {
    const delta = await callTool<Delta>(client, "observe", { cursor, paneId, waitMs });
    cursor = delta.cursor;
    return delta;
  };
}

/**
 * Build a session and every window in it with one call.
 *
 * Calling `new_window` per window spends a tmux invocation and a snapshot each,
 * because each has to find what it just made; this spends one of each for the
 * group and hands back every pane id, so nothing needs a `list_panes` after.
 */
export async function buildWorkspace(
  client: Client,
  session: string,
  windows: readonly string[],
): Promise<readonly string[]> {
  const built = await callTool<{ panes: { id: string }[] }>(client, "build_workspace", {
    session,
    windows: windows.map((name) => ({ name, shellCommand: "sh" })),
  });
  return built.panes.map((pane) => pane.id);
}
