import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  backupOnce,
  backupPath,
  blankJsonc,
  buildSpec,
  classifySpec,
  fromEntry,
  knownClis,
  nativeStatePath,
  parseJsonc,
  parseServerTables,
  PUBLISHED_PACKAGE,
  preflight,
  readServer,
  removeServerTable,
  renderServerTable,
  revertConfig,
  revertConfigs,
  selectClis,
  scopedCli,
  spliceEntry,
  toEntry,
  useNativeConfigs,
  writeServer,
  writeServers,
  xdgConfigHome,
  type CliInfo,
  type SwapTransactionHooks,
} from "../../../../scripts/mcp_swap.js";

import { makeTestDirectory } from "../../src/_internal/test/testkit.js";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const CLI_NAMES = ["claude", "codex", "cursor", "gemini", "grok", "agy", "opencode", "pi"];

function* permutations(values: readonly string[]): Generator<readonly string[]> {
  if (values.length === 0) {
    yield [];
    return;
  }
  for (const [index, value] of values.entries()) {
    for (const suffix of permutations(values.filter((_, candidate) => candidate !== index))) {
      yield [value, ...suffix];
    }
  }
}

/**
 * The config surgery behind `mcp_swap`.
 *
 * What makes this worth testing is that it edits files a person owns and did
 * not write for it: their comments, their spacing, their other servers. Getting
 * the entry right and the rest wrong is still a bad outcome, so most of what is
 * asserted here is about what did *not* change.
 */

let home: string;
let previousXdgStateHome: string | undefined;

beforeEach(async () => {
  home = await makeTestDirectory("ltx-swap-");
  previousXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
});

afterEach(async () => {
  if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousXdgStateHome;
  await rm(home, { force: true, recursive: true });
});

function cliFor(name: string): CliInfo {
  const info = knownClis({ XDG_CONFIG_HOME: join(home, ".config") }, home).find(
    (candidate) => candidate.name === name,
  );
  if (info === undefined) throw new Error(`no cli named ${name}`);
  return info;
}

function originalConfig(info: CliInfo): string {
  if (info.format === "toml") {
    return `model = "keep-${info.name}"\n\n[${info.container[0]}.keep]\ncommand = "other"\n`;
  }
  const comment = info.format === "jsonc" ? `  // keep-${info.name}\n` : "";
  return `{\n${comment}  "${info.container[0]}": {\n    "keep": { "command": "other" }\n  }\n}\n`;
}

async function seedAllClients(): Promise<readonly CliInfo[]> {
  const infos = knownClis({ XDG_CONFIG_HOME: join(home, ".config") }, home);
  await Promise.all(
    infos.map(async (info, index) => {
      await seed(info, originalConfig(info));
      await chmod(info.configPath, index % 2 === 0 ? 0o600 : 0o640);
    }),
  );
  return infos;
}

function backupRoutePath(configPath: string): string {
  return `${backupPath(configPath)}.route.json`;
}

function swapLockPath(): string {
  return join(home, ".local", "state", "libtmux-mcp-dev", "swap", "state.lock");
}

function firstNativeBackupPath(info: CliInfo, sequence: number): string {
  return `${info.configPath}.bak.mcp-swap-typescript-${String(sequence).padStart(20, "0")}`;
}

async function seed(info: CliInfo, contents: string): Promise<void> {
  await mkdir(join(info.configPath, ".."), { recursive: true });
  await writeFile(info.configPath, contents);
}

async function pathIdentity(path: string): Promise<string> {
  const metadata = await lstat(path, { bigint: true });
  return [metadata.dev, metadata.ino, metadata.birthtimeNs].map(String).join(":");
}

async function fileState(path: string): Promise<{ identity: string; mode: number; raw: string }> {
  return {
    identity: await pathIdentity(path),
    mode: (await stat(path)).mode & 0o777,
    raw: await readFile(path, "utf8"),
  };
}

function canonicalTestJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`)
    .join(",")}}`;
}

async function nativeRecoveryEntry(key: string): Promise<Record<string, unknown>> {
  const envelope = JSON.parse(await readFile(nativeStatePath(), "utf8")) as {
    payload: { entries: Record<string, Record<string, unknown>> };
  };
  const entry = envelope.payload.entries[key];
  if (entry === undefined) throw new Error(`missing native recovery entry ${key}`);
  return entry;
}

async function identitySurvives(identity: string): Promise<boolean> {
  for (const entry of await readdir(home, { recursive: true })) {
    try {
      // eslint-disable-next-line no-await-in-loop -- every retained path is checked by inode.
      if ((await pathIdentity(join(home, entry))) === identity) return true;
    } catch {
      // Directories and paths removed by rollback are not retained file candidates.
    }
  }
  return false;
}

async function seedSymlink(
  info: CliInfo,
  contents: string,
  mode: number,
): Promise<{ linkTarget: string; target: string }> {
  const target = join(home, "dotfiles", `${info.name}.${info.format === "toml" ? "toml" : "json"}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  await chmod(target, mode);
  await mkdir(dirname(info.configPath), { recursive: true });
  const linkTarget = relative(dirname(info.configPath), target);
  await symlink(linkTarget, info.configPath);
  return { linkTarget, target };
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- poll until the transaction reaches this boundary.
    if (await Bun.file(path).exists()) return;
    // eslint-disable-next-line no-await-in-loop -- polling must yield between observations.
    await Bun.sleep(1);
  }
  throw new Error(`path did not appear: ${path}`);
}

async function waitForFileChange(path: string, original: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- poll until the first write commits.
      if ((await readFile(path, "utf8")) !== original) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- polling must yield between observations.
    await Bun.sleep(1);
  }
  throw new Error(`file did not change: ${path}`);
}

async function expectRecordedProcessGone(path: string): Promise<void> {
  const pid = Number(await readFile(path, "utf8"));
  let alive = true;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        alive = false;
        break;
      }
      throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- process-group teardown is asynchronous.
    await Bun.sleep(2);
  }
  expect(alive).toBe(false);
}

async function runSwap(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ status: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(
    [process.execPath, join(repositoryRoot, "scripts", "mcp_swap.ts"), ...args],
    {
      env: {
        ...process.env,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        ...environment,
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [status, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { status, stderr, stdout };
}

async function tryPythonRecordLock(path: string): Promise<string> {
  const python = Bun.which("python3");
  if (python === null) throw new Error("python3 is required for the record-lock interop test");
  const source = `
import fcntl
import sys

with open(sys.argv[1], "r+b", buffering=0) as lock:
    try:
        fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("blocked")
    else:
        print("acquired")
        fcntl.lockf(lock, fcntl.LOCK_UN)
`;
  const child = Bun.spawn([python, "-c", source, path], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [status, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (status !== 0) throw new Error(`python lock probe failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function waitForPythonRecordLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- wait for the kernel to drop a dead owner's lock.
    if ((await tryPythonRecordLock(path)) === "acquired") return;
    // eslint-disable-next-line no-await-in-loop -- polling must yield between lock probes.
    await Bun.sleep(2);
  }
  throw new Error("record lock remained owned after its process exited");
}

type SwapOperation = "repeat-use" | "revert" | "use";
type ReplacementSide = "destination" | "source";

const TRANSITION_BOUNDARIES = [
  ["use", "backup-publish"],
  ["use", "state-publish"],
  ["use", "config-take-aside"],
  ["use", "config-publish"],
  ["use", "stage-cleanup"],
  ["repeat-use", "state-take-aside"],
  ["repeat-use", "state-publish"],
  ["repeat-use", "config-take-aside"],
  ["repeat-use", "config-publish"],
  ["repeat-use", "stage-cleanup"],
  ["revert", "config-take-aside"],
  ["revert", "config-publish"],
  ["revert", "state-take-aside"],
  ["revert", "backup-take-aside"],
  ["revert", "stage-cleanup"],
] as const;

const PRIVATE_CLEANUP_BOUNDARIES = [
  ["use", "config-cleanup"],
  ["repeat-use", "config-cleanup"],
  ["repeat-use", "state-cleanup"],
  ["revert", "config-cleanup"],
  ["revert", "state-cleanup"],
  ["revert", "backup-cleanup"],
] as const;

const ROLLBACK_BOUNDARIES = [
  ["use", "config-rollback-take-aside"],
  ["use", "config-rollback-publish"],
  ["use", "state-rollback-take-aside"],
  ["use", "backup-rollback-take-aside"],
  ["repeat-use", "state-rollback-take-aside"],
  ["repeat-use", "state-rollback-publish"],
  ["revert", "config-rollback-take-aside"],
  ["revert", "config-rollback-publish"],
  ["revert", "state-rollback-publish"],
  ["revert", "backup-rollback-publish"],
] as const;

const FORWARD_BOUNDARIES: readonly (readonly [ReplacementSide, SwapOperation, string])[] = [
  ...TRANSITION_BOUNDARIES.flatMap(([operation, boundary]) =>
    (["source", "destination"] as const).map((side) => [side, operation, boundary] as const),
  ),
  ...PRIVATE_CLEANUP_BOUNDARIES.map(
    ([operation, boundary]) => ["source", operation, boundary] as const,
  ),
];

