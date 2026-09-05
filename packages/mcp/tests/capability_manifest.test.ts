import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { Server } from "libtmux/server";
import type { TmuxEngine } from "libtmux/engine";

import { MAX_RESULT_BYTES, resolvePolicy } from "../src/policy.js";
import { createTmuxMcpServer, serverFromEnvironment } from "../src/server.js";
import { inspectServerStartup } from "../src/startup.js";
import { resolvedPaneInputTargetIds } from "../src/target_resolution.js";
import { SearchMatchBudget } from "../src/tools/search.js";
import { ReadBatchAccumulator, readBatchWireBytes } from "../src/tools/target.js";

const TOOLS_BY_TOOLSET = {
  inspect: [
    "call_read_tools_batch",
    "capture_pane",
    "capture_since",
    "find_pane_by_position",
    "get_pane_info",
    "get_server_info",
    "get_session_info",
    "get_tmux_variables",
    "get_window_info",
    "list_panes",
    "list_sessions",
    "list_windows",
    "search_panes",
    "show_option",
    "show_environment",
    "show_hooks",
    "snapshot_pane",
    "wait_for_text",
  ],
  manage: [
    "enter_copy_mode",
    "exit_copy_mode",
    "move_window",
    "rename_session",
    "rename_window",
    "resize_pane",
    "resize_window",
    "select_layout",
    "select_pane",
    "select_window",
    "set_history_limit",
    "set_mouse_enabled",
    "set_pane_title",
    "signal_channel",
    "swap_pane",
    "wait_for_channel",
  ],
  execute: [
    "create_session",
    "create_window",
    "paste_text",
    "respawn_pane",
    "run_shell_command",
    "send_keys",
    "send_keys_batch",
    "set_synchronize_panes",
    "split_window",
  ],
  teardown: ["clear_pane_scrollback", "kill_pane", "kill_session", "kill_window"],
} as const;

type Toolset = keyof typeof TOOLS_BY_TOOLSET;
const TOOLSETS = Object.keys(TOOLS_BY_TOOLSET) as Toolset[];
const READ_BATCH_TOOLS = [
  "list_sessions",
  "list_windows",
  "list_panes",
  "get_pane_info",
  "get_server_info",
  "capture_pane",
  "capture_since",
  "search_panes",
  "show_option",
  "show_hooks",
  "show_environment",
  "get_session_info",
  "get_window_info",
  "find_pane_by_position",
  "get_tmux_variables",
  "snapshot_pane",
] as const;
const SOURCE_CATALOG_ORDER = [
  "list_sessions",
  "list_windows",
  "list_panes",
  "get_pane_info",
  "get_server_info",
  "capture_pane",
  "capture_since",
  "search_panes",
  "send_keys",
  "paste_text",
  "run_shell_command",
  "create_session",
  "create_window",
  "split_window",
  "rename_session",
  "rename_window",
  "respawn_pane",
  "kill_pane",
  "kill_window",
  "kill_session",
  "resize_pane",
  "select_pane",
  "select_window",
  "select_layout",
  "swap_pane",
  "move_window",
  "resize_window",
  "set_pane_title",
  "show_option",
  "show_hooks",
  "show_environment",
  "wait_for_text",
  "get_session_info",
  "get_window_info",
  "find_pane_by_position",
  "get_tmux_variables",
  "snapshot_pane",
  "enter_copy_mode",
  "exit_copy_mode",
  "wait_for_channel",
  "signal_channel",
  "set_mouse_enabled",
  "set_history_limit",
  "set_synchronize_panes",
  "send_keys_batch",
  "clear_pane_scrollback",
  "call_read_tools_batch",
] as const;

