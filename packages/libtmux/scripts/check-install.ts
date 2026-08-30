import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "../../../scripts/bounded_process.js";
import { npmPack } from "../../../scripts/npm_pack.js";
import { resolveNode22 } from "../src/_internal/test/testkit.js";

/**
 * Install the tarball into a project that has never seen this repository.
 *
 * `test:package` reads the tarball; this one uses it. The project is empty
 * apart from the tarball, so nothing resolves through the workspace — no
 * `paths`, no hoisted `node_modules`, no repository source tree — and every
 * file named by `exports` has to be packed.
 *
 * Node 22 exercises the emitted JavaScript and Bun exercises the packed
 * TypeScript source selected by its export condition.
 */

const tsRoot = fileURLToPath(new URL("..", import.meta.url));
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 120_000;
const RUNTIME_TIMEOUT_MILLISECONDS = 30_000;

function fail(message: string): never {
  throw new Error(message);
}

function resolveBinary(name: string): string {
  let directory = tsRoot;
  for (;;) {
    const candidate = join(directory, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) fail(`${name} is not installed above the package`);
    directory = parent;
  }
}

async function run(
  command: readonly string[],
  cwd: string,
  timeoutMilliseconds: number,
): Promise<{ stderr: string; stdout: string }> {
  const result = await runBoundedCommand(command, {
    cwd,
    // The package has no runtime dependencies, so this install is offline.
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
  return { stderr: result.stderr, stdout: result.stdout };
}

const manifest = JSON.parse(await readFile(join(tsRoot, "package.json"), "utf8")) as {
  exports: Record<
    string,
    | string
    | {
        bun: string;
        import: string;
      }
  >;
  name: string;
  version: string;
};
const runtimeExports = Object.entries(manifest.exports).flatMap(([subpath, target]) => {
  if (typeof target === "string") return [];
  return [
    {
      bun: target.bun,
      node: target.import,
      specifier: subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
    },
  ];
});
const node = await resolveNode22();

// `ltx` so a sweep can tell this apart from another libtmux port's leavings.
const project = await mkdtemp(join(tmpdir(), "ltx-install-"));
try {
  const { tarballPath: tarball } = await npmPack(tsRoot, join(project, "artifacts"));

  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "ltx-install-canary", private: true, type: "module", version: "0.0.0" }, null, 2)}\n`,
  );
  await run(["npm", "install", "--no-save", tarball], project, COMMAND_TIMEOUT_MILLISECONDS);

  await writeFile(
    join(project, "declarations.ts"),
    [
      `import { decodeWhereDocument, encodeWhereDocument, OptionScope } from "${manifest.name}";`,
      `import type { CommandOptions, JoinOptions, SetOptionOptions, WhereDocumentV1 } from "${manifest.name}";`,
      "declare const command: CommandOptions;",
      "declare const join: JoinOptions;",
      "declare const setOption: SetOptionOptions;",
      'const document: WhereDocumentV1 = { model: "session", version: 1, where: { name: "work" } };',
      "void decodeWhereDocument(JSON.parse(encodeWhereDocument(document)) as unknown);",
      "void command.stdin;",
      "void join.vertical;",
      "void setOption.append;",
      "void OptionScope.Pane;",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: ["ES2024", "ESNext.Disposable"],
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
        files: ["declarations.ts"],
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

  // Resolving proves each runtime selects its intended packed tree; calling
  // proves the modules evaluate rather than merely resolve.
  const probe = join(project, "probe.mjs");
  await writeFile(
    probe,
    [
      `import { decodeWhereDocument as decodeRoot, encodeWhereDocument as encodeRoot } from "${manifest.name}";`,
      `import { Server, TmuxTransportError, PaneDirection, OptionScope, safeInteger } from "${manifest.name}";`,
      `import { Server as ServerFromSubpath } from "${manifest.name}/server";`,
      `import { decodeWhereDocument, encodeWhereDocument, parseLegacyWhere } from "${manifest.name}/selection";`,
      `const bun = typeof Bun !== "undefined";`,
      `const runtimeExports = ${JSON.stringify(runtimeExports)};`,
      `for (const entry of runtimeExports) {`,
      `  const expected = bun ? entry.bun : entry.node;`,
      `  const url = import.meta.resolve(entry.specifier);`,
      `  if (!url.endsWith(expected.slice(1))) throw new Error(entry.specifier + " resolved to " + url);`,
      `  await import(entry.specifier);`,
      `}`,
      "const server = new Server({ socketName: 'ltx-canary' });",
      "if (Server !== ServerFromSubpath) throw new Error('Server exports have different identities');",
      "if (typeof server.snapshot !== 'function') throw new Error('Server.snapshot is missing');",
      "if (typeof server.watch !== 'function') throw new Error('Server.watch is missing');",
      "if (typeof TmuxTransportError !== 'function') throw new Error('TmuxTransportError is missing');",
      "if (typeof parseLegacyWhere !== 'function') throw new Error('parseLegacyWhere is missing');",
      "if (decodeRoot !== decodeWhereDocument) throw new Error('decodeWhereDocument exports differ');",
      "if (encodeRoot !== encodeWhereDocument) throw new Error('encodeWhereDocument exports differ');",
      "if (PaneDirection.Above === undefined) throw new Error('PaneDirection is missing');",
      "if (OptionScope.Pane !== 'pane') throw new Error('OptionScope is missing');",
      "const where = parseLegacyWhere('window', { name__contains: 'logs' });",
      "if (where.model !== 'window') throw new Error('parseLegacyWhere answered the wrong model');",
      "const encoded = encodeWhereDocument({ model: 'pane', version: 1, where: { title: { contains: 'log' } } });",
      "const decoded = decodeWhereDocument(JSON.parse(encoded));",
      "if (decoded.model !== 'pane' || decoded.where.title?.contains !== 'log') throw new Error('WHERE document codecs disagree');",
      "let stack = '';",
      "try { safeInteger(0.5); } catch (error) { stack = String(error instanceof Error ? error.stack : error); }",
      "if (!stack.includes('/src/common.ts')) throw new Error('stack did not map to packed source: ' + stack);",
      "process.stdout.write('ok\\n');",
      "",
    ].join("\n"),
  );
  const nodeResult = await run(
    [node, "--enable-source-maps", probe],
    project,
    RUNTIME_TIMEOUT_MILLISECONDS,
  );
  const bunResult = await run([process.execPath, probe], project, RUNTIME_TIMEOUT_MILLISECONDS);
  for (const [runtime, stdout] of [
    ["Node 22", nodeResult.stdout],
    [`Bun ${Bun.version}`, bunResult.stdout],
  ] as const) {
    if (stdout.trim() !== "ok") {
      fail(`${runtime} answered ${JSON.stringify(stdout.trim())} for the installed package`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      installed: `${manifest.name}@${manifest.version}`,
      bun: Bun.version,
      node: node.split("/").at(-1) ?? "node",
      protocol: "libtmux-install-canary-v1",
      status: "passed",
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await rm(project, { force: true, recursive: true });
}