async function prepareSwap(operation: SwapOperation, infos: readonly CliInfo[]): Promise<void> {
  await Promise.all(
    infos.map(async (info) => {
      await seed(info, originalConfig(info));
      await chmod(info.configPath, 0o600);
    }),
  );
  if (operation !== "use") {
    await writeServers(infos, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
  }
}

function runTransaction(
  operation: SwapOperation,
  infos: readonly CliInfo[],
  hooks: SwapTransactionHooks,
): Promise<unknown> {
  return operation === "revert"
    ? revertConfigs(infos, hooks)
    : writeServers(
        infos,
        "libtmux",
        buildSpec({ kind: "dev", repo: operation === "use" ? "/one" : "/two" }),
        hooks,
      );
}

function replacementProbe(
  operation: SwapOperation,
  boundary: string,
  side: ReplacementSide,
): {
  readonly hook: NonNullable<SwapTransactionHooks["beforeFileOperation"]>;
  readonly identity: () => string | undefined;
} {
  let identity: string | undefined;
  return {
    hook: async (event) => {
      if (identity !== undefined || event.boundary !== boundary) return;
      const target = side === "source" ? event.source : event.destination;
      if (target === undefined) return;
      const human = join(home, `human-${operation}-${boundary}-${side}`);
      await writeFile(human, "human replacement\n", { mode: 0o600 });
      await rename(human, target);
      identity = await pathIdentity(target);
    },
    identity: () => identity,
  };
}

describe("source specs", () => {
  test("names each stage the way its runtime is invoked", () => {
    const dev = buildSpec({ kind: "dev", repo: "/repo" });
    const build = buildSpec({ kind: "build", repo: "/repo" });
    const published = buildSpec({ kind: "published", version: "1.2.3" });

    // Bun runs the TypeScript; Node runs what a release would ship; npx fetches
    // a release. `-y` so a machine that has never seen the package does not
    // stop to ask, which under an agent looks like a hang.
    expect([dev.command, ...dev.args]).toEqual(["bun", "run", "/repo/packages/mcp/src/server.ts"]);
    expect([build.command, ...build.args]).toEqual(["node", "/repo/packages/mcp/dist/server.js"]);
    expect([published.command, ...published.args]).toEqual(["npx", "-y", "@libtmux/mcp@1.2.3"]);
  });

  test("defaults a published source to the latest release", () => {
    expect(buildSpec({ kind: "published" }).args).toEqual(["-y", "@libtmux/mcp@latest"]);
  });

  test("names a package this workspace publishes, not the bin inside one", async () => {
    // `mcp_swap` writes an install command into somebody's agent config and
    // nothing else here reads it back — the Markdown gates check ```console
    // blocks, and this command is built in TypeScript. Naming the bin instead
    // of the package is an npx E404 nothing else catches.
    //
    // Answered from the manifests rather than the registry, so the gate holds
    // offline.
    const paths = await Array.fromAsync(
      new Bun.Glob("packages/*/package.json").scan({ cwd: repositoryRoot }),
    );
    const manifests = (await Promise.all(
      paths.map(async (path) => Bun.file(join(repositoryRoot, path)).json()),
    )) as { bin?: Record<string, string>; name?: string; private?: boolean }[];

    const published = manifests
      .filter((manifest) => manifest.private !== true)
      .map((manifest) => manifest.name);
    expect(published.length).toBeGreaterThan(0);
    expect(published).toContain(PUBLISHED_PACKAGE);

    // A bin name is not installable.
    const binNames = manifests.flatMap((manifest) => Object.keys(manifest.bin ?? {}));
    expect(binNames).not.toContain(PUBLISHED_PACKAGE);

    // And the command a caller actually receives carries that same name.
    expect(buildSpec({ kind: "published" }).args[1]).toBe(`${PUBLISHED_PACKAGE}@latest`);
  });

  test("refuses a checkout source with no checkout", () => {
    expect(() => buildSpec({ kind: "dev" })).toThrow(/repository path/u);
    expect(() => buildSpec({ kind: "build" })).toThrow(/repository path/u);
  });

  test("recognises its own handiwork when reading a config back", () => {
    for (const kind of ["build", "dev", "published"] as const) {
      expect(classifySpec(buildSpec({ kind, repo: "/repo" }))).toBe(kind);
    }
    // Anything else is somebody else's entry, and saying so is the point.
    expect(classifySpec({ args: [], command: "some-other-server", env: {} })).toBe("unknown");
  });

  test("rejects unsafe published versions before they can become paths or package selectors", () => {
    for (const version of ["../../escape", "name/tag", ".", "v1\0tail"]) {
      expect(() => buildSpec({ kind: "published", version })).toThrow(/safe component/u);
    }
  });

  test("builds a live build source after planning and before writing", async () => {
    const info = cliFor("cursor");
    const bin = join(home, "build-bin");
    const marker = join(home, "build-ran");
    await seed(info, originalConfig(info));
    await mkdir(bin);
    await writeFile(join(bin, "bun"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
    await chmod(join(bin, "bun"), 0o700);

    const result = await runSwap(
      ["use", "--source", "build", "--repo", repositoryRoot, "--no-preflight", "--cli", "cursor"],
      { PATH: bin },
    );

    expect(result.status).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(await readServer(info, "libtmux")).toMatchObject({ command: "node" });
  });

  test("does not build when final-spec planning rejects a config", async () => {
    const info = cliFor("cursor");
    const bin = join(home, "rejected-build-bin");
    const marker = join(home, "rejected-build-ran");
    await seed(info, '{"mcpServers":[]}\n');
    await mkdir(bin);
    await writeFile(join(bin, "bun"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
    await chmod(join(bin, "bun"), 0o700);

    const result = await runSwap(
      ["use", "--source", "build", "--repo", repositoryRoot, "--no-preflight", "--cli", "cursor"],
      { PATH: bin },
    );

    expect(result.status).toBe(1);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readFile(info.configPath, "utf8")).toBe('{"mcpServers":[]}\n');
  });
});

describe("server preflight", () => {
  test("accepts one complete initialize reply", async () => {
    const source = `
      const request = JSON.parse((await Bun.stdin.text()).trim());
      console.log(JSON.stringify({
        id: request.id,
        jsonrpc: "2.0",
        result: { protocolVersion: "2024-11-05", serverInfo: {} },
      }));
    `;

    expect(
      await preflight({ args: ["-e", source], command: process.execPath, env: {} }, 1_000),
    ).toBeUndefined();
  });

  test("bounds a server that never replies", async () => {
    expect(
      await preflight(
        { args: ["-e", "await Bun.sleep(60_000)"], command: process.execPath, env: {} },
        20,
      ),
    ).toBe("initialize exceeded 20ms");
  });

  test("accepts a valid reply from a long-lived server and reaps its process tree", async () => {
    const descendantPid = join(home, "preflight-descendant.pid");
    const source = `
      const child = Bun.spawn(["sh", "-c", "sleep 60"]);
      await Bun.write(${JSON.stringify(descendantPid)}, String(child.pid));
      const request = JSON.parse((await Bun.stdin.text()).trim());
      console.log(JSON.stringify({
        id: request.id,
        jsonrpc: "2.0",
        result: { protocolVersion: "2024-11-05" },
      }));
      await Bun.sleep(60_000);
    `;
    const started = performance.now();

    expect(
      await preflight({ args: ["-e", source], command: process.execPath, env: {} }, 2_000),
    ).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);

    await expectRecordedProcessGone(descendantPid);
  });

  test("reaps the process tree after an initialize timeout", async () => {
    const descendantPid = join(home, "timeout-descendant.pid");
    const source = `
      const child = Bun.spawn(["sh", "-c", "sleep 60"]);
      await Bun.write(${JSON.stringify(descendantPid)}, String(child.pid));
      await Bun.sleep(60_000);
    `;

    expect(await preflight({ args: ["-e", source], command: process.execPath, env: {} }, 30)).toBe(
      "initialize exceeded 30ms",
    );
    await expectRecordedProcessGone(descendantPid);
  });

  test.each([
    [{ id: 1, result: { protocolVersion: "2024-11-05" } }, "jsonrpc"],
    [{ id: 1, jsonrpc: "2.0", result: {} }, "protocolVersion"],
    [{ id: 2, jsonrpc: "2.0", result: { protocolVersion: "2024-11-05" } }, "id"],
  ] as const)("rejects an initialize reply without a valid %s envelope", async (reply, _label) => {
    const source = `
      await Bun.stdin.text();
      console.log(${JSON.stringify(JSON.stringify(reply))});
    `;

    expect(
      await preflight({ args: ["-e", source], command: process.execPath, env: {} }, 1_000),
    ).toBe("no valid initialize reply");
  });

  test.each([
    '{"id":1,"jsonrpc":"1.0","jsonrpc":"2.0","result":{"protocolVersion":"2024-11-05"}}',
    '{"id":1,"jsonrpc":"2.0","result":{"protocolVersion":"retired","protocolVersion":"2024-11-05"}}',
  ])("rejects duplicate initialize response members", async (reply) => {
    const source = `
      await Bun.stdin.text();
      console.log(${JSON.stringify(reply)});
    `;

    expect(
      await preflight({ args: ["-e", source], command: process.execPath, env: {} }, 1_000),
    ).toBe("no valid initialize reply");
  });

  test.each(["stdout", "stderr"] as const)(
    "terminates a long-lived server after oversized %s",
    async (stream) => {
      const descendantPid = join(home, `${stream}-limit-descendant.pid`);
      const source = `
        const child = Bun.spawn(["sh", "-c", "sleep 60"]);
        await Bun.write(${JSON.stringify(descendantPid)}, String(child.pid));
        process.${stream}.write("x".repeat(5 * 1024 * 1024));
        await Bun.sleep(60_000);
      `;
      const started = performance.now();

      expect(
        await preflight({ args: ["-e", source], command: process.execPath, env: {} }, 2_000),
      ).toBe("initialize exceeded 4194304 output bytes");
      expect(performance.now() - started).toBeLessThan(1_000);
      await expectRecordedProcessGone(descendantPid);
    },
  );

  test.each([
    ["cursor", '{"mcpServers":[]}\n', /mcpServers must be an object/u],
    [
      "cursor",
      '{"mcpServers":{},"mcpServers":{"libtmux":{"command":"old"}}}\n',
      /duplicate mcpServers/u,
    ],
    [
      "cursor",
      '{"mcpServers":{"libtmux":{"command":"old","env":[]}}}\n',
      /env must be an object of strings/u,
    ],
    [
      "cursor",
      '{"mcpServers":{"libtmux":{"command":"first","command":"second"}}}\n',
      /duplicate command/u,
    ],
    [
      "cursor",
      '{"mcpServers":{"libtmux":{"command":"old","env":{"KEEP":"first","KEEP":"second"}}}}\n',
      /duplicate KEEP/u,
    ],
    ["claude", '{// comment\n"mcpServers":{}}\n', /JSON Parse error/u],
    ["codex", "mcp_servers = []\n", /mcp_servers must be a table/u],
    [
      "opencode",
      '{"mcp":{"libtmux":{"type":"local","command":["bun",7]}}}\n',
      /command must be an array of strings/u,
    ],
  ] as const)(
    "rejects a schema-ambiguous %s config without rewriting it",
    async (name, raw, error) => {
      const info = cliFor(name);
      await seed(info, raw);

      const result = await runSwap(["use", "--source", "dev", "--dry-run", "--cli", name]);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(error);
      expect(result.stdout).not.toContain("would update");
      expect(await readFile(info.configPath, "utf8")).toBe(raw);
    },
  );
});

describe("entry dialects", () => {
  const spec = { args: ["run", "s.ts"], command: "bun", env: { A: "1" } };

  test("writes the shape each CLI actually reads", () => {
    // opencode takes one array for the whole command line and calls the table
    // `environment`. An `env` key is dropped in silence and a scalar `command`
    // fails to decode, taking the rest of the config with it.
    expect(toEntry(spec, "opencode")).toEqual({
      command: ["bun", "run", "s.ts"],
      environment: { A: "1" },
      type: "local",
    });
    expect(toEntry(spec, "claude")).toEqual({
      args: ["run", "s.ts"],
      command: "bun",
      env: { A: "1" },
      type: "stdio",
    });
    expect(toEntry(spec, "standard")).toEqual({
      args: ["run", "s.ts"],
      command: "bun",
      env: { A: "1" },
    });
  });

  test("omits an empty environment except where the CLI insists on it", () => {
    const bare = { args: [], command: "bun", env: {} };
    expect(toEntry(bare, "standard")).toEqual({ args: [], command: "bun" });
    expect(toEntry(bare, "opencode")).toEqual({ command: ["bun"], type: "local" });
    // Claude writes the key regardless, so it is written regardless.
    expect(toEntry(bare, "claude")).toMatchObject({ env: {} });
  });

  test("round-trips through the shape it wrote", () => {
    for (const dialect of ["claude", "opencode", "standard"] as const) {
      expect(fromEntry(toEntry(spec, dialect), dialect)).toEqual(spec);
    }
  });

  test("answers undefined for an entry it cannot read", () => {
    expect(fromEntry(undefined, "standard")).toBeUndefined();
    expect(fromEntry({ args: [] }, "standard")).toBeUndefined();
    // opencode's command is an array; a string there is not merely unusual.
    expect(fromEntry({ command: "bun" }, "opencode")).toBeUndefined();
  });
});

describe("Claude scopes", () => {
  test("maps project scope to only the selected repository container", () => {
    const claude = cliFor("claude");

    expect(scopedCli(claude, "/work/repo", "project").container).toEqual([
      "projects",
      "/work/repo",
      "mcpServers",
    ]);
    expect(scopedCli(claude, "/work/repo", "user").container).toEqual(["mcpServers"]);
    expect(scopedCli(cliFor("cursor"), "/work/repo", "project").container).toEqual(["mcpServers"]);
  });

  test("defaults use to the project layer and restores it exactly", async () => {
    const claude = cliFor("claude");
    const projectRoot = resolve(repositoryRoot);
    const original = `${JSON.stringify(
      {
        mcpServers: { tmux: { command: "user-server" } },
        projects: {
          [projectRoot]: { mcpServers: { tmux: { command: "project-server" } } },
        },
      },
      undefined,
      2,
    )}\n`;
    await seed(claude, original);

    const used = await runSwap([
      "use",
      "--source",
      "dev",
      "--no-preflight",
      "--repo",
      repositoryRoot,
      "--cli",
      "claude",
      "--server",
      "tmux",
    ]);
    expect(used.status).toBe(0);
    expect(used.stdout).toContain(repositoryRoot);
    const after = JSON.parse(await readFile(claude.configPath, "utf8"));
    expect(after.mcpServers.tmux.command).toBe("user-server");
    expect(Object.keys(after.projects)).toEqual([projectRoot]);
    expect(after.projects[projectRoot].mcpServers).toMatchObject({
      tmux: { command: "bun" },
    });

    const reverted = await runSwap(["revert", "--cli", "claude"]);
    expect(reverted.status).toBe(0);
    expect(await readFile(claude.configPath, "utf8")).toBe(original);
  });

  test("keeps user and project layers independent and reverts them in LIFO order", async () => {
    const claude = cliFor("claude");
    const projectRoot = resolve(repositoryRoot);
    const original = `${JSON.stringify(
      {
        mcpServers: { tmux: { command: "user-original" } },
        projects: {
          [projectRoot]: { mcpServers: { tmux: { command: "project-original" } } },
        },
      },
      undefined,
      2,
    )}\n`;
    await seed(claude, original);
    const common = [
      "--source",
      "dev",
      "--no-preflight",
      "--repo",
      projectRoot,
      "--cli",
      "claude",
      "--server",
      "tmux",
    ];

    expect((await runSwap(["use", ...common, "--scope", "project"])).status).toBe(0);
    expect((await runSwap(["use", ...common, "--scope", "user"])).status).toBe(0);

    const both = JSON.parse(await readFile(claude.configPath, "utf8"));
    expect(both.mcpServers.tmux.command).toBe("bun");
    expect(both.projects[projectRoot].mcpServers.tmux.command).toBe("bun");

    expect((await runSwap(["revert", "--cli", "claude", "--scope", "user"])).status).toBe(0);
    const projectOnly = JSON.parse(await readFile(claude.configPath, "utf8"));
    expect(projectOnly.mcpServers.tmux.command).toBe("user-original");
    expect(projectOnly.projects[projectRoot].mcpServers.tmux.command).toBe("bun");

    expect((await runSwap(["revert", "--cli", "claude", "--scope", "project"])).status).toBe(0);
    expect(await readFile(claude.configPath, "utf8")).toBe(original);
  });

  test("rewrites newer recovery when an older Claude layer is swapped again", async () => {
    const claude = cliFor("claude");
    const projectRoot = resolve(repositoryRoot);
    const original = `${JSON.stringify(
      {
        mcpServers: { tmux: { command: "user-original" } },
        projects: {
          [projectRoot]: { mcpServers: { tmux: { command: "project-original" } } },
        },
      },
      undefined,
      2,
    )}\n`;
    await seed(claude, original);
    const common = ["--no-preflight", "--repo", projectRoot, "--cli", "claude", "--server", "tmux"];

    expect((await runSwap(["use", "--source", "dev", ...common, "--scope", "user"])).status).toBe(
      0,
    );
    expect(
      (await runSwap(["use", "--source", "dev", ...common, "--scope", "project"])).status,
    ).toBe(0);
    expect((await runSwap(["use", "--source", "build", ...common, "--scope", "user"])).status).toBe(
      0,
    );

    const repeated = JSON.parse(await readFile(claude.configPath, "utf8"));
    expect(repeated.mcpServers.tmux.command).toBe("node");
    expect(repeated.projects[projectRoot].mcpServers.tmux.command).toBe("bun");

    const reverted = await runSwap(["revert", "--cli", "claude"]);
    expect(reverted.status).toBe(0);
    expect(await readFile(claude.configPath, "utf8")).toBe(original);
    expect(await Bun.file(nativeStatePath()).exists()).toBe(false);
  });

  test("refuses a scoped revert that would skip a newer Claude layer", async () => {
    const claude = cliFor("claude");
    const original = originalConfig(claude);
    await seed(claude, original);
    for (const scope of ["user", "project"] as const) {
      // eslint-disable-next-line no-await-in-loop -- the order creates the layered recovery chain.
      const result = await runSwap([
        "use",
        "--source",
        "dev",
        "--no-preflight",
        "--scope",
        scope,
        "--cli",
        "claude",
      ]);
      expect(result.status).toBe(0);
    }
    const before = await fileState(claude.configPath);
    const stateBefore = await fileState(nativeStatePath());

    const refused = await runSwap(["revert", "--scope", "user", "--cli", "claude"]);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("cannot revert before newer layer claude:project");
    expect(await fileState(claude.configPath)).toEqual(before);
    expect(await fileState(nativeStatePath())).toEqual(stateBefore);
  });

  test("status reports both Claude layers and honors a scope filter", async () => {
    const claude = cliFor("claude");
    const projectRoot = resolve(repositoryRoot);
    await seed(
      claude,
      `${JSON.stringify({
        mcpServers: { tmux: { command: "user", env: { TOKEN: "do-not-print" } } },
        projects: {
          [projectRoot]: { mcpServers: { tmux: { command: "project" } } },
        },
      })}\n`,
    );

    const both = await runSwap([
      "status",
      "--repo",
      projectRoot,
      "--server",
      "tmux",
      "--cli",
      "claude",
    ]);
    expect(both.status).toBe(0);
    expect(both.stdout).toContain("claude:user");
    expect(both.stdout).toContain("claude:project");
    expect(both.stdout).not.toContain("do-not-print");

    const project = await runSwap([
      "status",
      "--repo",
      projectRoot,
      "--server",
      "tmux",
      "--scope",
      "project",
      "--cli",
      "claude",
    ]);
    expect(project.status).toBe(0);
    expect(project.stdout).not.toContain("claude:user");
    expect(project.stdout).toContain("claude:project");
  });
});

describe("capability environment migration", () => {
  test("preserves retired safety until explicit toolsets authorizes migration", async () => {
    const cursor = cliFor("cursor");
    const original = `${JSON.stringify(
      {
        mcpServers: {
          libtmux: {
            args: ["old"],
            command: "old",
            env: { KEEP: "yes", LIBTMUX_SAFETY: "readonly" },
          },
        },
      },
      undefined,
      2,
    )}\n`;
    await seed(cursor, original);

    const preserved = await runSwap([
      "use",
      "--source",
      "dev",
      "--no-preflight",
      "--cli",
      "cursor",
    ]);
    expect(preserved.status).toBe(0);
    expect(await readServer(cursor, "libtmux")).toMatchObject({
      env: { KEEP: "yes", LIBTMUX_SAFETY: "readonly" },
    });

    const migrated = await runSwap([
      "use",
      "--source",
      "dev",
      "--no-preflight",
      "--cli",
      "cursor",
      "--env",
      "LIBTMUX_TOOLSETS=inspect,manage",
      "--env",
      "NEW=value",
    ]);
    expect(migrated.status).toBe(0);
    expect(await readServer(cursor, "libtmux")).toMatchObject({
      env: { KEEP: "yes", LIBTMUX_TOOLSETS: "inspect,manage", NEW: "value" },
    });
  });

  test("preflights the exact preserved inherited environment", async () => {
    const cursor = cliFor("cursor");
    const checkout = join(home, "safety-checkout");
    await seed(
      cursor,
      `${JSON.stringify({
        mcpServers: {
          libtmux: {
            args: [],
            command: "old",
            env: { LIBTMUX_SAFETY: "readonly" },
          },
        },
      })}\n`,
    );
    await mkdir(join(checkout, "packages", "mcp", "src"), { recursive: true });
    await writeFile(
      join(checkout, "packages", "mcp", "src", "server.ts"),
      `
        const request = JSON.parse((await Bun.stdin.text()).trim());
        if (process.env.LIBTMUX_SAFETY !== "readonly") process.exit(19);
        console.log(JSON.stringify({
          id: request.id,
          jsonrpc: "2.0",
          result: { protocolVersion: "2024-11-05" },
        }));
        await Bun.sleep(60_000);
      `,
    );

    const result = await runSwap(["use", "--source", "dev", "--repo", checkout, "--cli", "cursor"]);

    expect(result.status).toBe(0);
    expect(await readServer(cursor, "libtmux")).toMatchObject({
      env: { LIBTMUX_SAFETY: "readonly" },
    });
  });

  test("rejects explicit retired safety before reading any config", async () => {
    const result = await runSwap(["use", "--source", "dev", "--env", "LIBTMUX_SAFETY=readonly"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("LIBTMUX_SAFETY is retired");
  });
});

describe("native recovery ledger", () => {
  test("preserves a symlink route through native use and revert", async () => {
    const cursor = cliFor("cursor");
    const original = originalConfig(cursor);
    const { linkTarget, target } = await seedSymlink(cursor, original, 0o640);

    const used = await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "cursor"]);
    expect(used.status).toBe(0);
    expect((await lstat(cursor.configPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(cursor.configPath)).toBe(linkTarget);
    expect((await stat(target)).mode & 0o777).toBe(0o640);

    const reverted = await runSwap(["revert", "--cli", "cursor"]);
    expect(reverted.status).toBe(0);
    expect((await lstat(cursor.configPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(cursor.configPath)).toBe(linkTarget);
    expect(await readFile(target, "utf8")).toBe(original);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  test("removes an explicitly selected config that did not exist before use", async () => {
    const cursor = cliFor("cursor");
    expect(await Bun.file(cursor.configPath).exists()).toBe(false);

    const used = await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "cursor"]);
    expect(used.status).toBe(0);
    expect(await Bun.file(cursor.configPath).exists()).toBe(true);
    expect((await nativeRecoveryEntry("cursor:user")).backupPath).toBeNull();

    const reverted = await runSwap(["revert", "--cli", "cursor"]);
    expect(reverted.status).toBe(0);
    expect(await Bun.file(cursor.configPath).exists()).toBe(false);
    expect(await Bun.file(nativeStatePath()).exists()).toBe(false);
  });

  test("serializes native writers and retains the first backup", async () => {
    const all = knownClis({ XDG_CONFIG_HOME: join(home, ".config") }, home);
    const cursor = cliFor("cursor");
    const original = originalConfig(cursor);
    await seed(cursor, original);
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let firstHeld!: () => void;
    const held = new Promise<void>((resolvePromise) => {
      firstHeld = resolvePromise;
    });
    let secondLocked = false;
    const first = useNativeConfigs(
      all,
      [cursor],
      "libtmux",
      resolve(repositoryRoot),
      "user",
      buildSpec({ kind: "dev", repo: "/first" }),
      false,
      {
        dryRun: false,
        hooks: {
          afterLockAcquired: async () => {
            firstHeld();
            await release;
          },
        },
        skipPreflight: true,
      },
    );
    await held;
    const second = useNativeConfigs(
      all,
      [cursor],
      "libtmux",
      resolve(repositoryRoot),
      "user",
      buildSpec({ kind: "dev", repo: "/second" }),
      false,
      {
        dryRun: false,
        hooks: {
          afterLockAcquired: () => {
            secondLocked = true;
          },
        },
        skipPreflight: true,
      },
    );
    await Bun.sleep(30);
    expect(secondLocked).toBe(false);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(await readServer(cursor, "libtmux")).toMatchObject({
      args: ["run", "/second/packages/mcp/src/server.ts"],
    });

    const reverted = await runSwap(["revert", "--cli", "cursor"]);
    expect(reverted.status).toBe(0);
    expect(await readFile(cursor.configPath, "utf8")).toBe(original);
  });

  test("rejects a final spec changed after preflight during locked replan", async () => {
    const all = knownClis({ XDG_CONFIG_HOME: join(home, ".config") }, home);
    const cursor = cliFor("cursor");
    const late = `${JSON.stringify({
      mcpServers: {
        libtmux: { args: [], command: "old", env: { LATE: "yes" } },
      },
    })}\n`;
    await seed(cursor, originalConfig(cursor));
    const server = `
      const request = JSON.parse((await Bun.stdin.text()).trim());
      console.log(JSON.stringify({
        id: request.id,
        jsonrpc: "2.0",
        result: { protocolVersion: "2024-11-05" },
      }));
      await Bun.sleep(60_000);
    `;

    const mutation = useNativeConfigs(
      all,
      [cursor],
      "libtmux",
      resolve(repositoryRoot),
      "user",
      { args: ["-e", server], command: process.execPath, env: {} },
      false,
      {
        dryRun: false,
        hooks: { afterLockAcquired: () => writeFile(cursor.configPath, late) },
        skipPreflight: false,
      },
    );

    await expect(mutation).rejects.toThrow(/final MCP specification changed after preflight/u);
    expect(await readFile(cursor.configPath, "utf8")).toBe(late);
    expect(await Bun.file(nativeStatePath()).exists()).toBe(false);
  });

  test("round-trips all eight clients through one native ledger", async () => {
    const infos = await seedAllClients();
    const originals = await Promise.all(infos.map((info) => fileState(info.configPath)));

    const used = await runSwap([
      "use",
      "--source",
      "build",
      "--repo",
      repositoryRoot,
      "--no-preflight",
      "--cli",
      CLI_NAMES.join(","),
    ]);
    expect(used.status).toBe(0);
    const envelope = JSON.parse(await readFile(nativeStatePath(), "utf8")) as {
      payload: { entries: Record<string, { backupPath: string; sequence: number }> };
    };
    expect(Object.keys(envelope.payload.entries).toSorted()).toEqual([
      "agy:user",
      "claude:project",
      "codex:user",
      "cursor:user",
      "gemini:user",
      "grok:user",
      "opencode:user",
      "pi:user",
    ]);
    expect(
      new Set(Object.values(envelope.payload.entries).map((entry) => entry.sequence)).size,
    ).toBe(8);
    for (const [index, info] of infos.entries()) {
      const target =
        info.name === "claude" ? scopedCli(info, resolve(repositoryRoot), "project") : info;
      // eslint-disable-next-line no-await-in-loop -- verify every configured dialect.
      expect(await readServer(target, "libtmux")).toMatchObject({ command: "node" });
      const key = `${info.name}:${info.name === "claude" ? "project" : "user"}`;
      const entry = envelope.payload.entries[key]!;
      // eslint-disable-next-line no-await-in-loop -- every private backup has the same policy.
      expect((await stat(entry.backupPath)).mode & 0o777).toBe(0o600);
      // eslint-disable-next-line no-await-in-loop -- every configured mode is verified in catalog order.
      expect((await stat(info.configPath)).mode & 0o777).toBe(originals[index]!.mode);
    }

    const reverted = await runSwap(["revert", "--cli", CLI_NAMES.join(",")]);
    expect(reverted.status).toBe(0);
    expect(
      (await Promise.all(infos.map((info) => fileState(info.configPath)))).map(({ mode, raw }) => ({
        mode,
        raw,
      })),
    ).toEqual(originals.map(({ mode, raw }) => ({ mode, raw })));
    expect(await Bun.file(nativeStatePath()).exists()).toBe(false);
    for (const entry of Object.values(envelope.payload.entries)) {
      // eslint-disable-next-line no-await-in-loop -- every consumed backup must be removed.
      expect(await Bun.file(entry.backupPath).exists()).toBe(false);
    }
  });

  test("adds a Claude project layer without reformatting unrelated JSON", async () => {
    const claude = cliFor("claude");
    const original = '{\n  "theme" :  "dark",\n  "note": { "keep" : true }\n}\n';
    await seed(claude, original);

    const used = await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "claude"]);

    expect(used.status).toBe(0);
    const changed = await readFile(claude.configPath, "utf8");
    expect(changed).toContain('  "theme" :  "dark",\n  "note": { "keep" : true },\n');
    expect(changed).toContain('"projects"');
  });

  test("uses private TypeScript state and backups and restores exact bytes and mode", async () => {
    const cursor = cliFor("cursor");
    const original = originalConfig(cursor);
    await seed(cursor, original);
    await chmod(cursor.configPath, 0o640);

    const used = await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "cursor"]);
    expect(used.status).toBe(0);
    const entry = await nativeRecoveryEntry("cursor:user");
    const backup = entry.backupPath as string;
    expect(backup).toContain(".bak.mcp-swap-typescript-");
    expect((await stat(nativeStatePath())).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(nativeStatePath()))).mode & 0o777).toBe(0o700);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);

    const reverted = await runSwap(["revert", "--cli", "cursor"]);
    expect(reverted.status).toBe(0);
    expect(await readFile(cursor.configPath, "utf8")).toBe(original);
    expect((await stat(cursor.configPath)).mode & 0o777).toBe(0o640);
    expect(await Bun.file(nativeStatePath()).exists()).toBe(false);
    expect(await Bun.file(backup).exists()).toBe(false);
  });

  test("rejects duplicate recovery fields without guessing or writing", async () => {
    const cursor = cliFor("cursor");
    await seed(cursor, originalConfig(cursor));
    const used = await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "cursor"]);
    expect(used.status).toBe(0);
    const raw = await readFile(nativeStatePath(), "utf8");
    const duplicated = raw.replace('"version": 1', '"version": 1,\n    "version": 1');
    await writeFile(nativeStatePath(), duplicated, { mode: 0o600 });
    const configBefore = await fileState(cursor.configPath);

    const result = await runSwap(["revert", "--dry-run", "--cli", "cursor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicate version");
    expect(await fileState(cursor.configPath)).toEqual(configBefore);
    expect(await readFile(nativeStatePath(), "utf8")).toBe(duplicated);
  });

  test("rejects a recovery state with a permissive mode without writing", async () => {
    const cursor = cliFor("cursor");
    await seed(cursor, originalConfig(cursor));
    const used = await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "cursor"]);
    expect(used.status).toBe(0);
    await chmod(nativeStatePath(), 0o644);
    const configBefore = await fileState(cursor.configPath);
    const stateBefore = await fileState(nativeStatePath());

    const result = await runSwap(["revert", "--dry-run", "--cli", "cursor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recovery state mode must be 0600");
    expect(await fileState(cursor.configPath)).toEqual(configBefore);
    expect(await fileState(nativeStatePath())).toEqual(stateBefore);
  });

  test("rejects a recovery state with an invalid checksum without writing", async () => {
    const cursor = cliFor("cursor");
    await seed(cursor, originalConfig(cursor));
    const used = await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "cursor"]);
    expect(used.status).toBe(0);
    const raw = await readFile(nativeStatePath(), "utf8");
    const corrupted = raw.replace(/"checksum": "[a-f0-9]+"/u, '"checksum": "invalid"');
    await writeFile(nativeStatePath(), corrupted, { mode: 0o600 });
    const configBefore = await fileState(cursor.configPath);

    const result = await runSwap(["revert", "--dry-run", "--cli", "cursor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid checksum or schema");
    expect(await fileState(cursor.configPath)).toEqual(configBefore);
    expect(await readFile(nativeStatePath(), "utf8")).toBe(corrupted);
  });

  test("rejects an exhausted recovery sequence without writing", async () => {
    const cursor = cliFor("cursor");
    const codex = cliFor("codex");
    await seed(cursor, originalConfig(cursor));
    await seed(codex, originalConfig(codex));
    expect(
      (await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "cursor"])).status,
    ).toBe(0);
    const envelope = JSON.parse(await readFile(nativeStatePath(), "utf8")) as {
      checksum: string;
      payload: Record<string, unknown>;
    };
    envelope.payload.nextSequence = Number.MAX_SAFE_INTEGER;
    envelope.checksum = createHash("sha256")
      .update(canonicalTestJson(envelope.payload))
      .digest("hex");
    const forged = `${JSON.stringify(envelope, undefined, 2)}\n`;
    await writeFile(nativeStatePath(), forged, { mode: 0o600 });
    const configBefore = await fileState(codex.configPath);

    const result = await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "codex"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recovery sequence is exhausted");
    expect(await fileState(codex.configPath)).toEqual(configBefore);
    expect(await readFile(nativeStatePath(), "utf8")).toBe(forged);
  });
});