async function withClient(
  environment: Readonly<Record<string, string | undefined>>,
  body: (client: Client) => Promise<void>,
  tmux: Server = new Server(),
  serverOptions: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const mcp = createTmuxMcpServer(tmux, {
    environment,
    ...serverOptions,
  } as Parameters<typeof createTmuxMcpServer>[1]);
  const client = new Client({ name: "capability-manifest-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  try {
    await body(client);
  } finally {
    await client.close();
    await mcp.close();
  }
}

test("one manifest governs every toolset subset, selection, metadata, and reporting", async () => {
  expect(() => resolvePolicy({ LIBTMUX_SAFETY: "readonly" })).toThrow(
    /LIBTMUX_SAFETY.*LIBTMUX_TOOLSETS/u,
  );
  expect(() => resolvePolicy({ LIBTMUX_MCP_TOOLS: "list_sessions" })).toThrow(
    /LIBTMUX_MCP_TOOLS.*LIBTMUX_TOOLSETS.*LIBTMUX_TOOLS/u,
  );
  expect(() => resolvePolicy({ LIBTMUX_TOOLSETS: "inspect," })).toThrow(/empty token/u);
  expect(resolvePolicy({ LIBTMUX_TOOLSETS: "" }).toolsets.size).toBe(0);
  expect(() => resolvePolicy({ LIBTMUX_TOOLS: "" })).toThrow(/LIBTMUX_TOOLS.*empty token/u);
  expect(() => resolvePolicy({ LIBTMUX_EXCLUDE_TOOLS: "" })).toThrow(
    /LIBTMUX_EXCLUDE_TOOLS.*empty token/u,
  );
  expect(() => serverFromEnvironment({ LIBTMUX_TOOLS: "not_a_tool" })).toThrow(
    /unknown tool.*not_a_tool/u,
  );

  for (let mask = 0; mask < 1 << TOOLSETS.length; mask += 1) {
    const selected = TOOLSETS.filter((_, index) => (mask & (1 << index)) !== 0);
    const expected = selected.flatMap((toolset) => TOOLS_BY_TOOLSET[toolset]).sort();
    // eslint-disable-next-line no-await-in-loop -- each case owns one server lifecycle.
    await withClient(
      { LIBTMUX_MCP_LIVE: "0", LIBTMUX_TOOLSETS: selected.join(",") },
      async (client) => {
        expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual(expected);
      },
    );
  }

  expect(() =>
    createTmuxMcpServer(new Server(), {
      environment: { LIBTMUX_TOOLS: "not_a_tool", LIBTMUX_TOOLSETS: "" },
    }),
  ).toThrow(/unknown tool.*not_a_tool/u);

  await withClient(
    {
      LIBTMUX_EXCLUDE_TOOLS: "list_sessions,kill_pane",
      LIBTMUX_MCP_LIVE: "0",
      LIBTMUX_TOOLS: "run_shell_command,kill_pane",
      LIBTMUX_TOOLSETS: "inspect",
    },
    async (client) => {
      const tools = (await client.listTools()).tools;
      const listedNames = tools.map(({ name }) => name);
      const names = [...listedNames].sort();
      expect(names).toEqual(
        [
          ...TOOLS_BY_TOOLSET.inspect.filter((name) => name !== "list_sessions"),
          "run_shell_command",
        ].sort(),
      );
      expect(names).not.toContain("display_message");
      expect(names).not.toContain("pipe_pane");
      expect(names).not.toContain("set_option");

      const listed = tools.find(({ name }) => name === "run_shell_command");
      expect(listed?.description).toMatch(
        /^Run a shell command in a pane with your user's permissions\./u,
      );
      expect(listed?.annotations).toEqual({
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      });
      const listedBatch = tools.find(({ name }) => name === "call_read_tools_batch");
      expect(listedBatch?.description).toContain("inner tools receive no separate approval");
      expect(listedBatch?.description).toContain("explicit stop and truncation accounting");

      expect((await client.listResources()).resources.map(({ uri }) => uri)).toEqual([
        "tmux://capabilities",
      ]);
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();
      const resource = await client.readResource({ uri: "tmux://capabilities" });
      const content = resource.contents[0];
      const text = content !== undefined && "text" in content ? content.text : undefined;
      expect(typeof text).toBe("string");
      const report = JSON.parse(text as string) as {
        readonly effectiveTools: readonly string[];
        readonly tools: readonly { readonly name: string }[];
      };
      expect(report.effectiveTools).toEqual(listedNames);
      expect(report.tools.map(({ name }) => name)).toEqual(listedNames);
      for (const tool of tools) {
        const metadata = tool._meta?.["com.git-pull.libtmux-mcp/capability"];
        expect(metadata, tool.name).toEqual(report.tools.find(({ name }) => name === tool.name));
      }
      const readBatch = report.tools.find(({ name }) => name === "call_read_tools_batch") as
        | { readonly nestedAuthority?: readonly string[] }
        | undefined;
      expect(readBatch?.nestedAuthority).toEqual(
        READ_BATCH_TOOLS.filter((name) => name !== "list_sessions"),
      );
    },
  );

  await withClient(
    {
      LIBTMUX_MCP_LIVE: "0",
      LIBTMUX_TOOLS: "call_read_tools_batch",
      LIBTMUX_TOOLSETS: "",
    },
    async (client) => {
      const resource = await client.readResource({ uri: "tmux://capabilities" });
      const content = resource.contents[0];
      const text = content !== undefined && "text" in content ? content.text : undefined;
      const report = JSON.parse(text as string) as {
        readonly tools: readonly {
          readonly amplifiesFutureInput: boolean;
          readonly name: string;
          readonly nestedAuthority: readonly string[];
        }[];
      };
      expect(report.tools).toEqual([
        expect.objectContaining({
          name: "call_read_tools_batch",
          nestedAuthority: READ_BATCH_TOOLS,
          outputClasses: [
            "tmux-metadata",
            "terminal-content",
            "process-environment",
            "configured-command",
          ],
        }),
      ]);
      const batch = await client.callTool({
        arguments: { operations: [{ tool: "list_sessions" }] },
        name: "call_read_tools_batch",
      });
      expect(batch.isError).not.toBe(true);
      const structured = batch.structuredContent as
        | {
            readonly failed?: number;
            readonly results?: readonly {
              readonly result?: {
                readonly content?: readonly unknown[];
                readonly isError?: boolean;
              };
            }[];
            readonly stoppedAt?: number | null;
            readonly succeeded?: number;
          }
        | undefined;
      expect(structured).toMatchObject({ failed: 1, stoppedAt: 0, succeeded: 0 });
      expect(structured?.results?.[0]?.result?.content).toBeArray();
      expect(structured?.results?.[0]?.result?.isError).toBe(true);
      expect(JSON.stringify(structured)).toContain("stopped nested call");
      expect(JSON.stringify(structured)).not.toContain("outside the effective surface");
    },
    new Server({
      engine: {
        execute: (request) =>
          Promise.resolve({
            cmd: [...request.commands[0]],
            returncode: 1,
            signal: null,
            stderr: new TextEncoder().encode("stopped nested call"),
            stdout: new Uint8Array(),
          }),
      },
    }),
  );
});

test("target inventory pins a dedicated socket and commandless spawn schemas", async () => {
  const selected = serverFromEnvironment({});
  expect(selected.socketName).toBe("libtmux-mcp");
  expect(selected.socketPath).toBeUndefined();
  expect(readFileSync(selected.configFile ?? "", "utf8")).toContain("minimal tmux configuration");

  await withClient(
    { LIBTMUX_MCP_LIVE: "0", LIBTMUX_TOOLSETS: "inspect,manage,execute,teardown" },
    async (client) => {
      const tools = (await client.listTools()).tools;
      expect(tools.map(({ name }) => name)).toEqual([...SOURCE_CATALOG_ORDER]);
      expect(tools).toHaveLength(47);

      const controlledOpeners = [
        {
          names: [
            "find_pane_by_position",
            "get_pane_info",
            "get_server_info",
            "get_session_info",
            "get_window_info",
            "list_panes",
            "list_sessions",
            "list_windows",
          ],
          opener: "Inspect tmux metadata; accepts no client-supplied executable input.",
        },
        {
          names: [
            "call_read_tools_batch",
            "capture_pane",
            "capture_since",
            "search_panes",
            "snapshot_pane",
            "wait_for_text",
          ],
          opener:
            "Read pane output; accepts no client-supplied executable input. Returned content may be sensitive or untrusted.",
        },
        {
          names: ["show_environment"],
          opener:
            "Read the tmux environment; accepts no client-supplied executable input. Returned values may contain secrets.",
        },
        {
          names: ["get_tmux_variables", "show_hooks", "show_option"],
          opener:
            "Read configured tmux commands; accepts no client-supplied executable input. Returned values may contain executable configuration.",
        },
        {
          names: [...TOOLS_BY_TOOLSET.manage, "set_synchronize_panes"],
          opener: "Change tmux state; no client-supplied executable input.",
        },
        {
          names: ["create_session", "create_window", "respawn_pane", "split_window"],
          opener: "Start a pane's configured process; accepts no command payload.",
        },
        {
          names: ["paste_text", "send_keys", "send_keys_batch"],
          opener:
            "Send input to a pane's program; a shell that receives it runs it with your user's permissions.",
        },
        {
          names: ["run_shell_command"],
          opener: "Run a shell command in a pane with your user's permissions.",
        },
        {
          names: TOOLS_BY_TOOLSET.teardown,
          opener: "Delete tmux state; accepts no command payload.",
        },
      ] as const;
      expect(controlledOpeners.reduce((count, group) => count + group.names.length, 0)).toBe(47);
      for (const { names, opener } of controlledOpeners) {
        for (const name of names) {
          expect(tools.find((tool) => tool.name === name)?.description, name).toStartWith(
            `${opener} `,
          );
        }
      }

      const properties = (name: string): readonly string[] => {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema;
        return Object.keys(schema?.properties ?? {}).sort();
      };
      expect(properties("create_session")).toEqual([
        "height",
        "name",
        "startDirectory",
        "width",
        "windowName",
      ]);
      expect(properties("create_window")).toEqual(["name", "session", "startDirectory"]);
      expect(properties("split_window")).toEqual(["direction", "paneId", "startDirectory"]);
      expect(properties("respawn_pane")).toEqual([
        "force",
        "killFirst",
        "paneId",
        "startDirectory",
      ]);
      for (const name of ["create_session", "create_window", "split_window", "respawn_pane"]) {
        expect(properties(name)).not.toContain("shellCommand");
        expect(properties(name)).not.toContain("environment");
      }

      const resource = await client.readResource({ uri: "tmux://capabilities" });
      const content = resource.contents[0];
      const text = content !== undefined && "text" in content ? content.text : undefined;
      const report = JSON.parse(text as string) as {
        readonly boundary: Readonly<Record<string, boolean>>;
        readonly connection: Readonly<Record<string, unknown>>;
        readonly effectiveTools: readonly string[];
        readonly frozen: boolean;
        readonly schemaVersion: number;
        readonly tools: readonly {
          readonly amplifiesFutureInput: boolean;
          readonly inputSchema: {
            readonly properties?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
          };
          readonly inputLiteralization: Readonly<Record<string, string>>;
          readonly name: string;
          readonly nestedAuthority: readonly string[];
          readonly tmuxEffects: readonly string[];
        }[];
      };
      expect(report).toMatchObject({
        boundary: {
          dynamicResources: false,
          hostCommandExecution: false,
          oneSocketPerProcess: true,
          perCallSocketSelection: false,
        },
        connection: {
          attachCommand: expect.any(String),
          configurationProvenance: expect.any(String),
          resolvedSocketPath: null,
          serverState: expect.any(String),
          socketProvenance: expect.any(String),
          socketSelector: expect.any(String),
        },
        frozen: true,
        schemaVersion: 1,
      });
      expect(report.effectiveTools).toEqual([...SOURCE_CATALOG_ORDER]);
      expect(report.tools.map(({ name }) => name)).toEqual([...SOURCE_CATALOG_ORDER]);
      expect(
        report.tools
          .filter(({ amplifiesFutureInput }) => amplifiesFutureInput)
          .map(({ name }) => name),
      ).toEqual(["set_synchronize_panes"]);
      for (const definition of report.tools) {
        expect(Object.keys(definition).sort()).toEqual([
          "amplifiesFutureInput",
          "annotations",
          "description",
          "inputLiteralization",
          "inputSchema",
          "mayExposeSecrets",
          "mayReturnUntrustedContent",
          "name",
          "nestedAuthority",
          "outputClasses",
          "outputSchema",
          "processReach",
          "title",
          "tmuxEffects",
          "toolset",
        ]);
        expect(definition).not.toHaveProperty("inputSinks");
        expect(definition).not.toHaveProperty("tmuxFormatControls");
        expect(
          Object.values(definition.inputLiteralization).every(
            (strategy) => strategy === "double-hash-once" || strategy === "validated-variable-name",
          ),
        ).toBe(true);
      }
      expect(report).toMatchObject({
        executionAuthority: "tmux-user",
        hostCommandTools: 0,
        operatingSystemBoundary: "none",
        socket: { namespaceBoundary: "tmux-objects-only" },
        toolCount: 47,
        toolFilteringBoundary: "interface-shaping-not-authorization",
      });
      expect(report.tools.find(({ name }) => name === "snapshot_pane")?.nestedAuthority).toEqual(
        [],
      );
      expect(report.tools.find(({ name }) => name === "send_keys_batch")?.nestedAuthority).toEqual(
        [],
      );
      const readBatch = report.tools.find(({ name }) => name === "call_read_tools_batch");
      const tmuxVariables = report.tools.find(({ name }) => name === "get_tmux_variables");
      expect(tmuxVariables?.inputLiteralization).toEqual({
        names: "validated-variable-name",
      });
      expect(readBatch?.tmuxEffects).toEqual(["observe"]);
      expect(report.tools.find(({ name }) => name === "capture_since")?.tmuxEffects).toEqual([
        "observe",
      ]);
      expect(tools.find(({ name }) => name === "set_synchronize_panes")?.description).toContain(
        "subsequent input to one pane is copied to every pane",
      );
      expect(properties("send_keys")).toContain("paneId");
      const sendKeysOutput = tools.find(({ name }) => name === "send_keys")?.outputSchema;
      expect(sendKeysOutput?.properties).toHaveProperty("resolvedPaneIds");
      const sendBatchOutput = tools.find(({ name }) => name === "send_keys_batch")?.outputSchema;
      expect(sendBatchOutput?.properties).toHaveProperty("targets");
      const searchOutput = tools.find(({ name }) => name === "search_panes")?.outputSchema;
      for (const field of [
        "matchingByteClamped",
        "matchingLineClamped",
        "matchingTimeClamped",
        "paneLimitClamped",
      ]) {
        expect(searchOutput?.properties).toHaveProperty(field);
      }
      for (const name of ["search_panes", "wait_for_text"]) {
        const regex = tools.find((tool) => tool.name === name)?.inputSchema.properties?.regex;
        expect(regex, name).toMatchObject({ type: "boolean" });
        expect(regex, name).not.toHaveProperty("const");
      }
    },
  );
});

test("the MCP README names every manifest tool", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  await withClient(
    { LIBTMUX_MCP_LIVE: "0", LIBTMUX_TOOLSETS: "inspect,manage,execute,teardown" },
    async (client) => {
      for (const { name } of (await client.listTools()).tools) {
        expect(readme, name).toContain(`\`${name}\``);
      }
    },
  );
});

