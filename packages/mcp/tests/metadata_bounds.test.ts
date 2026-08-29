import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";

import type { Pane, ServerSnapshot, Session, Window } from "libtmux";

import type { ToolContext } from "../src/context.js";
import { MAX_RESULT_BYTES, resolvePolicy } from "../src/policy.js";
import { registerResources } from "../src/resources.js";
import { registerDiscovery } from "../src/tools/discovery.js";
import { registerSettings } from "../src/tools/settings.js";

const LARGE = "x".repeat(16 * 1024);

interface BoundedCollection<T> {
  readonly complete: boolean;
  readonly items: readonly T[];
  readonly omittedItems: number;
  readonly totalItems: number;
}

interface ToolCollection<T> {
  readonly complete: boolean;
  readonly omittedEntries: number;
  readonly values: T;
}

function selection<T extends { readonly id: string }>(items: readonly T[]): unknown {
  const pick = (where: { readonly id?: string; readonly name?: string }) =>
    items.find(
      (item) =>
        (where.id === undefined || item.id === where.id) &&
        (where.name === undefined || (item as { readonly name?: string }).name === where.name),
    );
  return {
    count: (where?: { readonly session?: { readonly is?: { readonly id?: string } } }) => {
      const sessionId = where?.session?.is?.id;
      return sessionId === undefined
        ? items.length
        : items.filter(
            (item) =>
              (item as { readonly format?: { readonly session_id?: string } }).format
                ?.session_id === sessionId,
          ).length;
    },
    oneOrUndefined: pick,
    toArray: () => [...items],
  };
}

function topology(count: number): {
  readonly panes: readonly Pane[];
  readonly sessions: readonly Session[];
  readonly windows: readonly Window[];
} {
  const sessions = Array.from(
    { length: count },
    (_, index) =>
      ({
        attached: 0,
        id: `$${String(index)}`,
        name: `session-${String(index)}-${LARGE}`,
      }) as Session,
  );
  const windows = Array.from({ length: count }, (_, index) => {
    const session = sessions[0] as Session;
    return {
      active: index === 0,
      format: { session_id: session.id, window_index: String(index) },
      id: `@${String(index)}`,
      index,
      layout: LARGE,
      name: `window-${String(index)}`,
      session,
      windowPanes: 1,
      zoomedFlag: false,
    } as unknown as Window;
  });
  const panes = Array.from({ length: count }, (_, index) => {
    const session = sessions[0] as Session;
    const window = windows[index] as Window;
    return {
      active: index === 0,
      currentCommand: "sh",
      currentPath: `/${LARGE}`,
      dead: false,
      format: {
        session_id: session.id,
        window_id: window.id,
        window_index: String(index),
      },
      height: 24,
      id: `%${String(index)}`,
      index: 0,
      session,
      title: "shell",
      width: 80,
      window,
    } as unknown as Pane;
  });
  return { panes, sessions, windows };
}

function fakeSnapshot(count = 32): ServerSnapshot {
  const entities = topology(count);
  return {
    clients: selection([]),
    panes: selection(entities.panes),
    sessions: selection(entities.sessions),
    windows: selection(entities.windows),
  } as ServerSnapshot;
}

function fakeContext(): ToolContext {
  const repeated = Array.from(
    { length: 32 },
    (_, index) => [`entry-${String(index)}`, LARGE] as const,
  );
  const snapshot = fakeSnapshot();
  return {
    hub: {},
    identity: async () => ({
      attendedPaneIds: [],
      callerPaneId: undefined,
      callerPaneIsOnThisServer: false,
      clients: [],
      serverPid: undefined,
    }),
    policy: resolvePolicy({ LIBTMUX_SAFETY: "mutating" }),
    snapshot: async () => snapshot,
    tmux: {
      cmd: async (_command: string, arguments_: readonly string[]) =>
        arguments_.includes("-a") ? ["session_name=value"] : [LARGE.repeat(20)],
      listBuffers: async () => repeated.map(([name, value]) => `${name}-${value}`),
      showEnvironment: async () => new Map(repeated),
      showHooks: async () => new Map(repeated.map(([name, value]) => [name, [value]] as const)),
      showOptions: async () => new Map(repeated),
    },
    topologyChanged: () => undefined,
  } as unknown as ToolContext;
}

