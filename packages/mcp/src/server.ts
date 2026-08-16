#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { Server } from "libtmux/server";

import manifest from "../package.json" with { type: "json" };

/** The version this server reports, taken from the manifest so it cannot drift from the release. */
const PACKAGE_VERSION: string = manifest.version;

/**
 * How long a tool waits on tmux before giving up.
 *
 * The library itself imposes no deadline — a caller may legitimately want to
 * wait as long as tmux takes. An MCP server is not that caller: it answers a
 * client that is waiting on it, and a wedged daemon would otherwise hold that
 * client forever.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How much of a pane's output one wait may accumulate before the oldest is dropped. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * An MCP server exposing a tmux server through libtmux.
 *
 * Every tool acquires its own snapshot. Two concurrent requests therefore
 * observe their own instants rather than sharing mutable state, which is the
 * property the acquisition design was chosen for.
 */
export function createTmuxMcpServer(tmux: Server): McpServer {
  const mcp = new McpServer({ name: "libtmux", version: PACKAGE_VERSION });

  mcp.registerTool(
    "list_sessions",
    {
      description: "List every tmux session with its id, name, and window count.",
      inputSchema: {},
      title: "List sessions",
    },
    async () => {
      const snapshot = await tmux.snapshot();
      // Count windows from the snapshot already in hand rather than asking each
      // session, which would resolve the same window set once per session.
      const sessions = snapshot.sessions.map((session) => ({
        id: session.id,
        name: session.name,
        windows: snapshot.windows.count({ session: { is: { id: session.id } } }),
      }));
      return { content: [{ text: JSON.stringify(sessions, null, 2), type: "text" }] };
    },
  );

  mcp.registerTool(
    "list_panes",
    {
      description: "List panes, optionally restricted to one session by name.",
      inputSchema: { session: z.string().optional() },
      title: "List panes",
    },
    async ({ session }) => {
      const snapshot = await tmux.snapshot();
      const panes = (
        session === undefined
          ? snapshot.panes
          : snapshot.panes.where({ session: { is: { name: session } } })
      )
        .toArray()
        .map((pane) => ({
          command: pane.currentCommand,
          id: pane.id,
          session: pane.sessionName,
          window: pane.windowName,
        }));
      return { content: [{ text: JSON.stringify(panes, null, 2), type: "text" }] };
    },
  );

  mcp.registerTool(
    "capture_pane",
    {
      description: "Capture a pane's visible contents, or reach into its scrollback.",
      inputSchema: { paneId: z.string(), start: z.number().int().optional() },
      title: "Capture pane",
    },
    async ({ paneId, start }) => {
      const snapshot = await tmux.snapshot();
      const pane = snapshot.panes.oneOrUndefined({ id: paneId });
      if (pane === undefined) {
        return { content: [{ text: `No pane ${paneId}`, type: "text" }], isError: true };
      }
      const lines = await pane.capture(start === undefined ? {} : { start });
      return { content: [{ text: lines.join("\n"), type: "text" }] };
    },
  );

  mcp.registerTool(
    "send_keys",
    {
      description: "Send keys to a pane, optionally literally and without Enter.",
      inputSchema: {
        enter: z.boolean().optional(),
        keys: z.string(),
        literal: z.boolean().optional(),
        paneId: z.string(),
      },
      title: "Send keys",
    },
    async ({ enter, keys, literal, paneId }) => {
      const snapshot = await tmux.snapshot();
      const pane = snapshot.panes.oneOrUndefined({ id: paneId });
      if (pane === undefined) {
        return { content: [{ text: `No pane ${paneId}`, type: "text" }], isError: true };
      }
      await pane.sendKeys(keys, {
        ...(enter === undefined ? {} : { enter }),
        ...(literal === undefined ? {} : { literal }),
      });
      return { content: [{ text: `Sent to ${paneId}`, type: "text" }] };
    },
  );

  mcp.registerTool(
    "new_session",
    {
      description: "Create a detached tmux session.",
      inputSchema: { name: z.string().optional() },
      title: "New session",
    },
    async ({ name }) => {
      const session = await tmux.newSession(name === undefined ? {} : { name });
      return {
        content: [
          {
            text: `Created ${session.name ?? "<unnamed>"} (${session.id})`,
            type: "text",
          },
        ],
      };
    },
  );

  mcp.registerTool(
    "run_and_wait",
    {
      description:
        "Send keys to a pane and wait until it prints the given text, returning " +
        "what it printed. Streams tmux's own notifications rather than polling. " +
        "A pane echoes what is typed into it, so text that also appears in the " +
        "keys being sent matches that echo immediately: wait for something the " +
        "command prints, such as its output or a marker echoed after it.",
      inputSchema: {
        contains: z.string(),
        keys: z.string(),
        literal: z.boolean().optional(),
        maxOutputBytes: z.number().int().positive().optional(),
        paneId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      },
      title: "Run in a pane and wait for its output",
    },
    async ({ contains, keys, literal, maxOutputBytes, paneId, timeoutMs }) => {
      const snapshot = await tmux.snapshot();
      const pane = snapshot.panes.oneOrUndefined({ id: paneId });
      if (pane === undefined) {
        return { content: [{ text: `No pane ${paneId}`, type: "text" }], isError: true };
      }
      // A control client is only told about panes in the session it attached
      // to, and an untargeted attach picks whichever session tmux considers
      // most recent. Watching this pane's own session is what makes the answer
      // depend on the pane asked about rather than on that guess.
      const sessionId = pane.sessionId;
      if (sessionId === null) {
        return {
          content: [{ text: `Pane ${paneId} has no session`, type: "text" }],
          isError: true,
        };
      }

      const limit = maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      await using events = tmux.watch({ target: sessionId });
      const deadline = setTimeout(() => void events.close(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let seen = "";
      try {
        // Subscribe, attach, *then* send. A control client is told nothing that
        // happened before it attached, so output printed ahead of the attach is
        // never seen and the wait runs to its deadline.
        await events.ready();
        await pane.sendKeys(keys, literal === undefined ? {} : { literal });

        for await (const event of events) {
          if (event.kind !== "output" || event.paneId !== paneId) continue;
          seen += event.data;
          // A rolling window: the match may straddle two notifications, so keep
          // enough to span one, and never let a chatty pane grow without bound.
          if (seen.length > limit) seen = seen.slice(seen.length - limit);
          if (seen.includes(contains)) {
            return { content: [{ text: seen, type: "text" }] };
          }
        }
      } finally {
        clearTimeout(deadline);
      }
      // Distinguish "it never printed that" from "it may have, and this could
      // not keep up" — the same empty-handed result otherwise.
      const dropped = events.dropped;
      return {
        content: [
          {
            text:
              dropped > 0
                ? `Pane ${paneId} did not print ${contains} in what was seen; ${String(dropped)} notifications were dropped, so it may have`
                : `Pane ${paneId} did not print ${contains}`,
            type: "text",
          },
        ],
        isError: true,
      };
    },
  );

  return mcp;
}

/**
 * The tmux server this process was pointed at.
 *
 * An MCP client launches this with an environment and a command line, and
 * nothing else, so the environment is the only place a socket can come from.
 * The library itself never reads these — a library that picks up ambient
 * configuration is a library that surprises its caller — which is why the
 * reading happens out here, at the edge that has a process to belong to.
 */
export function serverFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Server {
  const socketPath = environment.LIBTMUX_SOCKET_PATH;
  const socketName = environment.LIBTMUX_SOCKET_NAME;
  const tmuxBin = environment.LIBTMUX_TMUX_BIN;
  return new Server({
    // Bounded here rather than in the library: this process answers a client
    // that is waiting, so "wait as long as tmux takes" is not an option it has.
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...(socketPath === undefined || socketPath === "" ? {} : { socketPath }),
    ...(socketName === undefined || socketName === "" ? {} : { socketName }),
    ...(tmuxBin === undefined || tmuxBin === "" ? {} : { tmuxBin }),
  });
}

/** Serve over stdio when run directly. */
export async function main(): Promise<void> {
  const mcp = createTmuxMcpServer(serverFromEnvironment());
  await mcp.connect(new StdioServerTransport());
}

/**
 * Run when this file is the program, not when it is imported.
 *
 * Compared by URL rather than by `import.meta.main`, which Node does not have,
 * so the same file serves under both runtimes.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