test("search matching has one deterministic aggregate byte budget", () => {
  const budget = new SearchMatchBudget(4);
  expect(budget.take("é")).toBe(true);
  expect(budget.take("")).toBe(true);
  expect(budget.take("")).toBe(false);

  const defaultBudget = new SearchMatchBudget();
  expect(defaultBudget.take("x".repeat(256 * 1024 - 1))).toBe(true);
  expect(defaultBudget.take("")).toBe(false);

  let now = 0;
  const lineBudget = new SearchMatchBudget(100, 2, 5_000, () => now);
  expect(lineBudget.take("")).toBe(true);
  expect(lineBudget.take("")).toBe(true);
  expect(lineBudget.take("")).toBe(false);
  expect(lineBudget.exhaustedBy).toBe("lines");

  const timeBudget = new SearchMatchBudget(100, 20, 5, () => now);
  now = 5;
  expect(timeBudget.take("text")).toBe(false);
  expect(timeBudget.exhaustedBy).toBe("time");
});

test("tmux-format-bearing input is literalized exactly once", async () => {
  const commands: (readonly string[])[] = [];
  const engine: TmuxEngine = {
    execute: (request) => {
      commands.push(request.commands[0]);
      return Promise.resolve({
        cmd: [],
        returncode: 1,
        signal: null,
        stderr: new TextEncoder().encode("stop after recording arguments"),
        stdout: new Uint8Array(),
      });
    },
  };

  await withClient(
    { LIBTMUX_MCP_LIVE: "0", LIBTMUX_TOOLSETS: "execute" },
    async (client) => {
      const result = await client.callTool({
        arguments: {
          name: "session-#{session_name}",
          startDirectory: "/tmp/#{host}",
          windowName: "window-#H",
        },
        name: "create_session",
      });
      expect(result.isError).toBe(true);
    },
    new Server({ engine }),
  );
  expect(commands[0]).toEqual(
    expect.arrayContaining(["session-##{session_name}", "/tmp/##{host}", "window-##H"]),
  );
  expect(commands[0]).not.toEqual(
    expect.arrayContaining(["session-####{session_name}", "/tmp/####{host}", "window-####H"]),
  );
});

