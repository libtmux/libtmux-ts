import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

import { runBoundedCommand, type BoundedCommandResult } from "./bounded_process.js";

/**
 * Point selected installed agent CLIs at one build of this MCP server.
 *
 * An agent CLI launches an MCP server as a subprocess named in its config
 * file. Trying a change therefore means editing several files by hand, each in
 * its own format and shape, and undoing them afterwards — which is where the
 * stale entry nobody remembers writing comes from. This edits them together and
 * keeps a backup per file so `revert` lands exactly on what was there before.
 *
 * Three sources, because a change is worth trying at three stages:
 *
 * - `dev` runs the TypeScript in a checkout through Bun, so an edit is live on
 *   the next tool call with nothing to rebuild.
 * - `build` runs a checkout's compiled output through Node, which is what the
 *   published artifact will be — the stage where a build problem shows up
 *   rather than a source one.
 * - `published` runs a release from the registry, for reproducing what someone
 *   else is seeing.
 *
 * Ported from the Python original in libtmux-mcp. This repository is Bun and
 * TypeScript with no Python toolchain, and the work is config editing rather
 * than anything language-specific, so it moved rather than being copied.
 */

export type ConfigFormat = "json" | "jsonc" | "toml";
export type Dialect = "claude" | "opencode" | "standard";
export type SourceKind = "build" | "dev" | "published";
export type SwapScope = "project" | "user";

export interface CliInfo {
  /** Executable that proves the CLI is installed. */
  readonly binary: string;
  readonly configPath: string;
  /** Key path from the document root to the map of server name to entry. */
  readonly container: readonly string[];
  readonly dialect: Dialect;
  readonly format: ConfigFormat;
  readonly name: string;
}

export interface ServerSpec {
  readonly args: readonly string[];
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

const MAX_PREFLIGHT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PREPARATION_OUTPUT_BYTES = 16 * 1024 * 1024;
const LOCK_WORKER_COMMAND = "__mcp-swap-lock-worker";
const F_LOCK = 1;
const F_ULOCK = 0;
const O_CLOEXEC =
  (constants as unknown as Readonly<Record<string, number | undefined>>).O_CLOEXEC ?? 0;

/**
 * `$XDG_CONFIG_HOME` when absolute, else `<home>/.config`.
 *
 * The fallback is taken from the home it is given rather than the process's
 * own, so a caller that resolves paths against some other home gets every path
 * under it. Reading the real one here would put a single config somewhere the
 * other seven are not.
 */
export function xdgConfigHome(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const raw = environment.XDG_CONFIG_HOME;
  // The spec says to ignore a relative value. Honouring one would record a
  // backup path that resolves against the working directory, so a revert from
  // anywhere else could no longer find it.
  return raw !== undefined && raw !== "" && isAbsolute(raw) ? raw : join(home, ".config");
}

export function xdgStateHome(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const raw = environment.XDG_STATE_HOME;
  return raw !== undefined && raw !== "" && isAbsolute(raw) ? raw : join(home, ".local", "state");
}

export function swapLockPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(xdgStateHome(environment, home), "libtmux-mcp-dev", "swap", "state.lock");
}

export function knownClis(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): readonly CliInfo[] {
  return [
    {
      binary: "claude",
      configPath: join(home, ".claude.json"),
      container: ["mcpServers"],
      dialect: "claude",
      format: "json",
      name: "claude",
    },
    {
      binary: "codex",
      configPath: join(home, ".codex", "config.toml"),
      container: ["mcp_servers"],
      dialect: "standard",
      format: "toml",
      name: "codex",
    },
    {
      binary: "cursor-agent",
      configPath: join(home, ".cursor", "mcp.json"),
      container: ["mcpServers"],
      dialect: "standard",
      format: "json",
      name: "cursor",
    },
    {
      binary: "gemini",
      configPath: join(home, ".gemini", "settings.json"),
      container: ["mcpServers"],
      dialect: "standard",
      format: "json",
      name: "gemini",
    },
    {
      binary: "grok",
      configPath: join(home, ".grok", "config.toml"),
      container: ["mcp_servers"],
      dialect: "standard",
      format: "toml",
      name: "grok",
    },
    {
      binary: "agy",
      configPath: join(home, ".gemini", "config", "mcp_config.json"),
      container: ["mcpServers"],
      dialect: "standard",
      format: "json",
      name: "agy",
    },
    {
      binary: "opencode",
      configPath: join(xdgConfigHome(environment, home), "opencode", "opencode.jsonc"),
      container: ["mcp"],
      dialect: "opencode",
      format: "jsonc",
      name: "opencode",
    },
    {
      binary: "pi",
      configPath: join(home, ".pi", "agent", "mcp.json"),
      container: ["mcpServers"],
      dialect: "standard",
      format: "jsonc",
      name: "pi",
    },
  ];
}

export function scopedCli(info: CliInfo, repo: string, scope: SwapScope): CliInfo {
  if (info.name !== "claude" || scope === "user") return info;
  if (!isAbsolute(repo)) throw new TypeError("Claude project scope needs an absolute repository");
  return { ...info, container: ["projects", repo, "mcpServers"] };
}

/**
 * Render a spec in the shape one CLI expects.
 *
 * The three shapes are not stylistic. opencode takes one array for the whole
 * command line and calls the environment table `environment`; an `env` key
 * there is dropped without a word, and a scalar `command` fails to decode and
 * takes the rest of the config with it.
 */
export function toEntry(spec: ServerSpec, dialect: Dialect): Record<string, unknown> {
  if (dialect === "claude") {
    // Claude writes `type` and `env` even when there is nothing to say.
    return { args: [...spec.args], command: spec.command, env: { ...spec.env }, type: "stdio" };
  }
  if (dialect === "opencode") {
    const local: Record<string, unknown> = {
      command: [spec.command, ...spec.args],
      type: "local",
    };
    if (Object.keys(spec.env).length > 0) local.environment = { ...spec.env };
    return local;
  }
  const entry: Record<string, unknown> = { args: [...spec.args], command: spec.command };
  if (Object.keys(spec.env).length > 0) entry.env = { ...spec.env };
  return entry;
}

/** Read a spec back out of whatever shape a CLI stored it in. */
export function fromEntry(entry: unknown, dialect: Dialect): ServerSpec | undefined {
  try {
    return parseEntry(entry, dialect, "server entry");
  } catch {
    return undefined;
  }
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object of strings`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new TypeError(`${label} must be an object of strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function parseEntry(entry: unknown, dialect: Dialect, label: string): ServerSpec | undefined {
  if (entry === undefined) return undefined;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = entry as Record<string, unknown>;
  if (dialect === "opencode") {
    const line = stringArray(record.command, `${label}.command`);
    if (line.length === 0) throw new TypeError(`${label}.command must not be empty`);
    return {
      args: line.slice(1),
      command: line[0]!,
      env:
        record.environment === undefined
          ? {}
          : stringMap(record.environment, `${label}.environment`),
    };
  }
  if (typeof record.command !== "string" || record.command === "") {
    throw new TypeError(`${label}.command must be a nonempty string`);
  }
  return {
    args: record.args === undefined ? [] : stringArray(record.args, `${label}.args`),
    command: record.command,
    env: record.env === undefined ? {} : stringMap(record.env, `${label}.env`),
  };
}

/**
 * Where the server this repository builds actually lives.
 *
 * The MCP server is not part of the `libtmux` package: it imports the MCP SDK
 * and a schema library, and making those runtime dependencies of `libtmux`
 * would cost the property the package leads with — that installing it installs
 * nothing else. So `dev` and `build` run it from a checkout, and `published`
 * names the package that ships it beside `libtmux`.
 *
 * That name is the one on the registry, not the executable inside it:
 * `libtmux-mcp` is the `bin`, and asking npx for it resolves nothing.
 */
export const DEV_ENTRY = "packages/mcp/src/server.ts";
export const BUILD_ENTRY = "packages/mcp/dist/server.js";
export const PUBLISHED_PACKAGE = "@libtmux/mcp";

export interface SourceOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly kind: SourceKind;
  /** Checkout to run from, for `dev` and `build`. */
  readonly repo?: string;
  /** Version or dist-tag, for `published`. */
  readonly version?: string;
}

function requireSafeComponent(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)) {
    throw new TypeError(`${label} must be one safe component`);
  }
}

export function buildSpec(options: SourceOptions): ServerSpec {
  const env = { ...options.env };
  if (options.kind === "published") {
    const version = options.version ?? "latest";
    requireSafeComponent(version, "--version");
    // `-y` so a machine that has never seen the package does not stop to ask,
    // which for a server launched by an agent would look like a hang.
    return { args: ["-y", `${PUBLISHED_PACKAGE}@${version}`], command: "npx", env };
  }
  const repo = options.repo;
  if (repo === undefined) throw new Error(`the ${options.kind} source needs a repository path`);
  if (options.kind === "dev") {
    // Bun runs the TypeScript as it is, so an edit is live on the next call.
    return { args: ["run", join(repo, DEV_ENTRY)], command: "bun", env };
  }
  return { args: [join(repo, BUILD_ENTRY)], command: "node", env };
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }
  if (!metadata.isFile()) throw new TypeError(`${label} is not a regular file: ${path}`);
}

async function prepareSource(options: SourceOptions): Promise<void> {
  if (options.kind === "published") {
    if (Bun.which("npx") === null) throw new Error("published source needs npx on PATH");
    return;
  }
  const repo = options.repo!;
  if (options.kind === "dev") {
    if (Bun.which("bun") === null) throw new Error("dev source needs bun on PATH");
    await requireRegularFile(join(repo, DEV_ENTRY), "development server entry");
    return;
  }
  if (Bun.which("bun") === null) throw new Error("build source needs bun on PATH");
  const result = await runBoundedCommand(
    ["bun", "run", "--cwd", join(repo, "packages", "mcp"), "build"],
    {
      env: { ...process.env },
      maxOutputBytes: MAX_PREPARATION_OUTPUT_BYTES,
      timeoutMilliseconds: 300_000,
    },
  );
  if (result.termination !== "exited" || result.exitCode !== 0) {
    const detail = result.stderr.trim().split("\n")[0] ?? "";
    throw new Error(`MCP build failed${detail === "" ? "" : `: ${detail}`}`);
  }
  await requireRegularFile(join(repo, BUILD_ENTRY), "built server entry");
}

/** Describe a spec the way `status` prints it. */
export function describeSpec(spec: ServerSpec): string {
  return [spec.command, ...spec.args].join(" ");
}

/**
 * Which source a recorded entry came from, when it is recognisable.
 *
 * Used by `status` to say what a config points at without the caller having to
 * read an argument vector.
 */
export function classifySpec(spec: ServerSpec): SourceKind | "unknown" {
  const line = describeSpec(spec);
  if (line.includes(`${PUBLISHED_PACKAGE}@`)) return "published";
  if (line.includes(DEV_ENTRY)) return "dev";
  if (line.includes(BUILD_ENTRY)) return "build";
  return "unknown";
}

/**
 * Blank out comments and trailing commas, leaving every other byte in place.
 *
 * The result parses as JSON and every offset still matches the original, so an
 * edit computed here can be applied to the file the user wrote — comments,
 * spacing and all. Rewriting the document from a parsed value would be far
 * simpler and would throw away the comments, which for a file someone
 * hand-edited is not a fair trade.
 */
export function blankJsonc(text: string): string {
  // Indexed by UTF-16 code unit, the same unit `length`, `indexOf` and every
  // slice below count in. Spreading a string yields code points instead, so a
  // single emoji anywhere in the file would shift every offset after it and the
  // splice would land in the wrong place.
  const out = text.split("");
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    const next = text[index + 1];
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        out[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let scan = index; scan < stop; scan += 1) {
        if (text[scan] !== "\n") out[scan] = " ";
      }
      index = stop - 1;
      continue;
    }
  }
  // A trailing comma is legal in JSONC and not in JSON, so it goes too — after
  // the comments, since one can hide behind the other.
  const blanked = out.join("");
  const cleaned = blanked.split("");
  inString = false;
  escaped = false;
  for (let index = 0; index < blanked.length; index += 1) {
    const character = blanked[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== ",") continue;
    let scan = index + 1;
    while (scan < blanked.length && /\s/u.test(blanked[scan]!)) scan += 1;
    const following = blanked[scan];
    if (following === "}" || following === "]") cleaned[index] = " ";
  }
  return cleaned.join("");
}

export function parseJsonc(text: string): unknown {
  const blanked = blankJsonc(text);
  return blanked.trim() === "" ? {} : (JSON.parse(blanked) as unknown);
}

/**
 * Read the `[mcp_servers.<name>]` tables out of a Codex or Grok config.
 *
 * Only what this tool needs: the server tables and their scalar fields. A
 * general TOML parser is a dependency this repository does not carry, and the
 * shape here is fixed by the CLIs that write it.
 */
export function parseServerTables(text: string, container: string): Record<string, unknown> {
  const parsed = Bun.TOML.parse(text) as Readonly<Record<string, unknown>>;
  const servers = parsed[container];
  if (servers === undefined) return {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new TypeError(`${container} must be a table`);
  }
  return { ...(servers as Record<string, unknown>) };
}

function tomlInlineValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlInlineValue).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)} = ${tomlInlineValue(item)}`)
      .join(", ")} }`;
  }
  throw new TypeError("TOML server data has an unsupported value");
}

interface InlineTomlContainer {
  readonly index: number;
  readonly prefix: string;
  readonly suffix: string;
}

