/* eslint-disable no-await-in-loop -- Each launch gets its own servers and finishes before the next. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "bun:test";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "../../../scripts/bounded_process.js";
import {
  deadlineMs,
  makeTestDirectory,
  runWithCleanup,
} from "../../libtmux/src/_internal/test/testkit.js";
import { structured } from "./support/server_harness.js";

/**
 * Which tmux server the executable drives when no socket is chosen for it: the
 * one `LIBTMUX_SOCKET_PATH`, else `LIBTMUX_SOCKET`, names, and otherwise the
 * one tmux picks, which inside tmux is the one `TMUX` names.
 *
 * Every launch runs with `TMUX_TMPDIR` in a directory of this test's own,
 * which exists because tmux falls back to `/tmp` for one that does not, and
 * with no `TMUX`, `TMUX_PANE` or `LIBTMUX_SOCKET*` of the developer's.
 */

const entry = fileURLToPath(new URL("../src/server.ts", import.meta.url));

interface World {
  readonly directory: string;
  /** The `TMUX` and `TMUX_PANE` tmux exports into the first pane of server `name`. */
  pane(name: string): Promise<{ TMUX: string; TMUX_PANE: string; socketPath: string }>;
  /** Start a server on the named socket with one session. */
  start(name: string, session: string): Promise<void>;
  launch(extra: Record<string, string>): Promise<Launched>;
  socketIn(name: string): string;
}