test("startup env uses the shared socket name, socket path, and config contract", () => {
  const named = serverFromEnvironment({ LIBTMUX_SOCKET: "literal-name" });
  expect(named.socketName).toBe("literal-name");
  expect(named.socketPath).toBeUndefined();

  const path = serverFromEnvironment({ LIBTMUX_SOCKET_PATH: "/tmp/libtmux-mcp.sock" });
  expect(path.socketName).toBeUndefined();
  expect(path.socketPath).toBe("/tmp/libtmux-mcp.sock");

  const configured = serverFromEnvironment({ LIBTMUX_TMUX_CONFIG: "/tmp/tmux.conf" });
  expect(configured.configFile).toBe("/tmp/tmux.conf");
  for (const invalid of ["", "relative.conf", "user"]) {
    expect(() => serverFromEnvironment({ LIBTMUX_TMUX_CONFIG: invalid })).toThrow(
      /LIBTMUX_TMUX_CONFIG.*absolute path/u,
    );
  }
  expect(() =>
    serverFromEnvironment({
      LIBTMUX_SOCKET: "literal-name",
      LIBTMUX_SOCKET_PATH: "/tmp/libtmux-mcp.sock",
    }),
  ).toThrow(/only one.*LIBTMUX_SOCKET.*LIBTMUX_SOCKET_PATH|LIBTMUX_SOCKET.*only one/u);
});