function inlineTomlContainer(
  lines: readonly string[],
  container: string,
): InlineTomlContainer | undefined {
  const escaped = container.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const startPattern = new RegExp(`^(\\s*${escaped}\\s*=\\s*)\\{`, "u");
  for (const [index, line] of lines.entries()) {
    const start = startPattern.exec(line);
    if (start === null) continue;
    const open = start[0].lastIndexOf("{");
    let depth = 0;
    let quoted = false;
    let escapedCharacter = false;
    for (let cursor = open; cursor < line.length; cursor += 1) {
      const character = line[cursor]!;
      if (quoted) {
        if (escapedCharacter) escapedCharacter = false;
        else if (character === "\\") escapedCharacter = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const suffix = line.slice(cursor + 1);
          if (!/^\s*(?:#.*)?$/u.test(suffix)) return undefined;
          return { index, prefix: start[1]!, suffix };
        }
      }
    }
  }
  return undefined;
}

function dottedTomlTarget(line: string, container: string, name: string): boolean {
  const escapedContainer = container.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escapedContainer}\\.${escapedName}\\.`, "u").test(line);
}

/** Render one server as a TOML table, replacing any table of the same name. */
export function renderServerTable(
  text: string,
  container: string,
  name: string,
  entry: Record<string, unknown>,
): string {
  const header = `[${container}.${name}]`;
  const environment = entry.env;
  if (
    environment !== undefined &&
    (typeof environment !== "object" || environment === null || Array.isArray(environment))
  ) {
    throw new TypeError("TOML server env must be an object");
  }
  const body = Object.entries(entry)
    .filter(([key]) => key !== "env")
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  const environmentBody = Object.entries((environment ?? {}) as Record<string, unknown>).map(
    ([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`,
  );
  const block = [
    header,
    ...body,
    ...(environmentBody.length === 0 ? [] : ["", `[${container}.${name}.env]`, ...environmentBody]),
    "",
  ].join("\n");
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const inline = inlineTomlContainer(lines, container);
    if (inline !== undefined) {
      const servers = parseServerTables(text, container);
      servers[name] = entry;
      const changed = [...lines];
      changed[inline.index] = `${inline.prefix}${tomlInlineValue(servers)}${inline.suffix}`;
      return changed.join("\n");
    }
    if (lines.some((line) => dottedTomlTarget(line, container, name))) {
      const retained = lines.filter((line) => !dottedTomlTarget(line, container, name));
      const base = retained.join("\n").replace(/\n*$/u, "\n");
      return `${base}\n${block}`;
    }
    const separator = text.trim() === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${block}`;
  }
  let end = start + 1;
  const childPrefix = `[${container}.${name}.`;
  while (end < lines.length) {
    const line = lines[end]!.trim();
    if (line.startsWith("[") && !line.startsWith(childPrefix)) break;
    end += 1;
  }
  return [...lines.slice(0, start), block.trimEnd(), ...lines.slice(end)].join("\n");
}

/** Remove a server's TOML table, leaving the rest of the file alone. */
export function removeServerTable(text: string, container: string, name: string): string {
  const header = `[${container}.${name}]`;
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const inline = inlineTomlContainer(lines, container);
    if (inline !== undefined) {
      const servers = parseServerTables(text, container);
      if (!Object.hasOwn(servers, name)) return text;
      delete servers[name];
      const changed = [...lines];
      changed[inline.index] = `${inline.prefix}${tomlInlineValue(servers)}${inline.suffix}`;
      return changed.join("\n");
    }
    return lines.some((line) => dottedTomlTarget(line, container, name))
      ? lines.filter((line) => !dottedTomlTarget(line, container, name)).join("\n")
      : text;
  }
  let end = start + 1;
  const childPrefix = `[${container}.${name}.`;
  while (end < lines.length) {
    const line = lines[end]!.trim();
    if (line.startsWith("[") && !line.startsWith(childPrefix)) break;
    end += 1;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** End offset of the JSON value beginning at `start`, in blanked text. */
function valueEnd(text: string, start: number): number {
  const opener = text[start];
  if (opener === '"') {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index] === '"') return index + 1;
      else index += 1;
    }
    return text.length;
  }
  if (opener === "{" || opener === "[") {
    const close = opener === "{" ? "}" : "]";
    let depth = 0;
    let index = start;
    let inString = false;
    while (index < text.length) {
      const character = text[index]!;
      if (inString) {
        if (character === "\\") index += 1;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === opener) depth += 1;
      else if (character === close) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return text.length;
  }
  let index = start;
  while (index < text.length && !",}]\n".includes(text[index]!)) index += 1;
  return index;
}

interface Member {
  readonly key: string;
  readonly start: number;
  readonly valueEnd: number;
  readonly valueStart: number;
}

/** The members of the object that begins at `open`, in source order. */
function membersOf(text: string, open: number): Member[] {
  const members: Member[] = [];
  let index = open + 1;
  while (index < text.length) {
    while (index < text.length && /[\s,]/u.test(text[index]!)) index += 1;
    if (text[index] === "}" || index >= text.length) break;
    if (text[index] !== '"') break;
    const keyStart = index;
    const keyEnd = valueEnd(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    let cursor = keyEnd;
    while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
    if (text[cursor] !== ":") break;
    cursor += 1;
    while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
    const end = valueEnd(text, cursor);
    members.push({ key, start: keyStart, valueEnd: end, valueStart: cursor });
    index = end;
  }
  return members;
}

function assertUniqueMembers(text: string, open: number, label: string): readonly Member[] {
  const members = membersOf(text, open);
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.key)) throw new TypeError(`${label} has duplicate ${member.key} members`);
    seen.add(member.key);
  }
  return members;
}

function validateJsonPath(text: string, path: readonly string[]): void {
  if (text.trim() === "") return;
  const blanked = blankJsonc(text);
  let open = blanked.indexOf("{");
  if (open === -1) throw new TypeError("config root must be an object");
  const traversed: string[] = [];
  for (const key of path) {
    const label = traversed.length === 0 ? "config root" : traversed.join(".");
    const member = assertUniqueMembers(blanked, open, label).find(
      (candidate) => candidate.key === key,
    );
    if (member === undefined) return;
    traversed.push(key);
    if (blanked[member.valueStart] !== "{") {
      throw new TypeError(`${traversed.join(".")} must be an object`);
    }
    open = member.valueStart;
  }
  assertUniqueMembers(blanked, open, traversed.join("."));
}

function validateJsonServer(text: string, info: CliInfo, name: string): void {
  const entryPath = [...info.container, name];
  validateJsonPath(text, entryPath);
  const blanked = blankJsonc(text);
  const entry = objectAt(blanked, entryPath);
  if (entry === undefined) return;
  const environmentName = info.dialect === "opencode" ? "environment" : "env";
  const environment = membersOf(blanked, entry).find((member) => member.key === environmentName);
  if (environment !== undefined && blanked[environment.valueStart] === "{") {
    assertUniqueMembers(blanked, environment.valueStart, [...entryPath, environmentName].join("."));
  }
}

/** Offset of the `{` opening the object at `path`, if every step exists. */
function objectAt(text: string, path: readonly string[]): number | undefined {
  let open = text.indexOf("{");
  if (open === -1) return undefined;
  for (const key of path) {
    const member = membersOf(text, open).find((candidate) => candidate.key === key);
    if (member === undefined || text[member.valueStart] !== "{") return undefined;
    open = member.valueStart;
  }
  return open;
}

/**
 * Splice one entry into JSON text, leaving every other byte where it was.
 *
 * Rewriting the document from a parsed value is far shorter and throws away
 * comments and spacing. For a file a person edited by hand, that is not a
 * detail — it is most of what they wrote.
 */
export function spliceEntry(
  original: string,
  path: readonly string[],
  name: string,
  entry: Record<string, unknown>,
  indent = 2,
): string | undefined {
  const blanked = blankJsonc(original);
  const open = objectAt(blanked, path);
  if (open === undefined) return undefined;
  const rendered = JSON.stringify(entry, undefined, indent)
    .split("\n")
    .join("\n" + " ".repeat(indent * (path.length + 1)));
  const existing = membersOf(blanked, open).find((candidate) => candidate.key === name);
  if (existing !== undefined) {
    return original.slice(0, existing.valueStart) + rendered + original.slice(existing.valueEnd);
  }
  const members = membersOf(blanked, open);
  const pad = " ".repeat(indent * (path.length + 1));
  const addition = `${JSON.stringify(name)}: ${rendered}`;
  if (members.length === 0) {
    const close = valueEnd(blanked, open) - 1;
    return `${original.slice(0, open + 1)}\n${pad}${addition}\n${" ".repeat(indent * path.length)}${original.slice(close)}`;
  }
  const last = members[members.length - 1]!;
  return `${original.slice(0, last.valueEnd)},\n${pad}${addition}${original.slice(last.valueEnd)}`;
}

function spliceEntryCreatingPath(
  original: string,
  path: readonly string[],
  name: string,
  entry: Record<string, unknown>,
): string | undefined {
  const blanked = blankJsonc(original);
  let open = blanked.indexOf("{");
  if (open === -1) return undefined;
  const traversed: string[] = [];
  for (const [index, key] of path.entries()) {
    const member = membersOf(blanked, open).find((candidate) => candidate.key === key);
    if (member === undefined) {
      let nested: Record<string, unknown> = { [name]: entry };
      for (const suffix of path.slice(index + 1).toReversed()) nested = { [suffix]: nested };
      return spliceEntry(original, traversed, key, nested);
    }
    if (blanked[member.valueStart] !== "{") return undefined;
    traversed.push(key);
    open = member.valueStart;
  }
  return spliceEntry(original, path, name, entry);
}

const BACKUP_SUFFIX = ".mcp-swap-backup";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function fileMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o7777;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

type ConfigPathKind = "missing" | "regular" | "symlink";

interface ConfigRoute {
  readonly kind: ConfigPathKind;
  readonly logicalIdentity: string | undefined;
  readonly logicalPath: string;
  readonly targetIdentity: string | undefined;
  readonly targetPath: string;
}

const RECOVERY_ROUTE_SUFFIX = ".route.json";
const RECOVERY_ROUTE_MAX_BYTES = 16 * 1024;

function fileIdentity(metadata: {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}): string {
  return [metadata.dev, metadata.ino, metadata.birthtimeNs].map(String).join(":");
}

function linkIdentity(metadata: {
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}): string {
  return `${fileIdentity(metadata)}:${String(metadata.ctimeNs)}`;
}

function sameFileMetadata(
  expected: Parameters<typeof fileIdentity>[0] & { readonly mode: bigint; readonly nlink: bigint },
  actual: Parameters<typeof fileIdentity>[0] & { readonly mode: bigint; readonly nlink: bigint },
): boolean {
  return (
    fileIdentity(expected) === fileIdentity(actual) &&
    expected.mode === actual.mode &&
    expected.nlink === actual.nlink
  );
}

interface LockDirectoryState {
  readonly identity: string;
  readonly logicalPath: string;
  readonly mode: number;
  readonly physicalPath: string;
}

interface SwapLockState {
  readonly directory: LockDirectoryState | undefined;
  readonly identity: string | undefined;
  readonly links: number | undefined;
  readonly logicalPath: string;
  readonly mode: number | undefined;
  readonly physicalPath: string;
}

interface LockWorkerMessage {
  readonly error?: string;
  readonly kind: "acquired" | "error" | "released";
  readonly state?: SwapLockState;
}

interface NativeLockLibrary {
  close(): void;
  readonly symbols: {
    lockf(descriptor: number, operation: number, length: bigint): number;
    openat(directory: number, path: Buffer, flags: number, mode: number): number;
  };
}

function sameSwapLock(expected: SwapLockState, actual: SwapLockState): boolean {
  return (
    expected.directory?.identity === actual.directory?.identity &&
    expected.directory?.logicalPath === actual.directory?.logicalPath &&
    expected.directory?.mode === actual.directory?.mode &&
    expected.directory?.physicalPath === actual.directory?.physicalPath &&
    expected.identity === actual.identity &&
    expected.links === actual.links &&
    expected.logicalPath === actual.logicalPath &&
    expected.mode === actual.mode &&
    expected.physicalPath === actual.physicalPath
  );
}

function lockMatchesMetadata(
  lock: SwapLockState,
  metadata: Parameters<typeof fileIdentity>[0] & { readonly mode: bigint; readonly nlink: bigint },
): boolean {
  return (
    lock.identity !== undefined &&
    lock.identity === fileIdentity(metadata) &&
    lock.mode === Number(metadata.mode & 0o7777n) &&
    lock.links === Number(metadata.nlink)
  );
}

async function inspectLockDirectory(path: string): Promise<LockDirectoryState | undefined> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new TypeError(`swap lock directory is not a regular directory: ${path}`);
  }
  const physicalPath = await realpath(path);
  const after = await lstat(path, { bigint: true });
  const mode = Number(after.mode & 0o7777n);
  if (!sameFileMetadata(before, after)) {
    throw new Error(`swap lock directory changed while it was inspected: ${path}`);
  }
  if (mode !== 0o700) throw new TypeError(`swap lock directory mode must be 0700: ${path}`);
  return { identity: fileIdentity(after), logicalPath: path, mode, physicalPath };
}

async function inspectSwapLockAt(logicalPath: string): Promise<SwapLockState> {
  const directory = await inspectLockDirectory(dirname(logicalPath));
  const physicalPath =
    directory === undefined
      ? await canonicalMissingPath(logicalPath)
      : join(directory.physicalPath, basename(logicalPath));
  let before;
  try {
    before = await lstat(logicalPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      return {
        directory,
        identity: undefined,
        links: undefined,
        logicalPath,
        mode: undefined,
        physicalPath,
      };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new TypeError(`swap lock is not a regular file: ${logicalPath}`);
  }
  const resolved = await realpath(logicalPath);
  const after = await lstat(logicalPath, { bigint: true });
  const mode = Number(after.mode & 0o7777n);
  if (resolved !== physicalPath || !sameFileMetadata(before, after)) {
    throw new Error(`swap lock changed while it was inspected: ${logicalPath}`);
  }
  if (mode !== 0o600) throw new TypeError(`swap lock mode must be 0600: ${logicalPath}`);
  if (after.nlink !== 1n) throw new TypeError(`swap lock must have one link: ${logicalPath}`);
  return {
    directory,
    identity: fileIdentity(after),
    links: Number(after.nlink),
    logicalPath,
    mode,
    physicalPath,
  };
}

async function inspectSwapLock(): Promise<SwapLockState> {
  return inspectSwapLockAt(swapLockPath());
}

function nativeLibraryName(): string {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new Error(`swap locking is unsupported on ${process.platform}`);
}

async function runLockWorker(directoryPath: string, lockName: string): Promise<number> {
  let directoryDescriptor: number | undefined;
  let lockDescriptor: number | undefined;
  let library: NativeLockLibrary | undefined;
  const send = (message: LockWorkerMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  try {
    if (!isAbsolute(directoryPath) || lockName !== "state.lock") {
      throw new Error("lock worker received an unsafe lock path");
    }
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
      throw new Error("platform cannot open the swap lock without following links");
    }
    const { dlopen, FFIType } = await import("bun:ffi");
    library = dlopen(nativeLibraryName(), {
      lockf: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
      openat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    }) as unknown as NativeLockLibrary;
    directoryDescriptor = openSync(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC,
    );
    const openedDirectory = fstatSync(directoryDescriptor, { bigint: true });
    const directoryAtPath = lstatSync(directoryPath, { bigint: true });
    if (
      directoryAtPath.isSymbolicLink() ||
      !directoryAtPath.isDirectory() ||
      !sameFileMetadata(openedDirectory, directoryAtPath) ||
      Number(openedDirectory.mode & 0o7777n) !== 0o700
    ) {
      throw new Error("swap lock directory changed before descriptor authentication");
    }
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | O_CLOEXEC;
    const encodedLockName = Buffer.from(`${lockName}\0`);
    lockDescriptor = library.symbols.openat(
      directoryDescriptor,
      encodedLockName,
      flags | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    if (lockDescriptor === -1) {
      lockDescriptor = library.symbols.openat(directoryDescriptor, encodedLockName, flags, 0);
    } else {
      fchmodSync(lockDescriptor, 0o600);
    }
    if (lockDescriptor === -1) throw new Error("could not open the persistent swap lock");
    if (library.symbols.lockf(lockDescriptor, F_LOCK, 0n) !== 0) {
      throw new Error("could not acquire the persistent swap lock");
    }
    const state = await inspectSwapLockAt(join(directoryPath, lockName));
    const openedLock = fstatSync(lockDescriptor, { bigint: true });
    if (!lockMatchesMetadata(state, openedLock)) {
      throw new Error("swap lock descriptor does not match its public path");
    }
    send({ kind: "acquired", state });
    await Bun.stdin.text();
    const current = await inspectSwapLockAt(join(directoryPath, lockName));
    const openedAgain = fstatSync(lockDescriptor, { bigint: true });
    if (!sameSwapLock(state, current) || !lockMatchesMetadata(state, openedAgain)) {
      throw new Error("swap lock changed before release");
    }
    if (library.symbols.lockf(lockDescriptor, F_ULOCK, 0n) !== 0) {
      throw new Error("could not release the persistent swap lock");
    }
    send({ kind: "released" });
    return 0;
  } catch (error) {
    send({ kind: "error", error: (error as Error).message });
    return 1;
  } finally {
    if (lockDescriptor !== undefined && lockDescriptor !== -1) closeSync(lockDescriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    library?.close();
  }
}

interface SwapLockHandle {
  readonly assert: () => Promise<void>;
  readonly release: () => Promise<void>;
  readonly state: SwapLockState;
}

async function acquireSwapLock(): Promise<SwapLockHandle> {
  const logicalPath = swapLockPath();
  const directoryPath = dirname(logicalPath);
  const before = await inspectLockDirectory(directoryPath);
  if (before === undefined) await mkdir(directoryPath, { mode: 0o700, recursive: true });
  const directory = await inspectLockDirectory(directoryPath);
  if (directory === undefined) throw new Error("swap lock directory was not created");
  const child = Bun.spawn(
    [process.execPath, import.meta.path, LOCK_WORKER_COMMAND, directoryPath, basename(logicalPath)],
    { env: { ...process.env }, stderr: "pipe", stdin: "pipe", stdout: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const readMessage = async (): Promise<LockWorkerMessage> => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return JSON.parse(line) as LockWorkerMessage;
      }
      // eslint-disable-next-line no-await-in-loop -- one framed lock message is read in order.
      const next = await reader.read();
      if (next.done) {
        // eslint-disable-next-line no-await-in-loop -- diagnostics are consumed only after EOF.
        throw new Error(`swap lock worker exited unexpectedly: ${(await stderr).trim()}`);
      }
      buffered += decoder.decode(next.value, { stream: true });
    }
  };
  const acquired = await readMessage();
  if (acquired.kind !== "acquired" || acquired.state === undefined) {
    child.stdin.end();
    await child.exited;
    throw new Error(`swap lock is unusable: ${acquired.error ?? "invalid worker protocol"}`);
  }
  const state = acquired.state;
  const assert = async (): Promise<void> => {
    const current = await inspectSwapLock();
    if (!sameSwapLock(state, current)) throw new Error("swap lock path changed while held");
  };
  try {
    await assert();
  } catch (error) {
    child.stdin.end();
    await child.exited;
    throw error;
  }
  let released = false;
  return {
    assert,
    release: async () => {
      if (released) return;
      released = true;
      child.stdin.end();
      const message = await readMessage();
      const status = await child.exited;
      const diagnostic = (await stderr).trim();
      if (message.kind !== "released" || status !== 0) {
        throw new Error(
          `swap lock release failed: ${message.error ?? (diagnostic || "invalid worker protocol")}`,
        );
      }
    },
    state,
  };
}

async function withSwapLock<T>(action: (lock: SwapLockHandle) => Promise<T>): Promise<T> {
  const lock = await acquireSwapLock();
  let result: T | undefined;
  let failure: unknown;
  try {
    result = await action(lock);
  } catch (error) {
    failure = error;
  }
  try {
    await lock.release();
  } catch (error) {
    if (failure !== undefined) {
      throw new AggregateError([failure, error], "transaction and swap lock release both failed");
    }
    throw error;
  }
  if (failure !== undefined) throw failure;
  return result!;
}

function contentDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function canonicalMissingPath(path: string): Promise<string> {
  const suffix: string[] = [];
  let candidate = path;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop -- ascend until one ancestor exists.
      return join(await realpath(candidate), ...suffix);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function inspectConfigRoute(path: string): Promise<ConfigRoute> {
  let logical;
  try {
    logical = await lstat(path, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
    return {
      kind: "missing",
      logicalIdentity: undefined,
      logicalPath: path,
      targetIdentity: undefined,
      targetPath: await canonicalMissingPath(path),
    };
  }
  if (!logical.isFile() && !logical.isSymbolicLink()) {
    throw new TypeError(`config path is not a regular file or symlink: ${path}`);
  }
  let targetPath: string;
  try {
    targetPath = await realpath(path);
  } catch (error) {
    if (logical.isSymbolicLink() && isMissing(error)) {
      throw new Error(`config symlink target does not exist: ${path}`, { cause: error });
    }
    throw error;
  }
  const target = await stat(targetPath, { bigint: true });
  if (!target.isFile()) throw new TypeError(`config target is not a regular file: ${path}`);
  return {
    kind: logical.isSymbolicLink() ? "symlink" : "regular",
    logicalIdentity: logical.isSymbolicLink() ? linkIdentity(logical) : fileIdentity(logical),
    logicalPath: path,
    targetIdentity: fileIdentity(target),
    targetPath,
  };
}

function sameConfigRoute(expected: ConfigRoute, actual: ConfigRoute): boolean {
  return (
    actual.kind === expected.kind &&
    actual.logicalIdentity === expected.logicalIdentity &&
    actual.targetIdentity === expected.targetIdentity &&
    actual.targetPath === expected.targetPath
  );
}

async function assertConfigRoute(expected: ConfigRoute): Promise<void> {
  const actual = await inspectConfigRoute(expected.logicalPath);
  if (!sameConfigRoute(expected, actual)) {
    throw new Error(`config path changed after planning: ${expected.logicalPath}`);
  }
}

function committedRoute(route: ConfigRoute, targetIdentity: string): ConfigRoute {
  return {
    kind: route.kind === "symlink" ? "symlink" : "regular",
    logicalIdentity: route.kind === "symlink" ? route.logicalIdentity : targetIdentity,
    logicalPath: route.logicalPath,
    targetIdentity,
    targetPath: route.targetPath,
  };
}

function recoveryRoutePath(configPath: string): string {
  return `${backupPath(configPath)}${RECOVERY_ROUTE_SUFFIX}`;
}

/**
 * Replace a file's contents without leaving a truncated one behind.
 *
 * A config half-written because the disk filled or the process died is a CLI
 * that no longer starts, so the new bytes land under a temporary name and the
 * rename swaps them in whole.
 */
export async function writeAtomic(path: string, data: string, mode?: number): Promise<void> {
  const inspect = async (lock?: SwapLockState) => {
    const route = await inspectConfigRoute(path);
    const current =
      route.kind === "missing"
        ? undefined
        : await readRecoveryFile(route.targetPath, "atomic write target");
    if (route.kind !== "missing" && current?.identity !== route.targetIdentity) {
      throw new Error(`atomic write target changed while it was planned: ${path}`);
    }
    await assertDistinctTransactionArtifacts(
      [
        {
          info: { configPath: path, name: "atomic write" },
          recovery: { backup: undefined, route: undefined },
          route,
        },
      ],
      lock ?? (await inspectSwapLock()),
    );
    return { current, route };
  };
  await inspect();
  await withSwapLock(async (lock) => {
    const hooks: SwapTransactionHooks = {};
    const { current, route } = await inspect(lock.state);
    const temporary = await stageFile(route.targetPath, data, mode ?? current?.mode);
    const operation = fileReplacement(temporary, route.targetPath, current, "config");
    try {
      await applyReplacement(operation, hooks, lock);
      await assertConfigState(committedRoute(route, temporary.identity), data, temporary.mode);
    } catch (error) {
      const rollbackFailures: unknown[] = [
        ...(await collectFailures([operation], async (candidate) =>
          rollbackReplacement(candidate, hooks, lock),
        )),
      ];
      rollbackFailures.push(...(await cleanupFiles([temporary], hooks, lock)));
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          "atomic write failed and rollback was incomplete",
        );
      }
      throw error;
    }
    const cleanupFailures = [
      ...(await cleanupReplacements([operation], hooks, lock)),
      ...(await cleanupFiles([temporary], hooks, lock)),
    ];
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "atomic write cleanup was incomplete");
    }
  });
}

export function backupPath(configPath: string): string {
  return `${configPath}${BACKUP_SUFFIX}`;
}

interface RecoveryFile {
  readonly identity: string;
  readonly mode: number;
  readonly raw: string;
}

interface RecoveryState {
  readonly backup: RecoveryFile | undefined;
  readonly route: RecoveryFile | undefined;
}

function decodeUtf8(contents: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8`, { cause: error });
  }
}

