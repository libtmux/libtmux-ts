/* eslint-disable no-await-in-loop -- Each launch gets a private tmux directory and finishes before the next starts. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "../../../scripts/bounded_process.js";
import { fences, steps, words } from "../../../scripts/readme_blocks.js";
import {
  deadlineMs,
  makeTestDirectory,
  runWithCleanup,
} from "../../libtmux/src/_internal/test/testkit.js";
import manifest from "../package.json" with { type: "json" };
import { structured } from "./support/server_harness.js";

/**
 * Launch the MCP server the way the READMEs say to, and hold what they say it
 * does against what it does.
 *
 * Every launch line a README prints — `npx` with or without environment
 * variables, `claude mcp add`, and the `mcpServers` JSON — is read into the
 * environment and command it names. The command must pin the version in this
 * manifest, which is what an installed package would be; the working tree's
 * server then runs with that environment. `TMUX_TMPDIR` points into a directory
 * this test makes, so `LIBTMUX_SOCKET=agent` means a socket in there rather
 * than one of yours.
 *
 * Checked: the startup line on stderr, which names the socket and the toolsets;
 * which tools `tools/list` returns; and, for a `tmux` command printed above a
 * launch, the sessions that command made.
 */

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const documents = ["README.md", "packages/libtmux/README.md", "packages/mcp/README.md"] as const;
const PACKAGE = "@libtmux/mcp";
const ROLES = {
  execute: "run_shell_command",
  inspect: "list_sessions",
  manage: "rename_window",
  teardown: "kill_pane",
} as const;

interface Launch {
  readonly env: Readonly<Record<string, string>>;
  /** What the README prints under the command: the stderr startup line. */
  readonly printed: string | undefined;
  /** `tmux` commands printed above the launch, which make the world it meets. */
  readonly setup: readonly string[];
  readonly source: string;
}