test("minimal startup authenticates the daemon creator after start-server", async () => {
  const observedOwner = "01234567-89ab-cdef-0123-456789abcdef";
  const commands: (readonly string[])[] = [];
  const engine: TmuxEngine = {
    execute: (request) => {
      const command = request.commands[0];
      commands.push(command);
      const stdout =
        command[0] === "show-options"
          ? `${observedOwner}\n`
          : command[0] === "display-message"
            ? "/tmp/libtmux-owned.sock\n"
            : "";
      return Promise.resolve({
        cmd: [],
        returncode: 0,
        signal: null,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode(stdout),
      });
    },
  };
  const environment = { LIBTMUX_MCP_LAUNCH_NONCE: observedOwner };
  const startup = await inspectServerStartup(
    new Server({ engine, environment, socketPath: "/tmp/libtmux-owned.sock" }),
    "minimal",
    environment,
  );

  expect(commands.map(([name]) => name)).toEqual([
    "start-server",
    "show-options",
    "display-message",
  ]);
  expect(startup).toMatchObject({
    configurationProvenance: "minimal",
    resolvedSocketPath: "/tmp/libtmux-owned.sock",
    serverState: "created",
  });

  const losingEngine: TmuxEngine = {
    execute: (request) =>
      Promise.resolve({
        cmd: [],
        returncode: 0,
        signal: null,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode(
          request.commands[0][0] === "show-options" ? "another-launch\n" : "",
        ),
      }),
  };
  const raced = await inspectServerStartup(
    new Server({ engine: losingEngine, environment, socketName: "libtmux-mcp" }),
    "minimal",
    environment,
  );
  expect(raced).toMatchObject({
    configurationProvenance: "unknown",
    serverState: "existing",
  });

  const minimalConfig = readFileSync(new URL("../src/minimal.conf", import.meta.url), "utf8");
  expect(minimalConfig).toContain('set-option -g @libtmux-mcp-owner "$LIBTMUX_MCP_LAUNCH_NONCE"');
  expect(minimalConfig).toContain("set-environment -gu LIBTMUX_MCP_LAUNCH_NONCE");
});

