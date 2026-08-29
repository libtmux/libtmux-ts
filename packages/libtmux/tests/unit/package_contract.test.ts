import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BunConnectionOptions } from "node:tls";

import { describe, expect, test } from "bun:test";

import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

interface PackageManifest {
  author: string;
  bugs: Record<string, string>;
  dependencies: Record<string, string>;
  description: string;
  keywords: string[];
  license: string;
  repository: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
  exports: Record<string, string | Record<string, string>>;
  files: string[];
  main: string;
  name: string;
  overrides: Record<string, string>;
  packageManager: string;
  private: boolean;
  scripts: Record<string, string>;
  sideEffects: boolean;
  trustedDependencies: string[];
  type: string;
  types: string;
  version: string;
}

interface TypeScriptConfig {
  compilerOptions?: Record<string, unknown>;
  exclude?: string[];
  files?: string[];
  include?: string[];
}

const expectedScripts = {
  build: "bun run generate:check && rm -rf dist && tsc -p tsconfig.build.json",
  format: "oxfmt --write .",
  "format:check": "oxfmt --check .",
  generate: "bun scripts/generate-formats.ts --write",
  "docs:api": "bun scripts/generate-api-docs.ts",
  "docs:api:check": "bun scripts/generate-api-docs.ts --check",
  "docs:criteria": "bun scripts/generate-field-docs.ts",
  "docs:criteria:check": "bun scripts/generate-field-docs.ts --check",
  "generate:check": "bun scripts/generate-formats.ts --check",
  lint: "oxlint . --ignore-pattern tests/fixtures/type-aware-lint/** --deny-warnings --report-unused-disable-directives && bun scripts/check-type-aware-lint.ts",
  "lint:unused": "knip",
  parity: "bun scripts/check-parity.ts",
  "test:differential": "bun scripts/run-differential-tests.ts",
  "test:integration": "bun scripts/run-integration-tests.ts",
  "test:node": "bun run build && bun scripts/test-node.ts --expect-major 22",
  "test:compat": "bun scripts/check-tmux-compat.ts",
  "test:coverage": "bun run build && bun scripts/check-coverage.ts",
  "test:package":
    "bun run build && bun ../../scripts/check-source-maps.ts && bun scripts/check-package.ts && bun ../../scripts/check-package-analysis.ts",
  "test:readme": "bun scripts/doc-examples/check-readme-runs.ts",
  "test:symbols": "bun scripts/doc-examples/check-symbol-runs.ts",
  "test:install": "bun run build && bun scripts/check-install.ts",
  "test:type-performance": "bun scripts/check-type-performance.ts --check",
  "test:types": "tsc -p tests/types/tsconfig.json --noEmit && bun run test:type-performance",
  typecheck: "tsc -p tsconfig.json --noEmit",
  "typecheck:ambient-free": "bun run build && tsc -p tests/fixtures/ambient-free/tsconfig.json",
  "typecheck:readme": "bun scripts/doc-examples/check-readme-examples.ts",
  "typecheck:symbols": "bun scripts/doc-examples/check-symbol-examples.ts",
  "typecheck:tooling": "tsc -p tsconfig.tooling.json --noEmit",
  "test:unit": "bun run build && bun scripts/run-unit-tests.ts",
};

// Zero runtime dependencies is a property worth gating, not a coincidence:
// a consumer installs a tmux client and gets exactly that, with nothing
// third-party to audit, pin, or deduplicate. src/_internal/validate.ts covers
// what Zod covered.
const expectedDependencies = {};

const expectedDevDependencies = {
  "@types/bun": "1.4.0",
  // Held at the floor deliberately: `engines.node` is ">=22", and types
  // describing a newer Node would compile calls the floor cannot run. The root
  // `overrides` pins it for the whole workspace, so a manifest naming anything
  // else would name a version that does not install.
  "@types/node": "22.20.1",
  knip: "6.32.2",
  oxfmt: "0.64.0",
  oxlint: "1.79.0",
  "oxlint-tsgolint": "7.0.2001",
  typescript: "7.0.2",
  zod: "4.4.3",
};

const tsRoot = new URL("../..", import.meta.url);
const tsRootPath = fileURLToPath(tsRoot);
const bunTlsCompatibility: BunConnectionOptions = { key: [{ pem: "test key" }] };
void bunTlsCompatibility;

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relativePath, tsRoot), "utf8")) as T;
}