describe("JSONC", () => {
  test("blanks comments and trailing commas without moving anything", () => {
    const source = '{\n  // note\n  "a": 1, /* b */\n}\n';
    const blanked = blankJsonc(source);

    expect(blanked.length).toBe(source.length);
    // Newlines survive so line numbers still line up in an error.
    expect(blanked.split("\n").length).toBe(source.split("\n").length);
    expect(JSON.parse(blanked)).toEqual({ a: 1 });
  });

  test("counts in the units its offsets are measured in", () => {
    // Spreading a string yields code points while `length`, `indexOf` and every
    // slice count UTF-16 units, so one emoji anywhere would shift every offset
    // after it and land the splice in the wrong place.
    const source =
      '{\n  // \u{1F680}\n  "mcpServers": {\n    "other": { "note": "\u65E5\u672C\u8A9E\u{1F680}" }\n  }\n}\n';

    expect(blankJsonc(source).length).toBe(source.length);

    const spliced = spliceEntry(source, ["mcpServers"], "libtmux", { command: "bun" })!;
    expect(parseJsonc(spliced)).toMatchObject({
      mcpServers: { libtmux: { command: "bun" }, other: { note: "\u65E5\u672C\u8A9E\u{1F680}" } },
    });
    expect(spliced).toContain("// \u{1F680}");
  });

  test("leaves comment characters inside strings alone", () => {
    const source = '{ "url": "https://example.com", "path": "/a/*b*/c" }';
    expect(parseJsonc(source)).toEqual({ path: "/a/*b*/c", url: "https://example.com" });
  });

  test("leaves comma-like string contents alone", () => {
    const source = '{ "object": "value,}", "array": "value,]", }';
    expect(parseJsonc(source)).toEqual({ array: "value,]", object: "value,}" });
  });

  test("splices an entry while leaving every other byte where it was", () => {
    const source =
      '{\n  // keep me\n  "mcpServers": {\n    "other": { "command": "keep" }\n  }\n}\n';

    const spliced = spliceEntry(source, ["mcpServers"], "libtmux", { command: "bun" });

    expect(spliced).toContain("// keep me");
    // The neighbour keeps its own formatting rather than being reflowed.
    expect(spliced).toContain('"other": { "command": "keep" }');
    expect(parseJsonc(spliced!)).toMatchObject({
      mcpServers: { libtmux: { command: "bun" }, other: { command: "keep" } },
    });
  });

  test("replaces an entry it already wrote rather than adding a second", () => {
    const source = '{\n  "mcpServers": {\n    "libtmux": { "command": "old" }\n  }\n}\n';

    const spliced = spliceEntry(source, ["mcpServers"], "libtmux", { command: "new" })!;

    expect(parseJsonc(spliced)).toEqual({ mcpServers: { libtmux: { command: "new" } } });
    expect(spliced).not.toContain("old");
  });

  test("seeds an empty container", () => {
    const spliced = spliceEntry('{\n  "mcpServers": {}\n}\n', ["mcpServers"], "x", {
      command: "c",
    })!;
    expect(parseJsonc(spliced)).toEqual({ mcpServers: { x: { command: "c" } } });
  });

  test("declines a document with no such container", () => {
    expect(spliceEntry('{ "other": {} }', ["mcpServers"], "x", {})).toBeUndefined();
  });
});