test("synchronize-panes resolves the disclosed pane target set", async () => {
  const panes = [{ id: "%2" }, { id: "%1" }, { id: "%2" }];
  const pane = (value: string) => ({
    id: "%1",
    window: {
      panes: { toArray: () => panes },
      showResolvedOptions: () => Promise.resolve(new Map([["synchronize-panes", value]])),
    },
  });
  expect(await resolvedPaneInputTargetIds(pane("off"))).toEqual(["%1"]);
  expect(await resolvedPaneInputTargetIds(pane("on"))).toEqual(["%1", "%2"]);
});

test("read batch preserves nested results within the shared result ceiling", async () => {
  expect(MAX_RESULT_BYTES).toBe(1_000_000);
  const huge = "x".repeat(MAX_RESULT_BYTES * 2);
  const bounded = new ReadBatchAccumulator(1);
  expect(
    bounded.append({
      result: {
        content: [{ text: huge, type: "text" }],
        structuredContent: { value: huge },
      },
      tool: "list_sessions",
    }),
  ).toBe(true);
  expect(bounded.finish()).toMatchObject({
    failed: 0,
    onError: "stop",
    results: [
      {
        error: null,
        index: 0,
        result: null,
        resultTruncated: true,
        success: true,
        tool: "list_sessions",
      },
    ],
    stoppedAt: null,
    succeeded: 1,
    truncated: true,
    truncatedBytes: expect.any(Number),
  });

  const envelopeBounded = new ReadBatchAccumulator(1);
  envelopeBounded.append({
    result: {
      content: [{ text: "x".repeat(850_000), type: "text" }],
      structuredContent: { value: "x".repeat(850_000) },
    },
    tool: "list_sessions",
  });
  const requestId = "request-".repeat(25_000);
  const envelope = envelopeBounded.finish("stop", (answer) =>
    readBatchWireBytes(answer, requestId),
  );
  expect(envelope.results[0]).toMatchObject({
    index: 0,
    result: null,
    resultTruncated: true,
    tool: "list_sessions",
  });
  expect(readBatchWireBytes(envelope, requestId)).toBeLessThanOrEqual(MAX_RESULT_BYTES);

  await withClient(
    {
      LIBTMUX_MCP_LIVE: "0",
      LIBTMUX_TOOLS: "call_read_tools_batch",
      LIBTMUX_TOOLSETS: "",
    },
    async (client) => {
      const answer = await client.callTool({
        arguments: {
          onError: "continue",
          operations: Array.from({ length: 16 }, () => ({ tool: "list_sessions" })),
        },
        name: "call_read_tools_batch",
      });
      const structured = answer.structuredContent as
        | {
            readonly failed?: number;
            readonly onError?: string;
            readonly results?: readonly {
              readonly index?: number;
              readonly result?: {
                readonly content?: readonly unknown[];
                readonly isError?: boolean;
              } | null;
              readonly resultTruncated?: boolean;
              readonly success?: boolean;
            }[];
            readonly stoppedAt?: number | null;
            readonly succeeded?: number;
            readonly truncated?: boolean;
            readonly truncatedBytes?: number;
          }
        | undefined;
      expect(structured?.results?.[0]?.result?.content).toBeArray();
      expect(structured).toMatchObject({
        failed: 16,
        onError: "continue",
        stoppedAt: null,
        succeeded: 0,
        truncated: false,
        truncatedBytes: 0,
      });
      expect(structured?.results?.map(({ index }) => index)).toEqual(
        Array.from({ length: 16 }, (_, index) => index),
      );
      expect(structured?.results?.every(({ resultTruncated }) => !resultTruncated)).toBe(true);
      expect(structured?.truncated).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(structured), "utf8")).toBeLessThanOrEqual(
        MAX_RESULT_BYTES,
      );
    },
    new Server({
      engine: {
        execute: (request) =>
          Promise.resolve({
            cmd: [...request.commands[0]],
            returncode: 1,
            signal: null,
            stderr: new TextEncoder().encode("stopped nested call"),
            stdout: new Uint8Array(),
          }),
      },
    }),
  );
});

