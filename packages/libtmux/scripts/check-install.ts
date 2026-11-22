import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedCommand } from "../../../scripts/bounded_process/bounded_process.js";
import { npmPack } from "../../../scripts/npm_pack/npm_pack.js";
import { enterSandbox, resolveNode22 } from "../src/_internal/test/testkit.js";

/**
 * Install the tarball into clean consumer projects across npm, pnpm, Yarn, and Bun.
 *
 * `test:package` reads the tarball; this one uses it. Each consumer project is
 * empty apart from the tarball, outside the repository tree, so nothing
 * resolves through workspace `paths` or hoisted `node_modules`.
 *
 * Node 22 exercises emitted JavaScript and native TypeScript type-stripping,
 * TypeScript 5.7 and 7.x compile strict `NodeNext` declarations across flat and
 * symlinked layouts, and Bun exercises the packed TypeScript source condition.
 */

// The probes build a `Server` on a named socket, which lives under whatever
// TMUX_TMPDIR they inherit.
const sandbox = await enterSandbox();

const tsRoot = fileURLToPath(new URL("..", import.meta.url));
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 120_000;
const RUNTIME_TIMEOUT_MILLISECONDS = 30_000;

function fail(message: string): never {
  throw new Error(message);
}

/** The oldest TypeScript a consumer may hold, pinned as a devDependency. */
function floorCompiler(): string {
  const candidate = join(tsRoot, "node_modules", "typescript-floor", "bin", "tsc");
  if (!existsSync(candidate)) fail("typescript-floor is not installed beside the package");
  return candidate;
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

// `ltx` so a sweep can tell this apart from another libtmux port's leavings.
const workspace = await mkdtemp(join(tmpdir(), "ltx-install-"));
const userNpmrc = join(workspace, "user.npmrc");
const globalNpmrc = join(workspace, "global.npmrc");

async function run(
  command: readonly string[],
  cwd: string,
  timeoutMilliseconds: number,
): Promise<{ stderr: string; stdout: string }> {
  // `actions/setup-node` with `registry-url` exports `NPM_CONFIG_USERCONFIG`
  // containing `${NODE_AUTH_TOKEN}`, which is unset under OIDC trusted
  // publishing and aborts Yarn 1 config expansion during local-tarball installs.
  const result = await runBoundedCommand(command, {
    cwd,
    env: {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      COREPACK_ENABLE_STRICT: "0",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
      NPM_CONFIG_USERCONFIG: userNpmrc,
    },
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
const tsc = resolveBinary("tsc");
const floorTsc = floorCompiler();

const declarationsSource = [
  `import { decodeWhereDocument, encodeWhereDocument, OptionScope } from "${manifest.name}";`,
  `import { LibTmuxError, WaitTimeoutError } from "${manifest.name}/errors";`,
  `import { LibTmuxException, WaitTimeout } from "${manifest.name}/exc";`,
  "const canonical: LibTmuxError = new LibTmuxException();",
  "const legacy: WaitTimeout = new WaitTimeoutError();",
  "void [canonical, legacy];",
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
].join("\n");

const tsconfigSource = `${JSON.stringify(
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
    files: ["declarations.ts", "consumer.ts"],
  },
  null,
  2,
)}\n`;

const typescriptConsumerSource = [
  `import { OptionScope, Server, encodeWhereDocument, type SessionWhere, type WhereDocumentV1 } from "${manifest.name}";`,
  `import { Server as ServerFromSubpath } from "${manifest.name}/server";`,
  'const filter: SessionWhere = { name: "work" };',
  'const doc: WhereDocumentV1 = { model: "session", version: 1, where: filter };',
  'const server = new Server({ socketName: "ltx-ts-canary" });',
  'if (Server !== ServerFromSubpath) throw new Error("Server subpath identity mismatch");',
  'if (OptionScope.Window !== "window") throw new Error("OptionScope.Window mismatch");',
  'if (!encodeWhereDocument(doc).includes("work")) throw new Error("encodeWhereDocument failed");',
  'if (typeof server.snapshot !== "function") throw new Error("Server.snapshot missing");',
  "const writer = (globalThis as { process?: { stdout?: { write: (chunk: string) => void } } }).process?.stdout;",
  'if (writer === undefined) throw new Error("stdout unavailable");',
  'writer.write("ok\\n");',
  "",
].join("\n");

const probeSource = [
  `import { decodeWhereDocument as decodeRoot, encodeWhereDocument as encodeRoot } from "${manifest.name}";`,
  `import { Server, TmuxTransportError, PaneDirection, OptionScope, safeInteger } from "${manifest.name}";`,
  `import { LibTmuxError, WaitTimeoutError } from "${manifest.name}/errors";`,
  `import { LibTmuxException, WaitTimeout } from "${manifest.name}/exc";`,
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
  "if (LibTmuxError !== LibTmuxException || WaitTimeoutError !== WaitTimeout) throw new Error('Error aliases have different identities');",
  "if (!(new WaitTimeoutError() instanceof LibTmuxException)) throw new Error('Error ancestry changed across imports');",
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
].join("\n");

interface PackageManagerCase {
  readonly command: (tarball: string, workspace: string) => readonly string[];
  readonly name: "bun" | "npm" | "pnpm" | "yarn";
  readonly verifyLayout?: (project: string) => Promise<void>;
}

const packageManagers: readonly PackageManagerCase[] = [
  {
    command: (tarball) => ["npm", "install", "--no-save", tarball],
    name: "npm",
  },
  {
    command: (tarball, workspace) => [
      "pnpm",
      "add",
      "--store-dir",
      join(workspace, "pnpm-store"),
      tarball,
    ],
    name: "pnpm",
    verifyLayout: async (project) => {
      const resolved = await realpath(join(project, "node_modules", manifest.name));
      if (!resolved.includes(`${sep}.pnpm${sep}`)) {
        fail(`pnpm did not link ${manifest.name} through a .pnpm virtual store: ${resolved}`);
      }
    },
  },
  {
    command: (tarball, workspace) => [
      "yarn",
      "add",
      "--cache-folder",
      join(workspace, "yarn-cache"),
      tarball,
    ],
    name: "yarn",
  },
  {
    command: (tarball) => ["bun", "add", tarball],
    name: "bun",
  },
];

try {
  await Promise.all([writeFile(userNpmrc, ""), writeFile(globalNpmrc, "")]);
  const { tarballPath: tarball } = await npmPack(tsRoot, join(workspace, "artifacts"));

  for (const manager of packageManagers) {
    const project = join(workspace, `consumer-${manager.name}`);
    // eslint-disable-next-line no-await-in-loop -- sequential installs keep diagnostics attributable per manager.
    await mkdir(project, { recursive: true });
    // eslint-disable-next-line no-await-in-loop -- as above.
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify(
        {
          name: `ltx-install-canary-${manager.name}`,
          private: true,
          type: "module",
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
    );
    // eslint-disable-next-line no-await-in-loop -- as above.
    await run(manager.command(tarball, workspace), project, COMMAND_TIMEOUT_MILLISECONDS);
    if (manager.verifyLayout !== undefined) {
      // eslint-disable-next-line no-await-in-loop -- as above.
      await manager.verifyLayout(project);
    }

    // eslint-disable-next-line no-await-in-loop -- as above.
    await Promise.all([
      writeFile(join(project, "declarations.ts"), declarationsSource),
      writeFile(join(project, "consumer.ts"), typescriptConsumerSource),
      writeFile(join(project, "tsconfig.json"), tsconfigSource),
      writeFile(join(project, "probe.mjs"), probeSource),
    ]);

    // eslint-disable-next-line no-await-in-loop -- as above.
    await run([tsc, "--project", "tsconfig.json"], project, COMMAND_TIMEOUT_MILLISECONDS);

    // 5.6 and below ship no `ES2024` lib; compile against the pinned 5.7 floor
    // across every package manager's node_modules layout.
    // eslint-disable-next-line no-await-in-loop -- as above.
    await run(
      [process.execPath, floorTsc, "--project", "tsconfig.json"],
      project,
      COMMAND_TIMEOUT_MILLISECONDS,
    );

    // eslint-disable-next-line no-await-in-loop -- as above.
    const nodeEsm = await run(
      [node, "--enable-source-maps", "probe.mjs"],
      project,
      RUNTIME_TIMEOUT_MILLISECONDS,
    );
    // eslint-disable-next-line no-await-in-loop -- as above.
    const nodeTs = await run(
      [node, "--experimental-strip-types", "--enable-source-maps", "consumer.ts"],
      project,
      RUNTIME_TIMEOUT_MILLISECONDS,
    );
    // eslint-disable-next-line no-await-in-loop -- as above.
    const bunEsm = await run(
      [process.execPath, "probe.mjs"],
      project,
      RUNTIME_TIMEOUT_MILLISECONDS,
    );
    // eslint-disable-next-line no-await-in-loop -- as above.
    const bunTs = await run(
      [process.execPath, "consumer.ts"],
      project,
      RUNTIME_TIMEOUT_MILLISECONDS,
    );

    for (const [label, stdout] of [
      [`${manager.name} / Node 22 ESM`, nodeEsm.stdout],
      [`${manager.name} / Node 22 TypeScript`, nodeTs.stdout],
      [`${manager.name} / Bun ${Bun.version} ESM`, bunEsm.stdout],
      [`${manager.name} / Bun ${Bun.version} TypeScript`, bunTs.stdout],
    ] as const) {
      if (stdout.trim() !== "ok") {
        fail(`${label} answered ${JSON.stringify(stdout.trim())} for the installed package`);
      }
    }
  }

  // A server the probes left behind fails the check, whatever they printed.
  await sandbox.release();
  process.stdout.write(
    `${JSON.stringify({
      bun: Bun.version,
      installed: `${manifest.name}@${manifest.version}`,
      node: node.split("/").at(-1) ?? "node",
      packageManagers: packageManagers.map(({ name }) => name),
      protocol: "libtmux-install-canary-v1",
      status: "passed",
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await rm(workspace, { force: true, recursive: true });
}