async function readUtf8File(path: string, label: string): Promise<string> {
  return decodeUtf8(await readFile(path), label);
}

async function readRecoveryFile(
  path: string,
  label: string,
  maximumBytes?: number,
): Promise<RecoveryFile | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new TypeError(`${label} is not a readable regular file: ${path}`, { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    const atPath = await lstat(path, { bigint: true });
    if (
      !before.isFile() ||
      atPath.isSymbolicLink() ||
      !atPath.isFile() ||
      fileIdentity(before) !== fileIdentity(atPath)
    ) {
      throw new TypeError(`${label} is not a stable regular file: ${path}`);
    }
    if (maximumBytes !== undefined && before.size > BigInt(maximumBytes)) {
      throw new TypeError(`${label} exceeds ${String(maximumBytes)} bytes: ${path}`);
    }
    const raw = decodeUtf8(await handle.readFile(), label);
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      fileIdentity(before) !== fileIdentity(after) ||
      fileIdentity(after) !== fileIdentity(afterPath) ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      after.ctimeNs !== afterPath.ctimeNs ||
      after.mtimeNs !== afterPath.mtimeNs ||
      after.mode !== afterPath.mode ||
      after.size !== afterPath.size
    ) {
      throw new Error(`${label} changed while it was read: ${path}`);
    }
    return {
      identity: fileIdentity(after),
      mode: Number(after.mode & 0o7777n),
      raw,
    };
  } finally {
    await handle.close();
  }
}

/** Read a config, answering an empty document when the file is not there yet. */
export async function readConfig(info: CliInfo): Promise<{ raw: string; value: unknown }> {
  let raw: string;
  try {
    raw = await readUtf8File(info.configPath, `${info.name} config`);
  } catch (error) {
    if (!isMissing(error)) throw error;
    raw = "";
  }
  return { raw, value: parseConfigRaw(info, raw) };
}

function parseConfigRaw(info: CliInfo, raw: string): unknown {
  if (info.format === "toml") return parseServerTables(raw, info.container[0]!);
  if (raw.trim() === "") return {};
  return info.format === "jsonc" ? parseJsonc(raw) : (JSON.parse(raw) as unknown);
}

function containerOf(value: unknown, path: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("config root must be an object");
  }
  let node = value as Record<string, unknown>;
  const traversed: string[] = [];
  for (const key of path) {
    const next = node[key];
    traversed.push(key);
    if (next === undefined) return {};
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new TypeError(`${traversed.join(".")} must be an object`);
    }
    node = next as Record<string, unknown>;
  }
  return node;
}

/** The spec a CLI currently has registered under `name`, if any. */
export async function readServer(info: CliInfo, name: string): Promise<ServerSpec | undefined> {
  const { raw, value } = await readConfig(info);
  if (info.format !== "toml") validateJsonServer(raw, info, name);
  const servers =
    info.format === "toml"
      ? (value as Record<string, unknown>)
      : containerOf(value, info.container);
  return parseEntry(servers[name], info.dialect, `${info.name} ${name} entry`);
}

export type WriteServerOutcome = "added" | "replaced";

export interface SwapTransactionHooks {
  readonly afterFailureBeforeUnlock?: (error: unknown) => Promise<void> | void;
  readonly afterLockAcquired?: () => Promise<void> | void;
  readonly afterStaging?: () => Promise<void> | void;
  readonly beforeConfigCommit?: (info: CliInfo, index: number) => Promise<void> | void;
  readonly beforeFileOperation?: (operation: {
    readonly boundary: string;
    readonly destination?: string;
    readonly source: string;
  }) => Promise<void> | void;
  readonly beforeRecoveryRetire?: (info: CliInfo, index: number) => Promise<void> | void;
}