test("read batch schema exposes only its exclusion-pruned nested authority", async () => {
  await withClient(
    {
      LIBTMUX_EXCLUDE_TOOLS: "list_sessions",
      LIBTMUX_MCP_LIVE: "0",
      LIBTMUX_TOOLS: "call_read_tools_batch",
      LIBTMUX_TOOLSETS: "",
    },
    async (client) => {
      const batch = (await client.listTools()).tools.find(
        ({ name }) => name === "call_read_tools_batch",
      );
      const schema = JSON.stringify(batch?.inputSchema);
      expect(schema).not.toContain("list_sessions");
      expect(schema).toContain("capture_pane");
      expect(schema).toContain('"const":"capture_pane"');
      expect(schema).toContain('"paneId"');
    },
  );

  await withClient(
    {
      LIBTMUX_EXCLUDE_TOOLS: READ_BATCH_TOOLS.join(","),
      LIBTMUX_MCP_LIVE: "0",
      LIBTMUX_TOOLS: "call_read_tools_batch",
      LIBTMUX_TOOLSETS: "",
    },
    async (client) => {
      const batch = (await client.listTools()).tools.find(
        ({ name }) => name === "call_read_tools_batch",
      );
      expect(JSON.stringify(batch?.inputSchema)).toContain('"not":{}');
      expect(batch?._meta?.["com.git-pull.libtmux-mcp/capability"]).toMatchObject({
        nestedAuthority: [],
        outputClasses: [],
        tmuxEffects: ["observe"],
      });
      const rejected = await client.callTool({
        arguments: { operations: [{ tool: "list_sessions" }] },
        name: "call_read_tools_batch",
      });
      expect(rejected.isError).toBe(true);
    },
  );
});

