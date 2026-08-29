import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";

import { MAX_RESULT_BYTES, resolvePolicy } from "../src/policy.js";
import { PaneTail } from "../src/live.js";
import { registerResources } from "../src/resources.js";
import { registerCapture } from "../src/tools/capture.js";
import { registerInput } from "../src/tools/input.js";
import { registerSettings } from "../src/tools/settings.js";
import { registerWait } from "../src/tools/wait.js";
import type { ToolContext } from "../src/context.js";
import type { Pane, ServerSnapshot } from "libtmux";

interface FakePaneOptions {
  readonly capture?: (options: {
    readonly end?: number;
    readonly joinWrapped?: boolean;
    readonly start?: number;
  }) => Promise<readonly string[]>;
  readonly height?: number;
  readonly id: string;
  readonly sessionId?: string;
  readonly sendKeys?: (keys: string) => Promise<void>;
  readonly width?: number;
}

function fakePane({
  capture = async () => [],
  height = 24,
  id,
  sessionId = "$1",
  sendKeys = async () => undefined,
  width = 80,
}: FakePaneOptions): Pane {
  return {
    capture,
    currentCommand: "sh",
    dead: false,
    format: { session_id: sessionId },
    height,
    id,
    session: { name: `session-${sessionId}` },
    sendKeys,
    width,
    window: { name: "window" },
  } as unknown as Pane;
}

function fakeSelection<T extends { readonly id: string }>(items: readonly T[]): unknown {
  const select = (where: { readonly id?: string; readonly name?: string }) =>
    items.find(
      (item) =>
        (where.id === undefined || item.id === where.id) &&
        (where.name === undefined || (item as { readonly name?: string }).name === where.name),
    );
  return {
    first: select,
    oneOrUndefined: select,
    toArray: () => [...items],
  };
}

function fakeSnapshot(panes: readonly Pane[]): ServerSnapshot {
  return {
    clients: fakeSelection([]),
    panes: fakeSelection(panes),
    sessions: fakeSelection([]),
    windows: fakeSelection([]),
  } as ServerSnapshot;
}

function fakeContext(
  panes: readonly Pane[],
  options: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly hub?: unknown;
    readonly maxResultLines?: number;
    readonly tmux?: unknown;
  } = {},
): ToolContext {
  const environment = {
    ...options.environment,
    ...(options.maxResultLines === undefined
      ? {}
      : { LIBTMUX_MCP_MAX_RESULT_LINES: String(options.maxResultLines) }),
  };
  return {
    hub: options.hub ?? {},
    identity: async () => ({
      attendedPaneIds: [],
      callerPaneId: undefined,
      callerPaneIsOnThisServer: false,
      clients: [],
      serverPid: undefined,
    }),
    policy: resolvePolicy(environment),
    snapshot: async () => fakeSnapshot(panes),
    tmux: options.tmux ?? {},
    topologyChanged: () => undefined,
  } as unknown as ToolContext;
}

