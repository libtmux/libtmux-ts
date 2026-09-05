import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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
  parseJsonc,
  parseServerTables,
  PUBLISHED_PACKAGE,
  preflight,
  readServer,
  removeServerTable,
  renderServerTable,
  revertConfig,
  spliceEntry,
  toEntry,
  writeServer,
  writeServers,
  xdgConfigHome,
  type CliInfo,
} from "../../../../scripts/mcp_swap.js";

import { makeTestDirectory } from "../../src/_internal/test/testkit.js";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const CLI_NAMES = ["claude", "codex", "cursor", "gemini", "grok", "agy", "opencode", "pi"] as const;

/**
 * The config surgery behind `mcp_swap`.
 *
 * What makes this worth testing is that it edits files a person owns and did
 * not write for it: their comments, their spacing, their other servers. Getting
 * the entry right and the rest wrong is still a bad outcome, so most of what is
 * asserted here is about what did *not* change.
 */

let home: string;

beforeEach(async () => {
  home = await makeTestDirectory("ltx-swap-");
});

afterEach(async () => {
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

function backupRoutePath(configPath: string): string {
  return `${backupPath(configPath)}.route.json`;
}

async function seed(info: CliInfo, contents: string): Promise<void> {
  await mkdir(join(info.configPath, ".."), { recursive: true });
  await writeFile(info.configPath, contents);
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

async function waitForStagedFile(path: string): Promise<void> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.mcp-swap-`;
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- poll until staging reaches this boundary.
    if ((await readdir(directory)).some((entry) => entry.startsWith(prefix))) return;
    // eslint-disable-next-line no-await-in-loop -- polling must yield between observations.
    await Bun.sleep(1);
  }
  throw new Error(`staged file did not appear beside ${path}`);
}

async function waitForFileChange(path: string, original: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- poll until the first write commits.
    if ((await readFile(path, "utf8")) !== original) return;
    // eslint-disable-next-line no-await-in-loop -- polling must yield between observations.
    await Bun.sleep(1);
  }
  throw new Error(`file did not change: ${path}`);
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
});

describe("server preflight", () => {
  test("accepts one complete initialize reply", async () => {
    const source = `
      const request = JSON.parse((await Bun.stdin.text()).trim());
      console.log(JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { serverInfo: {} } }));
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

  test("removes only the table it was asked for", () => {
    const source =
      '[mcp_servers.other]\ncommand = "keep"\n\n[mcp_servers.libtmux]\ncommand = "go"\n';

    const removed = removeServerTable(source, "mcp_servers", "libtmux");

    expect(parseServerTables(removed, "mcp_servers")).toEqual({ other: { command: "keep" } });
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
    await Promise.all(
      infos.map(async (info, index) => {
        expect(await revertConfig(info)).toBe(true);
        const original = originals.get(info.name);
        if (original === undefined) throw new Error(`missing ${info.name} fixture`);
        expect((await lstat(info.configPath)).isSymbolicLink()).toBe(true);
        expect(await readlink(info.configPath)).toBe(original.linkTarget);
        expect(await readFile(original.target, "utf8")).toBe(original.raw);
        expect((await stat(info.configPath)).mode & 0o777).toBe(index % 2 === 0 ? 0o600 : 0o640);
        expect(await Bun.file(backupRoutePath(info.configPath)).exists()).toBe(false);
      }),
    );
  });

  test("rejects selected configs that resolve to one target", async () => {
    const first = cliFor("claude");
    const later = cliFor("cursor");
    const target = join(home, "dotfiles", "shared.json");
    const original = '{\n  "mcpServers": { "keep": { "command": "other" } }\n}\n';
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, original);
    await Promise.all(
      [first, later].map(async (info) => {
        await mkdir(dirname(info.configPath), { recursive: true });
        await symlink(relative(dirname(info.configPath), target), info.configPath);
      }),
    );

    await expect(
      writeServers([first, later], "libtmux", buildSpec({ kind: "dev", repo: "/repo" })),
    ).rejects.toThrow(/same resolved target/u);

    expect(await readFile(target, "utf8")).toBe(original);
    expect((await lstat(first.configPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(later.configPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(backupPath(first.configPath)).exists()).toBe(false);
    expect(await Bun.file(backupPath(later.configPath)).exists()).toBe(false);
  });

  test.each(["symlink", "file"] as const)(
    "refuses a config link replaced by a %s after staging",
    async (replacementKind) => {
      const info = cliFor("cursor");
      const padding = "x".repeat(16 * 1024 * 1024);
      const original = `{\n  "padding": "${padding}",\n  "mcpServers": {}\n}\n`;
      const { target } = await seedSymlink(info, original, 0o640);
      const replacementTarget = join(home, "dotfiles", "replacement.json");
      const replacement = '{\n  "sentinel": "unchanged"\n}\n';
      await writeFile(replacementTarget, replacement);

      const pending = writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
      try {
        await waitForStagedFile(target);
        await rm(info.configPath);
        if (replacementKind === "symlink") {
          await symlink(relative(dirname(info.configPath), replacementTarget), info.configPath);
        } else {
          await writeFile(info.configPath, replacement);
        }

        await expect(pending).rejects.toThrow(/config.*changed/u);
      } finally {
        await pending.catch(() => undefined);
      }

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
    const padding = "x".repeat(16 * 1024 * 1024);
    const original = `{\n  "padding": "${padding}",\n  "mcpServers": {}\n}\n`;
    const { target } = await seedSymlink(info, original, 0o640);
    const routePath = backupRoutePath(info.configPath);
    const intruder = "do not replace\n";

    const swap = writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/repo" }));
    await waitForStagedFile(routePath);
    await writeFile(routePath, intruder);

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
    const original = originalConfig(info);
    await seed(info, original);
    await chmod(info.configPath, 0o600);

    const { status, stderr } = await runSwap([
      "use",
      "--source",
      "dev",
      "--repo",
      join(home, "missing-checkout"),
    ]);

    expect(status).toBe(1);
    expect(stderr).toContain("did not answer");
    expect(await readFile(info.configPath, "utf8")).toBe(original);
    expect((await stat(info.configPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(backupPath(info.configPath)).exists()).toBe(false);
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

      await chmod(info.configPath, 0o640);
      expect((await stat(info.configPath)).mode & 0o777).toBe(0o640);

      expect(await revertConfig(info)).toBe(true);
      expect(await readFile(info.configPath, "utf8")).toBe(original);
      expect((await stat(info.configPath)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("writes, reads back, and reverts to the original bytes", async () => {
    const info = cliFor("cursor");
    const original =
      '{\n  // mine\n  "mcpServers": {\n    "other": { "command": "keep" }\n  }\n}\n';
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
    expect(await readFile(backupRoutePath(info.configPath))).toEqual(firstRoute);
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

  async function configState(infos: readonly CliInfo[]): Promise<unknown> {
    return Promise.all(
      infos.map(async (info) => ({
        mode: (await stat(info.configPath)).mode & 0o777,
        name: info.name,
        raw: await readFile(info.configPath, "utf8"),
      })),
    );
  }

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
      ["use", "--source", "build", "--repo", repositoryRoot, "--dry-run"],
      { PATH: bin },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const info of infos) expect(result.stdout).toContain(`would update ${info.name}`);
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

    const result = await runSwap(["use", "--source", "dev", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pi .*JSON Parse error/u);
    expect(result.stdout).not.toContain("would update");
    expect(await configState(infos)).toEqual(beforeState);
    expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);
  });

  test.each(["unusable backup", "unwritable destination"] as const)(
    "rejects an %s for a later client without writes",
    async (failure) => {
      const infos = await seedAllClients();
      const later = infos.at(-1)!;
      const directory = dirname(later.configPath);
      if (failure === "unusable backup") {
        await mkdir(backupPath(later.configPath));
      } else {
        await chmod(directory, 0o500);
      }
      const beforeState = await configState(infos);
      const beforeTree = (await readdir(home, { recursive: true })).toSorted();

      try {
        const result = await runSwap(["use", "--source", "dev", "--dry-run"]);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/pi .*recovery backup|pi .*not writable/u);
        expect(result.stdout).not.toContain("would update");
        expect(await configState(infos)).toEqual(beforeState);
        expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);

        await expect(
          writeServers(infos, "libtmux", buildSpec({ kind: "dev", repo: "/repo" })),
        ).rejects.toThrow(/recovery backup|not writable/u);
        expect(await configState(infos)).toEqual(beforeState);
        expect((await readdir(home, { recursive: true })).toSorted()).toEqual(beforeTree);
      } finally {
        if (failure === "unwritable destination") await chmod(directory, 0o700);
      }
    },
  );
});

describe("CLI table", () => {
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
