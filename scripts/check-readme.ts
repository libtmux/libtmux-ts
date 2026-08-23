import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  // Generated, and its examples were compiled by nothing: the package's own
  // gate reads its README, and this one read everything above the package. A
  // reference that teaches a call is as wrong as a README that does.
  "packages/libtmux/docs/criteria.md",
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
const perReadme = sources.map(({ file, markdown }) => ({
  blocks: fencedBlocks(markdown, file),
  file,
}));
const blocks = perReadme.flatMap(({ blocks: found }) => found);
if (blocks.length === 0) throw new Error("no ```ts blocks found");

/**
 * One program per README, compiled where that README lives.
 *
 * Module resolution is the reason. A README documents the package it sits in,
 * so its imports are the ones a reader of that package has — and
 * `@modelcontextprotocol/sdk` is a dependency of `packages/mcp` alone. Compiled
 * from the workspace root, the MCP README could only typecheck on a machine
 * whose node_modules happened to have that package hoisted; on a clean install
 * it did not, which is what took CI red.
 *
 * Compiling each in place also keeps a gate this repository cares about: the
 * library's README cannot import something only a sibling depends on, because
 * from `packages/libtmux` it does not resolve.
 */
function programFor(found: readonly Block[]): string {
  // Imports hoist: a block is wrapped in a function, and an import cannot be.
  // Merged by module rather than deduplicated by line, because two blocks may
  // legitimately name the same symbol alongside different neighbours, and
  // hoisting both lines declares it twice.
  const named = new Map<string, Set<string>>();
  const otherImports = new Set<string>();
  const bodies: string[] = [];
  for (const [index, block] of found.entries()) {
    const kept: string[] = [];
    for (const line of block.code.split("\n")) {
      if (!line.startsWith("import ")) {
        kept.push(line);
        continue;
      }
      const match = /^import\s+\{([^}]*)\}\s+from\s+"([^"]+)";$/u.exec(line.trim());
      if (match?.[1] === undefined || match[2] === undefined) {
        otherImports.add(line);
        continue;
      }
      const module = match[2];
      const symbols = named.get(module) ?? new Set<string>();
      for (const symbol of match[1].split(",")) {
        const trimmed = symbol.trim();
        if (trimmed !== "") symbols.add(trimmed);
      }
      named.set(module, symbols);
    }
    bodies.push(
      `// ${block.origin}\nasync function block${index}(): Promise<void> {\n` +
        kept.map((line) => (line === "" ? "" : `  ${line}`)).join("\n") +
        `\n}\nvoid block${index};\n`,
    );
  }
  const imports = new Set([
    ...otherImports,
    ...[...named]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([module, symbols]) => `import { ${[...symbols].sort().join(", ")} } from "${module}";`),
  ]);

  return [
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
}

const failures: string[] = [];
for (const { blocks: found, file } of perReadme) {
  if (found.length === 0) continue;
  // Beside the README, so a bare specifier resolves through that package's
  // node_modules exactly as it would for someone who installed it.
  const home = join(repositoryRoot, dirname(file));
  // eslint-disable-next-line no-await-in-loop -- one program at a time keeps the report ordered.
  const directory = await mkdtemp(join(home, ".readme-check-"));
  try {
    const checkPath = join(directory, "check.ts");
    const configPath = join(directory, "tsconfig.json");
    // eslint-disable-next-line no-await-in-loop -- as above.
    await writeFile(checkPath, programFor(found));
    // eslint-disable-next-line no-await-in-loop -- as above.
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
      failures.push(
        result.stdout.toString().replaceAll(directory, `<${file}>`) + result.stderr.toString(),
      );
    }
  } finally {
    // eslint-disable-next-line no-await-in-loop -- as above.
    await rm(directory, { force: true, recursive: true });
  }
}

if (failures.length > 0) {
  process.stderr.write("README examples do not typecheck:\n");
  for (const failure of failures) process.stderr.write(failure);
  process.exit(1);
}

process.stdout.write(
  `README examples typecheck: ${String(blocks.length)} blocks across ${String(readmes.length)} files\n`,
);
