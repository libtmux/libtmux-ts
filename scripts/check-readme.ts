import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Typecheck the TypeScript in the READMEs that span more than one package.
 *
 * `packages/libtmux` gates its own README against its own API. These ones sit
 * above it and reach across packages, so they need the workspace to resolve —
 * and they had gone uncompiled, which is how the workspace example came to call
 * `applyWorkspace` with a server it never created.
 *
 * Blocks are wrapped one function apiece so a `const` in one cannot satisfy the
 * next: each snippet has to stand on its own, the way a reader will paste it.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const readmes = [
  "README.md",
  "examples/README.md",
  "packages/mcp/README.md",
  "packages/workspace/README.md",
];

interface Block {
  readonly code: string;
  readonly origin: string;
}

function fencedBlocks(markdown: string, file: string): readonly Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  let open: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (open === undefined) {
      if (line.trim() === "```ts") open = index;
      continue;
    }
    if (line.trim() !== "```") continue;
    blocks.push({ code: lines.slice(open + 1, index).join("\n"), origin: `${file}:${open + 2}` });
    open = undefined;
  }
  if (open !== undefined) throw new Error(`${file}: unterminated \`\`\`ts block`);
  return blocks;
}

const sources = await Promise.all(
  readmes.map(async (file) => ({
    file,
    markdown: await Bun.file(join(repositoryRoot, file)).text(),
  })),
);
const blocks = sources.flatMap(({ file, markdown }) => fencedBlocks(markdown, file));
if (blocks.length === 0) throw new Error("no ```ts blocks found");

// Imports hoist: a block is wrapped in a function, and an import cannot be.
const imports = new Set<string>();
const bodies: string[] = [];
for (const [index, block] of blocks.entries()) {
  const kept: string[] = [];
  for (const line of block.code.split("\n")) {
    if (line.startsWith("import ")) imports.add(line);
    else kept.push(line);
  }
  bodies.push(
    `// ${block.origin}\nasync function block${index}(): Promise<void> {\n` +
      kept.map((line) => (line === "" ? "" : `  ${line}`)).join("\n") +
      `\n}\nvoid block${index};\n`,
  );
}

const source = [
  'import type { Selection, ServerSnapshot, Session } from "libtmux";',
  // Aliased: a block is free to `import { Server }` as a value, and the two
  // names would otherwise collide in the one file every block is spliced into.
  'import type { Server as ServerHandle } from "libtmux";',
  ...[...imports].sort(),
  "declare const snapshot: ServerSnapshot;",
  "declare const selection: Selection<Session>;",
  // So a recipe can be a literal excerpt of the example that runs it. The
  // example receives its server as a parameter, and a README block that had to
  // construct one could not be drawn from that file line for line.
  "declare const server: ServerHandle;",
  "export {};",
  "",
  ...bodies,
].join("\n");

// Inside the repository, so `types: ["bun", "node"]` resolves from the
// workspace's node_modules the way every other config here does.
const directory = await mkdtemp(join(repositoryRoot, ".readme-check-"));
try {
  const checkPath = join(directory, "check.ts");
  const configPath = join(directory, "tsconfig.json");
  await writeFile(checkPath, source);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        extends: join(repositoryRoot, "packages/libtmux/tsconfig.tooling.json"),
        compilerOptions: {
          noEmit: true,
          // The program spans the workspace: the check file plus the sources
          // its paths resolve to.
          rootDir: repositoryRoot,
          skipLibCheck: true,
          paths: {
            libtmux: [join(repositoryRoot, "packages/libtmux/src/index.ts")],
            "libtmux/*": [join(repositoryRoot, "packages/libtmux/src/*.ts")],
            "@libtmux/mcp": [join(repositoryRoot, "packages/mcp/src/server.ts")],
            "@libtmux/workspace": [join(repositoryRoot, "packages/workspace/src/builder.ts")],
          },
        },
        // The base config includes the library's own sources; this program is
        // only the generated check file.
        include: [],
        exclude: [],
        files: [checkPath],
      },
      null,
      2,
    )}\n`,
  );

  const compiler = join(repositoryRoot, "node_modules/.bin/tsc");
  const result = Bun.spawnSync([compiler, "-p", configPath, "--pretty", "false"], {
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    process.stderr.write("README examples do not typecheck:\n");
    process.stderr.write(result.stdout.toString().replaceAll(directory, "<check>"));
    process.stderr.write(result.stderr.toString());
    process.exit(1);
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}

process.stdout.write(
  `README examples typecheck: ${String(blocks.length)} blocks across ${String(readmes.length)} files\n`,
);