async function withTools(
  context: ToolContext,
  register: (mcp: McpServer, context: ToolContext) => void,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const mcp = new McpServer({ name: "bounded-read-test", version: "0" });
  register(mcp, context);
  const client = new Client({ name: "bounded-read-test", version: "0" });
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

describe("bounded result policy", () => {
  test("hard-clamps an operator line ceiling", () => {
    expect(resolvePolicy({ LIBTMUX_MCP_MAX_RESULT_LINES: "999999999" }).maxResultLines).toBe(
      10_000,
    );
  });
});

describe("bounded pane reads", () => {
  test("bounds run_command by UTF-8 bytes", async () => {
    const tail = new PaneTail("%1", MAX_RESULT_BYTES * 2);
    const pane = fakePane({
      id: "%1",
      sendKeys: async (keys) => {
        const marker = /=(ltx[0-9a-f]+);/u.exec(keys)?.[1];
        if (marker === undefined) throw new Error("No command marker");
        tail.append(`${marker}_S\n${"x".repeat(MAX_RESULT_BYTES + 1_000)}\n${marker}_E 0\n`);
      },
    });
    const context = fakeContext([pane], {
      environment: { LIBTMUX_SAFETY: "mutating" },
      hub: { tail: async () => tail },
    });

    await withTools(context, registerInput, async (client) => {
      const result = structured<{ omittedBytes: number; output: string }>(
        await client.callTool({
          arguments: { command: "true", maxLines: 1, paneId: "%1" },
          name: "run_command",
        }),
      );

      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      expect(result.omittedBytes).toBeGreaterThan(0);
    });
  });

  test("does not capture an oversized run_command fallback", async () => {
    let captures = 0;
    const pane = fakePane({
      capture: async () => {
        captures += 1;
        return ["must not be read"];
      },
      id: "%1",
      width: 1_000_000,
    });
    const context = fakeContext([pane], {
      environment: { LIBTMUX_MCP_LIVE: "0", LIBTMUX_SAFETY: "mutating" },
    });

    await withTools(context, registerInput, async (client) => {
      const result = structured<{ outcome: string }>(
        await client.callTool({
          arguments: { command: "sleep 10", paneId: "%1", timeoutMs: 1_000 },
          name: "run_command",
        }),
      );
      expect(result.outcome).toBe("timed_out");
    });
    expect(captures).toBe(0);
  });

  test("does not capture an oversized screen for observe or a missed wait", async () => {
    let captures = 0;
    const pane = fakePane({
      capture: async () => {
        captures += 1;
        return ["must not be read"];
      },
      id: "%1",
      width: 1_000_000,
    });
    const tail = new PaneTail("%1");
    const live = fakeContext([pane], { hub: { tail: async () => tail } });

    await withTools(live, registerWait, async (client) => {
      const result = structured<{ screenClamped: boolean }>(
        await client.callTool({
          arguments: { paneId: "%1", patterns: ["absent"], timeoutMs: 1_000 },
          name: "wait_for_text",
        }),
      );
      expect(result.screenClamped).toBe(true);
    });
    await withTools(
      fakeContext([pane], { environment: { LIBTMUX_MCP_LIVE: "0" } }),
      registerCapture,
      async (client) => {
        const result = structured<{ byteClamped: boolean }>(
          await client.callTool({ arguments: { paneId: "%1" }, name: "observe" }),
        );
        expect(result.byteClamped).toBe(true);
      },
    );
    expect(captures).toBe(0);
  });

  test("does not capture an oversized pane-content resource", async () => {
    let captures = 0;
    const pane = fakePane({
      capture: async () => {
        captures += 1;
        return ["must not be read"];
      },
      id: "%1",
      width: 1_000_000,
    });

    await withTools(fakeContext([pane]), registerResources, async (client) => {
      const read = await client.readResource({ uri: "tmux://panes/%251/content" });
      const content = read.contents[0];
      expect(content !== undefined && "text" in content ? content.text : "").toContain(
        "capture omitted",
      );
    });
    expect(captures).toBe(0);
  });
});

describe("capture_pane", () => {
  test("keeps a caller maxLines below the operator ceiling", async () => {
    const pane = fakePane({
      capture: async () => Array.from({ length: 12 }, (_, index) => `line-${String(index)}`),
      id: "%1",
    });
    await withTools(fakeContext([pane], { maxResultLines: 4 }), registerCapture, async (client) => {
      const answer = await client.callTool({
        arguments: { maxLines: 999, paneId: "%1" },
        name: "capture_pane",
      });
      const result = structured<{ readonly droppedLines: number; readonly text: string }>(answer);

      expect(result.text.split("\n")).toHaveLength(4);
      expect(result.droppedLines).toBe(8);
    });
  });

  test("bounds a history range before capture and reports the effective range", async () => {
    let seen: { readonly end?: number; readonly start?: number } | undefined;
    const pane = fakePane({
      capture: async (options) => {
        seen = options;
        return ["tail"];
      },
      id: "%1",
    });
    await withTools(
      fakeContext([pane], { maxResultLines: 10 }),
      registerCapture,
      async (client) => {
        const answer = await client.callTool({
          arguments: { end: -1, maxLines: 5, paneId: "%1", start: -1_000_000 },
          name: "capture_pane",
        });
        const result = structured<{
          readonly effectiveEnd: number | null;
          readonly effectiveStart: number | null;
          readonly rangeClamped: boolean;
        }>(answer);

        expect(seen).toMatchObject({ end: -1, start: -5 });
        expect(result).toMatchObject({
          effectiveEnd: -1,
          effectiveStart: -5,
          rangeClamped: true,
        });
      },
    );
  });

  test("does not link a custom capture to the default visible resource", async () => {
    const pane = fakePane({ capture: async () => ["a", "b", "c"], id: "%1" });
    await withTools(fakeContext([pane], { maxResultLines: 2 }), registerCapture, async (client) => {
      const answer = await client.callTool({
        arguments: { joinWrapped: true, paneId: "%1", start: -2 },
        name: "capture_pane",
      });
      const content = (answer as { readonly content: readonly { readonly type: string }[] })
        .content;

      expect(content.some((entry) => entry.type === "resource_link")).toBe(false);
    });
  });

  test("bounds the default visible range before capture", async () => {
    let seen: { readonly end?: number; readonly start?: number } | undefined;
    const pane = fakePane({
      capture: async (options) => {
        seen = options;
        return ["tail"];
      },
      height: 100,
      id: "%1",
    });
    await withTools(fakeContext([pane], { maxResultLines: 4 }), registerCapture, async (client) => {
      const answer = await client.callTool({ arguments: { paneId: "%1" }, name: "capture_pane" });
      const result = structured<{ readonly rangeClamped: boolean }>(answer);
      const content = (answer as { readonly content: readonly { readonly type: string }[] })
        .content;

      expect(seen).toMatchObject({ end: 99, start: 96 });
      expect(result.rangeClamped).toBe(true);
      expect(content.some((entry) => entry.type === "resource_link")).toBe(true);
    });
  });

  test("does not read a row whose width cannot fit the byte ceiling", async () => {
    let captures = 0;
    const pane = fakePane({
      capture: async () => {
        captures += 1;
        return ["must not be read"];
      },
      height: 1,
      id: "%1",
      width: 1_000_000,
    });
    await withTools(fakeContext([pane]), registerCapture, async (client) => {
      const answer = await client.callTool({ arguments: { paneId: "%1" }, name: "capture_pane" });
      const result = structured<{ readonly byteClamped: boolean; readonly text: string }>(answer);

      expect(captures).toBe(0);
      expect(result).toMatchObject({ byteClamped: true, text: "" });
    });
  });
});

describe("search_panes", () => {
  test("rejects an empty literal before capturing every pane", async () => {
    let captures = 0;
    const pane = fakePane({
      capture: async () => {
        captures += 1;
        return ["anything"];
      },
      id: "%1",
    });
    await withTools(fakeContext([pane]), registerCapture, async (client) => {
      const answer = await client.callTool({ arguments: { pattern: "" }, name: "search_panes" });

      expect((answer as { readonly isError?: boolean }).isError).toBe(true);
      expect(captures).toBe(0);
    });
  });

  test("clamps scrollback before capture and reports the clamp", async () => {
    let seenStart: number | undefined;
    const pane = fakePane({
      capture: async (options) => {
        seenStart = options.start;
        return [];
      },
      id: "%1",
    });
    await withTools(fakeContext([pane], { maxResultLines: 7 }), registerCapture, async (client) => {
      const answer = await client.callTool({
        arguments: { pattern: "needle", scrollbackLines: 1_000_000 },
        name: "search_panes",
      });
      const result = structured<{
        readonly effectiveScrollbackLines: number;
        readonly scrollbackClamped: boolean;
      }>(answer);

      expect(seenStart).toBe(-7);
      expect(result).toMatchObject({ effectiveScrollbackLines: 7, scrollbackClamped: true });
    });
  });

  test("captures each linked pane once", async () => {
    const calls = new Map<string, number>();
    const pane = (id: string, sessionId: string): Pane =>
      fakePane({
        capture: async () => {
          calls.set(id, (calls.get(id) ?? 0) + 1);
          return ["needle"];
        },
        id,
        sessionId,
      });
    await withTools(
      fakeContext([pane("%1", "$1"), pane("%1", "$2"), pane("%2", "$1")]),
      registerCapture,
      async (client) => {
        const answer = await client.callTool({
          arguments: { pattern: "needle" },
          name: "search_panes",
        });
        const result = structured<{
          readonly matches: readonly { readonly paneId: string }[];
          readonly panesSearched: number;
        }>(answer);

        expect(calls).toEqual(
          new Map([
            ["%1", 1],
            ["%2", 1],
          ]),
        );
        expect(result.panesSearched).toBe(2);
        expect(result.matches.map((match) => match.paneId)).toEqual(["%1", "%2"]);
      },
    );
  });

  test("runs no more than eight captures at once", async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const panes = Array.from({ length: 20 }, (_, index) =>
      fakePane({
        capture: async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await gate;
          active -= 1;
          return [];
        },
        id: `%${String(index + 1)}`,
      }),
    );

    await withTools(fakeContext(panes), registerCapture, async (client) => {
      const pending = client.callTool({ arguments: { pattern: "needle" }, name: "search_panes" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await pending;

      expect(maximum).toBeLessThanOrEqual(8);
    });
  });

  test("reports matches omitted by the result ceiling", async () => {
    const pane = fakePane({ capture: async () => ["n", "n", "n", "n"], id: "%1" });
    await withTools(fakeContext([pane], { maxResultLines: 3 }), registerCapture, async (client) => {
      const answer = await client.callTool({
        arguments: { maxMatchesPerPane: 999, pattern: "n" },
        name: "search_panes",
      });
      const result = structured<{
        readonly matches: readonly unknown[];
        readonly matchesTruncated: boolean;
      }>(answer);

      expect(result.matches).toHaveLength(3);
      expect(result.matchesTruncated).toBe(true);
    });
  });
});

describe("show_buffer", () => {
  test("does not allocate an oversized buffer and reports the omitted bytes", async () => {
    const tmux = {
      cmd: async () => {
        throw new Error("show_buffer must not list every buffer");
      },
      saveBuffer: async (_name: string, path: string) =>
        writeFile(path, Buffer.alloc(300_000, "x")),
    };
    await withTools(fakeContext([], { tmux }), registerSettings, async (client) => {
      const answer = await client.callTool({
        arguments: { name: "large" },
        name: "show_buffer",
      });
      const result = structured<{
        readonly omittedBytes: number;
        readonly returnedBytes: number;
        readonly text: string;
        readonly totalBytes: number;
        readonly truncated: boolean;
      }>(answer);
      expect(result).toMatchObject({
        omittedBytes: 300_000,
        returnedBytes: 0,
        text: "",
        totalBytes: 300_000,
        truncated: true,
      });
    });
  });

  test("tail-limits a readable buffer to the operator ceiling", async () => {
    const tmux = {
      cmd: async () => {
        throw new Error("show_buffer must not list every buffer");
      },
      saveBuffer: async (_name: string, path: string) => writeFile(path, "one\ntwo\nthree"),
    };
    await withTools(
      fakeContext([], { maxResultLines: 2, tmux }),
      registerSettings,
      async (client) => {
        const answer = await client.callTool({
          arguments: { maxLines: 999, name: "short" },
          name: "show_buffer",
        });
        const result = structured<{
          readonly droppedLines: number;
          readonly text: string;
          readonly truncated: boolean;
        }>(answer);

        expect(result).toMatchObject({ droppedLines: 1, text: "two\nthree", truncated: true });
      },
    );
  });

  test("keeps a changed buffer response inside the byte ceiling", async () => {
    const tmux = {
      cmd: async () => {
        throw new Error("show_buffer must not list every buffer");
      },
      saveBuffer: async (_name: string, path: string) =>
        writeFile(path, new Uint8Array(100_000).fill(0xff)),
    };
    await withTools(fakeContext([], { tmux }), registerSettings, async (client) => {
      const answer = await client.callTool({
        arguments: { name: "racing" },
        name: "show_buffer",
      });
      const result = structured<{ readonly text: string; readonly truncated: boolean }>(answer);

      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(256 * 1024);
      expect(result.truncated).toBe(true);
    });
  });
});