describe("TOML", () => {
  test("rejects malformed input instead of editing around it", () => {
    expect(() => parseServerTables("broken = [", "mcp_servers")).toThrow();
  });

  test("adds a table without disturbing its neighbours", () => {
    const source = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "keep"\n';

    const written = renderServerTable(source, "mcp_servers", "libtmux", {
      args: ["run"],
      command: "bun",
    });

    expect(parseServerTables(written, "mcp_servers")).toEqual({
      libtmux: { args: ["run"], command: "bun" },
      other: { command: "keep" },
    });
    expect(written).toContain('model = "gpt"');
  });

  test("replaces a table it already wrote", () => {
    let source = 'model = "gpt"\n';
    source = renderServerTable(source, "mcp_servers", "libtmux", { command: "old" });
    source = renderServerTable(source, "mcp_servers", "libtmux", { command: "new" });

    expect(parseServerTables(source, "mcp_servers")).toEqual({ libtmux: { command: "new" } });
    expect(source).not.toContain("old");
  });

  test("replaces a server and its environment table without touching neighbours", () => {
    const source = [
      "# retained",
      "[mcp_servers.libtmux]",
      'command = "old"',
      "",
      "[mcp_servers.libtmux.env]",
      'OLD = "remove"',
      "",
      "[mcp_servers.other]",
      'command = "keep"',
      "",
    ].join("\n");

    const written = renderServerTable(source, "mcp_servers", "libtmux", {
      args: ["run"],
      command: "bun",
      env: { KEEP: "yes" },
    });

    expect(parseServerTables(written, "mcp_servers")).toEqual({
      libtmux: { args: ["run"], command: "bun", env: { KEEP: "yes" } },
      other: { command: "keep" },
    });
    expect(written).toStartWith("# retained\n");
    expect(written).toContain('[mcp_servers.other]\ncommand = "keep"');
    expect(written).not.toContain("OLD");
  });

  test("removes only the table it was asked for", () => {
    const source =
      '[mcp_servers.other]\ncommand = "keep"\n\n[mcp_servers.libtmux]\ncommand = "go"\n';

    const removed = removeServerTable(source, "mcp_servers", "libtmux");

    expect(parseServerTables(removed, "mcp_servers")).toEqual({ other: { command: "keep" } });
  });

  test("updates and removes a server in an inline container", () => {
    const source =
      '# retained\nmcp_servers = { other = { command = "other" }, libtmux = { command = "old", args = [] } } # keep inline\ntheme = "dark"\n';

    const written = renderServerTable(source, "mcp_servers", "libtmux", {
      args: ["run"],
      command: "bun",
      env: { KEEP: "yes" },
    });

    expect(parseServerTables(written, "mcp_servers")).toEqual({
      libtmux: { args: ["run"], command: "bun", env: { KEEP: "yes" } },
      other: { command: "other" },
    });
    expect(written).toStartWith("# retained\n");
    expect(written).toContain("# keep inline");
    expect(written).toContain('theme = "dark"');

    const removed = removeServerTable(written, "mcp_servers", "libtmux");
    expect(parseServerTables(removed, "mcp_servers")).toEqual({ other: { command: "other" } });
    expect(removed).toContain("# keep inline");
    expect(removed).toContain('theme = "dark"');
  });

  test("updates and removes a server expressed through dotted keys", () => {
    const source = [
      "# retained",
      'mcp_servers.other.command = "other"',
      'mcp_servers.libtmux.command = "old"',
      "mcp_servers.libtmux.args = []",
      'theme = "dark"',
      "",
    ].join("\n");

    const written = renderServerTable(source, "mcp_servers", "libtmux", {
      args: ["run"],
      command: "bun",
      env: { KEEP: "yes" },
    });

    expect(parseServerTables(written, "mcp_servers")).toEqual({
      libtmux: { args: ["run"], command: "bun", env: { KEEP: "yes" } },
      other: { command: "other" },
    });
    expect(written).toStartWith("# retained\n");
    expect(written).toContain('mcp_servers.other.command = "other"');
    expect(written).toContain('theme = "dark"');
    expect(written).not.toContain('mcp_servers.libtmux.command = "old"');

    const removed = removeServerTable(written, "mcp_servers", "libtmux");
    expect(parseServerTables(removed, "mcp_servers")).toEqual({ other: { command: "other" } });
    expect(removed).toContain('mcp_servers.other.command = "other"');
    expect(removed).toContain('theme = "dark"');
  });
});

