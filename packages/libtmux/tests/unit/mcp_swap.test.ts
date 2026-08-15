import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
  readServer,
  removeServerTable,
  renderServerTable,
  revertConfig,
  spliceEntry,
  toEntry,
  writeServer,
  xdgConfigHome,
  type CliInfo,
} from "../../scripts/mcp_swap.js";

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
  home = await mkdtemp(join(tmpdir(), "ltx-swap-"));
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

async function seed(info: CliInfo, contents: string): Promise<void> {
  await mkdir(join(info.configPath, ".."), { recursive: true });
  await writeFile(info.configPath, contents);
}

describe("source specs", () => {
  test("names each stage the way its runtime is invoked", () => {
    const dev = buildSpec({ kind: "dev", repo: "/repo" });
    const build = buildSpec({ kind: "build", repo: "/repo" });
    const published = buildSpec({ kind: "published", version: "1.2.3" });

    // Bun runs the TypeScript; Node runs what a release would ship; npx fetches
    // a release. `-y` so a machine that has never seen the package does not
    // stop to ask, which under an agent looks like a hang.
    expect([dev.command, ...dev.args]).toEqual(["bun", "run", "/repo/consumers/mcp/server.ts"]);
    expect([build.command, ...build.args]).toEqual(["node", "/repo/dist-mcp/server.js"]);
    expect([published.command, ...published.args]).toEqual(["npx", "-y", "libtmux-mcp@1.2.3"]);
  });

  test("defaults a published source to the latest release", () => {
    expect(buildSpec({ kind: "published" }).args).toEqual(["-y", "libtmux-mcp@latest"]);
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
    await seed(info, original);

    await writeServer(info, "libtmux", buildSpec({ kind: "dev", repo: "/one" }));
    await writeServer(info, "libtmux", buildSpec({ kind: "build", repo: "/two" }));
    await writeServer(info, "libtmux", buildSpec({ kind: "published", version: "9" }));
    await revertConfig(info);

    // Not the state before the last swap — the state before any of them.
    expect(await readFile(info.configPath, "utf8")).toBe(original);
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