interface Launched {
  readonly capabilities: {
    readonly connection: {
      readonly resolvedSocketPath: string | null;
      readonly serverState: string;
      readonly socketProvenance: string;
      readonly socketSelector: string;
    };
    readonly socket: { readonly selectionProvenance: string };
  };
  readonly instructions: string;
  readonly sessions: readonly string[];
  readonly startup: string;
  readonly tools: readonly string[];
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const directory = await makeTestDirectory("ltx-mcp-sock-");
  const tmuxDirectory = join(directory, "t");
  const home = join(directory, "home");
  await Promise.all([tmuxDirectory, home].map((path) => mkdir(path, { mode: 0o700 })));
  const environment: Record<string, string> = {
    HOME: home,
    LANG: process.env["LANG"] ?? "C.UTF-8",
    PATH: process.env["PATH"] ?? "",
    TMUX_TMPDIR: tmuxDirectory,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
  };
  const uid = String(process.getuid?.() ?? 0);
  const socketIn = (name: string): string => join(tmuxDirectory, `tmux-${uid}`, name);
  const tmux = async (...argv: string[]): Promise<string> => {
    const result = await runBoundedCommand(["tmux", "-f", "/dev/null", ...argv], {
      env: environment,
      maxOutputBytes: 65_536,
      timeoutMilliseconds: 10_000,
    });
    expect(result, `tmux ${argv.join(" ")}\n${result.stderr}`).toMatchObject({
      exitCode: 0,
      termination: "exited",
    });
    return result.stdout.trim();
  };
  await runWithCleanup(
    () =>
      body({
        directory,
        launch: async (extra) => {
          const client = new Client({ name: "socket-default", version: "0.0.0" });
          const transport = new StdioClientTransport({
            args: [entry],
            command: process.execPath,
            env: { ...environment, ...extra },
            stderr: "pipe",
          });
          let diagnostic = "";
          transport.stderr?.on("data", (chunk: Buffer | string) => {
            diagnostic += chunk.toString();
          });
          return runWithCleanup(
            async () => {
              await client.connect(transport);
              const until = Date.now() + deadlineMs(5_000);
              while (!diagnostic.includes("\n") && Date.now() < until) await delay(20);
              const tools = (await client.listTools()).tools.map(({ name }) => name);
              const resource = await client.readResource({ uri: "tmux://capabilities" });
              const content = resource.contents[0];
              const text = content !== undefined && "text" in content ? content.text : "{}";
              const listed = tools.includes("list_sessions")
                ? await client.callTool({ arguments: {}, name: "list_sessions" })
                : undefined;
              return {
                capabilities: JSON.parse(text) as Launched["capabilities"],
                instructions: client.getInstructions() ?? "",
                sessions:
                  listed === undefined || listed.isError === true
                    ? []
                    : structured<{ sessions: readonly { name: string }[] }>(listed).sessions.map(
                        ({ name }) => name,
                      ),
                startup: diagnostic.split("\n")[0] ?? "",
                tools,
              };
            },
            () => client.close(),
          );
        },
        pane: async (name) => {
          const socketPath = await tmux("-L", name, "display-message", "-p", "#{socket_path}");
          const pid = await tmux("-L", name, "display-message", "-p", "#{pid}");
          const paneId = await tmux("-L", name, "display-message", "-p", "#{pane_id}");
          return { TMUX: `${socketPath},${pid},0`, TMUX_PANE: paneId, socketPath };
        },
        socketIn,
        start: async (name, session) => {
          await tmux("-L", name, "new-session", "-d", "-s", session);
        },
      }),
    async () => {
      const sockets = join(tmuxDirectory, `tmux-${uid}`);
      for (const name of await readdir(sockets).catch(() => [])) {
        await runBoundedCommand(["tmux", "-S", join(sockets, name), "kill-server"], {
          env: environment,
          maxOutputBytes: 65_536,
          timeoutMilliseconds: 10_000,
        });
      }
      await rm(directory, { force: true, recursive: true });
    },
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("inside tmux with no variable, the server is the one TMUX names", async () => {
  await withWorld(async (world) => {
    await world.start("ltx-pane", "from-the-pane");
    const { socketPath, ...inside } = await world.pane("ltx-pane");

    const launched = await world.launch(inside);

    expect(launched.sessions).toEqual(["from-the-pane"]);
    expect(launched.capabilities.connection).toMatchObject({
      resolvedSocketPath: socketPath,
      serverState: "existing",
      socketProvenance: "tmux-choice",
      socketSelector: "tmux-choice",
    });
    expect(launched.startup).toContain(`serving existing ${socketPath},`);
    expect(launched.startup).toEndWith(`, from pane ${inside.TMUX_PANE} on ${socketPath}`);
    expect(launched.instructions).toContain(
      `launched from tmux pane ${inside.TMUX_PANE} on the server at ${socketPath};`,
    );
    expect(launched.tools).not.toContain("kill_pane");
    expect(await exists(world.socketIn("libtmux-mcp"))).toBe(false);
  });
}, 60_000);

test("inside tmux, LIBTMUX_SOCKET takes the server over TMUX and the line names both", async () => {
  await withTwoServers(async (world, inside, elsewhere) => {
    const launched = await world.launch({ ...inside, LIBTMUX_SOCKET: "ltx-elsewhere" });

    expect(launched.sessions).toEqual(["elsewhere-session"]);
    expect(launched.capabilities.connection).toMatchObject({
      resolvedSocketPath: elsewhere,
      socketProvenance: "socket-name",
      socketSelector: "name:ltx-elsewhere",
    });
    expect(launched.startup).toContain("serving existing ltx-elsewhere,");
    expect(launched.startup).toEndWith(`, from pane ${inside.TMUX_PANE} on ${inside.socketPath}`);
  });
}, 60_000);

test("LIBTMUX_SOCKET_PATH takes the server over LIBTMUX_SOCKET and TMUX", async () => {
  await withTwoServers(async (world, inside, elsewhere) => {
    const launched = await world.launch({
      ...inside,
      LIBTMUX_SOCKET: "ltx-pane",
      LIBTMUX_SOCKET_PATH: elsewhere,
    });

    expect(launched.sessions).toEqual(["elsewhere-session"]);
    expect(launched.capabilities.connection).toMatchObject({
      resolvedSocketPath: elsewhere,
      socketProvenance: "socket-path",
      socketSelector: `path:${elsewhere}`,
    });
    expect(launched.startup).toContain(`serving existing ${elsewhere},`);
  });
}, 60_000);

test("with nothing chosen and no TMUX, it starts no server of its own", async () => {
  await withWorld(async (world) => {
    const launched = await world.launch({});

    expect(launched.capabilities.connection).toMatchObject({
      serverState: "absent",
      socketProvenance: "tmux-choice",
    });
    expect(launched.startup).toMatch(
      /^libtmux-mcp \S+ serving default, toolsets execute,inspect,manage,/u,
    );
    expect(launched.startup).not.toContain("from pane");
    expect(launched.tools).toContain("list_sessions");
    expect(launched.tools).not.toContain("kill_pane");
    expect(await exists(world.socketIn("libtmux-mcp"))).toBe(false);
    expect(await exists(world.socketIn("default"))).toBe(false);
  });
}, 60_000);

async function withTwoServers(
  body: (
    world: World,
    inside: { TMUX: string; TMUX_PANE: string; socketPath: string },
    elsewhere: string,
  ) => Promise<void>,
): Promise<void> {
  await withWorld(async (world) => {
    await world.start("ltx-pane", "from-the-pane");
    await world.start("ltx-elsewhere", "elsewhere-session");
    const inside = await world.pane("ltx-pane");
    const { socketPath: elsewhere } = await world.pane("ltx-elsewhere");
    await body(world, inside, elsewhere);
  });
}