describe("swapping a config", () => {
  test.each(CLI_NAMES)("round-trips %s bytes and mode in isolation", async (name) => {
    const info = cliFor(name);
    const original = originalConfig(info);
    await seed(info, original);
    await chmod(info.configPath, 0o640);

    expect(await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }))).toBe(
      "added",
    );
    expect(await readServer(info, "libtmux")).toMatchObject({ command: "bun" });
    expect((await stat(info.configPath)).mode & 0o777).toBe(0o640);
    expect((await stat(backupPath(info.configPath))).mode & 0o777).toBe(0o640);

    expect(await revertConfig(info)).toBe(true);
    expect(await readFile(info.configPath, "utf8")).toBe(original);
    expect((await stat(info.configPath)).mode & 0o777).toBe(0o640);
  });

  test.each(CLI_NAMES)("round-trips a symlinked %s config", async (name) => {
    const info = cliFor(name);
    const original = originalConfig(info);
    const { linkTarget, target } = await seedSymlink(info, original, 0o640);

    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));

    expect((await lstat(info.configPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(info.configPath)).toBe(linkTarget);
    expect(await readServer(info, "libtmux")).toMatchObject({ command: "bun" });
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect((await stat(backupPath(info.configPath))).mode & 0o777).toBe(0o640);
    expect((await stat(backupRoutePath(info.configPath))).mode & 0o777).toBe(0o600);

    expect(await revertConfig(info)).toBe(true);
    expect((await lstat(info.configPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(info.configPath)).toBe(linkTarget);
    expect(await readFile(target, "utf8")).toBe(original);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await Bun.file(backupRoutePath(info.configPath)).exists()).toBe(false);
  });

  test("round-trips all eight symlinked clients together", async () => {
    const infos = knownClis({ XDG_CONFIG_HOME: join(home, ".config") }, home);
    const originals = new Map<
      string,
      { linkTarget: string; mode: number; raw: string; target: string }
    >();
    await Promise.all(
      infos.map(async (info, index) => {
        const raw = originalConfig(info);
        const mode = index % 2 === 0 ? 0o600 : 0o640;
        const seeded = await seedSymlink(info, raw, mode);
        originals.set(info.name, { ...seeded, mode, raw });
      }),
    );

    const outcomes = await writeServers(
      infos,
      "libtmux",
      buildSpec({ kind: "build", repo: "/repo" }),
    );
    expect(outcomes).toEqual(infos.map(() => "added"));
    await Promise.all(
      infos.map(async (info, index) => {
        expect((await lstat(info.configPath)).isSymbolicLink()).toBe(true);
        expect(await readServer(info, "libtmux")).toMatchObject({ command: "node" });
        expect((await stat(info.configPath)).mode & 0o777).toBe(index % 2 === 0 ? 0o600 : 0o640);
      }),
    );
    expect(await revertConfigs(infos)).toEqual(infos.map(() => true));
    await Promise.all(
      infos.map(async (info, index) => {
        const original = originals.get(info.name);
        if (original === undefined) throw new Error(`missing ${info.name} fixture`);
        expect((await lstat(info.configPath)).isSymbolicLink()).toBe(true);
        expect(await readlink(info.configPath)).toBe(original.linkTarget);
        expect(await readFile(original.target, "utf8")).toBe(original.raw);
        expect((await stat(info.configPath)).mode & 0o777).toBe(index % 2 === 0 ? 0o600 : 0o640);
        expect(await Bun.file(backupRoutePath(info.configPath)).exists()).toBe(false);
      }),
    );
    expect(
      (await readdir(home, { recursive: true })).some((path) => /\.mcp-swap-\d+-/u.test(path)),
    ).toBe(false);
  });

  test("serializes same-process writers before either re-plans", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      firstReached = resolve;
    });
    let secondStaged = false;
    const first = writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }), {
      afterStaging: async () => {
        firstReached();
        await release;
      },
    });
    await reached;
    const second = writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/two" }), {
      afterStaging: () => {
        secondStaged = true;
      },
    });
    await Bun.sleep(30);
    const serialized = !secondStaged;
    releaseFirst();
    const results = await Promise.allSettled([first, second]);

    expect(serialized).toBe(true);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await readServer(info, "libtmux")).toMatchObject({
      args: ["run", "/two/packages/mcp/src/server.ts"],
    });
  });

  test("serializes writers in separate processes without blocking the caller", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    const helper = join(home, "swap-child.ts");
    const firstMarker = join(home, "first-staged");
    const secondMarker = join(home, "second-staged");
    const release = join(home, "release-first");
    const swapModule = join(repositoryRoot, "scripts", "mcp_swap.ts");
    await writeFile(
      helper,
      `
        const { buildSpec, knownClis, useNativeConfigs } = await import(${JSON.stringify(swapModule)});
        const [scratch, marker, release, repo, pause] = process.argv.slice(2);
        const all = knownClis({ XDG_CONFIG_HOME: scratch + "/.config" }, scratch);
        const info = all.find((candidate) => candidate.name === "cursor");
        await Bun.write(marker + ".started", "started\\n");
        const outcome = await useNativeConfigs(
          all,
          [info],
          "libtmux",
          repo,
          "user",
          buildSpec({ kind: "dev", repo }),
          false,
          { dryRun: false,
            hooks: { afterStaging: async () => {
              await Bun.write(marker, "ready\\n");
              if (pause === "yes") {
                while (!(await Bun.file(release).exists())) await Bun.sleep(2);
              }
            } },
            skipPreflight: true },
        );
        console.log(outcome.length);
      `,
    );
    const environment = {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
    };
    const spawn = (repo: string, marker: string, pause: boolean) =>
      Bun.spawn([process.execPath, helper, home, marker, release, repo, pause ? "yes" : "no"], {
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      });
    const first = spawn("/one", firstMarker, true);
    await waitForPath(firstMarker);
    const second = spawn("/two", secondMarker, false);
    await waitForPath(`${secondMarker}.started`);
    let eventLoopTicks = 0;
    const timer = setInterval(() => {
      eventLoopTicks += 1;
    }, 1);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- observe the exact serialization boundary.
      if (await Bun.file(secondMarker).exists()) break;
      // eslint-disable-next-line no-await-in-loop -- polling must leave the event loop responsive.
      await Bun.sleep(2);
    }
    clearInterval(timer);
    const serialized = !(await Bun.file(secondMarker).exists());
    await writeFile(release, "go\n");
    const [firstStatus, secondStatus, firstError, secondError] = await Promise.all([
      first.exited,
      second.exited,
      new Response(first.stderr).text(),
      new Response(second.stderr).text(),
    ]);

    expect(serialized).toBe(true);
    expect(eventLoopTicks).toBeGreaterThan(10);
    expect({ firstError, firstStatus, secondError, secondStatus }).toEqual({
      firstError: "",
      firstStatus: 0,
      secondError: "",
      secondStatus: 0,
    });
  });

  test("holds a POSIX record lock that blocks Python fcntl.lockf", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    let observation = "not-run";

    await useNativeConfigs(
      knownClis({ XDG_CONFIG_HOME: join(home, ".config") }, home),
      [info],
      "libtmux",
      resolve(repositoryRoot),
      "user",
      buildSpec({ kind: "dev", repo: resolve(repositoryRoot) }),
      false,
      {
        dryRun: false,
        hooks: {
          afterStaging: async () => {
            observation = await tryPythonRecordLock(swapLockPath());
          },
        },
        skipPreflight: true,
      },
    );

    expect(observation).toBe("blocked");
    expect(await tryPythonRecordLock(swapLockPath())).toBe("acquired");
  });

  test("keeps the worker lock through native config hardlink-alias rejection", async () => {
    const all = knownClis({ XDG_CONFIG_HOME: join(home, ".config") }, home);
    const info = cliFor("cursor");
    const original = originalConfig(info);
    const displaced = join(home, "cursor-before-alias.json");
    await seed(info, original);
    let contender = "not-run";

    const mutation = useNativeConfigs(
      all,
      [info],
      "libtmux",
      resolve(repositoryRoot),
      "user",
      buildSpec({ kind: "dev", repo: resolve(repositoryRoot) }),
      false,
      {
        dryRun: false,
        hooks: {
          afterFailureBeforeUnlock: async () => {
            contender = await tryPythonRecordLock(swapLockPath());
            await unlink(info.configPath);
            await rename(displaced, info.configPath);
          },
          afterStaging: async () => {
            await rename(info.configPath, displaced);
            await link(swapLockPath(), info.configPath);
          },
        },
        skipPreflight: true,
      },
    );

    await expect(mutation).rejects.toThrow(/config.*changed|does not match|aliases swap lock/u);
    expect(contender).toBe("blocked");
    expect(await tryPythonRecordLock(swapLockPath())).toBe("acquired");
    expect(await readFile(info.configPath, "utf8")).toBe(original);
  });

  test("keeps the worker lock through native recovery hardlink-alias rejection", async () => {
    const all = knownClis({ XDG_CONFIG_HOME: join(home, ".config") }, home);
    const info = cliFor("cursor");
    const backup = firstNativeBackupPath(info, 0);
    const original = originalConfig(info);
    await seed(info, original);
    let contender = "not-run";

    const mutation = useNativeConfigs(
      all,
      [info],
      "libtmux",
      resolve(repositoryRoot),
      "user",
      buildSpec({ kind: "dev", repo: resolve(repositoryRoot) }),
      false,
      {
        dryRun: false,
        hooks: {
          afterFailureBeforeUnlock: async () => {
            contender = await tryPythonRecordLock(swapLockPath());
            await unlink(backup);
          },
          afterStaging: () => link(swapLockPath(), backup),
        },
        skipPreflight: true,
      },
    );

    await expect(mutation).rejects.toThrow(
      /backup.*(?:appeared|already exists|aliases swap lock)/u,
    );
    expect(contender).toBe("blocked");
    expect(await tryPythonRecordLock(swapLockPath())).toBe("acquired");
    expect(await readFile(info.configPath, "utf8")).toBe(original);
    expect(await Bun.file(nativeStatePath()).exists()).toBe(false);
  });

  test("keeps one authenticated persistent lock across use and revert", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));

    expect(
      (await runSwap(["use", "--source", "dev", "--no-preflight", "--cli", "cursor"])).status,
    ).toBe(0);
    const lock = swapLockPath();
    const before = await pathIdentity(lock);
    const metadata = await stat(lock);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);

    expect((await runSwap(["revert", "--cli", "cursor"])).status).toBe(0);
    expect(await pathIdentity(lock)).toBe(before);
    expect((await stat(lock)).nlink).toBe(1);
  });

  test("kernel-releases the record lock when the lock worker dies", async () => {
    const lock = swapLockPath();
    const directory = dirname(lock);
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    const worker = Bun.spawn(
      [
        process.execPath,
        join(repositoryRoot, "scripts", "mcp_swap.ts"),
        "__mcp-swap-lock-worker",
        directory,
        basename(lock),
      ],
      { stderr: "pipe", stdin: "pipe", stdout: "pipe" },
    );
    const reader = worker.stdout.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('"kind":"acquired"');
    expect(await tryPythonRecordLock(lock)).toBe("blocked");

    worker.kill("SIGKILL");
    await worker.exited;
    await waitForPythonRecordLock(lock);
  });

  test("does not orphan the lock owner when the parent dies", async () => {
    const info = cliFor("cursor");
    const marker = join(home, "parent-held-lock");
    const helper = join(home, "parent-lock-helper.ts");
    const swapModule = join(repositoryRoot, "scripts", "mcp_swap.ts");
    await seed(info, originalConfig(info));
    await writeFile(
      helper,
      `
        const swap = await import(${JSON.stringify(swapModule)});
        const home = process.env.HOME;
        const all = swap.knownClis({ XDG_CONFIG_HOME: home + "/.config" }, home);
        const cursor = all.find((candidate) => candidate.name === "cursor");
        await swap.useNativeConfigs(
          all,
          [cursor],
          "libtmux",
          ${JSON.stringify(resolve(repositoryRoot))},
          "user",
          swap.buildSpec({ kind: "dev", repo: ${JSON.stringify(resolve(repositoryRoot))} }),
          false,
          {
            dryRun: false,
            hooks: { afterLockAcquired: async () => {
              await Bun.write(${JSON.stringify(marker)}, "held\\n");
              await new Promise(() => {});
            } },
            skipPreflight: true,
          },
        );
      `,
    );
    const parent = Bun.spawn([process.execPath, helper], {
      env: {
        ...process.env,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".local", "state"),
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    await waitForPath(marker);
    expect(await tryPythonRecordLock(swapLockPath())).toBe("blocked");

    parent.kill("SIGKILL");
    await parent.exited;
    await waitForPythonRecordLock(swapLockPath());
    expect(await readFile(info.configPath, "utf8")).toBe(originalConfig(info));
  });

  test.each(["symlink", "hardlink"] as const)(
    "rejects a selected config that aliases the lock by %s in use and dry-run",
    async (aliasKind) => {
      const info = cliFor("cursor");
      const lock = swapLockPath();
      await mkdir(dirname(lock), { mode: 0o700, recursive: true });
      await chmod(dirname(lock), 0o700);
      await writeFile(lock, originalConfig(info), { mode: 0o600 });
      await chmod(lock, 0o600);
      await mkdir(dirname(info.configPath), { recursive: true });
      if (aliasKind === "symlink") {
        await symlink(relative(dirname(info.configPath), lock), info.configPath);
      } else {
        await link(lock, info.configPath);
      }
      const before = await fileState(lock);

      const dryRun = await runSwap(["use", "--source", "dev", "--dry-run"]);
      expect(dryRun.status).toBe(1);
      expect(dryRun.stderr).toMatch(/lock/u);
      await expect(
        writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" })),
      ).rejects.toThrow(/lock/u);

      expect(await fileState(lock)).toEqual(before);
      expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(false);
    },
  );

  test("rechecks unselected client routes immediately before mutation", async () => {
    const selected = cliFor("cursor");
    const unselected = cliFor("gemini");
    await seed(selected, originalConfig(selected));
    await seed(unselected, originalConfig(unselected));
    const selectedBefore = await fileState(selected.configPath);
    let raced = false;

    await expect(
      writeServers(
        [selected],
        "libtmux",
        buildSpec({ kind: "dev", repo: "/repo" }),
        {
          beforeFileOperation: async ({ boundary }) => {
            if (raced || boundary !== "config-take-aside") return;
            raced = true;
            await rm(unselected.configPath);
            await symlink(selected.configPath, unselected.configPath);
          },
        },
        [selected, unselected],
      ),
    ).rejects.toThrow(/gemini .*config path changed/u);

    expect(raced).toBe(true);
    expect(await fileState(selected.configPath)).toEqual(selectedBefore);
    expect((await lstat(unselected.configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(unselected.configPath, "utf8")).toBe(selectedBefore.raw);
  });

  test.each([
    ["backup", "hardlink"],
    ["backup", "symlink"],
    ["state", "hardlink"],
    ["state", "symlink"],
  ] as const)(
    "rejects a recovery %s %s alias to the lock for repeat use and revert",
    async (artifact, aliasKind) => {
      const info = cliFor("cursor");
      await seed(info, originalConfig(info));
      await chmod(info.configPath, 0o600);
      await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
      const lock = swapLockPath();
      const recovery =
        artifact === "backup" ? backupPath(info.configPath) : backupRoutePath(info.configPath);
      await mkdir(dirname(lock), { mode: 0o700, recursive: true });
      await chmod(dirname(lock), 0o700);
      if (aliasKind === "hardlink") {
        await rm(lock, { force: true });
        await link(recovery, lock);
      } else {
        await rm(recovery);
        await symlink(relative(dirname(recovery), lock), recovery);
      }
      const before = await Promise.all(
        [info.configPath, backupPath(info.configPath), backupRoutePath(info.configPath), lock].map(
          fileState,
        ),
      );

      await expect(
        writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/two" })),
      ).rejects.toThrow(/lock|recovery/u);
      await expect(revertConfig(info)).rejects.toThrow(/lock|recovery/u);

      expect(
        await Promise.all(
          [
            info.configPath,
            backupPath(info.configPath),
            backupRoutePath(info.configPath),
            lock,
          ].map(fileState),
        ),
      ).toEqual(before);
    },
  );

  test.each(["symlink", "hardlink"] as const)(
    "rejects recovery state aliased to its backup by %s",
    async (aliasKind) => {
      const info = cliFor("cursor");
      await seed(info, originalConfig(info));
      await chmod(info.configPath, 0o600);
      await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
      const backup = backupPath(info.configPath);
      const state = backupRoutePath(info.configPath);
      await rm(state);
      if (aliasKind === "symlink") {
        await symlink(relative(dirname(state), backup), state);
      } else {
        await link(backup, state);
      }
      const before = await Promise.all([info.configPath, backup, state].map(fileState));

      await expect(
        writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/two" })),
      ).rejects.toThrow(/recovery route/u);
      await expect(revertConfig(info)).rejects.toThrow(/recovery route/u);

      expect(await Promise.all([info.configPath, backup, state].map(fileState))).toEqual(before);
    },
  );

  test.each([
    "mode",
    "link-count",
    "directory",
    "file-symlink",
    "directory-symlink",
    "directory-mode",
  ] as const)("rejects unsafe lock %s topology before live and dry-run writes", async (defect) => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    const lock = swapLockPath();
    const directory = dirname(lock);
    if (defect === "directory-symlink") {
      const target = join(home, "lock-directory-target");
      await mkdir(target, { mode: 0o700, recursive: true });
      await mkdir(dirname(directory), { recursive: true });
      await symlink(target, directory);
      await writeFile(join(target, "state.lock"), "", { mode: 0o600 });
    } else {
      await mkdir(directory, { mode: 0o700, recursive: true });
      await chmod(directory, defect === "directory-mode" ? 0o755 : 0o700);
      if (defect === "directory") {
        await mkdir(lock);
      } else if (defect === "file-symlink") {
        const target = join(home, "lock-target");
        await writeFile(target, "", { mode: 0o600 });
        await symlink(target, lock);
      } else {
        await writeFile(lock, "", { mode: defect === "mode" ? 0o640 : 0o600 });
        await chmod(lock, defect === "mode" ? 0o640 : 0o600);
        if (defect === "link-count") await link(lock, join(home, "extra-lock-link"));
      }
    }
    const configBefore = await fileState(info.configPath);
    const treeBefore = (await readdir(home, { recursive: true })).toSorted();

    const dryRun = await runSwap(["use", "--source", "dev", "--dry-run"]);
    expect(dryRun.status).toBe(1);
    expect(dryRun.stderr).toMatch(/lock/u);
    await expect(
      writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" })),
    ).rejects.toThrow(/lock/u);

    expect(await fileState(info.configPath)).toEqual(configBefore);
    expect((await readdir(home, { recursive: true })).toSorted()).toEqual(treeBefore);
  });

  test("re-plans under the acquired lock instead of committing stale bytes", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    const late = '{\n  "mcpServers": { "late": { "command": "human" } }\n}\n';
    let injected = false;
    const hooks: SwapTransactionHooks = {
      afterLockAcquired: async () => {
        injected = true;
        await writeFile(info.configPath, late);
      },
    };

    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }), hooks);

    expect(injected).toBe(true);
    expect(await readFile(backupPath(info.configPath), "utf8")).toBe(late);
  });

  test.each(["file", "directory"] as const)(
    "rejects a lock %s replaced after acquisition and preserves the replacement",
    async (replaced) => {
      const info = cliFor("cursor");
      await seed(info, originalConfig(info));
      const before = await fileState(info.configPath);
      const lock = swapLockPath();
      const replacement = join(home, "replacement-lock");
      await writeFile(replacement, "human lock replacement\n", { mode: 0o600 });
      const unexpectedIdentity = await pathIdentity(replacement);

      await expect(
        writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }), {
          afterLockAcquired: async () => {
            if (replaced === "directory") {
              await rename(dirname(lock), `${dirname(lock)}.replaced`);
              await mkdir(dirname(lock), { mode: 0o700 });
            }
            await rename(replacement, lock);
          },
        }),
      ).rejects.toThrow(/lock/u);

      expect(await fileState(info.configPath)).toEqual(before);
      expect(await identitySurvives(unexpectedIdentity)).toBe(true);
      expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(false);
    },
  );

  test.each(FORWARD_BOUNDARIES)(
    "preserves a late %s replacement at %s %s",
    async (side, operation, boundary) => {
      const info = cliFor("cursor");
      await prepareSwap(operation, [info]);
      const probe = replacementProbe(operation, boundary, side);

      await expect(
        runTransaction(operation, [info], { beforeFileOperation: probe.hook }),
      ).rejects.toThrow();

      expect(probe.identity()).toBeDefined();
      expect(await identitySurvives(probe.identity()!)).toBe(true);
    },
  );

  test.each(
    ROLLBACK_BOUNDARIES.flatMap(([operation, boundary]) =>
      (["source", "destination"] as const).map(
        (replacement) => [operation, boundary, replacement] as const,
      ),
    ),
  )(
    "preserves a late %s rollback replacement at %s %s",
    async (operation, boundary, replacement) => {
      const infos = [cliFor("claude"), cliFor("cursor")];
      await prepareSwap(operation, infos);
      const probe = replacementProbe(operation, boundary, replacement);
      const hooks: SwapTransactionHooks = {
        beforeConfigCommit: (_info, index) => {
          if (
            (boundary.startsWith("config-rollback") && index === 1) ||
            (!boundary.startsWith("config-rollback") && operation !== "revert" && index === 0)
          ) {
            throw new Error("injected commit failure");
          }
        },
        beforeFileOperation: probe.hook,
        beforeRecoveryRetire: (_info, index) => {
          if (operation === "revert" && !boundary.startsWith("config-rollback") && index === 1) {
            throw new Error("injected retirement failure");
          }
        },
      };

      await expect(runTransaction(operation, infos, hooks)).rejects.toThrow();

      expect(probe.identity()).toBeDefined();
      expect(await identitySurvives(probe.identity()!)).toBe(true);
    },
  );

  test("retains every prior recovery identity when repeat-use rollback is blocked", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    await chmod(info.configPath, 0o600);
    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
    const priorIdentities = await Promise.all(
      [info.configPath, backupPath(info.configPath), backupRoutePath(info.configPath)].map(
        pathIdentity,
      ),
    );
    let unexpectedIdentity: string | undefined;

    await expect(
      writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/two" }), {
        beforeConfigCommit: () => {
          throw new Error("injected repeat-use failure");
        },
        beforeFileOperation: async (event) => {
          if (event.boundary !== "state-rollback-publish" || event.destination === undefined)
            return;
          await writeFile(event.destination, "human rollback destination\n", { mode: 0o600 });
          unexpectedIdentity = await pathIdentity(event.destination);
        },
      }),
    ).rejects.toThrow(/rollback/u);

    for (const identity of priorIdentities) {
      // eslint-disable-next-line no-await-in-loop -- every pre-call identity must remain recoverable.
      expect(await identitySurvives(identity)).toBe(true);
    }
    expect(unexpectedIdentity).toBeDefined();
    expect(await identitySurvives(unexpectedIdentity!)).toBe(true);
  });

  test.each(["config commit", "recovery retirement"] as const)(
    "rolls back an earlier %s with exact inode identities",
    async (failure) => {
      const infos = [cliFor("claude"), cliFor("cursor")];
      await Promise.all(infos.map(async (info) => seed(info, originalConfig(info))));
      await writeServers(infos, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
      const paths = infos.flatMap((info) => [
        info.configPath,
        backupPath(info.configPath),
        backupRoutePath(info.configPath),
      ]);
      const before = await Promise.all(paths.map(fileState));
      const failLater = (_info: CliInfo, index: number): void => {
        if (index === 1) throw new Error("injected later restore failure");
      };

      await expect(
        revertConfigs(
          infos,
          failure === "config commit"
            ? { beforeConfigCommit: failLater }
            : { beforeRecoveryRetire: failLater },
        ),
      ).rejects.toThrow(/injected later restore failure/u);

      expect(await Promise.all(paths.map(fileState))).toEqual(before);
      expect(
        (await readdir(home, { recursive: true })).some((path) => /\.mcp-swap-\d+-/u.test(path)),
      ).toBe(false);
    },
  );

  test.each(["symlink", "hardlink"] as const)(
    "rejects selected configs that alias one target by %s",
    async (aliasKind) => {
      const first = cliFor("claude");
      const later = { ...cliFor("cursor"), name: first.name };
      const target = join(home, "dotfiles", "shared.json");
      const original = '{\n  "mcpServers": { "keep": { "command": "other" } }\n}\n';
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, original);
      await Promise.all(
        [first, later].map(async (info) => {
          await mkdir(dirname(info.configPath), { recursive: true });
          if (aliasKind === "symlink") {
            await symlink(relative(dirname(info.configPath), target), info.configPath);
          } else {
            await link(target, info.configPath);
          }
        }),
      );

      await expect(
        writeServers([first, later], "libtmux", buildSpec({ kind: "dev", repo: "/repo" })),
      ).rejects.toThrow(/same resolved target|same transaction artifact/u);

      expect(await readFile(target, "utf8")).toBe(original);
      expect((await lstat(first.configPath)).isSymbolicLink()).toBe(aliasKind === "symlink");
      expect((await lstat(later.configPath)).isSymbolicLink()).toBe(aliasKind === "symlink");
      expect(await Bun.file(backupPath(first.configPath)).exists()).toBe(false);
      expect(await Bun.file(backupPath(later.configPath)).exists()).toBe(false);
    },
  );

  test.each([
    ["backup", "symlink"],
    ["backup", "hardlink"],
    ["state", "symlink"],
    ["state", "hardlink"],
  ] as const)(
    "rejects a config target aliased to another client's %s by %s",
    async (artifact, aliasKind) => {
      const first = cliFor("claude");
      const later = cliFor("cursor");
      const original = originalConfig(first);
      await seed(first, original);
      const firstUse = await runSwap([
        "use",
        "--source",
        "dev",
        "--repo",
        repositoryRoot,
        "--no-preflight",
        "--scope",
        "user",
        "--cli",
        "claude",
      ]);
      expect(firstUse.status).toBe(0);
      await mkdir(dirname(later.configPath), { recursive: true });
      const entry = await nativeRecoveryEntry("claude:user");
      const aliased = artifact === "backup" ? (entry.backupPath as string) : nativeStatePath();
      if (aliasKind === "symlink") {
        await symlink(relative(dirname(later.configPath), aliased), later.configPath);
      } else {
        await link(aliased, later.configPath);
      }
      const firstBefore = await readFile(first.configPath, "utf8");
      const artifactBefore = await readFile(aliased, "utf8");
      const artifactIdentity = await pathIdentity(aliased);

      const args = [
        "use",
        "--source",
        "dev",
        "--repo",
        repositoryRoot,
        "--scope",
        "user",
        "--cli",
        "claude,cursor",
      ];
      const dryRun = await runSwap([...args, "--dry-run"]);
      expect(dryRun.status).toBe(1);
      expect(dryRun.stderr).toMatch(/aliases/u);
      expect(dryRun.stdout).not.toContain("would update");

      const live = await runSwap([...args, "--no-preflight"]);
      expect(live.status).toBe(1);
      expect(live.stderr).toMatch(/aliases/u);

      expect(await readFile(first.configPath, "utf8")).toBe(firstBefore);
      expect(await readFile(aliased, "utf8")).toBe(artifactBefore);
      expect(await pathIdentity(aliased)).toBe(artifactIdentity);
      expect(await readFile(later.configPath, "utf8")).toBe(artifactBefore);
    },
  );

  test.each(["symlink", "file"] as const)(
    "refuses a config link replaced by a %s after staging",
    async (replacementKind) => {
      const info = cliFor("cursor");
      const original = '{\n  "mcpServers": {}\n}\n';
      const { target } = await seedSymlink(info, original, 0o640);
      const replacementTarget = join(home, "dotfiles", "replacement.json");
      const replacement = '{\n  "sentinel": "unchanged"\n}\n';
      await writeFile(replacementTarget, replacement);

      const pending = writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }), {
        afterStaging: async () => {
          await rm(info.configPath);
          if (replacementKind === "symlink") {
            await symlink(relative(dirname(info.configPath), replacementTarget), info.configPath);
          } else {
            await writeFile(info.configPath, replacement);
          }
        },
      });

      await expect(pending).rejects.toThrow(/config.*changed/u);

      expect(await readFile(target, "utf8")).toBe(original);
      expect(await readFile(replacementTarget, "utf8")).toBe(replacement);
      expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(false);
    },
  );

  test("refuses a config link retargeted after backup commit", async () => {
    const raw = '{\n  "mcpServers": { "keep": { "command": "other" } }\n}\n';
    const earlier = Array.from({ length: 40 }, (_, index): CliInfo => ({
      binary: `earlier-${index}`,
      configPath: join(home, "earlier", `${index}.json`),
      container: ["mcpServers"],
      dialect: "standard",
      format: "json",
      name: `earlier-${index}`,
    }));
    await Promise.all(earlier.map(async (info) => seed(info, raw)));
    const later = cliFor("cursor");
    const { target } = await seedSymlink(later, raw, 0o640);
    const replacementTarget = join(home, "dotfiles", "retargeted.json");
    const replacement = '{\n  "sentinel": "unchanged"\n}\n';
    await writeFile(replacementTarget, replacement);

    const pending = writeServers(
      [...earlier, later],
      "libtmux",
      buildSpec({ kind: "dev", repo: "/repo" }),
    );
    await waitForPath(backupPath(later.configPath));
    await rm(later.configPath);
    await symlink(relative(dirname(later.configPath), replacementTarget), later.configPath);

    await expect(pending).rejects.toThrow(/config.*changed/u);
    expect(await readFile(target, "utf8")).toBe(raw);
    expect(await readFile(replacementTarget, "utf8")).toBe(replacement);
    await Promise.all(
      earlier.map(async (info) => {
        expect(await readFile(info.configPath, "utf8")).toBe(raw);
        expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(false);
      }),
    );
  });

  test("retains and names recovery units whose rollback fails in reverse order", async () => {
    const raw = '{\n  "mcpServers": { "keep": { "command": "other" } }\n}\n';
    const info = (name: string): CliInfo => ({
      binary: name,
      configPath: join(home, "rollback", `${name}.json`),
      container: ["mcpServers"],
      dialect: "standard",
      format: "json",
      name,
    });
    const first = info("first");
    const second = info("second");
    const middle = Array.from({ length: 120 }, (_, index) => info(`middle-${index}`));
    const later = info("later");
    const firstSeed = await seedSymlink(first, raw, 0o640);
    const secondSeed = await seedSymlink(second, raw, 0o640);
    const laterSeed = await seedSymlink(later, raw, 0o640);
    await Promise.all(middle.map(async (entry) => seed(entry, raw)));

    const replacement = '{\n  "sentinel": "untouched"\n}\n';
    const replacementTarget = join(home, "dotfiles", "rollback-replacement.json");
    await writeFile(replacementTarget, replacement);
    const replacementLinks = [first, second, later].map(
      (entry) => `${entry.configPath}.replacement`,
    );
    await Promise.all(
      replacementLinks.map(async (path) => {
        await symlink(relative(dirname(path), replacementTarget), path);
      }),
    );

    const pending = writeServers(
      [first, second, ...middle, later],
      "libtmux",
      buildSpec({ kind: "dev", repo: "/repo" }),
    );
    await waitForFileChange(secondSeed.target, raw);
    await rename(replacementLinks[0]!, first.configPath);
    await rename(replacementLinks[1]!, second.configPath);
    await rename(replacementLinks[2]!, later.configPath);

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    const rollbackMessages = failure.errors
      .slice(1)
      .map((error: unknown) => (error as Error).message);
    expect(rollbackMessages[0]).toContain(second.configPath);
    expect(rollbackMessages[1]).toContain(first.configPath);

    for (const entry of [first, second]) {
      expect(failure.message).toContain(backupPath(entry.configPath));
      expect(failure.message).toContain(backupRoutePath(entry.configPath));
    }
    const retainedState = await Promise.all(
      [first, second].map(async (entry) => ({
        backupMode: (await stat(backupPath(entry.configPath))).mode & 0o777,
        raw: await readFile(backupPath(entry.configPath), "utf8"),
        routeMode: (await stat(backupRoutePath(entry.configPath))).mode & 0o777,
      })),
    );
    expect(retainedState).toEqual([
      { backupMode: 0o640, raw, routeMode: 0o600 },
      { backupMode: 0o640, raw, routeMode: 0o600 },
    ]);
    expect(await readFile(firstSeed.target, "utf8")).not.toBe(raw);
    expect(await readFile(secondSeed.target, "utf8")).not.toBe(raw);
    expect(await readFile(replacementTarget, "utf8")).toBe(replacement);

    const middleState = await Promise.all(
      middle.map(async (entry) => ({
        backup: await Bun.file(backupPath(entry.configPath)).exists(),
        raw: await readFile(entry.configPath, "utf8"),
        route: await Bun.file(backupRoutePath(entry.configPath)).exists(),
      })),
    );
    expect(middleState).toEqual(middle.map(() => ({ backup: false, raw, route: false })));
    expect(await readFile(laterSeed.target, "utf8")).toBe(raw);
    expect(await Bun.file(backupPath(later.configPath)).exists()).toBe(false);
    expect(await Bun.file(backupRoutePath(later.configPath)).exists()).toBe(false);
  });

  test("removes a new backup when route publication loses a race", async () => {
    const info = cliFor("cursor");
    const original = '{\n  "mcpServers": {}\n}\n';
    const { target } = await seedSymlink(info, original, 0o640);
    const routePath = backupRoutePath(info.configPath);
    const intruder = "do not replace\n";

    const swap = writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }), {
      afterStaging: () => writeFile(routePath, intruder),
    });

    await expect(swap).rejects.toThrow(/recovery route.*changed/u);
    expect(await readFile(target, "utf8")).toBe(original);
    expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(false);
    expect(await readFile(routePath, "utf8")).toBe(intruder);
  });

  test.each(["directory", "symlink", "malformed", "oversized", "wrong-mode"] as const)(
    "rejects a %s recovery route sidecar",
    async (kind) => {
      const info = cliFor("cursor");
      const original = originalConfig(info);
      const { target } = await seedSymlink(info, original, 0o640);
      await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
      const before = await readFile(target, "utf8");
      const sidecar = backupRoutePath(info.configPath);
      const validSidecar = await readFile(sidecar, "utf8");
      await rm(sidecar, { force: true, recursive: true });
      if (kind === "directory") {
        await mkdir(sidecar);
      } else if (kind === "symlink") {
        const other = join(home, "route-record.json");
        await writeFile(other, "{}\n");
        await symlink(other, sidecar);
      } else if (kind === "malformed") {
        await writeFile(sidecar, "{ malformed\n", { mode: 0o600 });
      } else if (kind === "oversized") {
        await writeFile(sidecar, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
      } else {
        await writeFile(sidecar, validSidecar, { mode: 0o640 });
        await chmod(sidecar, 0o640);
      }

      await expect(
        writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/two" })),
      ).rejects.toThrow(/recovery route/u);

      expect(await readFile(target, "utf8")).toBe(before);
      expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(true);
    },
  );

  test.each(["symlink", "same-target-symlink", "file"] as const)(
    "refuses revert after the config link becomes a %s",
    async (replacementKind) => {
      const info = cliFor("cursor");
      const original = originalConfig(info);
      const { target } = await seedSymlink(info, original, 0o640);
      await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
      const swapped = await readFile(target, "utf8");
      const replacementTarget = join(home, "dotfiles", "revert-replacement.json");
      const replacement = '{\n  "sentinel": "unchanged"\n}\n';
      await writeFile(replacementTarget, replacement);
      await rm(info.configPath);
      if (replacementKind.endsWith("symlink")) {
        const nextTarget = replacementKind === "same-target-symlink" ? target : replacementTarget;
        await symlink(relative(dirname(info.configPath), nextTarget), info.configPath);
      } else {
        await writeFile(info.configPath, replacement);
      }

      await expect(revertConfig(info)).rejects.toThrow(/config.*changed/u);

      expect(await readFile(target, "utf8")).toBe(swapped);
      expect(await readFile(replacementTarget, "utf8")).toBe(replacement);
      expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(true);
      expect(await Bun.file(backupRoutePath(info.configPath)).exists()).toBe(true);
    },
  );

  test("refuses an in-place edit after use and retains recovery", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
    const backupIdentity = await pathIdentity(backupPath(info.configPath));
    const routeIdentity = await pathIdentity(backupRoutePath(info.configPath));
    const edited = '{\n  "human": "edit"\n}\n';
    await writeFile(info.configPath, edited);

    await expect(revertConfig(info)).rejects.toThrow(/config.*changed since swap/u);

    expect(await readFile(info.configPath, "utf8")).toBe(edited);
    expect(await pathIdentity(backupPath(info.configPath))).toBe(backupIdentity);
    expect(await pathIdentity(backupRoutePath(info.configPath))).toBe(routeIdentity);
  });

  test("refuses a mode change after use and retains recovery", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    await chmod(info.configPath, 0o600);
    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
    const backupIdentity = await pathIdentity(backupPath(info.configPath));
    const routeIdentity = await pathIdentity(backupRoutePath(info.configPath));
    await chmod(info.configPath, 0o640);

    await expect(revertConfig(info)).rejects.toThrow(/config.*changed since swap/u);

    expect((await stat(info.configPath)).mode & 0o777).toBe(0o640);
    expect(await pathIdentity(backupPath(info.configPath))).toBe(backupIdentity);
    expect(await pathIdentity(backupRoutePath(info.configPath))).toBe(routeIdentity);
  });

  test.each(["contents", "inode", "mode"] as const)(
    "refuses recovery backup %s changes",
    async (change) => {
      const info = cliFor("cursor");
      await seed(info, originalConfig(info));
      await chmod(info.configPath, 0o600);
      await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
      const swapped = await readFile(info.configPath, "utf8");
      const sidecarIdentity = await pathIdentity(backupRoutePath(info.configPath));
      const backup = backupPath(info.configPath);
      if (change === "contents") {
        await writeFile(backup, '{\n  "tampered": true\n}\n');
      } else if (change === "inode") {
        const replacement = `${backup}.replacement`;
        await writeFile(replacement, originalConfig(info), { mode: 0o600 });
        await rename(replacement, backup);
      } else {
        await chmod(backup, 0o640);
      }
      const backupIdentity = await pathIdentity(backup);

      await expect(revertConfig(info)).rejects.toThrow(/recovery backup changed since swap/u);

      expect(await readFile(info.configPath, "utf8")).toBe(swapped);
      expect(await pathIdentity(backup)).toBe(backupIdentity);
      expect(await pathIdentity(backupRoutePath(info.configPath))).toBe(sidecarIdentity);
    },
  );

  test.each(["regular", "symlink"] as const)(
    "refuses a same-path %s target replacement after use",
    async (kind) => {
      const info = cliFor("cursor");
      const original = originalConfig(info);
      let target: string;
      if (kind === "symlink") {
        target = (await seedSymlink(info, original, 0o640)).target;
      } else {
        await seed(info, original);
        target = info.configPath;
      }
      await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
      const backupIdentity = await pathIdentity(backupPath(info.configPath));
      const routeIdentity = await pathIdentity(backupRoutePath(info.configPath));
      const replacement = '{\n  "replacement": true\n}\n';
      const temporary = `${target}.replacement`;
      await writeFile(temporary, replacement);
      await rename(temporary, target);

      await expect(revertConfig(info)).rejects.toThrow(/config.*changed since swap/u);

      expect(await readFile(target, "utf8")).toBe(replacement);
      expect(await pathIdentity(backupPath(info.configPath))).toBe(backupIdentity);
      expect(await pathIdentity(backupRoutePath(info.configPath))).toBe(routeIdentity);
    },
  );

  test("updates recovery ownership on repeat use", async () => {
    const info = cliFor("cursor");
    const original = originalConfig(info);
    await seed(info, original);
    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
    const firstRoute = await readFile(backupRoutePath(info.configPath), "utf8");
    const firstRouteIdentity = await pathIdentity(backupRoutePath(info.configPath));

    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/two" }));

    const secondRoute = await readFile(backupRoutePath(info.configPath), "utf8");
    expect(secondRoute).not.toBe(firstRoute);
    expect(await pathIdentity(backupRoutePath(info.configPath))).not.toBe(firstRouteIdentity);
    expect(JSON.parse(secondRoute)).toMatchObject({
      backupIdentity: await pathIdentity(backupPath(info.configPath)),
      targetIdentity: await pathIdentity(info.configPath),
      version: 2,
    });
    expect(await revertConfig(info)).toBe(true);
    expect(await readFile(info.configPath, "utf8")).toBe(original);
  });

  test("restores an existing recovery sidecar inode when repeat use fails", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
    const configBefore = await pathIdentity(info.configPath);
    const backupBefore = await pathIdentity(backupPath(info.configPath));
    const routeBefore = await pathIdentity(backupRoutePath(info.configPath));

    await expect(
      writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/two" }), {
        beforeConfigCommit: () => {
          throw new Error("injected config commit failure");
        },
      }),
    ).rejects.toThrow(/injected config commit failure/u);

    expect(await pathIdentity(info.configPath)).toBe(configBefore);
    expect(await pathIdentity(backupPath(info.configPath))).toBe(backupBefore);
    expect(await pathIdentity(backupRoutePath(info.configPath))).toBe(routeBefore);
    expect(
      (await readdir(dirname(info.configPath))).some((name) => /\.mcp-swap-\d+-/u.test(name)),
    ).toBe(false);
  });

  test("refuses a legacy symlink backup without route metadata", async () => {
    const info = cliFor("cursor");
    const original = originalConfig(info);
    const { target } = await seedSymlink(info, original, 0o640);
    await writeFile(backupPath(info.configPath), original, { mode: 0o640 });

    await expect(revertConfig(info)).rejects.toThrow(/legacy.*symlink/u);

    expect(await readFile(target, "utf8")).toBe(original);
    expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(true);
  });

  test("preflights every selected config before changing any", async () => {
    const first = cliFor("claude");
    const later = cliFor("cursor");
    const original = '{\n  "mcpServers": { "keep": { "command": "first" } }\n}\n';
    await seed(first, original);
    await seed(later, '{ "mcpServers": { broken } }\n');
    await chmod(first.configPath, 0o600);
    await chmod(later.configPath, 0o640);

    const { status, stderr } = await runSwap([
      "use",
      "--source",
      "dev",
      "--repo",
      repositoryRoot,
      "--no-preflight",
    ]);

    expect(status).toBe(1);
    expect(stderr).toContain("cursor");
    expect(await readFile(first.configPath, "utf8")).toBe(original);
    expect((await stat(first.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(later.configPath)).mode & 0o777).toBe(0o640);
    expect(await Bun.file(backupPath(first.configPath)).exists()).toBe(false);
    expect(await Bun.file(backupPath(later.configPath)).exists()).toBe(false);
    expect(
      (await readdir(join(first.configPath, ".."))).some((name) => name.includes("mcp-swap")),
    ).toBe(false);
  });

  test("a failed server preflight writes no config or backup", async () => {
    const info = cliFor("claude");
    const checkout = join(home, "broken-checkout");
    const original = originalConfig(info);
    await seed(info, original);
    await chmod(info.configPath, 0o600);
    await mkdir(join(checkout, "packages", "mcp", "src"), { recursive: true });
    await writeFile(join(checkout, "packages", "mcp", "src", "server.ts"), "process.exit(1);\n");

    const { status, stderr } = await runSwap([
      "use",
      "--source",
      "dev",
      "--repo",
      checkout,
      "--cli",
      "claude",
    ]);

    expect(status).toBe(1);
    expect(stderr).toContain("did not answer");
    expect(await readFile(info.configPath, "utf8")).toBe(original);
    expect((await stat(info.configPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(false);
    expect(await Bun.file(nativeStatePath()).exists()).toBe(false);
    expect(await Bun.file(swapLockPath()).exists()).toBe(false);
  });

  test.serial("preserves a private mode through swap and revert", async () => {
    const previousUmask = process.umask(0o022);
    try {
      const info = cliFor("cursor");
      const original = '{\n  "mcpServers": {}\n}\n';
      await seed(info, original);
      await chmod(info.configPath, 0o600);

      await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));

      expect((await stat(info.configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(backupPath(info.configPath))).mode & 0o777).toBe(0o600);

      expect(await revertConfig(info)).toBe(true);
      expect(await readFile(info.configPath, "utf8")).toBe(original);
      expect((await stat(info.configPath)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("writes, reads back, and reverts to the original bytes", async () => {
    const info = cliFor("opencode");
    const original =
      '{\n  // mine\n  "mcp": {\n    "other": { "type": "local", "command": ["keep"] }\n  }\n}\n';
    await seed(info, original);

    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));

    expect(await readServer(info, "libtmux")).toMatchObject({ command: "bun" });
    // The other server and the comment are still exactly as they were.
    expect(await readFile(info.configPath, "utf8")).toContain("// mine");
    expect(await readServer(info, "other")).toMatchObject({ command: "keep" });

    expect(await revertConfig(info)).toBe(true);
    expect(await readFile(info.configPath, "utf8")).toBe(original);
  });

  test("keeps the first backup, so revert undoes every swap at once", async () => {
    const info = cliFor("cursor");
    const original = '{\n  "mcpServers": {}\n}\n';
    const { linkTarget, target } = await seedSymlink(info, original, 0o640);

    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
    const firstBackup = await readFile(backupPath(info.configPath));
    const firstRoute = await readFile(backupRoutePath(info.configPath));
    await writeServer(info, "libtmux", buildSpec({ kind: "build", repo: "/two" }));
    await writeServer(info, "libtmux", buildSpec({ kind: "published", version: "9" }));
    expect(await readFile(backupPath(info.configPath))).toEqual(firstBackup);
    expect(await readFile(backupRoutePath(info.configPath))).not.toEqual(firstRoute);
    await revertConfig(info);

    // Not the state before the last swap — the state before any of them.
    expect((await lstat(info.configPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(info.configPath)).toBe(linkTarget);
    expect(await readFile(target, "utf8")).toBe(original);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(false);
    expect(await Bun.file(backupRoutePath(info.configPath)).exists()).toBe(false);
  });

  test("creates a config for a CLI that has none", async () => {
    const info = cliFor("gemini");

    await writeServer(info, "libtmux", buildSpec({ kind: "published", version: "1" }));

    expect(await readServer(info, "libtmux")).toMatchObject({ command: "npx" });
  });

  test("reverts a TOML config to its original bytes", async () => {
    const info = cliFor("codex");
    const original = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "keep"\n';
    await seed(info, original);

    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
    expect(await readServer(info, "libtmux")).toMatchObject({ command: "bun" });

    await revertConfig(info);
    expect(await readFile(info.configPath, "utf8")).toBe(original);
  });

  test("says a config was never swapped rather than inventing a backup", async () => {
    const info = cliFor("cursor");
    await seed(info, "{}\n");

    expect(await revertConfig(info)).toBe(false);
  });

  test("takes no backup of a file that does not exist yet", async () => {
    const info = cliFor("gemini");
    expect(await backupOnce(info.configPath)).toBeUndefined();
    expect(backupPath(info.configPath)).toBe(`${info.configPath}.mcp-swap-backup`);
  });

  test("backs up a symlink as an authenticated recovery unit", async () => {
    const info = cliFor("cursor");
    const original = originalConfig(info);
    const { linkTarget, target } = await seedSymlink(info, original, 0o640);

    expect(await backupOnce(info.configPath)).toBe(backupPath(info.configPath));
    expect(await readFile(backupPath(info.configPath), "utf8")).toBe(original);
    expect((await stat(backupRoutePath(info.configPath))).mode & 0o777).toBe(0o600);
    expect((await lstat(info.configPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(info.configPath)).toBe(linkTarget);

    expect(await revertConfig(info)).toBe(true);
    expect(await readFile(target, "utf8")).toBe(original);
    expect(await Bun.file(backupRoutePath(info.configPath)).exists()).toBe(false);
  });

  test("backupOnce rejects a malformed existing recovery unit", async () => {
    const info = cliFor("cursor");
    await seedSymlink(info, originalConfig(info), 0o640);
    await backupOnce(info.configPath);
    await writeFile(backupRoutePath(info.configPath), "{}\n", { mode: 0o600 });

    await expect(backupOnce(info.configPath)).rejects.toThrow(/recovery route/u);
  });
});

describe("dry-run", () => {
  async function configState(infos: readonly CliInfo[]): Promise<unknown> {
    return Promise.all(
      infos.map(async (info) => ({
        mode: (await stat(info.configPath)).mode & 0o777,
        name: info.name,
        raw: await readFile(info.configPath, "utf8"),
      })),
    );
  }

  async function corruptedNativePair(): Promise<readonly string[]> {
    const first = cliFor("claude");
    const later = cliFor("cursor");
    await seed(first, originalConfig(first));
    await seed(later, originalConfig(later));
    const used = await runSwap([
      "use",
      "--source",
      "dev",
      "--no-preflight",
      "--scope",
      "user",
      "--cli",
      "claude,cursor",
    ]);
    expect(used.status).toBe(0);
    const firstEntry = await nativeRecoveryEntry("claude:user");
    const laterEntry = await nativeRecoveryEntry("cursor:user");
    const laterBackup = laterEntry.backupPath as string;
    await writeFile(laterBackup, "corrupted recovery\n", { mode: 0o600 });
    return [
      first.configPath,
      later.configPath,
      firstEntry.backupPath as string,
      laterBackup,
      nativeStatePath(),
    ];
  }

  test("selects repeatable client flags in canonical order without duplicates", async () => {
    const infos = await seedAllClients();
    const beforeState = await configState(infos);

    const result = await runSwap([
      "use",
      "--source",
      "dev",
      "--dry-run",
      "--cli",
      "cursor",
      "--client",
      "claude",
      "--cli",
      "cursor",
      "--client",
      "antigravity",
      "--cli",
      "agy",
    ]);

    expect(result.status).toBe(0);
    expect(
      result.stdout
        .split("\n")
        .filter((line) => line.startsWith("would update "))
        .map((line) => /^would update ([^ ]+)/u.exec(line)?.[1]),
    ).toEqual(["claude:project", "cursor", "agy"]);
    expect(await configState(infos)).toEqual(beforeState);
  });

  test.each(["use", "revert"] as const)(
    "refuses %s when a selected config aliases an unselected client",
    async (command) => {
      const selected = cliFor("cursor");
      const unselected = cliFor("gemini");
      await seed(unselected, originalConfig(unselected));
      await mkdir(dirname(selected.configPath), { recursive: true });
      await symlink(unselected.configPath, selected.configPath);
      if (command === "revert") {
        await writeServers([selected], "libtmux", buildSpec({ kind: "dev", repo: "/first" }));
      }
      const before = await fileState(unselected.configPath);

      const result = await runSwap(
        command === "use"
          ? ["use", "--source", "dev", "--no-preflight", "--cli", "cursor"]
          : ["revert", "--cli", "cursor"],
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/aliases|same resolved target|same transaction artifact/u);
      expect(result.stdout).not.toMatch(/updated|restored/u);
      expect(await fileState(unselected.configPath)).toEqual(before);
    },
  );

  test("rejects unknown options before planning writes", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    const before = await fileState(info.configPath);

    const result = await runSwap(["use", "--dry-run", "--definitely-invalid", "value"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown option --definitely-invalid");
    expect(result.stdout).not.toContain("would update");
    expect(await fileState(info.configPath)).toEqual(before);
  });

  test("rejects a client flag without a value before planning writes", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    const before = await fileState(info.configPath);

    const result = await runSwap(["use", "--dry-run", "--cli"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--cli wants a value");
    expect(result.stdout).not.toContain("would update");
    expect(await fileState(info.configPath)).toEqual(before);
  });

  test("rejects an unknown client before planning writes", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));
    const before = await fileState(info.configPath);

    const result = await runSwap(["use", "--dry-run", "--cli", "clod"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown client clod");
    expect(result.stdout).not.toContain("would update");
    expect(await fileState(info.configPath)).toEqual(before);
  });

  test("defaults dev registration to this checkout", async () => {
    const info = cliFor("cursor");
    await seed(info, originalConfig(info));

    const result = await runSwap(["use", "--source", "dev", "--dry-run", "--cli", "cursor"], {
      PATH: join(home, "empty-path"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `dev: bun run ${join(repositoryRoot, "packages", "mcp", "src", "server.ts")}`,
    );
  });

  test("validates all eight clients without starting the build server or writing", async () => {
    const infos = await seedAllClients();
    const bin = join(home, "bin");
    const serverMarker = join(home, "server-started");
    await mkdir(bin);
    await writeFile(join(bin, "node"), `#!/bin/sh\n: > ${JSON.stringify(serverMarker)}\nexit 1\n`);
    await chmod(join(bin, "node"), 0o700);
    const beforeState = await configState(infos);
    const beforeTree = (await readdir(home, { recursive: true })).toSorted();

    const result = await runSwap(
      [
        "use",
        "--source",
        "build",
        "--repo",
        repositoryRoot,
        "--dry-run",
        "--cli",
        CLI_NAMES.join(","),
      ],
      { PATH: bin },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const info of infos) {
      const label = info.name === "claude" ? "claude:project" : info.name;
      expect(result.stdout).toContain(`would update ${label}`);
    }
    expect(await configState(infos)).toEqual(beforeState);
    expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);
    expect(await Bun.file(serverMarker).exists()).toBe(false);
  });

  test("rejects a malformed later config without writes or success claims", async () => {
    const infos = await seedAllClients();
    const later = infos.at(-1)!;
    await writeFile(later.configPath, "{ malformed\n");
    const beforeState = await configState(infos);
    const beforeTree = (await readdir(home, { recursive: true })).toSorted();

    const result = await runSwap([
      "use",
      "--source",
      "dev",
      "--dry-run",
      "--cli",
      CLI_NAMES.join(","),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pi .*JSON Parse error/u);
    expect(result.stdout).not.toContain("would update");
    expect(await configState(infos)).toEqual(beforeState);
    expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);
  });

  test.each([
    ["claude", '{"note":"', '"}'],
    ["codex", "# keep ", '\nmodel = "gpt"\n'],
    ["opencode", "{// keep ", '\n"mcp": {}}'],
  ] as const)(
    "rejects malformed UTF-8 in %s without rewriting it",
    async (name, prefix, suffix) => {
      const info = cliFor(name);
      const malformed = Buffer.concat([
        Buffer.from(prefix),
        Buffer.from([0xc3, 0x28]),
        Buffer.from(suffix),
      ]);
      await mkdir(dirname(info.configPath), { recursive: true });
      await writeFile(info.configPath, malformed);

      const result = await runSwap(["use", "--source", "dev", "--dry-run", "--cli", name]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("UTF-8");
      expect(result.stdout).not.toContain("would update");
      expect(await readFile(info.configPath)).toEqual(malformed);
    },
  );

  test.each(["unusable backup", "unwritable destination"] as const)(
    "rejects an %s for a later client without writes",
    async (failure) => {
      const infos = await seedAllClients();
      const later = infos.at(-1)!;
      const directory = dirname(later.configPath);
      if (failure === "unusable backup") {
        await mkdir(firstNativeBackupPath(later, infos.length - 1));
      } else {
        await chmod(directory, 0o500);
      }
      const beforeState = await configState(infos);
      const beforeTree = (await readdir(home, { recursive: true })).toSorted();

      try {
        const result = await runSwap([
          "use",
          "--source",
          "dev",
          "--dry-run",
          "--cli",
          CLI_NAMES.join(","),
        ]);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/pi(?::user)? .*recovery backup|pi .*not writable/u);
        expect(result.stdout).not.toContain("would update");
        expect(await configState(infos)).toEqual(beforeState);
        expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);

        const live = await runSwap([
          "use",
          "--source",
          "dev",
          "--no-preflight",
          "--cli",
          CLI_NAMES.join(","),
        ]);
        expect(live.status).toBe(1);
        expect(live.stderr).toMatch(/recovery backup|not writable/u);
        expect(await configState(infos)).toEqual(beforeState);
        expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);
      } finally {
        if (failure === "unwritable destination") await chmod(directory, 0o700);
      }
    },
  );

  test("validates every selected revert before reporting success", async () => {
    const paths = await corruptedNativePair();
    const beforeTree = (await readdir(home, { recursive: true })).toSorted();
    const before = await Promise.all(paths.map(fileState));

    const result = await runSwap(["revert", "--dry-run", "--cli", "claude,cursor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cursor:user recovery backup changed/u);
    expect(result.stdout).not.toContain("would restore");
    expect(await Promise.all(paths.map(fileState))).toEqual(before);
    expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);
  });

  test("validates every selected revert before restoring any", async () => {
    const paths = await corruptedNativePair();
    const beforeTree = (await readdir(home, { recursive: true })).toSorted();
    const before = await Promise.all(paths.map(fileState));

    const result = await runSwap(["revert", "--cli", "claude,cursor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cursor:user recovery backup changed/u);
    expect(result.stdout).not.toContain("restored");
    expect(await Promise.all(paths.map(fileState))).toEqual(before);
    expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);
  });
});

describe("CLI table", () => {
  test("documents comma selectors and the antigravity alias", async () => {
    const help = await runSwap(["help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("NAME[,NAME...]");
    expect(help.stdout).toContain("agy (or antigravity)");
  });

  test("detect reports binary, config, and pi adapter state", async () => {
    const pi = cliFor("pi");
    await seed(pi, originalConfig(pi));

    const result = await runSwap(["detect", "--cli", "pi"], {
      PATH: join(home, "empty-path"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[no] pi");
    expect(result.stdout).toContain("binary=missing config=present");
    expect(result.stdout).toContain("needs pi-mcp-adapter");
  });

  test("doctor is read-only and reports config, recovery, and login overrides", async () => {
    const pi = cliFor("pi");
    await seed(pi, originalConfig(pi));
    const before = (await readdir(home, { recursive: true })).toSorted();

    const result = await runSwap(
      ["doctor", "--repo", repositoryRoot, "--server", "libtmux", "--cli", "pi"],
      { OPENAI_API_KEY: "not-printed" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mcp-swap doctor");
    expect(result.stdout).toContain("pi:");
    expect(result.stdout).toContain("outstanding swaps: none");
    expect(result.stdout).toContain("OPENAI_API_KEY overrides codex's stored login");
    expect(result.stdout).not.toContain("not-printed");
    expect((await readdir(home, { recursive: true })).toSorted()).toEqual(before);
    expect(await Bun.file(swapLockPath()).exists()).toBe(false);
  });

  test("doctor reports an unowned native backup without claiming it", async () => {
    const cursor = cliFor("cursor");
    const orphan = firstNativeBackupPath(cursor, 99);
    await seed(cursor, originalConfig(cursor));
    await writeFile(orphan, "unowned\n", { mode: 0o600 });
    const before = await fileState(orphan);

    const result = await runSwap(["doctor", "--repo", repositoryRoot, "--cli", "cursor"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unowned TypeScript backup");
    expect(await fileState(orphan)).toEqual(before);
    expect(await Bun.file(nativeStatePath()).exists()).toBe(false);
  });

  test.each([
    ["detect", ["--dry-run"]],
    ["status", ["--env", "A=1"]],
    ["revert", ["--source", "dev"]],
    ["use", ["--source", "dev", "--version", "1.0.0"]],
    ["detect", ["--server", "bad/name"]],
  ] as const)("rejects options that do not apply to %s", async (command, flags) => {
    const result = await runSwap([command, ...flags]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/does not apply|only applies|safe component/u);
  });

  test("normalizes all 40,320 client orderings", () => {
    const clis = knownClis({}, "/home/x");
    const expected = CLI_NAMES.join("\0");
    let count = 0;
    for (const ordering of permutations(CLI_NAMES)) {
      const selected = selectClis(clis, ordering)
        .map((info) => info.name)
        .join("\0");
      if (selected !== expected)
        throw new Error(`selection order changed for ${ordering.join(",")}`);
      count += 1;
    }
    expect(count).toBe(40_320);
  });

  test("applies comma, repeat, and alias selectors to detect, status, and revert", async () => {
    const infos = await seedAllClients();
    const selection = ["--cli", "cursor,antigravity", "--client", "claude", "--cli", "cursor"];

    const detected = await runSwap(["detect", ...selection]);
    expect(detected.status).toBe(0);
    expect(
      detected.stdout
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/u)[1]),
    ).toEqual(["claude", "cursor", "agy"]);

    const status = await runSwap(["status", ...selection]);
    expect(status.status).toBe(0);
    expect(
      status.stdout
        .trim()
        .split("\n")
        .map((line) => line.split(/\s+/u)[0]),
    ).toEqual(["claude:user", "claude:project", "cursor", "agy"]);

    const used = await runSwap([
      "use",
      "--source",
      "dev",
      "--no-preflight",
      "--cli",
      CLI_NAMES.join(","),
    ]);
    expect(used.status).toBe(0);
    const reverted = await runSwap(["revert", ...selection]);
    expect(reverted.status).toBe(0);
    expect(
      reverted.stdout
        .trim()
        .split("\n")
        .map((line) => line.split(/\s+/u)[1]),
    ).toEqual(["agy", "cursor", "claude:project"]);
    await Promise.all(
      infos.map(async (info) => {
        const target =
          info.name === "claude" ? scopedCli(info, resolve(repositoryRoot), "project") : info;
        const registered = await readServer(target, "libtmux");
        if (["claude", "cursor", "agy"].includes(info.name)) {
          expect(registered).toBeUndefined();
        } else {
          expect(registered).toBeDefined();
        }
      }),
    );
  });

  test("covers every agent the original swapped, with its own shape", () => {
    const clis = knownClis({}, "/home/x");
    expect(clis.map((info) => info.name).toSorted()).toEqual([
      "agy",
      "claude",
      "codex",
      "cursor",
      "gemini",
      "grok",
      "opencode",
      "pi",
    ]);
    // The two TOML CLIs nest under a different key than the JSON ones.
    for (const info of clis) {
      expect(info.container[0]).toBe(
        info.format === "toml" ? "mcp_servers" : info.name === "opencode" ? "mcp" : "mcpServers",
      );
    }
  });

  test("ignores a relative XDG_CONFIG_HOME, as the spec says to", () => {
    // A relative value resolves against the working directory, so a backup
    // recorded under it could not be found again from anywhere else.
    expect(xdgConfigHome({ XDG_CONFIG_HOME: "/abs/conf" })).toBe("/abs/conf");
    expect(xdgConfigHome({ XDG_CONFIG_HOME: "relative/path" })).toBe(join(homedir(), ".config"));
    expect(xdgConfigHome({})).toBe(join(homedir(), ".config"));
  });

  test("resolves every config under the home it was given", () => {
    // One path deriving from the process's own home instead would send a single
    // registration somewhere the other seven are not — which is the whole of
    // the difference between a dry run against a scratch home and a write to
    // the real one.
    const home = "/somewhere/else";

    for (const info of knownClis({}, home)) {
      expect(info.configPath).toStartWith(`${home}/`);
    }

    // An absolute XDG_CONFIG_HOME still wins, which is what the spec says.
    const overridden = knownClis({ XDG_CONFIG_HOME: "/abs/conf" }, home).find(
      (info) => info.name === "opencode",
    );
    expect(overridden?.configPath).toBe("/abs/conf/opencode/opencode.jsonc");
  });
});
