import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNode22 } from "../packages/libtmux/src/_internal/test/testkit.js";
import { runBoundedCommand } from "./bounded_process.js";
import { npmPack } from "./npm_pack.js";

interface Manifest {
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly peerDependencies?: Readonly<Record<string, unknown>>;
  readonly version: string;
}

interface Consumer {
  readonly bunProbe: string;
  readonly dependencyField: "dependencies" | "peerDependencies";
  readonly libs: readonly string[];
  readonly nodeProbe: string;
  readonly types: string;
}

interface McpMessage {
  readonly id?: number;
  readonly result?: {
    readonly capabilities?: { readonly tasks?: unknown };
    readonly tools?: readonly { readonly name?: string }[];
  };
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageDirectory = process.argv[2];
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 120_000;
const INSTALL_TIMEOUT_MILLISECONDS = 300_000;
const MCP_PROBE_TIMEOUT_MILLISECONDS = 20_000;
const RUNTIME_TIMEOUT_MILLISECONDS = 30_000;

function fail(message: string): never {
  throw new Error(message);
}

function failBeforeProject(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function resolveBinary(name: string): string {
  let directory = repositoryRoot;
  for (;;) {
    const candidate = join(directory, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) fail(`${name} is not installed above the repository root`);
    directory = parent;
  }
}

async function run(
  command: readonly string[],
  cwd: string,
  timeoutMilliseconds: number,
): Promise<string> {
  const result = await runBoundedCommand(command, {
    cwd,
    env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    timeoutMilliseconds,
  });
  if (result.termination === "timed_out") {
    fail(`${command.join(" ")} exceeded ${String(timeoutMilliseconds)}ms`);
  }
  if (result.termination === "output_limit_exceeded") {
    fail(`${command.join(" ")} exceeded ${String(MAX_COMMAND_OUTPUT_BYTES)} output bytes`);
  }
  if (result.exitCode !== 0) {
    fail(
      `${command.join(" ")} exited ${String(result.exitCode)}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

async function probeMcpBinary(project: string, node: string): Promise<void> {
  const binary = join(project, "node_modules", ".bin", "libtmux-mcp");
  const frames = [
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "installed-bin-canary", version: "0" },
        protocolVersion: "2024-11-05",
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
  ];
  const result = await runBoundedCommand([node, binary], {
    cwd: project,
    env: { ...process.env, LIBTMUX_SAFETY: "readonly", TMUX: "", TMUX_PANE: "" },
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    stdin: `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
    timeoutMilliseconds: MCP_PROBE_TIMEOUT_MILLISECONDS,
  });
  if (result.termination === "timed_out") {
    fail(`installed ${binary} exceeded its handshake deadline\n${result.stderr}`);
  }
  if (result.termination === "output_limit_exceeded") {
    fail(`installed ${binary} exceeded ${String(MAX_COMMAND_OUTPUT_BYTES)} output bytes`);
  }
  if (result.exitCode !== 0) {
    fail(`installed ${binary} exited ${String(result.exitCode)}\n${result.stdout}${result.stderr}`);
  }
  const { stderr, stdout: output } = result;

  const messages = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as McpMessage);
  const initialized = messages.find(({ id }) => id === 1);
  const listed = messages.find(({ id }) => id === 2);
  const tools =
    listed?.result?.tools?.flatMap(({ name }) => (name === undefined ? [] : [name])) ?? [];
  if (tools.length === 0) {
    fail(`installed ${binary} returned no tools\n${output}${stderr}`);
  }
  if (tools.includes("wait_for_text_task")) {
    fail(`installed ${binary} offered experimental task tool\n${output}${stderr}`);
  }
  if (!tools.includes("wait_for_text")) {
    fail(`installed ${binary} omitted stable wait tool\n${output}${stderr}`);
  }
  if (initialized?.result?.capabilities?.tasks !== undefined) {
    fail(`installed ${binary} advertised experimental task support\n${output}${stderr}`);
  }
}

function consumerFor(name: string): Consumer {
  if (name === "@libtmux/mcp") {
    return {
      dependencyField: "dependencies",
      libs: ["ES2024", "ESNext.Disposable", "DOM"],
      types: [
        'import { createTmuxMcpServer, type Policy, type SafetyTier } from "@libtmux/mcp";',
        'import { Server } from "libtmux";',
        'const safety: SafetyTier = "readonly";',
        "const policy: Policy = {",
        "  blockingWaitMaxMs: 30_000,",
        "  commandTimeoutMs: 10_000,",
        "  liveEnabled: false,",
        "  maxResultLines: 2_000,",
        "  safety,",
        "  tools: undefined,",
        "};",
        'createTmuxMcpServer(new Server({ socketName: "ltx-install-canary" }), { policy });',
        "",
      ].join("\n"),
      nodeProbe: [
        'import { createTmuxMcpServer } from "@libtmux/mcp";',
        'import { Server } from "libtmux";',
        'if (!import.meta.resolve("@libtmux/mcp").endsWith("/dist/server.js")) throw new Error("MCP did not resolve to dist");',
        'if (!import.meta.resolve("libtmux").endsWith("/dist/index.js")) throw new Error("libtmux did not resolve to dist");',
        'const server = createTmuxMcpServer(new Server({ socketName: "ltx-install-canary" }));',
        'if (server === undefined) throw new Error("MCP factory returned undefined");',
        "",
      ].join("\n"),
      bunProbe: [
        'import { createTmuxMcpServer } from "@libtmux/mcp";',
        'import { Server } from "libtmux";',
        'if (!import.meta.resolve("@libtmux/mcp").endsWith("/src/server.ts")) throw new Error("MCP did not resolve to source");',
        'if (!import.meta.resolve("libtmux").endsWith("/src/index.ts")) throw new Error("libtmux did not resolve to source");',
        'const server = createTmuxMcpServer(new Server({ socketName: "ltx-install-canary" }));',
        'if (server === undefined) throw new Error("MCP factory returned undefined");',
        "",
      ].join("\n"),
    };
  }
  if (name === "@libtmux/workspace") {
    return {
      dependencyField: "peerDependencies",
      libs: ["ES2024", "ESNext.Disposable"],
      types: [
        'import { applyWorkspace } from "@libtmux/workspace";',
        'import { parseWorkspace, parseWorkspaceYaml } from "@libtmux/workspace/config";',
        'import { OWNERSHIP_OPTION } from "@libtmux/workspace/ownership";',
        "void applyWorkspace;",
        "void parseWorkspace;",
        "void parseWorkspaceYaml;",
        "void OWNERSHIP_OPTION;",
        "",
      ].join("\n"),
      nodeProbe: [
        'import { applyWorkspace } from "@libtmux/workspace";',
        'import { parseWorkspace } from "@libtmux/workspace/config";',
        'import { OWNERSHIP_OPTION } from "@libtmux/workspace/ownership";',
        'if (!import.meta.resolve("@libtmux/workspace").endsWith("/dist/builder.js")) throw new Error("workspace did not resolve to dist");',
        'if (!import.meta.resolve("@libtmux/workspace/config").endsWith("/dist/config.js")) throw new Error("workspace config did not resolve to dist");',
        'if (!import.meta.resolve("@libtmux/workspace/ownership").endsWith("/dist/ownership.js")) throw new Error("workspace ownership did not resolve to dist");',
        'const workspace = parseWorkspace({ session_name: "ltx-install-canary", windows: [{}] });',
        'if (typeof applyWorkspace !== "function" || workspace.session_name !== "ltx-install-canary" || OWNERSHIP_OPTION !== "@libtmux-workspace") {',
        '  throw new Error("workspace exports are unavailable");',
        "}",
        "",
      ].join("\n"),
      bunProbe: [
        'import { applyWorkspace } from "@libtmux/workspace";',
        'import { parseWorkspaceYaml } from "@libtmux/workspace/config";',
        'import { OWNERSHIP_OPTION } from "@libtmux/workspace/ownership";',
        'if (!import.meta.resolve("@libtmux/workspace").endsWith("/src/builder.ts")) throw new Error("workspace did not resolve to source");',
        'if (!import.meta.resolve("@libtmux/workspace/config").endsWith("/src/config.ts")) throw new Error("workspace config did not resolve to source");',
        'if (!import.meta.resolve("@libtmux/workspace/ownership").endsWith("/src/ownership.ts")) throw new Error("workspace ownership did not resolve to source");',
        'const workspace = parseWorkspaceYaml("session_name: ltx-install-canary\\nwindows: [{}]\\n");',
        'if (typeof applyWorkspace !== "function" || workspace.session_name !== "ltx-install-canary" || OWNERSHIP_OPTION !== "@libtmux-workspace") {',
        '  throw new Error("workspace exports are unavailable");',
        "}",
        "",
      ].join("\n"),
    };
  }
  failBeforeProject(`no installed-consumer probe exists for ${name}`);
}

if (packageDirectory === undefined) {
  failBeforeProject("usage: bun scripts/check-consumer-install.ts <package-directory>");
}
const targetRoot = resolve(repositoryRoot, packageDirectory);
const libraryRoot = join(repositoryRoot, "packages", "libtmux");
const targetManifest = JSON.parse(
  await readFile(join(targetRoot, "package.json"), "utf8"),
) as Manifest;
const consumer = consumerFor(targetManifest.name);
const libraryManifest = JSON.parse(
  await readFile(join(libraryRoot, "package.json"), "utf8"),
) as Manifest;
if (targetManifest.version !== libraryManifest.version) {
  failBeforeProject(
    `${targetManifest.name}@${targetManifest.version} does not match libtmux@${libraryManifest.version}`,
  );
}
const declaredLibraryVersion = targetManifest[consumer.dependencyField]?.libtmux;
if (declaredLibraryVersion !== libraryManifest.version) {
  failBeforeProject(
    `${targetManifest.name} must declare exact ${consumer.dependencyField}.libtmux ${libraryManifest.version}; found ${typeof declaredLibraryVersion === "string" ? JSON.stringify(declaredLibraryVersion) : "nothing"}`,
  );
}
const project = await mkdtemp(join(tmpdir(), "ltx-consumer-install-"));

try {
  await run(["bun", "run", "build"], libraryRoot, COMMAND_TIMEOUT_MILLISECONDS);
  const artifacts = join(project, "artifacts");
  const { tarballPath: libraryTarball } = await npmPack(libraryRoot, artifacts);
  const { tarballPath: targetTarball } = await npmPack(targetRoot, artifacts);
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "ltx-consumer-install", private: true, type: "module", version: "0.0.0" })}\n`,
  );
  await run(
    ["npm", "install", "--no-save", libraryTarball, targetTarball],
    project,
    INSTALL_TIMEOUT_MILLISECONDS,
  );
  await writeFile(join(project, "consumer.ts"), consumer.types);
  await writeFile(
    join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: consumer.libs,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2024",
          types: [],
          verbatimModuleSyntax: true,
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await run(
    [resolveBinary("tsc"), "--project", "tsconfig.json"],
    project,
    COMMAND_TIMEOUT_MILLISECONDS,
  );
  await writeFile(join(project, "node.mjs"), consumer.nodeProbe);
  await writeFile(join(project, "bun.mjs"), consumer.bunProbe);
  const node = await resolveNode22();
  await run([node, "node.mjs"], project, RUNTIME_TIMEOUT_MILLISECONDS);
  await run(["bun", "bun.mjs"], project, RUNTIME_TIMEOUT_MILLISECONDS);
  if (targetManifest.name === "@libtmux/mcp") await probeMcpBinary(project, node);
  process.stdout.write(
    `${JSON.stringify({
      installed: `${targetManifest.name}@${targetManifest.version}`,
      protocol: "libtmux-consumer-install-v1",
      status: "passed",
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await rm(project, { force: true, recursive: true });
}
