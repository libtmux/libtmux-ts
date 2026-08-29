import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNode22 } from "../packages/libtmux/src/_internal/test/node22.js";

interface Manifest {
  readonly name: string;
  readonly version: string;
}

interface Consumer {
  readonly bunProbe: string;
  readonly libs: readonly string[];
  readonly nodeProbe: string;
  readonly types: string;
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageDirectory = process.argv[2];

function fail(message: string): never {
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

async function run(command: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) fail(`${command.join(" ")} exited ${String(exitCode)}\n${stdout}${stderr}`);
  return stdout;
}

function consumerFor(name: string): Consumer {
  if (name === "@libtmux/mcp") {
    return {
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
        "  taskWaitMaxMs: 3_600_000,",
        "  tools: undefined,",
        "};",
        'createTmuxMcpServer(new Server({ socketName: "ltx-install-canary" }), { policy });',
        "",
      ].join("\n"),
      nodeProbe: [
        'import { createTmuxMcpServer } from "@libtmux/mcp";',
        'import { Server } from "libtmux";',
        'const server = createTmuxMcpServer(new Server({ socketName: "ltx-install-canary" }));',
        'if (server === undefined) throw new Error("MCP factory returned undefined");',
        "",
      ].join("\n"),
      bunProbe: [
        'import { createTmuxMcpServer } from "@libtmux/mcp";',
        'import { Server } from "libtmux";',
        'const server = createTmuxMcpServer(new Server({ socketName: "ltx-install-canary" }));',
        'if (server === undefined) throw new Error("MCP factory returned undefined");',
        "",
      ].join("\n"),
    };
  }
  if (name === "@libtmux/workspace") {
    return {
      libs: ["ES2024", "ESNext.Disposable"],
      types: [
        'import { applyWorkspace } from "@libtmux/workspace";',
        'import { parseWorkspace, parseWorkspaceYaml } from "@libtmux/workspace/config";',
        "void applyWorkspace;",
        "void parseWorkspace;",
        "void parseWorkspaceYaml;",
        "",
      ].join("\n"),
      nodeProbe: [
        'import { applyWorkspace } from "@libtmux/workspace";',
        'import { parseWorkspace } from "@libtmux/workspace/config";',
        'const workspace = parseWorkspace({ session_name: "ltx-install-canary", windows: [{}] });',
        'if (typeof applyWorkspace !== "function" || workspace.session_name !== "ltx-install-canary") {',
        '  throw new Error("workspace exports are unavailable");',
        "}",
        "",
      ].join("\n"),
      bunProbe: [
        'import { parseWorkspaceYaml } from "@libtmux/workspace/config";',
        'const workspace = parseWorkspaceYaml("session_name: ltx-install-canary\\nwindows: [{}]\\n");',
        'if (workspace.session_name !== "ltx-install-canary") {',
        '  throw new Error("YAML parser is unavailable");',
        "}",
        "",
      ].join("\n"),
    };
  }
  fail(`no installed-consumer probe exists for ${name}`);
}

if (packageDirectory === undefined) {
  fail("usage: bun scripts/check-consumer-install.ts <package-directory>");
}
const targetRoot = resolve(repositoryRoot, packageDirectory);
const libraryRoot = join(repositoryRoot, "packages", "libtmux");
const targetManifest = JSON.parse(
  await readFile(join(targetRoot, "package.json"), "utf8"),
) as Manifest;
const libraryManifest = JSON.parse(
  await readFile(join(libraryRoot, "package.json"), "utf8"),
) as Manifest;
const consumer = consumerFor(targetManifest.name);
const targetTarball = join(
  targetRoot,
  `${targetManifest.name.replace("@", "").replace("/", "-")}-${targetManifest.version}.tgz`,
);
const libraryTarball = join(libraryRoot, `${libraryManifest.name}-${libraryManifest.version}.tgz`);
const project = await mkdtemp(join(tmpdir(), "ltx-consumer-install-"));

try {
  await run(["bun", "run", "build"], libraryRoot);
  await run(["bun", "pm", "pack"], libraryRoot);
  await run(["bun", "pm", "pack"], targetRoot);
  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "ltx-consumer-install", private: true, type: "module", version: "0.0.0" })}\n`,
  );
  await run(["npm", "install", "--no-save", libraryTarball, targetTarball], project);
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
  await run([resolveBinary("tsc"), "--project", "tsconfig.json"], project);
  await writeFile(join(project, "node.mjs"), consumer.nodeProbe);
  await writeFile(join(project, "bun.mjs"), consumer.bunProbe);
  await run([await resolveNode22(), "node.mjs"], project);
  await run(["bun", "bun.mjs"], project);
  process.stdout.write(
    `${JSON.stringify({
      installed: `${targetManifest.name}@${targetManifest.version}`,
      protocol: "libtmux-consumer-install-v1",
      status: "passed",
    })}\n`,
  );
} finally {
  await Promise.all([
    rm(project, { force: true, recursive: true }),
    rm(libraryTarball, { force: true }),
    rm(targetTarball, { force: true }),
  ]);
}
