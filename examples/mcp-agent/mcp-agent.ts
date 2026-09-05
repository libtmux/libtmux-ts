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
      environment: { LIBTMUX_TOOLSETS: "inspect,execute" },
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
 * `run_shell_command` frames what it sends so the marker it waits for cannot
 * appear in what it typed. That is why waiting for `hello` here does not match
 * the `echo hello` that produced it, which is the trap a capture loop falls
 * into every time.
 */
export async function runAndCheck(
  client: Client,
  paneId: string,
  command: string,
): Promise<CommandResult> {
  return callTool<CommandResult>(client, "run_shell_command", { command, paneId });
}

export interface WaitResult {
  readonly cursor: string | null;
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
  readonly cursor: string | null;
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
  let cursor = (await callTool<Delta>(client, "capture_since", { paneId })).cursor;
  return async (waitMs: number) => {
    const delta = await callTool<Delta>(client, "capture_since", {
      ...(cursor === null ? {} : { cursor }),
      paneId,
      waitMs,
    });
    cursor = delta.cursor;
    return delta;
  };
}

/**
 * Build a session and add configured-process windows without command payloads.
 */
export async function buildWorkspace(
  client: Client,
  session: string,
  windows: readonly string[],
): Promise<readonly string[]> {
  const [first, ...rest] = windows;
  if (first === undefined) throw new TypeError("windows must not be empty");
  const created = await callTool<{ paneId: string }>(client, "create_session", {
    name: session,
    windowName: first,
  });
  const paneIds = [created.paneId];
  for (const name of rest) {
    // eslint-disable-next-line no-await-in-loop -- window creation follows session mutation order.
    const window = await callTool<{ paneId: string }>(client, "create_window", {
      name,
      session,
    });
    paneIds.push(window.paneId);
  }
  return paneIds;
}