/** The environment assignments before a command, and the command after them. */
function splitAssignments(found: readonly string[]): {
  readonly command: readonly string[];
  readonly env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  let index = 0;
  for (; index < found.length; index += 1) {
    const assignment = /^(?<name>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u.exec(found[index] ?? "");
    if (assignment?.groups === undefined) break;
    env[assignment.groups["name"] ?? ""] = assignment.groups["value"] ?? "";
  }
  return { command: found.slice(index), env };
}

/** A command an MCP client would run: it must be this package at this version. */
function assertInstalledServer(command: readonly string[], source: string): void {
  const [program, ...args] = command;
  const pinned = ["-y", `${PACKAGE}@${manifest.version}`];
  const accepted =
    (program === "npx" && args.length === 2 && args.every((arg, i) => arg === pinned[i])) ||
    (program === "libtmux-mcp" && args.length === 0) ||
    (program === "bun" && args.length === 1 && args[0] === "packages/mcp/src/server.ts");
  if (!accepted)
    throw new Error(
      `${source}: not a launch of ${PACKAGE}@${manifest.version}: ${command.join(" ")}`,
    );
}

function launchesIn(markdown: string, file: string): readonly Launch[] {
  const launches: Launch[] = [];
  let setup: string[] = [];
  for (const fence of fences(markdown, file)) {
    if (fence.language === "json") {
      const parsed = JSON.parse(fence.lines.join("\n")) as {
        mcpServers?: Record<
          string,
          { args?: string[]; command: string; env?: Record<string, string> }
        >;
      };
      for (const server of Object.values(parsed.mcpServers ?? {})) {
        const command = [server.command, ...(server.args ?? [])];
        const source = `${file}:${String(fence.line)}`;
        assertInstalledServer(command, source);
        launches.push({ env: server.env ?? {}, printed: undefined, setup: [], source });
      }
    }
    if (fence.language !== "console") continue;
    for (const step of steps(fence)) {
      const source = `${file}:${String(step.line)}`;
      const found = words(step.command);
      if (found[0] === "tmux") {
        setup.push(step.command);
        continue;
      }
      let { command, env } = splitAssignments(found);
      if (command[0] === "claude" && command[1] === "mcp" && command[2] === "add") {
        const separator = command.indexOf("--");
        const options = command.slice(4, separator === -1 ? command.length : separator);
        for (const [index, option] of options.entries()) {
          if (option !== "--env" && option !== "-e") continue;
          const [name, ...value] = (options[index + 1] ?? "").split("=");
          env = { ...env, [name ?? ""]: value.join("=") };
        }
        command = separator === -1 ? [] : command.slice(separator + 1);
      }
      const launchesServer =
        (command[0] === "npx" && command.some((word) => word.startsWith(`${PACKAGE}@`))) ||
        command[0] === "libtmux-mcp" ||
        (command[0] === "bun" && command[1] === "packages/mcp/src/server.ts");
      if (!launchesServer) continue;
      assertInstalledServer(command, source);
      launches.push({ env, printed: step.output[0], setup, source });
      setup = [];
    }
  }
  if (setup.length > 0) throw new Error(`${file}: tmux commands printed with no launch after them`);
  return launches;
}

interface Observed {
  readonly sessions: readonly string[];
  readonly startup: string;
  readonly tools: readonly string[];
}

/** Run the working tree's server with a launch's environment and report what it did. */
async function observe(launch: Launch): Promise<Observed> {
  const directory = await makeTestDirectory("ltx-mcp-readme-");
  const tmuxDirectory = join(directory, "t");
  const home = join(directory, "home");
  await Promise.all([tmuxDirectory, home].map((path) => mkdir(path)));
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
  const client = new Client({ name: "readme-launch", version: "0.0.0" });
  return runWithCleanup(
    async () => {
      for (const command of launch.setup) {
        const made = await runBoundedCommand(["sh", "-c", command], {
          env: environment,
          maxOutputBytes: 65_536,
          timeoutMilliseconds: 10_000,
        });
        expect(made, `${launch.source}: ${command}\n${made.stderr}`).toMatchObject({
          exitCode: 0,
          termination: "exited",
        });
      }
      const transport = new StdioClientTransport({
        args: [entry],
        command: process.execPath,
        cwd: repositoryRoot,
        env: { ...environment, ...launch.env },
        stderr: "pipe",
      });
      let diagnostic = "";
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        diagnostic += chunk.toString();
      });
      await client.connect(transport);
      const until = Date.now() + deadlineMs(5_000);
      while (!diagnostic.includes("\n") && Date.now() < until) await delay(20);
      const tools = (await client.listTools()).tools.map(({ name }) => name);
      // Only a launch with a `tmux` command above it has sessions to find; on a
      // socket nothing started yet, listing them is an error and not an answer.
      const sessions =
        launch.setup.length > 0 && tools.includes("list_sessions")
          ? structured<{ sessions: readonly { name: string }[] }>(
              await client.callTool({ name: "list_sessions", arguments: {} }),
            ).sessions.map(({ name }) => name)
          : [];
      return { sessions, startup: diagnostic.split("\n")[0] ?? "", tools };
    },
    async () => {
      await runWithCleanup(
        () => client.close(),
        async () => {
          const sockets = join(tmuxDirectory, `tmux-${String(process.getuid?.() ?? 0)}`);
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
    },
  );
}

/** The toolsets the READMEs say a launch gets. */
function toolsetsFor(env: Readonly<Record<string, string>>): readonly string[] {
  if (env["LIBTMUX_TOOLSETS"] !== undefined) {
    return env["LIBTMUX_TOOLSETS"]
      .split(",")
      .filter((name) => name !== "")
      .toSorted();
  }
  const chosen = env["LIBTMUX_SOCKET"] !== undefined || env["LIBTMUX_SOCKET_PATH"] !== undefined;
  return chosen ? ["execute", "inspect", "manage"] : ["execute", "inspect", "manage", "teardown"];
}

/** What a README claims about a launch, held against what the server did. */
async function assertLaunch(launch: Launch): Promise<void> {
  const seen = await observe(launch);
  const where = `${launch.source} ${JSON.stringify(launch.env)}`;
  const toolsets = toolsetsFor(launch.env);
  const startup =
    /^libtmux-mcp (?<version>\S+) serving(?: (?<state>new|existing))? (?<socket>\S+), toolsets (?<sets>\S+), (?<named>\d+) named inclusions, (?<excluded>\d+) exclusions/u.exec(
      seen.startup,
    )?.groups;
  expect(startup, `${where}: startup line was ${JSON.stringify(seen.startup)}`).toBeDefined();
  expect(startup?.["version"], where).toBe(manifest.version);
  expect(startup?.["sets"], where).toBe(toolsets.join(",") || "none");
  const socket = launch.env["LIBTMUX_SOCKET"];
  if (socket !== undefined) expect(startup?.["socket"], where).toBe(socket);
  if (launch.printed !== undefined) expect(seen.startup, where).toBe(launch.printed);

  const named = (launch.env["LIBTMUX_TOOLS"] ?? "").split(",").filter((name) => name !== "");
  if (toolsets.length === 0) {
    expect(seen.tools.toSorted(), where).toEqual(named.toSorted());
  }
  for (const [set, tool] of Object.entries(ROLES)) {
    expect(seen.tools.includes(tool) || named.includes(tool), `${where}: ${tool}`).toBe(
      toolsets.includes(set) || named.includes(tool),
    );
  }
  for (const command of launch.setup) {
    const found = words(command);
    const session = found.includes("-s") ? found[found.indexOf("-s") + 1] : undefined;
    if (session !== undefined && seen.tools.includes("list_sessions")) {
      expect(seen.sessions, `${where}: ${command}`).toContain(session);
    }
  }
}

for (const file of documents) {
  test(`${file} launch lines start the server they describe`, async () => {
    const launches = launchesIn(await readFile(join(repositoryRoot, file), "utf8"), file);
    // A document that stops showing launch lines would otherwise pass by
    // checking nothing, which is what a broken extraction looks like too.
    expect(launches.length, `${file} shows no launch of ${PACKAGE}`).toBeGreaterThan(0);
    for (const launch of launches) await assertLaunch(launch);
  }, 180_000);
}

test("a launch a reader could not reproduce fails here", async () => {
  const control = launchesIn(
    ["```console", `$ LIBTMUX_TOOLSETS=inspect npx -y ${PACKAGE}@${manifest.version}`, "```"].join(
      "\n",
    ),
    "control",
  );
  expect(control).toHaveLength(1);
  const [launch] = control;
  if (launch === undefined) throw new Error("control launch missing");
  await assertLaunch(launch);
  // The observation tells a narrow surface from a wide one.
  const narrow = await observe(launch);
  expect(narrow.tools).toContain("list_sessions");
  expect(narrow.tools).not.toContain("kill_pane");

  // The version pin is the manifest's, so a stale one is not a launch.
  expect(() =>
    launchesIn(`\`\`\`console\n$ npx -y ${PACKAGE}@0.0.0-stale\n\`\`\`\n`, "stale"),
  ).toThrow("not a launch");
  // A transcript that disagrees with the startup line is a different server.
  await expect(
    assertLaunch({ ...launch, printed: "libtmux-mcp 0.0.0 serving new x, toolsets inspect" }),
  ).rejects.toThrow();
  // A retired variable stops startup, as the README says.
  await expect(assertLaunch({ ...launch, env: { LIBTMUX_SAFETY: "readonly" } })).rejects.toThrow();
}, 120_000);