test("read batch capability unions follow its effective nested authority", async () => {
  await withClient(
    {
      LIBTMUX_EXCLUDE_TOOLS: READ_BATCH_TOOLS.filter((name) => name !== "list_sessions").join(","),
      LIBTMUX_MCP_LIVE: "0",
      LIBTMUX_TOOLS: "call_read_tools_batch",
      LIBTMUX_TOOLSETS: "",
    },
    async (client) => {
      const batch = (await client.listTools()).tools.find(
        ({ name }) => name === "call_read_tools_batch",
      );
      expect(batch?._meta?.["com.git-pull.libtmux-mcp/capability"]).toMatchObject({
        nestedAuthority: ["list_sessions"],
        outputClasses: ["tmux-metadata"],
        tmuxEffects: ["observe"],
      });
    },
  );
});

test("startup provenance controls the implicit teardown surface", async () => {
  const cases = [
    {
      configurationProvenance: "minimal",
      hasTeardown: true,
      serverState: "created",
    },
    {
      configurationProvenance: "unknown",
      hasTeardown: false,
      serverState: "existing",
    },
    {
      configurationProvenance: "user-configured",
      hasTeardown: false,
      serverState: "absent",
    },
  ] as const;

  for (const startup of cases) {
    // eslint-disable-next-line no-await-in-loop -- each provenance case owns one server lifecycle.
    await withClient(
      { LIBTMUX_MCP_LIVE: "0" },
      async (client) => {
        const names = (await client.listTools()).tools.map(({ name }) => name);
        expect(names.includes("kill_session")).toBe(startup.hasTeardown);

        const resource = await client.readResource({ uri: "tmux://capabilities" });
        const content = resource.contents[0];
        const text = content !== undefined && "text" in content ? content.text : undefined;
        const report = JSON.parse(text as string) as {
          readonly socket: {
            readonly configurationProvenance: string;
            readonly serverState: string;
          };
        };
        expect(report.socket.configurationProvenance).toBe(startup.configurationProvenance);
        expect(report.socket.serverState).toBe(startup.serverState);
      },
      new Server({ socketName: "libtmux-mcp" }),
      { startup },
    );
  }
});