async function runBoundedCommand(command: readonly string[], cwd: string) {
  const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdout: "pipe" });
  let deadlineReached = false;
  const terminate = setTimeout(() => {
    deadlineReached = true;
    child.kill("SIGTERM");
  }, 10_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 10_500);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (deadlineReached) throw new Error(`subprocess exceeded deadline: ${command.join(" ")}`);
    return { exitCode, stderr, stdout };
  } finally {
    clearTimeout(terminate);
    clearTimeout(kill);
  }
}

describe("package contract", () => {
  test("publishes only ESM root and package metadata entrypoints", async () => {
    const packageManifest = await readJson<PackageManifest>("package.json");

    // The root entrypoint is the surface a consumer actually imports.
    expect(Object.keys(await import("../../src/index.js")).toSorted()).toEqual([
      "Client",
      "LibTmuxException",
      "MultipleMatchesError",
      "MultipleObjectsReturned",
      "NoMatchError",
      "ObjectDoesNotExist",
      "OptionScope",
      "Pane",
      "PaneDirection",
      "QueryValidationError",
      "ResizeAdjustmentDirection",
      "Server",
      "Session",
      "TmuxCommandError",
      "TmuxServerRestarted",
      "TmuxTransportError",
      "VersionTooLow",
      "WaitTimeout",
      "Window",
      "WindowDirection",
      "isSafeInteger",
      "isSplitSize",
      "parseLegacyWhere",
      "safeInteger",
      "splitSize",
    ]);
    expect(packageManifest.name).toBe("libtmux");
    // A prerelease while the API is still moving. The exact number is not
    // pinned: it changes every release, and a gate that has to be edited to
    // release is a gate people learn to edit.
    expect(packageManifest.version).toMatch(/^\d+\.\d+\.\d+-alpha\.\d+$/u);
    // Every package in the workspace ships together under one version, so a
    // tag names a state of the whole repository rather than of one package.
    const siblings = await Promise.all(
      ["mcp", "workspace"].map(async (sibling) =>
        JSON.parse(
          await readFile(new URL(`../../../${sibling}/package.json`, import.meta.url), "utf8"),
        ),
      ),
    );
    for (const sibling of siblings as Array<{ version: string }>) {
      expect(sibling.version).toBe(packageManifest.version);
    }
    // Published: `files` and `exports` below are what a consumer receives.
    expect(packageManifest.private).toBeUndefined();
    expect(packageManifest.license).toBe("MIT");
    expect(packageManifest.description).toContain("tmux");
    expect(packageManifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/libtmux/libtmux-ts.git",
      directory: "packages/libtmux",
    });
    expect(packageManifest.bugs).toEqual({
      url: "https://github.com/libtmux/libtmux-ts/issues",
    });
    expect(packageManifest.author).toBe("Tony Narlock <tony@git-pull.com>");
    expect(packageManifest.keywords).toContain("tmux");
    expect(packageManifest.type).toBe("module");
    expect(packageManifest.main).toBe("./dist/index.js");
    expect(packageManifest.types).toBe("./dist/index.d.ts");
    expect(packageManifest.files).toEqual([
      "CHANGELOG.md",
      "dist",
      "!dist/_internal/test",
      "src",
      "!src/_internal/test",
    ]);
    expect(packageManifest.sideEffects).toBe(false);
    expect(packageManifest.trustedDependencies).toEqual([]);
    expect(Object.keys(packageManifest.exports)).toEqual([
      ".",
      "./package.json",
      "./common",
      "./exc",
      "./constants",
      "./formats",
      "./types",
      "./field-types",
      "./server",
      "./session",
      "./window",
      "./pane",
      "./client",
      "./selection",
      "./engine",
    ]);
    expect(packageManifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    });
    expect(Object.keys(packageManifest.exports["."]!)).toEqual(["types", "import", "default"]);
    expect(packageManifest.exports["./package.json"]).toBe("./package.json");
    expect(packageManifest.exports["./common"]).toEqual({
      types: "./dist/common.d.ts",
      import: "./dist/common.js",
      default: "./dist/common.js",
    });
    expect(packageManifest.exports["./exc"]).toEqual({
      types: "./dist/exc.d.ts",
      import: "./dist/exc.js",
      default: "./dist/exc.js",
    });
    expect(packageManifest.exports["./constants"]).toEqual({
      types: "./dist/constants.d.ts",
      import: "./dist/constants.js",
      default: "./dist/constants.js",
    });
    expect(packageManifest.exports["./formats"]).toEqual({
      types: "./dist/formats.d.ts",
      import: "./dist/formats.js",
      default: "./dist/formats.js",
    });
    expect(packageManifest.exports["./types"]).toEqual({
      types: "./dist/types.d.ts",
      import: "./dist/types.js",
      default: "./dist/types.js",
    });
    expect(packageManifest.exports["./field-types"]).toEqual({
      types: "./dist/field_types.d.ts",
      import: "./dist/field_types.js",
      default: "./dist/field_types.js",
    });
    for (const model of ["server", "session", "window", "pane", "client", "selection"]) {
      expect(packageManifest.exports[`./${model}`]).toEqual({
        types: `./dist/${model}.d.ts`,
        import: `./dist/${model}.js`,
        default: `./dist/${model}.js`,
      });
    }

    const serializedExports = JSON.stringify(packageManifest.exports);
    expect(serializedExports).not.toContain("require");
    expect(serializedExports).not.toContain("bun");
    expect(serializedExports).not.toContain("src/");
    expect(Object.keys(packageManifest.exports)).not.toContain("./*");
    expect(Object.keys(packageManifest.exports)).not.toContain("./dist/*");
  });

  test("pins the complete dependency boundary to the accepted runtime floors", async () => {
    const packageManifest = await readJson<PackageManifest>("package.json");

    const runtimeManifests = await Promise.all(
      [
        "../../package.json",
        "package.json",
        "../mcp/package.json",
        "../workspace/package.json",
      ].map((path) => readJson<{ engines: Record<string, string> }>(path)),
    );
    for (const manifest of runtimeManifests) {
      expect(manifest.engines).toEqual({ node: ">=22", bun: ">=1.3.14" });
    }
    // Absent, not empty: an empty `dependencies` object is noise in a manifest.
    expect(packageManifest.dependencies ?? {}).toEqual(expectedDependencies);
    expect(packageManifest.devDependencies).toEqual(expectedDevDependencies);

    const lockfile = await readFile(new URL("../../bun.lock", tsRoot), "utf8");
    expect(lockfile).not.toContain('"bun-types/@types/node"');
  });

  test("turns off only the lint rule that is broken for this package's idiom", async () => {
    const config = JSON.parse(
      await readFile(new URL("../../../../.oxlintrc.json", import.meta.url), "utf8"),
    ) as { rules?: Record<string, string> };

    // typescript/await-thenable reports every `await using`, whatever the type
    // implements — a plain class with a real Symbol.asyncDispose no less than
    // an interface — so it is noise against this package's central idiom.
    // TypeScript rejects a genuinely non-disposable `await using` on its own,
    // and promise/no-floating-promises still catches an unawaited promise.
    //
    // A second entry here needs its own reason.
    expect(config.rules).toEqual({ "typescript/await-thenable": "off" });
  });

  test("exposes exactly the scripts the gates run, and no others", async () => {
    const packageManifest = await readJson<PackageManifest>("package.json");

    expect(packageManifest.scripts).toEqual(expectedScripts);
  });

  test("isolates Node source types from Bun tooling types and invalid fixtures", async () => {
    const source = await readJson<TypeScriptConfig>("tsconfig.json");
    const build = await readJson<TypeScriptConfig>("tsconfig.build.json");
    const tooling = await readJson<TypeScriptConfig>("tsconfig.tooling.json");
    const lintFixture = await readJson<TypeScriptConfig>(
      "tests/fixtures/type-aware-lint/tsconfig.json",
    );

    expect(source.include).toEqual(["src/**/*.ts"]);
    expect(source.compilerOptions).toMatchObject({
      declaration: true,
      erasableSyntaxOnly: true,
      exactOptionalPropertyTypes: true,
      isolatedDeclarations: true,
      isolatedModules: true,
      lib: ["ES2024", "ESNext.Disposable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noUncheckedIndexedAccess: true,
      rootDir: "src",
      strict: true,
      target: "ES2024",
      types: ["node"],
      verbatimModuleSyntax: true,
    });
    expect(source.compilerOptions?.skipLibCheck).not.toBe(true);
    expect(build.compilerOptions).toMatchObject({
      declaration: true,
      declarationMap: true,
      inlineSources: true,
      noEmit: false,
      outDir: "dist",
      sourceMap: true,
    });
    expect(build.compilerOptions).not.toHaveProperty("sourceRoot");
    expect(tooling.compilerOptions?.types).toEqual(["bun", "node"]);
    expect(tooling.compilerOptions).not.toHaveProperty("paths");
    expect(tooling.files).toBeUndefined();
    expect(tooling.include).toEqual([
      "scripts/**/*.ts",
      "tests/differential/**/*.ts",
      "tests/integration/**/*.ts",
      "tests/unit/**/*.ts",
      "tests/fixtures/**/*.ts",
      "tests/support/**/*.ts",
    ]);
    expect(tooling.exclude).toContain("tests/types/**");
    expect(tooling.exclude).toContain("tests/fixtures/negative-declarations/**");
    expect(tooling.exclude).toContain("tests/fixtures/type-aware-lint/no_floating_promise.ts");
    expect(lintFixture.files).toEqual(["../../support/bun-tooling.d.ts"]);
  });

  test("proves the exact type-aware no-floating-promises diagnostic", async () => {
    const process = Bun.spawn(["bun", "scripts/check-type-aware-lint.ts"], {
      cwd: tsRootPath,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(
      "Type-aware lint fixture produced typescript/no-floating-promises with nonzero status",
    );

    const harness = await readFile(new URL("scripts/check-type-aware-lint.ts", tsRoot), "utf8");
    expect(harness).toContain('"../node_modules/.bin/tsc"');
    expect(harness).toContain("output.diagnostics.length !== 1");
    expect(harness).toContain('entry.severity !== "error"');
    expect(harness).toContain("fileURLToPath");
    expect(tsRootPath).not.toContain("%20");
  });

  test("emits self-contained public declarations", async () => {
    const temporary = await makeTestDirectory("ltx5-declarations-");
    const outputDirectory = join(temporary, "types");
    const configPath = join(temporary, "tsconfig.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          extends: join(tsRootPath, "tsconfig.build.json"),
          compilerOptions: {
            emitDeclarationOnly: true,
            inlineSources: false,
            outDir: outputDirectory,
            sourceMap: false,
            typeRoots: [join(tsRootPath, "node_modules/@types")],
          },
        },
        null,
        2,
      )}\n`,
    );
    try {
      const { exitCode, stderr, stdout } = await runBoundedCommand(
        [join(tsRootPath, "node_modules/.bin/tsc"), "-p", configPath],
        tsRootPath,
      );
      expect(exitCode, `${stdout}${stderr}`).toBe(0);

      const declarations = await Promise.all([
        readFile(join(outputDirectory, "index.d.ts"), "utf8"),
        readFile(join(outputDirectory, "formats.d.ts"), "utf8"),
      ]);
      // The root entrypoint carries the public surface, so it has to name the
      // classes rather than be empty.
      for (const symbol of ["Server", "Session", "Window", "Pane", "Client", "Selection"]) {
        expect(declarations[0]).toContain(symbol);
      }
      // No public declaration may name an internal module or the runtime
      // plumbing behind it.
      const forbiddenEverywhere = [
        "_generated",
        "_internal",
        "Bun",
        "CommandTransport",
        "FormatProtocolError",
        "GuardCodec",
        "GuardFactory",
        "TmuxCapabilities",
        "Zod",
        "transport",
        "zod",
      ];
      for (const declaration of declarations) {
        for (const forbidden of forbiddenEverywhere) {
          expect(declaration).not.toContain(forbidden);
        }
      }
      // The format entrypoint additionally must not drag the model classes in;
      // the root entrypoint is where those legitimately live.
      expect(declarations[1]).not.toContain("Server");

      await writeFile(
        join(temporary, "package.json"),
        `${JSON.stringify(
          {
            exports: {
              ".": { types: "./types/index.d.ts" },
              "./engine": { types: "./types/engine.d.ts" },
              "./field-types": { types: "./types/field_types.d.ts" },
              "./formats": { types: "./types/formats.d.ts" },
              "./server": { types: "./types/server.d.ts" },
              "./types": { types: "./types/types.d.ts" },
            },
            name: "libtmux",
            type: "module",
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(temporary, "consumer.ts"),
        `import {
  CLIENT_FORMATS,
  FORMAT_SEPARATOR,
  PANE_FORMATS,
  SESSION_FORMATS,
  WINDOW_FORMATS,
} from "libtmux/formats";
import {
  Client,
  LibTmuxException,
  NoMatchError,
  Pane,
  Server,
  Session,
  Window,
  type CaptureOptions,
  type DaemonIdentity,
  type NewSessionOptions,
  type PaneId,
  type PaneIdInput,
  type Selection,
  type ServerSnapshot,
  type SessionId,
  type SessionIdInput,
  type SessionWhere,
  type WindowId,
  type WindowIdInput,
} from "libtmux";
import {
  MAX_PACKED_ARGV_BYTES,
  type TmuxCommandRequest,
  type TmuxEngine,
} from "libtmux/engine";
import type { DecodedFormatValue, RowWithIdentities } from "libtmux/field-types";
import { Server as ServerFromSubpath, type DaemonIdentity as ServerDaemonIdentity } from "libtmux/server";
import type { AbortLike } from "libtmux/types";

// The root entrypoint must be usable exactly as a published consumer sees it.
declare const rootServer: Server;
declare const rootSnapshot: ServerSnapshot;
declare const rootSessions: Selection<Session>;
declare const rootWindow: Window;
declare const rootPane: Pane;
declare const rootClient: Client;
declare const rootCriteria: SessionWhere;
declare const rootCapture: CaptureOptions;
declare const rootNewSession: NewSessionOptions;
declare const daemonIdentity: DaemonIdentity;
declare const engine: TmuxEngine;
declare const request: TmuxCommandRequest;
declare const abortLike: AbortLike;
declare const paneIdentityRow: RowWithIdentities<"pane_id">;
declare const decodedPaneId: DecodedFormatValue<"pane_id">;
const exactPackedArgvLimit: 16384 = MAX_PACKED_ARGV_BYTES;
const daemonIdentityFromServer: ServerDaemonIdentity = daemonIdentity;
const paneIdFromRequiredRow: PaneId = paneIdentityRow.pane_id;
const paneIdFromDecoder: PaneId = decodedPaneId;
const sessionId: SessionId = rootSnapshot.sessions.one().id;
const windowId: WindowId = rootWindow.id;
const paneId: PaneId = rootPane.id;
const rawSessionId: SessionIdInput = "$1";
const rawWindowId: WindowIdInput = "@1";
const rawPaneId: PaneIdInput = "%1";
// @ts-expect-error A pane ID already read from the package is not session input.
const wrongSessionId: SessionIdInput = rootPane.id;
void [
  rootServer.snapshot,
  rootSnapshot.sessions,
  rootSessions.where(rootCriteria),
  rootWindow.panes,
  rootPane.capture(rootCapture),
  rootClient.session,
  rootServer.newSession(rootNewSession),
  engine.execute(request),
  abortLike.aborted,
  exactPackedArgvLimit,
  daemonIdentityFromServer,
  paneIdFromRequiredRow,
  paneIdFromDecoder,
  sessionId,
  windowId,
  paneId,
  rawSessionId,
  rawWindowId,
  rawPaneId,
  wrongSessionId,
  LibTmuxException,
  NoMatchError,
  ServerFromSubpath,
];

void [CLIENT_FORMATS, FORMAT_SEPARATOR, PANE_FORMATS, SESSION_FORMATS, WINDOW_FORMATS];

// @ts-expect-error The format vocabulary is internal; there is no neo subpath.
void import("libtmux/neo");
// @ts-expect-error Internal package paths are not exported.
void import("libtmux/_internal/codec/guard_codec.js");
`,
      );
      const consumerConfigPath = join(temporary, "consumer-tsconfig.json");
      await writeFile(
        consumerConfigPath,
        `${JSON.stringify(
          {
            compilerOptions: {
              // Server.watch returns an async disposable, so a consumer needs
              // the lib that declares Symbol.asyncDispose. Requiring it is the
              // cost of shipping `await using`; the README states it.
              lib: ["ES2024", "ESNext.Disposable"],
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
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
      const consumer = await runBoundedCommand(
        [join(tsRootPath, "node_modules/.bin/tsc"), "-p", consumerConfigPath],
        temporary,
      );
      expect(consumer.exitCode, `${consumer.stdout}${consumer.stderr}`).toBe(0);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }, 25_000);
});