async function withMcp(
  registrations: readonly ((mcp: McpServer, context: ToolContext) => void)[],
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const context = fakeContext();
  const mcp = new McpServer({ name: "metadata-bounds-test", version: "0" });
  for (const register of registrations) register(mcp, context);
  const client = new Client({ name: "metadata-bounds-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  try {
    await body(client);
  } finally {
    await client.close();
  }
}

function structured<T>(result: unknown): T {
  return (result as { readonly structuredContent: T }).structuredContent;
}

function text(result: unknown): string {
  const content = (result as { readonly content: readonly { readonly text?: string }[] }).content;
  return content.map((entry) => entry.text ?? "").join("\n");
}

function expectBounded(result: unknown, field: string): void {
  const value = structured<
    ToolCollection<Readonly<Record<string, unknown>> | readonly unknown[]> &
      Readonly<Record<string, unknown>>
  >(result);
  expect(value.complete).toBe(false);
  expect(value.omittedEntries).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(value[field]), "utf8")).toBeLessThanOrEqual(
    MAX_RESULT_BYTES,
  );
  expect(Buffer.byteLength(text(result), "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES + 256);
}

describe("metadata tool bounds", () => {
  test("bounds settings collections and reports omitted entries", async () => {
    await withMcp([registerSettings], async (client) => {
      const results = await Promise.all([
        client.callTool({ arguments: {}, name: "show_options" }),
        client.callTool({ arguments: {}, name: "show_hooks" }),
        client.callTool({ arguments: {}, name: "show_environment" }),
        client.callTool({ arguments: {}, name: "list_buffers" }),
      ]);

      for (const [result, field] of results.map(
        (result, index) =>
          [result, ["options", "hooks", "environment", "buffers"][index] as string] as const,
      )) {
        expectBounded(result, field);
      }
    });
  });

  test("bounds discovery lists and format values", async () => {
    await withMcp([registerDiscovery], async (client) => {
      const lists = await Promise.all([
        client.callTool({ arguments: {}, name: "list_sessions" }),
        client.callTool({ arguments: {}, name: "list_windows" }),
        client.callTool({ arguments: {}, name: "list_panes" }),
      ]);
      for (const [result, field] of lists.map(
        (result, index) => [result, ["sessions", "windows", "panes"][index] as string] as const,
      )) {
        expectBounded(result, field);
      }

      const displayed = await client.callTool({
        arguments: { format: "#{session_name}" },
        name: "display_message",
      });
      const value = structured<{
        readonly complete: boolean;
        readonly omittedBytes: number;
        readonly value: string;
      }>(displayed);
      expect(value.complete).toBe(false);
      expect(value.omittedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(value.value, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      expect(Buffer.byteLength(text(displayed), "utf8")).toBeLessThanOrEqual(
        MAX_RESULT_BYTES + 256,
      );
    });
  });
});

describe("metadata resource bounds", () => {
  test("bounds collection and nested JSON resource bodies", async () => {
    await withMcp([registerResources], async (client) => {
      for (const uri of ["tmux://sessions", "tmux://sessions/%240"]) {
        // eslint-disable-next-line no-await-in-loop -- each URI exercises a distinct resource shape.
        const result = await client.readResource({ uri });
        const content = result.contents[0];
        if (content === undefined || !("text" in content)) throw new Error(`No text for ${uri}`);
        expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
        const value = JSON.parse(content.text) as
          | BoundedCollection<unknown>
          | { readonly complete: boolean; readonly omittedItems: number };
        expect(value.complete).toBe(false);
        expect(value.omittedItems).toBeGreaterThan(0);
      }
    });
  });
});