/** Parse and render one update without changing its config or backup. */

function renderServerData(
  info: CliInfo,
  raw: string,
  value: unknown,
  name: string,
  spec: ServerSpec,
): { readonly data: string; readonly outcome: WriteServerOutcome } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("config root must be an object");
  }
  if (info.format !== "toml") validateJsonServer(raw, info, name);
  const servers =
    info.format === "toml"
      ? (value as Record<string, unknown>)
      : containerOf(value, info.container);
  const current = parseEntry(servers[name], info.dialect, `${info.name} ${name} entry`);
  const had = current !== undefined;
  const entry = toEntry(spec, info.dialect);
  let data: string;
  if (info.format === "toml") {
    data = renderServerTable(raw, info.container[0]!, name, entry);
    Bun.TOML.parse(data);
  } else {
    // Splice into the bytes the user has, so comments and spacing survive. Only
    // when there is no container to splice into — an empty or absent file — is
    // the document rebuilt, where there is nothing to preserve anyway.
    const spliced =
      raw.trim() === "" ? undefined : spliceEntryCreatingPath(raw, info.container, name, entry);
    if (spliced !== undefined) {
      data = spliced;
    } else {
      const document = value as Record<string, unknown>;
      let node = document;
      const traversed: string[] = [];
      for (const key of info.container) {
        const next = node[key];
        traversed.push(key);
        if (
          next !== undefined &&
          (typeof next !== "object" || next === null || Array.isArray(next))
        ) {
          throw new TypeError(`${traversed.join(".")} must be an object`);
        }
        node[key] = next ?? {};
        node = node[key] as Record<string, unknown>;
      }
      node[name] = entry;
      data = `${JSON.stringify(document, undefined, 2)}\n`;
    }
    if (info.format === "jsonc") parseJsonc(data);
    else JSON.parse(data);
  }

  return { data, outcome: had ? "replaced" : "added" };
}

interface StagedFile extends RecoveryFile {
  readonly path: string;
}

interface HeldFile extends RecoveryFile {
  readonly directory: string;
  readonly path: string;
}

async function stageFile(
  path: string,
  data: string,
  mode: number | undefined,
): Promise<StagedFile> {
  const temporary = `${path}.mcp-swap-${String(process.pid)}-${randomUUID()}`;
  await writeFile(temporary, data, mode === undefined ? { flag: "wx" } : { flag: "wx", mode });
  if (mode !== undefined) await chmod(temporary, mode);
  const staged = await readRecoveryFile(temporary, "transaction stage");
  if (staged === undefined || staged.raw !== data || (mode !== undefined && staged.mode !== mode)) {
    throw new Error(`transaction stage is not exact; retained at ${temporary}`);
  }
  return { ...staged, path: temporary };
}

function sameRecoveryFile(expected: RecoveryFile, actual: RecoveryFile | undefined): boolean {
  return (
    actual !== undefined &&
    actual.identity === expected.identity &&
    actual.mode === expected.mode &&
    actual.raw === expected.raw
  );
}

interface FileTransition {
  readonly delayed: Error | undefined;
  readonly file: RecoveryFile;
}

interface TakeAsideTransition {
  readonly delayed: Error | undefined;
  readonly held: HeldFile;
}

async function callFileOperationHook(
  hooks: SwapTransactionHooks,
  boundary: string,
  source: string,
  destination?: string,
): Promise<void> {
  await hooks.beforeFileOperation?.(
    destination === undefined ? { boundary, source } : { boundary, destination, source },
  );
}

async function publishAbsent(
  source: string,
  destination: string,
  expected: RecoveryFile,
  boundary: string,
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<FileTransition> {
  await lock.assert();
  await callFileOperationHook(hooks, boundary, source, destination);
  const sourceBefore = await readRecoveryFile(source, "publication source");
  if (!sameRecoveryFile(expected, sourceBefore)) {
    throw new Error(`publication source changed before ${boundary}: ${source}`);
  }
  await assertPathMissing(destination, `${boundary} destination`);
  await lock.assert();
  let delayed: Error | undefined;
  try {
    await link(source, destination);
  } catch (error) {
    const committed = await readRecoveryFile(destination, `${boundary} destination`);
    if (!sameRecoveryFile(expected, committed)) throw error;
    delayed = error as Error;
  }
  const committed = await readRecoveryFile(destination, `${boundary} destination`);
  if (!sameRecoveryFile(expected, committed)) {
    throw new Error(`atomic publication was not exact at ${boundary}: ${destination}`);
  }
  const sourceAfter = await readRecoveryFile(source, "publication source");
  if (!sameRecoveryFile(expected, sourceAfter) && delayed === undefined) {
    delayed = new Error(`publication source changed during ${boundary}: ${source}`);
  }
  await lock.assert();
  return { delayed, file: committed! };
}

async function takeAsideExact(
  source: string,
  expected: RecoveryFile,
  boundary: string,
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<TakeAsideTransition> {
  await lock.assert();
  const directory = await mkdtemp(join(dirname(source), `.${basename(source)}.mcp-swap-retained-`));
  await chmod(directory, 0o700);
  const destination = join(directory, "artifact");
  try {
    await callFileOperationHook(hooks, boundary, source, destination);
    const sourceBefore = await readRecoveryFile(source, `${boundary} source`);
    if (!sameRecoveryFile(expected, sourceBefore)) {
      throw new Error(`${boundary} source changed before take-aside: ${source}`);
    }
    await assertPathMissing(destination, `${boundary} quarantine`);
    await lock.assert();
    let delayed: Error | undefined;
    try {
      await rename(source, destination);
    } catch (error) {
      const moved = await readRecoveryFile(destination, `${boundary} quarantine`);
      if (!sameRecoveryFile(expected, moved)) throw error;
      delayed = error as Error;
    }
    const moved = await readRecoveryFile(destination, `${boundary} quarantine`);
    if (!sameRecoveryFile(expected, moved)) {
      throw new Error(`${boundary} moved an unexpected inode; retained at ${directory}`);
    }
    try {
      await lstat(source);
      delayed ??= new Error(`${boundary} source reappeared during take-aside: ${source}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await lock.assert();
    return { delayed, held: { ...moved!, directory, path: destination } };
  } catch (error) {
    try {
      await rmdir(directory);
    } catch {
      // A non-empty quarantine contains evidence that must survive the failure.
    }
    throw error;
  }
}

async function destroyHeldExact(
  held: HeldFile,
  lock: SwapLockHandle,
  hooks?: SwapTransactionHooks,
  boundary?: string,
): Promise<void> {
  await lock.assert();
  if (hooks !== undefined && boundary !== undefined) {
    await callFileOperationHook(hooks, boundary, held.path);
  }
  const before = await readRecoveryFile(held.path, "private transaction artifact");
  if (!sameRecoveryFile(held, before)) {
    throw new Error(`private transaction artifact changed; retained at ${held.directory}`);
  }
  await unlink(held.path);
  try {
    await lstat(held.path);
    throw new Error(`private transaction artifact reappeared; retained at ${held.directory}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await rmdir(held.directory);
  await lock.assert();
}

async function removeExact(
  path: string,
  expected: RecoveryFile,
  boundary: string,
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<void> {
  const transition = await takeAsideExact(path, expected, boundary, hooks, lock);
  await destroyHeldExact(transition.held, lock);
  if (transition.delayed !== undefined) throw transition.delayed;
}

async function collectFailures<T>(
  items: readonly T[],
  action: (item: T) => Promise<void>,
): Promise<readonly Error[]> {
  const failures: Error[] = [];
  for (const item of items) {
    try {
      // eslint-disable-next-line no-await-in-loop -- transaction steps stay deterministically ordered.
      await action(item);
    } catch (error) {
      failures.push(error as Error);
    }
  }
  return failures;
}

async function cleanupFiles(
  files: readonly StagedFile[],
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<readonly Error[]> {
  return collectFailures(files, async (file) =>
    removeExact(file.path, file, "stage-cleanup", hooks, lock),
  );
}

interface FileReplacement {
  committed?: RecoveryFile;
  readonly cleanupBoundary: string;
  readonly destination: string;
  readonly original: RecoveryFile | undefined;
  previous?: HeldFile;
  readonly publishBoundary: string | undefined;
  readonly rollbackPublishBoundary: string;
  readonly rollbackTakeBoundary: string;
  readonly source: StagedFile | undefined;
  readonly takeBoundary: string;
}

function fileReplacement(
  source: StagedFile,
  destination: string,
  original: RecoveryFile | undefined,
  role: "backup" | "config" | "state",
): FileReplacement {
  return {
    cleanupBoundary: `${role}-cleanup`,
    destination,
    original,
    publishBoundary: `${role}-publish`,
    rollbackPublishBoundary: `${role}-rollback-publish`,
    rollbackTakeBoundary: `${role}-rollback-take-aside`,
    source,
    takeBoundary: `${role}-take-aside`,
  };
}

function fileRemoval(
  destination: string,
  original: RecoveryFile,
  role: "backup" | "config" | "state",
): FileReplacement {
  return {
    cleanupBoundary: `${role}-cleanup`,
    destination,
    original,
    publishBoundary: undefined,
    rollbackPublishBoundary: `${role}-rollback-publish`,
    rollbackTakeBoundary: `${role}-rollback-take-aside`,
    source: undefined,
    takeBoundary: `${role}-take-aside`,
  };
}

async function applyReplacement(
  operation: FileReplacement,
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<void> {
  if (operation.original !== undefined) {
    const removal = await takeAsideExact(
      operation.destination,
      operation.original,
      operation.takeBoundary,
      hooks,
      lock,
    );
    operation.previous = removal.held;
    if (removal.delayed !== undefined) throw removal.delayed;
  }
  if (operation.source !== undefined && operation.publishBoundary !== undefined) {
    const publication = await publishAbsent(
      operation.source.path,
      operation.destination,
      operation.source,
      operation.publishBoundary,
      hooks,
      lock,
    );
    operation.committed = publication.file;
    if (publication.delayed !== undefined) throw publication.delayed;
  }
}

async function rollbackReplacement(
  operation: FileReplacement,
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<void> {
  let displaced: HeldFile | undefined;
  let delayed: Error | undefined;
  if (operation.committed !== undefined) {
    const removal = await takeAsideExact(
      operation.destination,
      operation.committed,
      operation.rollbackTakeBoundary,
      hooks,
      lock,
    );
    displaced = removal.held;
    delayed = removal.delayed;
  }
  if (operation.previous !== undefined) {
    const restoration = await publishAbsent(
      operation.previous.path,
      operation.destination,
      operation.previous,
      operation.rollbackPublishBoundary,
      hooks,
      lock,
    );
    delayed ??= restoration.delayed;
    await destroyHeldExact(operation.previous, lock);
  } else if (operation.original === undefined) {
    await assertPathMissing(operation.destination, `${operation.takeBoundary} rollback target`);
  } else {
    await assertRecoveryFile(
      operation.destination,
      operation.original,
      operation.original.raw,
      `${operation.takeBoundary} rollback target`,
      operation.original.mode,
    );
  }
  if (displaced !== undefined) await destroyHeldExact(displaced, lock);
  if (delayed !== undefined) throw delayed;
}

async function cleanupReplacements(
  operations: readonly FileReplacement[],
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<readonly Error[]> {
  return collectFailures(operations, async (operation) => {
    if (operation.previous !== undefined) {
      await destroyHeldExact(operation.previous, lock, hooks, operation.cleanupBoundary);
    }
  });
}

async function assertDistinctTransactionArtifacts(
  plans: readonly {
    readonly info: Pick<CliInfo, "configPath" | "name">;
    readonly recovery: RecoveryState;
    readonly route: ConfigRoute;
  }[],
  lock: SwapLockState,
): Promise<void> {
  const paths = new Map<string, string>();
  const identities = new Map<string, string>();
  const claim = (
    label: string,
    artifactPaths: readonly string[],
    artifactIdentities: readonly (string | undefined)[],
  ): void => {
    for (const path of new Set(artifactPaths)) {
      const owner = paths.get(path);
      if (owner !== undefined) {
        throw new Error(
          `${label} has the same resolved target or same transaction artifact as ${owner}`,
        );
      }
      paths.set(path, label);
    }
    for (const identity of new Set(artifactIdentities)) {
      if (identity === undefined) continue;
      const owner = identities.get(identity);
      if (owner !== undefined) {
        throw new Error(
          `${label} has the same resolved target or same transaction artifact as ${owner}`,
        );
      }
      identities.set(identity, label);
    }
  };
  claim("swap lock", [lock.logicalPath, lock.physicalPath], [lock.identity]);
  const artifactGroups = await Promise.all(
    plans.map(async (plan) => [
      {
        identities: [
          plan.route.targetIdentity,
          plan.route.logicalIdentity?.split(":").slice(0, 3).join(":"),
        ],
        label: `${plan.info.name} config`,
        paths: [plan.route.logicalPath, plan.route.targetPath],
      },
      {
        identities: [plan.recovery.backup?.identity],
        label: `${plan.info.name} recovery backup`,
        paths: [
          backupPath(plan.info.configPath),
          await canonicalMissingPath(backupPath(plan.info.configPath)),
        ],
      },
      {
        identities: [plan.recovery.route?.identity],
        label: `${plan.info.name} recovery route sidecar`,
        paths: [
          recoveryRoutePath(plan.info.configPath),
          await canonicalMissingPath(recoveryRoutePath(plan.info.configPath)),
        ],
      },
    ]),
  );
  for (const artifacts of artifactGroups) {
    for (const artifact of artifacts) {
      claim(artifact.label, artifact.paths, artifact.identities);
    }
  }
}

async function assertDestinationFeasible(path: string): Promise<void> {
  let candidate = dirname(path);
  for (;;) {
    let metadata;
    try {
      // eslint-disable-next-line no-await-in-loop -- ascend until one ancestor exists.
      metadata = await lstat(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new TypeError(`destination parent is not a directory: ${path}`);
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- the discovered ancestor must be checked now.
      await access(candidate, constants.W_OK | constants.X_OK);
    } catch (error) {
      throw new Error(`destination is not writable: ${path}`, { cause: error });
    }
    return;
  }
}

function planError(info: CliInfo, error: unknown): Error {
  return new Error(`${info.name} (${info.configPath}): ${(error as Error).message}`, {
    cause: error,
  });
}

async function assertPathMissing(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`${label} changed after planning: ${path}`);
}

async function assertRecoveryFile(
  path: string,
  expected: RecoveryFile | StagedFile,
  raw: string,
  label: string,
  mode?: number,
): Promise<void> {
  const actual = await readRecoveryFile(
    path,
    label,
    label.includes("route") ? RECOVERY_ROUTE_MAX_BYTES : undefined,
  );
  if (
    actual === undefined ||
    actual.identity !== expected.identity ||
    actual.raw !== raw ||
    (mode !== undefined && actual.mode !== mode)
  ) {
    throw new Error(`${label} changed after planning: ${path}`);
  }
}

async function assertConfigState(
  route: ConfigRoute,
  raw: string,
  mode: number | undefined,
): Promise<void> {
  await assertConfigRoute(route);
  if (route.kind === "missing") return;
  if (
    (await readUtf8File(route.targetPath, "config")) !== raw ||
    (await fileMode(route.targetPath)) !== mode
  ) {
    throw new Error(`config contents changed after planning: ${route.logicalPath}`);
  }
}

/** Update a selected client set as one rollback-capable transaction. */

/** Point one CLI at `spec`, backing the file up first. */

/** Restore a selected client set as one rollback-capable transaction. */

/** Restore one config from the backup a swap wrote. */

const NATIVE_CONFIG_MAX_BYTES = 16 * 1024 * 1024;
const NATIVE_STATE_MAX_BYTES = 256 * 1024;
const NATIVE_BACKUP_MARKER = ".bak.mcp-swap-typescript-";

interface NativeFileRecord {
  readonly digest: string;
  readonly identity: string;
  readonly mode: number;
  readonly size: number;
}

interface NativeRecoveryEntry {
  readonly backup: NativeFileRecord | null;
  readonly backupPath: string | null;
  readonly client: string;
  readonly configPath: string;
  readonly expectedConfig: NativeFileRecord;
  readonly logicalIdentity: string | null;
  readonly originalKind: "file" | "missing";
  readonly originalMode: number | null;
  readonly routeKind: "regular" | "symlink";
  readonly scope: SwapScope;
  readonly sequence: number;
  readonly server: string;
  readonly targetPath: string;
}

interface NativeLedger {
  readonly entries: Readonly<Record<string, NativeRecoveryEntry>>;
  readonly nextSequence: number;
  readonly port: "typescript";
  readonly version: 1;
}

interface NativeContext {
  readonly ledger: NativeLedger;
  readonly stateFile: RecoveryFile | undefined;
}

function nativeStateDirectory(): string {
  return join(xdgStateHome(), "libtmux-mcp-dev", "swap", "typescript");
}

export function nativeStatePath(): string {
  return join(nativeStateDirectory(), "state.json");
}

function nativeBackupPath(targetPath: string, sequence: number): string {
  return `${targetPath}${NATIVE_BACKUP_MARKER}${String(sequence).padStart(20, "0")}`;
}

function nativeFileRecord(file: RecoveryFile): NativeFileRecord {
  return {
    digest: contentDigest(file.raw),
    identity: file.identity,
    mode: file.mode,
    size: Buffer.byteLength(file.raw),
  };
}

function sameNativeFileRecord(expected: NativeFileRecord, actual: RecoveryFile): boolean {
  return (
    expected.identity === actual.identity &&
    expected.mode === actual.mode &&
    expected.size === Buffer.byteLength(actual.raw) &&
    expected.digest === contentDigest(actual.raw)
  );
}

function sameNativeContent(expected: NativeFileRecord, actual: RecoveryFile): boolean {
  return (
    expected.mode === actual.mode &&
    expected.size === Buffer.byteLength(actual.raw) &&
    expected.digest === contentDigest(actual.raw)
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function serializeNativeLedger(ledger: NativeLedger): string {
  const payload = {
    entries: Object.fromEntries(
      Object.entries(ledger.entries).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    nextSequence: ledger.nextSequence,
    port: ledger.port,
    version: ledger.version,
  };
  return `${JSON.stringify({ checksum: contentDigest(canonicalJson(payload)), payload }, undefined, 2)}\n`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).toSorted().join("\0") !== keys.toSorted().join("\0")) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function nativeObjectMember(text: string, open: number, key: string, label: string): Member {
  const member = assertUniqueMembers(text, open, label).find((candidate) => candidate.key === key);
  if (member === undefined || text[member.valueStart] !== "{") {
    throw new TypeError(`${label}.${key} must be an object`);
  }
  return member;
}

function validateNativeLedgerDuplicates(raw: string): void {
  const open = raw.indexOf("{");
  if (open === -1) throw new TypeError("TypeScript recovery state is not an object");
  const payload = nativeObjectMember(raw, open, "payload", "TypeScript recovery state");
  const entries = nativeObjectMember(
    raw,
    payload.valueStart,
    "entries",
    "TypeScript recovery payload",
  );
  for (const entry of assertUniqueMembers(raw, entries.valueStart, "TypeScript recovery entries")) {
    if (raw[entry.valueStart] !== "{") {
      throw new TypeError(`recovery entry ${entry.key} is not an object`);
    }
    const members = assertUniqueMembers(raw, entry.valueStart, `recovery entry ${entry.key}`);
    for (const key of ["backup", "expectedConfig"]) {
      const nested = members.find((member) => member.key === key);
      if (nested !== undefined && raw[nested.valueStart] === "{") {
        assertUniqueMembers(raw, nested.valueStart, `${entry.key} ${key}`);
      }
    }
  }
}

function parseNativeFileRecord(value: unknown, label: string): NativeFileRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} is not an object`);
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, ["digest", "identity", "mode", "size"], label);
  if (
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    typeof record.identity !== "string" ||
    !/^\d+:\d+:-?\d+$/u.test(record.identity) ||
    !Number.isInteger(record.mode) ||
    (record.mode as number) < 0 ||
    (record.mode as number) > 0o7777 ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0
  ) {
    throw new TypeError(`${label} has invalid file identity`);
  }
  return {
    digest: record.digest,
    identity: record.identity,
    mode: record.mode as number,
    size: record.size as number,
  };
}

function parseNativeRecoveryEntry(key: string, value: unknown): NativeRecoveryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`recovery entry ${key} is not an object`);
  }
  const record = value as Record<string, unknown>;
  exactKeys(
    record,
    [
      "backup",
      "backupPath",
      "client",
      "configPath",
      "expectedConfig",
      "logicalIdentity",
      "originalKind",
      "originalMode",
      "routeKind",
      "scope",
      "sequence",
      "server",
      "targetPath",
    ],
    `recovery entry ${key}`,
  );
  const clientNames = new Set(knownClis({}, "/home").map((info) => info.name));
  if (
    typeof record.client !== "string" ||
    !clientNames.has(record.client) ||
    (record.scope !== "user" && record.scope !== "project") ||
    (record.client !== "claude" && record.scope !== "user") ||
    key !== `${record.client}:${record.scope}` ||
    typeof record.configPath !== "string" ||
    !isAbsolute(record.configPath) ||
    record.configPath.includes("\0") ||
    typeof record.targetPath !== "string" ||
    !isAbsolute(record.targetPath) ||
    record.targetPath.includes("\0") ||
    (record.routeKind !== "regular" && record.routeKind !== "symlink") ||
    (record.originalKind !== "file" && record.originalKind !== "missing") ||
    typeof record.server !== "string" ||
    record.server === "" ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0
  ) {
    throw new TypeError(`recovery entry ${key} has invalid ownership`);
  }
  requireSafeComponent(record.server, `${key} server`);
  if (
    (record.routeKind === "regular" && record.logicalIdentity !== null) ||
    (record.routeKind === "symlink" &&
      (typeof record.logicalIdentity !== "string" ||
        !/^\d+:\d+:-?\d+:-?\d+$/u.test(record.logicalIdentity))) ||
    (record.originalKind === "missing" &&
      (record.originalMode !== null || record.backup !== null || record.backupPath !== null)) ||
    (record.originalKind === "file" &&
      (!Number.isInteger(record.originalMode) ||
        (record.originalMode as number) < 0 ||
        (record.originalMode as number) > 0o7777 ||
        typeof record.backupPath !== "string" ||
        !isAbsolute(record.backupPath) ||
        record.backupPath.includes("\0") ||
        record.backup === null))
  ) {
    throw new TypeError(`recovery entry ${key} has invalid route or backup`);
  }
  return {
    backup:
      record.backup === null
        ? null
        : parseNativeFileRecord(record.backup, `${key} recovery backup`),
    backupPath: record.backupPath as string | null,
    client: record.client,
    configPath: record.configPath,
    expectedConfig: parseNativeFileRecord(record.expectedConfig, `${key} expected config`),
    logicalIdentity: record.logicalIdentity as string | null,
    originalKind: record.originalKind,
    originalMode: record.originalMode as number | null,
    routeKind: record.routeKind,
    scope: record.scope,
    sequence: record.sequence as number,
    server: record.server,
    targetPath: record.targetPath,
  };
}

function parseNativeLedger(raw: string): NativeLedger {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new TypeError("TypeScript recovery state is malformed", { cause: error });
  }
  validateNativeLedgerDuplicates(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("TypeScript recovery state is not an object");
  }
  const envelope = value as Record<string, unknown>;
  exactKeys(envelope, ["checksum", "payload"], "TypeScript recovery state");
  if (
    typeof envelope.payload !== "object" ||
    envelope.payload === null ||
    Array.isArray(envelope.payload)
  ) {
    throw new TypeError("TypeScript recovery payload is not an object");
  }
  const payload = envelope.payload as Record<string, unknown>;
  exactKeys(payload, ["entries", "nextSequence", "port", "version"], "TypeScript recovery payload");
  if (
    envelope.checksum !== contentDigest(canonicalJson(payload)) ||
    payload.port !== "typescript" ||
    payload.version !== 1 ||
    !Number.isSafeInteger(payload.nextSequence) ||
    (payload.nextSequence as number) < 0 ||
    typeof payload.entries !== "object" ||
    payload.entries === null ||
    Array.isArray(payload.entries)
  ) {
    throw new TypeError("TypeScript recovery state has an invalid checksum or schema");
  }
  const entries = Object.fromEntries(
    Object.entries(payload.entries as Record<string, unknown>).map(([key, entry]) => [
      key,
      parseNativeRecoveryEntry(key, entry),
    ]),
  );
  const sequences = Object.values(entries).map((entry) => entry.sequence);
  if (
    new Set(sequences).size !== sequences.length ||
    sequences.some((sequence) => sequence >= (payload.nextSequence as number))
  ) {
    throw new TypeError("TypeScript recovery state has invalid sequence ownership");
  }
  return {
    entries,
    nextSequence: payload.nextSequence as number,
    port: "typescript",
    version: 1,
  };
}

function emptyNativeLedger(): NativeLedger {
  return { entries: {}, nextSequence: 0, port: "typescript", version: 1 };
}

async function readNativeContext(): Promise<NativeContext> {
  const directory = await inspectLockDirectory(nativeStateDirectory());
  if (directory === undefined) return { ledger: emptyNativeLedger(), stateFile: undefined };
  const stateFile = await readRecoveryFile(
    nativeStatePath(),
    "TypeScript recovery state",
    NATIVE_STATE_MAX_BYTES,
  );
  if (stateFile === undefined) return { ledger: emptyNativeLedger(), stateFile: undefined };
  if (stateFile.mode !== 0o600) throw new TypeError("TypeScript recovery state mode must be 0600");
  return { ledger: parseNativeLedger(stateFile.raw), stateFile };
}

async function ensureNativeStateDirectory(): Promise<void> {
  try {
    await mkdir(nativeStateDirectory(), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directory = await inspectLockDirectory(nativeStateDirectory());
  if (directory === undefined) throw new Error("TypeScript recovery directory was not created");
}

async function ensureNativeDestinationParent(path: string): Promise<void> {
  const parent = dirname(path);
  const expected = await canonicalMissingPath(parent);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const metadata = await lstat(parent);
  const actual = await realpath(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || actual !== expected) {
    throw new Error(`destination parent changed while it was created: ${path}`);
  }
}

async function nativeOrphanBackups(
  allClis: readonly CliInfo[],
  ledger: NativeLedger,
): Promise<readonly string[]> {
  const owned = new Set(
    Object.values(ledger.entries).flatMap((entry) =>
      entry.backupPath === null ? [] : [entry.backupPath],
    ),
  );
  const candidates = new Set<string>();
  for (const info of allClis) {
    // eslint-disable-next-line no-await-in-loop -- routes may point at distinct dotfile trees.
    const route = await inspectConfigRoute(info.configPath);
    const parent = dirname(route.targetPath);
    const prefix = `${basename(route.targetPath)}${NATIVE_BACKUP_MARKER}`;
    let names: string[];
    try {
      // eslint-disable-next-line no-await-in-loop -- each authenticated parent is inspected once.
      names = await readdir(parent);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const name of names) {
      const path = join(parent, name);
      if (name.startsWith(prefix) && !owned.has(path)) candidates.add(path);
    }
  }
  return [...candidates].toSorted();
}

interface NativeConfigSnapshot {
  readonly file: RecoveryFile | undefined;
  readonly info: CliInfo;
  readonly route: ConfigRoute;
}

async function nativeConfigSnapshot(info: CliInfo): Promise<NativeConfigSnapshot> {
  const route = await inspectConfigRoute(info.configPath);
  const file =
    route.kind === "missing"
      ? undefined
      : await readRecoveryFile(route.targetPath, `${info.name} config`, NATIVE_CONFIG_MAX_BYTES);
  if (route.kind !== "missing" && file?.identity !== route.targetIdentity) {
    throw new Error(`${info.name} config changed while it was read`);
  }
  return { file, info, route };
}

function nativeEntryMatchesRoute(entry: NativeRecoveryEntry, route: ConfigRoute): boolean {
  return (
    route.kind === entry.routeKind &&
    route.logicalPath === entry.configPath &&
    route.targetPath === entry.targetPath &&
    (route.kind === "regular" || route.logicalIdentity === entry.logicalIdentity)
  );
}

async function verifyNativeContext(
  context: NativeContext,
  allClis: readonly CliInfo[],
  extraPaths: readonly { readonly label: string; readonly path: string }[] = [],
  heldLock?: SwapLockState,
): Promise<Map<string, NativeConfigSnapshot>> {
  const byName = new Map(allClis.map((info) => [info.name, info]));
  const snapshots = new Map<string, NativeConfigSnapshot>();
  for (const info of allClis) {
    // eslint-disable-next-line no-await-in-loop -- every path is authenticated in canonical order.
    snapshots.set(info.name, await nativeConfigSnapshot(info));
  }

  const entriesByTarget = new Map<string, NativeRecoveryEntry[]>();
  for (const [key, entry] of Object.entries(context.ledger.entries)) {
    const info = byName.get(entry.client);
    if (info === undefined || info.configPath !== entry.configPath) {
      throw new Error(`${key} recovery state does not own its configured client path`);
    }
    if (entry.backupPath !== null) {
      if (entry.backupPath !== nativeBackupPath(entry.targetPath, entry.sequence)) {
        throw new Error(`${key} recovery backup is outside the TypeScript namespace`);
      }
      // eslint-disable-next-line no-await-in-loop -- every recorded backup is authenticated.
      const backup = await readRecoveryFile(
        entry.backupPath,
        `${key} recovery backup`,
        NATIVE_CONFIG_MAX_BYTES,
      );
      if (
        backup === undefined ||
        entry.backup === null ||
        backup.mode !== 0o600 ||
        !sameNativeFileRecord(entry.backup, backup)
      ) {
        throw new Error(`${key} recovery backup changed`);
      }
    }
    const snapshot = snapshots.get(entry.client)!;
    if (!nativeEntryMatchesRoute(entry, snapshot.route) || snapshot.file === undefined) {
      throw new Error(`${key} configuration route changed`);
    }
    const grouped = entriesByTarget.get(entry.targetPath) ?? [];
    grouped.push(entry);
    entriesByTarget.set(entry.targetPath, grouped);
  }
  for (const entries of entriesByTarget.values()) {
    const newest = entries.toSorted((a, b) => b.sequence - a.sequence)[0]!;
    const current = snapshots.get(newest.client)!.file!;
    if (!sameNativeFileRecord(newest.expectedConfig, current)) {
      throw new Error(`${newest.client} config changed since mcp-swap wrote its newest layer`);
    }
  }

  const paths = new Map<string, string>();
  const identities = new Map<string, string>();
  const claim = (
    label: string,
    artifactPaths: readonly string[],
    artifactIdentities: readonly (string | undefined)[],
  ): void => {
    for (const path of new Set(artifactPaths)) {
      const previous = paths.get(path);
      if (previous !== undefined) throw new Error(`${label} aliases ${previous}`);
      paths.set(path, label);
    }
    for (const identity of new Set(artifactIdentities)) {
      if (identity === undefined) continue;
      const previous = identities.get(identity);
      if (previous !== undefined) throw new Error(`${label} aliases ${previous}`);
      identities.set(identity, label);
    }
  };
  const lock = heldLock ?? (await inspectSwapLock());
  claim("swap lock", [lock.logicalPath, lock.physicalPath], [lock.identity]);
  for (const snapshot of snapshots.values()) {
    claim(
      `${snapshot.info.name} config`,
      [snapshot.route.logicalPath, snapshot.route.targetPath],
      [
        snapshot.route.targetIdentity,
        snapshot.route.logicalIdentity?.split(":").slice(0, 3).join(":"),
      ],
    );
  }
  claim(
    "TypeScript recovery state",
    [nativeStatePath(), await canonicalMissingPath(nativeStatePath())],
    [context.stateFile?.identity],
  );
  for (const [key, entry] of Object.entries(context.ledger.entries)) {
    if (entry.backupPath !== null) {
      claim(
        `${key} recovery backup`,
        // eslint-disable-next-line no-await-in-loop -- claims retain ledger order for diagnostics.
        [entry.backupPath, await canonicalMissingPath(entry.backupPath)],
        [entry.backup?.identity],
      );
    }
  }
  for (const extra of extraPaths) {
    let metadata;
    try {
      // eslint-disable-next-line no-await-in-loop -- candidate claims are checked in plan order.
      metadata = await lstat(extra.path, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- candidate claims are checked in plan order.
    const canonical = await canonicalMissingPath(extra.path);
    claim(
      extra.label,
      [extra.path, canonical],
      [metadata === undefined ? undefined : fileIdentity(metadata)],
    );
    if (metadata !== undefined) throw new Error(`${extra.label} already exists`);
    // eslint-disable-next-line no-await-in-loop -- each destination must pass before planning returns.
    await assertDestinationFeasible(extra.path);
  }
  return snapshots;
}

type NativeUseOutcome = "added" | "replaced" | "unchanged";

interface NativeBackupRewrite {
  readonly data: string;
  readonly entry: NativeRecoveryEntry;
  readonly key: string;
  readonly snapshot: RecoveryFile;
}

interface NativeUsePlan {
  readonly backupPath: string | null;
  readonly data: string;
  readonly existing: NativeRecoveryEntry | undefined;
  readonly finalSpec: ServerSpec;
  readonly key: string;
  readonly newer: readonly NativeBackupRewrite[];
  readonly outcome: NativeUseOutcome;
  readonly scope: SwapScope;
  readonly server: string;
  readonly scopedInfo: CliInfo;
  readonly sequence: number;
  readonly snapshot: NativeConfigSnapshot;
}

interface NativeUseBatch {
  readonly context: NativeContext;
  readonly plans: readonly NativeUsePlan[];
}

function sameServerSpec(left: ServerSpec | undefined, right: ServerSpec): boolean {
  return left !== undefined && canonicalJson(left) === canonicalJson(right);
}

function serverFromRaw(info: CliInfo, raw: string, server: string): ServerSpec | undefined {
  const value = parseConfigRaw(info, raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("config root must be an object");
  }
  const servers =
    info.format === "toml"
      ? (value as Record<string, unknown>)
      : containerOf(value, info.container);
  if (info.format !== "toml") validateJsonServer(raw, info, server);
  return parseEntry(servers[server], info.dialect, `${info.name} ${server} entry`);
}

function finalServerSpec(
  base: ServerSpec,
  current: ServerSpec | undefined,
  explicitToolsets: boolean,
): ServerSpec {
  if ("LIBTMUX_SAFETY" in base.env) {
    throw new Error("LIBTMUX_SAFETY is retired; use LIBTMUX_TOOLSETS");
  }
  const environment = { ...current?.env, ...base.env };
  if (explicitToolsets) {
    delete environment.LIBTMUX_SAFETY;
  }
  return { args: [...base.args], command: base.command, env: environment };
}

async function planNativeUse(
  allClis: readonly CliInfo[],
  selected: readonly CliInfo[],
  server: string,
  repo: string,
  scope: SwapScope,
  baseSpec: ServerSpec,
  explicitToolsets: boolean,
  heldLock?: SwapLockState,
): Promise<NativeUseBatch> {
  const context = await readNativeContext();
  const snapshots = await verifyNativeContext(context, allClis, [], heldLock);
  let nextSequence = context.ledger.nextSequence;
  const plans: NativeUsePlan[] = [];
  const extraPaths: { label: string; path: string }[] = [];
  for (const info of selected) {
    try {
      const normalizedScope: SwapScope = info.name === "claude" ? scope : "user";
      const scopedInfo = scopedCli(info, repo, normalizedScope);
      const key = `${info.name}:${normalizedScope}`;
      const snapshot = snapshots.get(info.name)!;
      const raw = snapshot.file?.raw ?? "";
      const current = serverFromRaw(scopedInfo, raw, server);
      const finalSpec = finalServerSpec(baseSpec, current, explicitToolsets);
      const existing = context.ledger.entries[key];
      let sequence = existing?.sequence;
      if (sequence === undefined) {
        if (nextSequence === Number.MAX_SAFE_INTEGER) {
          throw new Error("TypeScript recovery sequence is exhausted");
        }
        sequence = nextSequence++;
      }
      const backupPath =
        existing?.backupPath ??
        (snapshot.file === undefined
          ? null
          : nativeBackupPath(snapshot.route.targetPath, sequence));
      if (existing === undefined && backupPath !== null) {
        extraPaths.push({ label: `${key} recovery backup`, path: backupPath });
      }
      const rendered = sameServerSpec(current, finalSpec)
        ? { data: raw, outcome: "unchanged" as const }
        : {
            ...renderServerData(
              scopedInfo,
              raw,
              parseConfigRaw(scopedInfo, raw),
              server,
              finalSpec,
            ),
            outcome: (current === undefined ? "added" : "replaced") as NativeUseOutcome,
          };
      const newer: NativeBackupRewrite[] = [];
      if (existing !== undefined && rendered.outcome !== "unchanged") {
        const candidates = Object.entries(context.ledger.entries)
          .filter(
            ([candidateKey, candidate]) =>
              candidateKey !== key &&
              candidate.targetPath === existing.targetPath &&
              candidate.sequence > existing.sequence,
          )
          .toSorted(([, left], [, right]) => left.sequence - right.sequence);
        for (const [candidateKey, candidate] of candidates) {
          if (candidate.backupPath === null) {
            throw new Error(`${candidateKey} recovery chain has no backup`);
          }
          // eslint-disable-next-line no-await-in-loop -- recovery order is the chain order.
          const backup = await readRecoveryFile(
            candidate.backupPath,
            `${candidateKey} recovery backup`,
            NATIVE_CONFIG_MAX_BYTES,
          );
          if (
            backup === undefined ||
            candidate.backup === null ||
            !sameNativeFileRecord(candidate.backup, backup)
          ) {
            throw new Error(`${candidateKey} recovery backup changed`);
          }
          const data = renderServerData(
            scopedInfo,
            backup.raw,
            parseConfigRaw(scopedInfo, backup.raw),
            server,
            finalSpec,
          ).data;
          newer.push({ data, entry: candidate, key: candidateKey, snapshot: backup });
        }
      }
      // eslint-disable-next-line no-await-in-loop -- failures are attributed in selection order.
      await assertDestinationFeasible(snapshot.route.targetPath);
      plans.push({
        backupPath,
        data: rendered.data,
        existing,
        finalSpec,
        key,
        newer,
        outcome: rendered.outcome,
        scope: normalizedScope,
        server,
        scopedInfo,
        sequence,
        snapshot,
      });
    } catch (error) {
      throw planError(info, error);
    }
  }
  await assertDestinationFeasible(nativeStatePath());
  await verifyNativeContext(context, allClis, extraPaths, heldLock);
  return { context, plans };
}

function sameFinalSpecs(left: NativeUseBatch, right: NativeUseBatch): boolean {
  return (
    left.plans.length === right.plans.length &&
    left.plans.every(
      (plan, index) =>
        plan.key === right.plans[index]?.key &&
        canonicalJson(plan.finalSpec) === canonicalJson(right.plans[index]?.finalSpec),
    )
  );
}

interface NativePreparedUse {
  readonly configStages: ReadonlyMap<string, StagedFile>;
  readonly ledger: NativeLedger;
  readonly operations: readonly FileReplacement[];
  readonly temporaryFiles: readonly StagedFile[];
}

async function prepareNativeUse(batch: NativeUseBatch): Promise<NativePreparedUse> {
  if (batch.plans.every((plan) => plan.outcome === "unchanged")) {
    return {
      configStages: new Map(),
      ledger: batch.context.ledger,
      operations: [],
      temporaryFiles: [],
    };
  }
  await ensureNativeStateDirectory();
  const entries: Record<string, NativeRecoveryEntry> = { ...batch.context.ledger.entries };
  let nextSequence = batch.context.ledger.nextSequence;
  const temporaryFiles: StagedFile[] = [];
  const prefix: FileReplacement[] = [];
  const configs: FileReplacement[] = [];
  const configStages = new Map<string, StagedFile>();
  for (const plan of batch.plans) {
    if (plan.outcome !== "unchanged") {
      // eslint-disable-next-line no-await-in-loop -- every target parent is authenticated before staging.
      await ensureNativeDestinationParent(plan.snapshot.route.targetPath);
    }
  }
  for (const plan of batch.plans) {
    if (plan.outcome === "unchanged") continue;
    const current = plan.snapshot.file;
    let backup = plan.existing?.backup ?? null;
    let restoredSelected: NativeFileRecord | undefined;
    if (plan.existing === undefined && plan.backupPath !== null && current !== undefined) {
      // eslint-disable-next-line no-await-in-loop -- every owned backup stages before publication.
      const stage = await stageFile(plan.backupPath, current.raw, 0o600);
      temporaryFiles.push(stage);
      prefix.push(fileReplacement(stage, plan.backupPath, undefined, "backup"));
      backup = nativeFileRecord(stage);
    }
    for (const rewrite of plan.newer) {
      // eslint-disable-next-line no-await-in-loop -- recovery-chain order is deterministic.
      const stage = await stageFile(rewrite.entry.backupPath!, rewrite.data, 0o600);
      temporaryFiles.push(stage);
      prefix.push(fileReplacement(stage, rewrite.entry.backupPath!, rewrite.snapshot, "backup"));
      entries[rewrite.key] = { ...rewrite.entry, backup: nativeFileRecord(stage) };
      restoredSelected ??= {
        ...nativeFileRecord(stage),
        mode: rewrite.entry.originalMode!,
      };
    }
    // eslint-disable-next-line no-await-in-loop -- all config stages precede any publication.
    const configStage = await stageFile(
      plan.snapshot.route.targetPath,
      plan.data,
      current?.mode ?? 0o600,
    );
    temporaryFiles.push(configStage);
    configStages.set(plan.key, configStage);
    const configRecord = nativeFileRecord(configStage);
    const newestRewrite = plan.newer.at(-1);
    if (newestRewrite !== undefined) {
      entries[newestRewrite.key] = {
        ...entries[newestRewrite.key]!,
        expectedConfig: configRecord,
      };
    }
    const existing = plan.existing;
    entries[plan.key] = {
      backup,
      backupPath: plan.backupPath,
      client: plan.scopedInfo.name,
      configPath: plan.scopedInfo.configPath,
      expectedConfig: newestRewrite === undefined ? configRecord : restoredSelected!,
      logicalIdentity:
        plan.snapshot.route.kind === "symlink" ? plan.snapshot.route.logicalIdentity! : null,
      originalKind: existing?.originalKind ?? (current === undefined ? "missing" : "file"),
      originalMode: existing?.originalMode ?? current?.mode ?? null,
      routeKind: plan.snapshot.route.kind === "symlink" ? "symlink" : "regular",
      scope: plan.scope,
      sequence: plan.sequence,
      server: plan.server,
      targetPath: plan.snapshot.route.targetPath,
    };
    nextSequence = Math.max(nextSequence, plan.sequence + 1);
    configs.push(fileReplacement(configStage, plan.snapshot.route.targetPath, current, "config"));
  }
  const ledger: NativeLedger = {
    entries,
    nextSequence,
    port: "typescript",
    version: 1,
  };
  const stateStage = await stageFile(nativeStatePath(), serializeNativeLedger(ledger), 0o600);
  temporaryFiles.push(stateStage);
  prefix.push(fileReplacement(stateStage, nativeStatePath(), batch.context.stateFile, "state"));
  return { configStages, ledger, operations: [...prefix, ...configs], temporaryFiles };
}

async function applyNativeOperations(
  operations: readonly FileReplacement[],
  temporaryFiles: readonly StagedFile[],
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<void> {
  const applied: FileReplacement[] = [];
  try {
    for (const operation of operations) {
      // eslint-disable-next-line no-await-in-loop -- publication order is part of recovery.
      await applyReplacement(operation, hooks, lock);
      applied.push(operation);
    }
  } catch (error) {
    const rollbackFailures = [
      ...(await collectFailures(applied.toReversed(), async (operation) =>
        rollbackReplacement(operation, hooks, lock),
      )),
    ];
    rollbackFailures.push(...(await cleanupFiles(temporaryFiles, hooks, lock)));
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "native swap failed and exact rollback was incomplete",
      );
    }
    throw error;
  }
  const cleanupFailures = [
    ...(await cleanupReplacements(operations, hooks, lock)),
    ...(await cleanupFiles(temporaryFiles, hooks, lock)),
  ];
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "native swap committed but cleanup was incomplete");
  }
}

export async function useNativeConfigs(
  allClis: readonly CliInfo[],
  selected: readonly CliInfo[],
  server: string,
  repo: string,
  scope: SwapScope,
  baseSpec: ServerSpec,
  explicitToolsets: boolean,
  options: {
    readonly dryRun: boolean;
    readonly hooks?: SwapTransactionHooks;
    readonly prepare?: () => Promise<void>;
    readonly skipPreflight: boolean;
  },
): Promise<readonly NativeUsePlan[]> {
  const preliminary = await planNativeUse(
    allClis,
    selected,
    server,
    repo,
    scope,
    baseSpec,
    explicitToolsets,
  );
  if (options.dryRun) return preliminary.plans;
  await options.prepare?.();
  if (!options.skipPreflight) {
    const unique = new Map(
      preliminary.plans.map((plan) => [canonicalJson(plan.finalSpec), plan.finalSpec]),
    );
    for (const spec of unique.values()) {
      // eslint-disable-next-line no-await-in-loop -- every distinct final environment is probed.
      const reason = await preflight(spec, 300_000);
      if (reason !== undefined) {
        throw new Error(`server did not answer MCP initialize: ${reason}`);
      }
    }
  }
  return withSwapLock(async (lock) => {
    try {
      await options.hooks?.afterLockAcquired?.();
      const locked = await planNativeUse(
        allClis,
        selected,
        server,
        repo,
        scope,
        baseSpec,
        explicitToolsets,
      );
      if (!sameFinalSpecs(preliminary, locked)) {
        throw new Error("final MCP specification changed after preflight");
      }
      const prepared = await prepareNativeUse(locked);
      await options.hooks?.afterStaging?.();
      const stagedCheck = await planNativeUse(
        allClis,
        selected,
        server,
        repo,
        scope,
        baseSpec,
        explicitToolsets,
        lock.state,
      );
      if (!sameFinalSpecs(locked, stagedCheck)) {
        throw new Error("final MCP specification changed during staging");
      }
      await applyNativeOperations(
        prepared.operations,
        prepared.temporaryFiles,
        options.hooks ?? {},
        lock,
      );
      return locked.plans;
    } catch (error) {
      await options.hooks?.afterFailureBeforeUnlock?.(error);
      throw error;
    }
  });
}

interface NativeRevertPlan {
  readonly backup: RecoveryFile | undefined;
  readonly entry: NativeRecoveryEntry;
  readonly info: CliInfo;
  readonly key: string;
  readonly snapshot: NativeConfigSnapshot;
}

interface NativeRevertBatch {
  readonly context: NativeContext;
  readonly plans: readonly NativeRevertPlan[];
}

async function planNativeRevert(
  allClis: readonly CliInfo[],
  selected: readonly CliInfo[],
  scope: SwapScope | undefined,
  heldLock?: SwapLockState,
): Promise<NativeRevertBatch> {
  const context = await readNativeContext();
  const snapshots = await verifyNativeContext(context, allClis, [], heldLock);
  const selectedNames = new Set(selected.map((info) => info.name));
  const candidates = Object.entries(context.ledger.entries)
    .filter(([, entry]) => selectedNames.has(entry.client))
    .filter(
      ([, entry]) =>
        scope === undefined || entry.scope === (entry.client === "claude" ? scope : "user"),
    )
    .toSorted(([, left], [, right]) => right.sequence - left.sequence);
  const candidateKeys = new Set(candidates.map(([key]) => key));
  for (const [key, entry] of candidates) {
    const skippedNewer = Object.entries(context.ledger.entries).find(
      ([otherKey, other]) =>
        !candidateKeys.has(otherKey) &&
        other.targetPath === entry.targetPath &&
        other.sequence > entry.sequence,
    );
    if (skippedNewer !== undefined) {
      throw new Error(`${key} cannot revert before newer layer ${skippedNewer[0]}`);
    }
  }

  const simulated = new Map<string, RecoveryFile | undefined>();
  const plans: NativeRevertPlan[] = [];
  for (const [key, entry] of candidates) {
    const info = allClis.find((candidate) => candidate.name === entry.client)!;
    const snapshot = snapshots.get(entry.client)!;
    const current = simulated.has(entry.targetPath)
      ? simulated.get(entry.targetPath)
      : snapshot.file;
    if (current === undefined) throw new Error(`${key} config disappeared before revert`);
    const first = !simulated.has(entry.targetPath);
    if (
      (first && !sameNativeFileRecord(entry.expectedConfig, current)) ||
      (!first && !sameNativeContent(entry.expectedConfig, current))
    ) {
      throw new Error(`${key} recovery chain does not match the current config`);
    }
    let backup: RecoveryFile | undefined;
    if (entry.originalKind === "file") {
      // eslint-disable-next-line no-await-in-loop -- backups are consumed in strict LIFO order.
      backup = await readRecoveryFile(
        entry.backupPath!,
        `${key} recovery backup`,
        NATIVE_CONFIG_MAX_BYTES,
      );
      if (
        backup === undefined ||
        entry.backup === null ||
        !sameNativeFileRecord(entry.backup, backup)
      ) {
        throw new Error(`${key} recovery backup changed before revert`);
      }
      simulated.set(entry.targetPath, { ...backup, mode: entry.originalMode! });
    } else {
      simulated.set(entry.targetPath, undefined);
    }
    plans.push({ backup, entry, info, key, snapshot });
  }
  return { context, plans };
}

interface NativePreparedRevert {
  readonly operations: readonly FileReplacement[];
  readonly temporaryFiles: readonly StagedFile[];
}

async function prepareNativeRevert(batch: NativeRevertBatch): Promise<NativePreparedRevert> {
  if (batch.plans.length === 0) return { operations: [], temporaryFiles: [] };
  await ensureNativeStateDirectory();
  const entries: Record<string, NativeRecoveryEntry> = { ...batch.context.ledger.entries };
  const temporaryFiles: StagedFile[] = [];
  const configs: FileReplacement[] = [];
  const lastRestored = new Map<string, RecoveryFile | undefined>();
  const expected = new Map<string, RecoveryFile>();
  for (const plan of batch.plans) {
    const prior = expected.get(plan.entry.targetPath) ?? plan.snapshot.file;
    if (prior === undefined) throw new Error(`${plan.key} config disappeared before staging`);
    if (plan.entry.originalKind === "file") {
      // eslint-disable-next-line no-await-in-loop -- restore stages follow the authenticated LIFO chain.
      const stage = await stageFile(
        plan.entry.targetPath,
        plan.backup!.raw,
        plan.entry.originalMode!,
      );
      temporaryFiles.push(stage);
      configs.push(fileReplacement(stage, plan.entry.targetPath, prior, "config"));
      expected.set(plan.entry.targetPath, stage);
      lastRestored.set(plan.entry.targetPath, stage);
    } else {
      configs.push(fileRemoval(plan.entry.targetPath, prior, "config"));
      expected.delete(plan.entry.targetPath);
      lastRestored.set(plan.entry.targetPath, undefined);
    }
    delete entries[plan.key];
  }

  for (const [targetPath, restored] of lastRestored) {
    const predecessor = Object.entries(entries)
      .filter(([, entry]) => entry.targetPath === targetPath)
      .toSorted(([, left], [, right]) => right.sequence - left.sequence)[0];
    if (predecessor !== undefined) {
      if (restored === undefined) {
        throw new Error(`${predecessor[0]} recovery predecessor cannot expect a missing config`);
      }
      entries[predecessor[0]] = {
        ...predecessor[1],
        expectedConfig: nativeFileRecord(restored),
      };
    }
  }

  const backups = batch.plans.flatMap((plan) =>
    plan.backup === undefined ? [] : [fileRemoval(plan.entry.backupPath!, plan.backup, "backup")],
  );
  let state: FileReplacement;
  if (Object.keys(entries).length === 0) {
    if (batch.context.stateFile === undefined) {
      throw new Error("recovery entries exist without TypeScript recovery state");
    }
    state = fileRemoval(nativeStatePath(), batch.context.stateFile, "state");
  } else {
    const ledger: NativeLedger = { ...batch.context.ledger, entries };
    const stage = await stageFile(nativeStatePath(), serializeNativeLedger(ledger), 0o600);
    temporaryFiles.push(stage);
    state = fileReplacement(stage, nativeStatePath(), batch.context.stateFile, "state");
  }
  return { operations: [...configs, ...backups, state], temporaryFiles };
}

export async function revertNativeConfigs(
  allClis: readonly CliInfo[],
  selected: readonly CliInfo[],
  scope: SwapScope | undefined,
  options: { readonly dryRun: boolean; readonly hooks?: SwapTransactionHooks },
): Promise<readonly NativeRevertPlan[]> {
  const preliminary = await planNativeRevert(allClis, selected, scope);
  if (options.dryRun || preliminary.plans.length === 0) return preliminary.plans;
  return withSwapLock(async (lock) => {
    try {
      await options.hooks?.afterLockAcquired?.();
      const locked = await planNativeRevert(allClis, selected, scope);
      if (
        locked.plans.map((plan) => plan.key).join("\0") !==
        preliminary.plans.map((plan) => plan.key).join("\0")
      ) {
        throw new Error("revert plan changed before the shared lock was acquired");
      }
      const prepared = await prepareNativeRevert(locked);
      await options.hooks?.afterStaging?.();
      const stagedCheck = await planNativeRevert(allClis, selected, scope, lock.state);
      if (
        stagedCheck.plans.map((plan) => plan.key).join("\0") !==
        locked.plans.map((plan) => plan.key).join("\0")
      ) {
        throw new Error("revert plan changed during staging");
      }
      await applyNativeOperations(
        prepared.operations,
        prepared.temporaryFiles,
        options.hooks ?? {},
        lock,
      );
      return locked.plans;
    } catch (error) {
      await options.hooks?.afterFailureBeforeUnlock?.(error);
      throw error;
    }
  });
}

interface ClientPresence {
  readonly binary: boolean;
  readonly config: boolean;
  readonly piAdapter: boolean;
}

async function clientPresence(info: CliInfo): Promise<ClientPresence> {
  return {
    binary: Bun.which(info.binary) !== null,
    config: await exists(info.configPath),
    piAdapter:
      info.name !== "pi" ||
      (await stat(join(dirname(info.configPath), "npm", "node_modules", "pi-mcp-adapter")).then(
        (metadata) => metadata.isDirectory(),
        () => false,
      )),
  };
}

/** Whether both the CLI executable and its known configuration are present. */
export async function isInstalled(info: CliInfo): Promise<boolean> {
  const presence = await clientPresence(info);
  return presence.binary && presence.config;
}

/** Complete one MCP `initialize` round trip and reject unusable server specs. */
export async function preflight(spec: ServerSpec, timeoutMs = 60_000): Promise<string | undefined> {
  const frames =
    [
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "mcp_swap", version: "0" },
          protocolVersion: "2024-11-05",
        },
      }),
    ].join("\n") + "\n";
  let result: BoundedCommandResult;
  try {
    result = await runBoundedCommand([spec.command, ...spec.args], {
      acceptStdoutLine: (line) => {
        try {
          validateJsonPath(line, ["result"]);
          const message = JSON.parse(line) as Record<string, unknown>;
          const response = message.result;
          return (
            message.jsonrpc === "2.0" &&
            message.id === 1 &&
            typeof response === "object" &&
            response !== null &&
            !Array.isArray(response) &&
            typeof (response as Record<string, unknown>).protocolVersion === "string" &&
            ((response as Record<string, unknown>).protocolVersion as string).trim() !== ""
          );
        } catch {
          return false;
        }
      },
      env: { ...process.env, ...spec.env },
      maxOutputBytes: MAX_PREFLIGHT_OUTPUT_BYTES,
      stdin: frames,
      terminationGraceMilliseconds: 500,
      timeoutMilliseconds: timeoutMs,
    });
  } catch (error) {
    return `could not start ${spec.command}: ${(error as Error).message}`;
  }
  if (result.termination === "timed_out") return `initialize exceeded ${String(timeoutMs)}ms`;
  if (result.termination === "output_limit_exceeded") {
    return `initialize exceeded ${String(MAX_PREFLIGHT_OUTPUT_BYTES)} output bytes`;
  }
  if (result.termination === "accepted") return undefined;
  if (result.termination === "signaled") {
    return `server terminated by ${result.signalCode ?? "an unknown signal"}`;
  }
  const stderr = result.stderr.trim();
  return `no valid initialize reply${stderr === "" ? "" : `: ${stderr.split("\n")[0]!}`}`;
}

interface Options {
  readonly clients: readonly string[];
  readonly dryRun: boolean;
  readonly explicitToolsets: boolean;
  readonly repo: string;
  readonly provided: ReadonlySet<string>;
  readonly server: string;
  readonly skipPreflight: boolean;
  readonly scope: SwapScope | undefined;
  readonly source: SourceOptions;
}

function usage(): string {
  return [
    "Point selected installed agent CLIs at one build of this MCP server.",
    "",
    "  bun scripts/mcp_swap.ts detect",
    "  bun scripts/mcp_swap.ts status",
    "  bun scripts/mcp_swap.ts doctor",
    "  bun scripts/mcp_swap.ts use --source dev [--dry-run]",
    "  bun scripts/mcp_swap.ts use --source build",
    "  bun scripts/mcp_swap.ts use --source published --version 1.2.3",
    "  bun scripts/mcp_swap.ts revert",
    "",
    "  --cli NAME[,NAME...]  limit clients; repeat to select more",
    "  --client NAME  alias for --cli",
    "  client names: claude, codex, cursor, gemini, grok, agy (or antigravity), opencode, pi",
    "  --server NAME   registration slug (default: libtmux)",
    "  --repo PATH     checkout for dev and build (default: this one)",
    "  --scope SCOPE   Claude layer: project or user (use default: project)",
    "  --env KEY=VALUE environment overlay; repeat to set more",
    "  --no-preflight  register without starting the server first",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  const provided = new Set<string>();
  const clients: string[] = [];
  const environment: Record<string, string> = {};
  let dryRun = false;
  let skipPreflight = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    const assigned = equals === -1 ? undefined : token.slice(equals + 1);
    provided.add(flag);
    if (flag === "--dry-run" || flag === "--no-preflight") {
      if (assigned !== undefined) throw new Error(`${flag} takes no value`);
      if (flag === "--dry-run") dryRun = true;
      else skipPreflight = true;
      continue;
    }
    if (
      ![
        "--cli",
        "--client",
        "--env",
        "--repo",
        "--scope",
        "--server",
        "--source",
        "--version",
      ].includes(flag)
    ) {
      throw new Error(`unknown option ${flag}`);
    }
    const value = assigned ?? argv[++index];
    if (value === undefined || value === "" || (assigned === undefined && value.startsWith("--"))) {
      throw new Error(`${flag} wants a value`);
    }
    if (flag === "--cli" || flag === "--client") clients.push(value);
    else if (flag === "--env") {
      const separator = value.indexOf("=");
      const key = separator === -1 ? "" : value.slice(0, separator);
      const environmentValue = separator === -1 ? "" : value.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || environmentValue.includes("\0")) {
        throw new Error("--env expects KEY=VALUE with a valid environment name");
      }
      if (key === "LIBTMUX_SAFETY") {
        throw new Error("LIBTMUX_SAFETY is retired; use LIBTMUX_TOOLSETS");
      }
      environment[key] = environmentValue;
    } else values.set(flag, value);
  }

  const kind = (values.get("--source") ?? "dev") as SourceKind;
  if (!["build", "dev", "published"].includes(kind)) {
    throw new Error(`unknown source ${kind}; expected dev, build, or published`);
  }
  // The repository root, one directory above this repository-level script.
  const repo = resolve(values.get("--repo") ?? join(import.meta.dir, ".."));
  const version = values.get("--version");
  const rawScope = values.get("--scope");
  if (rawScope !== undefined && rawScope !== "project" && rawScope !== "user") {
    throw new Error("--scope expects project or user");
  }
  return {
    clients,
    dryRun,
    explicitToolsets: Object.hasOwn(environment, "LIBTMUX_TOOLSETS"),
    provided,
    repo,
    server: values.get("--server") ?? "libtmux",
    skipPreflight,
    scope: rawScope,
    source: { env: environment, kind, repo, ...(version === undefined ? {} : { version }) },
  };
}

function validateCommandOptions(command: string, options: Options): void {
  if (!["detect", "doctor", "revert", "status", "use"].includes(command)) {
    throw new Error(`unknown command ${command}`);
  }
  const only = (flags: readonly string[], commands: readonly string[]): void => {
    for (const flag of flags) {
      if (options.provided.has(flag) && !commands.includes(command)) {
        throw new Error(`${flag} does not apply to ${command}`);
      }
    }
  };
  only(["--dry-run"], ["revert", "use"]);
  only(["--env", "--no-preflight", "--source", "--version"], ["use"]);
  only(["--repo", "--server"], ["doctor", "status", "use"]);
  only(["--scope"], ["revert", "status", "use"]);
  if (options.provided.has("--version") && options.source.kind !== "published") {
    throw new Error("--version only applies to --source published");
  }
  requireSafeComponent(options.server, "--server");
  if (options.source.version !== undefined)
    requireSafeComponent(options.source.version, "--version");
}

async function canonicalRepository(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new Error(`repository does not exist: ${path}`, { cause: error });
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new TypeError(`repository is not a directory: ${path}`);
  }
  return canonical;
}

export function selectClis(clis: readonly CliInfo[], names: readonly string[]): readonly CliInfo[] {
  if (names.length === 0) return clis;
  const known = new Set(clis.map((info) => info.name));
  const wanted = new Set<string>();
  for (const selection of names) {
    for (const rawName of selection.split(",")) {
      const name = rawName.trim() === "antigravity" ? "agy" : rawName.trim();
      if (name === "") throw new Error("client name was empty");
      if (!known.has(name)) throw new Error(`unknown client ${name}`);
      wanted.add(name);
    }
  }
  return clis.filter((info) => wanted.has(info.name));
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "status";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let options: Options;
  let clis: readonly CliInfo[];
  let allClis: readonly CliInfo[];
  try {
    options = parseOptions(argv.slice(1));
    validateCommandOptions(command, options);
    allClis = knownClis();
    clis = selectClis(allClis, options.clients);
  } catch (error) {
    process.stderr.write(`mcp_swap: ${(error as Error).message}\n${usage()}\n`);
    return 2;
  }

  if (command === "detect") {
    for (const info of clis) {
      // eslint-disable-next-line no-await-in-loop -- each CLI is reported in order, and one failing must not race the next.
      const presence = await clientPresence(info);
      const installed = presence.binary && presence.config;
      const caveat =
        info.name === "pi" && !presence.piAdapter
          ? " (needs pi-mcp-adapter; pi has no built-in MCP client)"
          : "";
      process.stdout.write(
        `[${installed ? "yes" : "no"}] ${info.name.padEnd(9)} binary=${presence.binary ? "present" : "missing"} config=${presence.config ? "present" : "missing"}${caveat}\n`,
      );
    }
    return 0;
  }

  if (command === "status") {
    let failed = false;
    let repository: string;
    try {
      repository = await canonicalRepository(options.repo);
    } catch (error) {
      process.stderr.write(`mcp_swap: ${(error as Error).message}\n`);
      return 1;
    }
    for (const info of clis) {
      // eslint-disable-next-line no-await-in-loop -- status is deliberately deterministic.
      const presence = await clientPresence(info);
      if (!presence.config) {
        if (options.clients.length > 0)
          process.stdout.write(`${info.name.padEnd(15)} (no config)\n`);
        continue;
      }
      const scopes: readonly SwapScope[] =
        info.name === "claude"
          ? options.scope === undefined
            ? ["user", "project"]
            : [options.scope]
          : ["user"];
      for (const scope of scopes) {
        const label = info.name === "claude" ? `claude:${scope}` : info.name;
        try {
          const target = scopedCli(info, repository, scope);
          // eslint-disable-next-line no-await-in-loop -- scope precedence is reported in order.
          const spec = await readServer(target, options.server);
          const shown =
            spec === undefined
              ? "(not registered)"
              : `${classifySpec(spec)}: ${describeSpec(spec)} env=${JSON.stringify(Object.keys(spec.env).toSorted())}`;
          process.stdout.write(`${label.padEnd(15)} ${shown}\n`);
        } catch (error) {
          failed = true;
          process.stderr.write(`${label}: ${(error as Error).message}\n`);
        }
      }
    }
    return failed ? 1 : 0;
  }

  if (command === "doctor") {
    let failed = false;
    let repository: string;
    try {
      repository = await canonicalRepository(options.repo);
    } catch (error) {
      process.stderr.write(`mcp_swap: ${(error as Error).message}\n`);
      return 1;
    }
    process.stdout.write(`mcp-swap doctor\n  repo: ${repository}\n  server: ${options.server}\n`);
    process.stdout.write("  configurations:\n");
    for (const info of clis) {
      try {
        // eslint-disable-next-line no-await-in-loop -- diagnostics retain catalog order.
        const snapshot = await nativeConfigSnapshot(info);
        if (snapshot.file === undefined) {
          process.stdout.write(`    ${info.name}: missing\n`);
          continue;
        }
        // Parse every scope that this client can own, not just its bytes.
        const scopes: readonly SwapScope[] =
          info.name === "claude" ? ["user", "project"] : ["user"];
        for (const scope of scopes) {
          const target = scopedCli(info, repository, scope);
          serverFromRaw(target, snapshot.file.raw, options.server);
        }
        process.stdout.write(
          `    ${info.name}: ${String(Buffer.byteLength(snapshot.file.raw))} bytes mode=${snapshot.file.mode.toString(8).padStart(4, "0")}\n`,
        );
      } catch (error) {
        failed = true;
        process.stdout.write(`    ${info.name}: unreadable: ${(error as Error).message}\n`);
      }
    }
    let doctorLedger = emptyNativeLedger();
    try {
      const context = await readNativeContext();
      doctorLedger = context.ledger;
      if (context.stateFile === undefined) {
        process.stdout.write("  outstanding swaps: none\n");
      } else {
        await verifyNativeContext(context, allClis);
        process.stdout.write("  outstanding swaps:\n");
        for (const [key, entry] of Object.entries(context.ledger.entries).toSorted(
          ([, left], [, right]) => left.sequence - right.sequence,
        )) {
          process.stdout.write(`    ${key} sequence=${String(entry.sequence)}\n`);
        }
      }
    } catch (error) {
      failed = true;
      process.stdout.write(`  recovery: invalid: ${(error as Error).message}\n`);
    }
    try {
      const orphans = await nativeOrphanBackups(allClis, doctorLedger);
      for (const orphan of orphans) {
        failed = true;
        process.stdout.write(`  recovery: unowned TypeScript backup: ${orphan}\n`);
      }
    } catch (error) {
      failed = true;
      process.stdout.write(`  recovery scan: ${(error as Error).message}\n`);
    }
    for (const [name, client] of [
      ["ANTHROPIC_API_KEY", "claude"],
      ["OPENAI_API_KEY", "codex"],
      ["GEMINI_API_KEY", "gemini"],
      ["GOOGLE_API_KEY", "gemini"],
      ["XAI_API_KEY", "grok"],
      ["GROK_API_KEY", "grok"],
    ] as const) {
      if (process.env[name] !== undefined) {
        process.stdout.write(`  ! ${name} overrides ${client}'s stored login\n`);
      }
    }
    return failed ? 1 : 0;
  }

  if (command === "use") {
    try {
      const repository = await canonicalRepository(options.repo);
      const source = { ...options.source, repo: repository };
      const spec = buildSpec(source);
      const selected: CliInfo[] = [];
      for (const info of clis) {
        if (options.clients.length > 0) selected.push(info);
        // eslint-disable-next-line no-await-in-loop -- default detection preserves catalog order.
        else if (await isInstalled(info)) selected.push(info);
      }
      if (selected.length === 0) {
        throw new Error("no installed client with a configuration was detected");
      }
      const plans = await useNativeConfigs(
        allClis,
        selected,
        options.server,
        repository,
        options.scope ?? "project",
        spec,
        options.explicitToolsets,
        {
          dryRun: options.dryRun,
          prepare: () => prepareSource(source),
          skipPreflight: options.skipPreflight,
        },
      );
      process.stdout.write(`${options.source.kind}: ${describeSpec(spec)}\n`);
      for (const plan of plans) {
        const verb = options.dryRun ? "would update" : plan.outcome;
        const label =
          plan.scopedInfo.name === "claude" ? `claude:${plan.scope}` : plan.scopedInfo.name;
        process.stdout.write(
          `${verb} ${label} (${plan.scopedInfo.configPath}): ${options.server}\n`,
        );
      }
      return 0;
    } catch (error) {
      process.stderr.write(`refusing partial client update: ${(error as Error).message}\n`);
      return 1;
    }
  }

  if (command === "revert") {
    try {
      const plans = await revertNativeConfigs(allClis, clis, options.scope, {
        dryRun: options.dryRun,
      });
      for (const plan of plans) {
        const label = plan.info.name === "claude" ? `claude:${plan.entry.scope}` : plan.info.name;
        process.stdout.write(
          `${options.dryRun ? "would restore" : "restored"} ${label} (${plan.info.configPath})\n`,
        );
      }
      return 0;
    } catch (error) {
      process.stderr.write(`refusing partial client revert: ${(error as Error).message}\n`);
      return 1;
    }
  }

  process.stderr.write(`${usage()}\n`);
  return 2;
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.path === invokedAs) {
  process.exitCode =
    process.argv[2] === LOCK_WORKER_COMMAND
      ? await runLockWorker(process.argv[3]!, process.argv[4]!)
      : await main(process.argv.slice(2));
}
