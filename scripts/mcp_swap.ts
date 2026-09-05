import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { runBoundedCommand, type BoundedCommandResult } from "./bounded_process.js";

/**
 * Point every installed agent CLI at one build of this MCP server.
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
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  if (dialect === "opencode") {
    const line = record.command;
    if (!Array.isArray(line) || line.length === 0) return undefined;
    const [command, ...args] = line as string[];
    if (command === undefined) return undefined;
    return { args, command, env: (record.environment as Record<string, string>) ?? {} };
  }
  const command = record.command;
  if (typeof command !== "string") return undefined;
  return {
    args: (record.args as string[] | undefined) ?? [],
    command,
    env: (record.env as Record<string, string>) ?? {},
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

export function buildSpec(options: SourceOptions): ServerSpec {
  const env = { ...options.env };
  if (options.kind === "published") {
    const version = options.version ?? "latest";
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
  for (let index = 0; index < blanked.length; index += 1) {
    if (blanked[index] !== ",") continue;
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
  return typeof servers === "object" && servers !== null
    ? { ...(servers as Record<string, unknown>) }
    : {};
}

/** Render one server as a TOML table, replacing any table of the same name. */
export function renderServerTable(
  text: string,
  container: string,
  name: string,
  entry: Record<string, unknown>,
): string {
  const header = `[${container}.${name}]`;
  const body = Object.entries(entry)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");
  const block = `${header}\n${body}\n`;
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const separator = text.trim() === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${block}`;
  }
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trim().startsWith("[")) end += 1;
  return [...lines.slice(0, start), block.trimEnd(), ...lines.slice(end)].join("\n");
}

/** Remove a server's TOML table, leaving the rest of the file alone. */
export function removeServerTable(text: string, container: string, name: string): string {
  const header = `[${container}.${name}]`;
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trim().startsWith("[")) end += 1;
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
    const key = text.slice(keyStart + 1, keyEnd - 1);
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

interface RecoveryRouteRecord {
  readonly kind: Exclude<ConfigPathKind, "missing">;
  readonly logicalIdentity: string | null;
  readonly targetPath: string;
  readonly version: 1;
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

function recoveryRouteRecord(route: ConfigRoute): RecoveryRouteRecord {
  return {
    kind: route.kind === "symlink" ? "symlink" : "regular",
    logicalIdentity: route.kind === "symlink" ? (route.logicalIdentity ?? null) : null,
    targetPath: route.targetPath,
    version: 1,
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
  const route = await inspectConfigRoute(path);
  const temporary = await stageFile(
    route.targetPath,
    data,
    mode ?? (await fileMode(route.targetPath)),
  );
  try {
    await assertConfigRoute(route);
    await rename(temporary.path, route.targetPath);
  } catch (error) {
    await rm(temporary.path, { force: true });
    throw error;
  }
}

/**
 * Take a backup, unless one is already there.
 *
 * Swapping something already swapped keeps the first backup, so `revert` lands
 * on what was there before any of this ran rather than on the previous swap.
 */
export async function backupOnce(path: string): Promise<string | undefined> {
  const backup = `${path}${BACKUP_SUFFIX}`;
  const route = await inspectConfigRoute(path);
  const recovery = await readRecoveryState(path, route);
  if (recovery.backup !== undefined) return backup;
  if (route.kind === "missing") return undefined;
  const mode = await fileMode(route.targetPath);
  if (mode === undefined) return undefined;
  const backupTemporary = await stageFile(backup, await readFile(route.targetPath, "utf8"), mode);
  const routePath = recoveryRoutePath(path);
  let routeTemporary: StagedFile | undefined;
  let publishedBackup = false;
  try {
    routeTemporary = await stageFile(
      routePath,
      serializeRecoveryRoute(recoveryRouteRecord(route)),
      0o600,
    );
    await assertConfigRoute(route);
    await assertPathMissing(backup, "recovery backup");
    await assertPathMissing(routePath, "recovery route sidecar");
    await rename(backupTemporary.path, backup);
    publishedBackup = true;
    await rename(routeTemporary.path, routePath);
    return backup;
  } catch (error) {
    await rm(backupTemporary.path, { force: true });
    if (routeTemporary !== undefined) await rm(routeTemporary.path, { force: true });
    if (publishedBackup) await rm(backup, { force: true });
    throw error;
  }
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

async function readRecoveryFile(
  path: string,
  label: string,
  maximumBytes?: number,
): Promise<RecoveryFile | undefined> {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError(`${label} is not a regular file: ${path}`);
  }
  if (maximumBytes !== undefined && metadata.size > BigInt(maximumBytes)) {
    throw new TypeError(`${label} exceeds ${String(maximumBytes)} bytes: ${path}`);
  }
  return {
    identity: fileIdentity(metadata),
    mode: Number(metadata.mode & 0o7777n),
    raw: await readFile(path, "utf8"),
  };
}

function parseRecoveryRoute(raw: string): RecoveryRouteRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new TypeError("recovery route metadata is malformed", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("recovery route metadata is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (keys.join(",") !== "kind,logicalIdentity,targetPath,version") {
    throw new TypeError("recovery route metadata has unknown or missing fields");
  }
  if (record.version !== 1 || (record.kind !== "regular" && record.kind !== "symlink")) {
    throw new TypeError("recovery route metadata has an unsupported version or kind");
  }
  if (typeof record.targetPath !== "string" || !isAbsolute(record.targetPath)) {
    throw new TypeError("recovery route metadata has an invalid target path");
  }
  if (
    (record.kind === "regular" && record.logicalIdentity !== null) ||
    (record.kind === "symlink" &&
      (typeof record.logicalIdentity !== "string" ||
        !/^\d+:\d+:-?\d+:-?\d+$/u.test(record.logicalIdentity)))
  ) {
    throw new TypeError("recovery route metadata has an invalid logical identity");
  }
  return {
    kind: record.kind,
    logicalIdentity: record.logicalIdentity as string | null,
    targetPath: record.targetPath,
    version: 1,
  };
}

function serializeRecoveryRoute(record: RecoveryRouteRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function persistentRouteMatches(route: ConfigRoute, record: RecoveryRouteRecord): boolean {
  return (
    route.kind === record.kind &&
    route.targetPath === record.targetPath &&
    (record.kind === "regular" || route.logicalIdentity === record.logicalIdentity)
  );
}

async function readRecoveryState(configPath: string, route: ConfigRoute): Promise<RecoveryState> {
  const backup = await readRecoveryFile(backupPath(configPath), "recovery backup");
  const routeFile = await readRecoveryFile(
    recoveryRoutePath(configPath),
    "recovery route sidecar",
    RECOVERY_ROUTE_MAX_BYTES,
  );
  if (routeFile !== undefined && routeFile.mode !== 0o600) {
    throw new TypeError("recovery route sidecar mode must be 0600");
  }
  if (backup === undefined) {
    if (routeFile !== undefined) throw new TypeError("recovery route sidecar has no backup");
    return { backup: undefined, route: undefined };
  }
  if (routeFile === undefined) {
    if (route.kind !== "regular") {
      throw new TypeError("legacy symlink backup has no authenticated recovery route");
    }
    return { backup, route: undefined };
  }
  const routeRecord = parseRecoveryRoute(routeFile.raw);
  if (!persistentRouteMatches(route, routeRecord)) {
    throw new Error(`config path changed since backup: ${configPath}`);
  }
  return { backup, route: routeFile };
}

/** Read a config, answering an empty document when the file is not there yet. */
export async function readConfig(info: CliInfo): Promise<{ raw: string; value: unknown }> {
  let raw: string;
  try {
    raw = await readFile(info.configPath, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    raw = "";
  }
  if (info.format === "toml") return { raw, value: parseServerTables(raw, info.container[0]!) };
  if (raw.trim() === "") return { raw, value: {} };
  // Read every JSON config the lenient way. JSONC is a superset, so a strict
  // file parses identically, and a stray comment in one that is meant to be
  // strict is the user's business rather than a reason to refuse the file.
  return { raw, value: parseJsonc(raw) };
}

function containerOf(value: unknown, path: readonly string[]): Record<string, unknown> {
  let node = value as Record<string, unknown>;
  for (const key of path) {
    const next = node[key];
    if (typeof next !== "object" || next === null) return {};
    node = next as Record<string, unknown>;
  }
  return node;
}

/** The spec a CLI currently has registered under `name`, if any. */
export async function readServer(info: CliInfo, name: string): Promise<ServerSpec | undefined> {
  const { value } = await readConfig(info);
  const servers =
    info.format === "toml"
      ? (value as Record<string, unknown>)
      : containerOf(value, info.container);
  return fromEntry(servers[name], info.dialect);
}

export type WriteServerOutcome = "added" | "replaced";

interface ServerWritePlan {
  readonly data: string;
  readonly info: CliInfo;
  readonly mode: number | undefined;
  readonly outcome: WriteServerOutcome;
  readonly raw: string;
  readonly recovery: RecoveryState;
  readonly route: ConfigRoute;
}

/** Parse and render one update without changing its config or backup. */
async function planServerWrite(
  info: CliInfo,
  name: string,
  spec: ServerSpec,
): Promise<ServerWritePlan> {
  const route = await inspectConfigRoute(info.configPath);
  const { raw, value } = await readConfig(info);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("config root must be an object");
  }
  const servers =
    info.format === "toml"
      ? (value as Record<string, unknown>)
      : containerOf(value, info.container);
  const had = fromEntry(servers[name], info.dialect) !== undefined;
  const entry = toEntry(spec, info.dialect);
  let data: string;
  if (info.format === "toml") {
    data = renderServerTable(raw, info.container[0]!, name, entry);
    Bun.TOML.parse(data);
  } else {
    // Splice into the bytes the user has, so comments and spacing survive. Only
    // when there is no container to splice into — an empty or absent file — is
    // the document rebuilt, where there is nothing to preserve anyway.
    const spliced = raw.trim() === "" ? undefined : spliceEntry(raw, info.container, name, entry);
    if (spliced !== undefined) {
      data = spliced;
    } else {
      const document = value as Record<string, unknown>;
      let node = document;
      for (const key of info.container) {
        const next = node[key];
        node[key] = typeof next === "object" && next !== null ? next : {};
        node = node[key] as Record<string, unknown>;
      }
      node[name] = entry;
      data = `${JSON.stringify(document, undefined, 2)}\n`;
    }
    parseJsonc(data);
  }

  const mode = await fileMode(route.targetPath);
  const recovery = await readRecoveryState(info.configPath, route);
  await assertConfigRoute(route);
  return {
    data,
    info,
    mode,
    outcome: had ? "replaced" : "added",
    raw,
    recovery,
    route,
  };
}

interface StagedFile {
  readonly identity: string;
  readonly path: string;
}

interface StagedServerWrite {
  readonly backupTemporary: StagedFile | undefined;
  readonly committedRoute: ConfigRoute;
  readonly plan: ServerWritePlan;
  readonly routeTemporary: StagedFile | undefined;
  readonly temporary: StagedFile;
}

async function stageFile(
  path: string,
  data: string,
  mode: number | undefined,
): Promise<StagedFile> {
  const temporary = `${path}.mcp-swap-${String(process.pid)}-${randomUUID()}`;
  try {
    await writeFile(temporary, data, mode === undefined ? { flag: "wx" } : { flag: "wx", mode });
    if (mode !== undefined) await chmod(temporary, mode);
    return { identity: fileIdentity(await lstat(temporary, { bigint: true })), path: temporary };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function cleanupTemporaries(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

function assertDistinctConfigTargets(plans: readonly ServerWritePlan[]): void {
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const plan of plans) {
    const { targetIdentity, targetPath } = plan.route;
    if (paths.has(targetPath) || (targetIdentity !== undefined && identities.has(targetIdentity))) {
      throw new Error(`${plan.info.name} resolves to the same resolved target: ${targetPath}`);
    }
    paths.add(targetPath);
    if (targetIdentity !== undefined) identities.add(targetIdentity);
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

async function assertPlanFeasible(plan: ServerWritePlan): Promise<void> {
  const destinations = [plan.route.targetPath];
  if (plan.mode !== undefined && plan.recovery.backup === undefined) {
    destinations.push(backupPath(plan.info.configPath));
  }
  const needsRoute = plan.mode !== undefined || plan.recovery.backup !== undefined;
  if (needsRoute && plan.recovery.route === undefined) {
    destinations.push(recoveryRoutePath(plan.info.configPath));
  }
  await Promise.all([...new Set(destinations)].map(assertDestinationFeasible));
}

function planError(info: CliInfo, error: unknown): Error {
  return new Error(`${info.name} (${info.configPath}): ${(error as Error).message}`, {
    cause: error,
  });
}

async function planServerWrites(
  infos: readonly CliInfo[],
  name: string,
  spec: ServerSpec,
): Promise<readonly ServerWritePlan[]> {
  const plans: ServerWritePlan[] = [];
  for (const info of infos) {
    try {
      // eslint-disable-next-line no-await-in-loop -- every config parses before feasibility checks.
      plans.push(await planServerWrite(info, name, spec));
    } catch (error) {
      throw planError(info, error);
    }
  }
  assertDistinctConfigTargets(plans);
  for (const plan of plans) {
    try {
      // eslint-disable-next-line no-await-in-loop -- stable client ownership keeps failures actionable.
      await assertPlanFeasible(plan);
    } catch (error) {
      throw planError(plan.info, error);
    }
  }
  return plans;
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

async function assertRecoveryUnit(entry: StagedServerWrite): Promise<void> {
  const { plan } = entry;
  const backup = entry.backupTemporary ?? plan.recovery.backup;
  if (backup !== undefined) {
    await assertRecoveryFile(
      backupPath(plan.info.configPath),
      backup,
      entry.backupTemporary === undefined ? plan.recovery.backup!.raw : plan.raw,
      "recovery backup",
    );
  }
  const route = entry.routeTemporary ?? plan.recovery.route;
  if (route !== undefined) {
    await assertRecoveryFile(
      recoveryRoutePath(plan.info.configPath),
      route,
      entry.routeTemporary === undefined
        ? plan.recovery.route!.raw
        : serializeRecoveryRoute(recoveryRouteRecord(plan.route)),
      "recovery route sidecar",
      0o600,
    );
  }
}

async function replaceExpectedRoute(
  expected: ConfigRoute,
  data: string,
  mode: number,
): Promise<void> {
  const temporary = await stageFile(expected.targetPath, data, mode);
  try {
    await assertConfigRoute(expected);
    await rename(temporary.path, expected.targetPath);
  } catch (error) {
    await rm(temporary.path, { force: true });
    throw error;
  }
}

async function assertRestoredPlan(plan: ServerWritePlan): Promise<void> {
  const actual = await inspectConfigRoute(plan.info.configPath);
  const topologyMatches =
    actual.kind === plan.route.kind &&
    actual.targetPath === plan.route.targetPath &&
    (actual.kind !== "symlink" || actual.logicalIdentity === plan.route.logicalIdentity);
  if (
    !topologyMatches ||
    (await readFile(actual.targetPath, "utf8")) !== plan.raw ||
    (await fileMode(actual.targetPath)) !== plan.mode
  ) {
    throw new Error(`config rollback could not be verified: ${plan.info.configPath}`);
  }
}

/** Update a selected client set as one rollback-capable transaction. */
export async function writeServers(
  infos: readonly CliInfo[],
  name: string,
  spec: ServerSpec,
): Promise<readonly WriteServerOutcome[]> {
  const plans = await planServerWrites(infos, name, spec);

  const staged: StagedServerWrite[] = [];
  const temporaryPaths: string[] = [];
  try {
    for (const plan of plans) {
      // eslint-disable-next-line no-await-in-loop -- staging preserves deterministic failure ownership.
      await mkdir(dirname(plan.route.targetPath), { recursive: true });
      const backupTemporary =
        plan.mode === undefined || plan.recovery.backup !== undefined
          ? undefined
          : // eslint-disable-next-line no-await-in-loop -- all backups stage before target changes.
            await stageFile(backupPath(plan.info.configPath), plan.raw, plan.mode);
      if (backupTemporary !== undefined) temporaryPaths.push(backupTemporary.path);
      const needsRoute = plan.mode !== undefined || plan.recovery.backup !== undefined;
      const routeTemporary =
        !needsRoute || plan.recovery.route !== undefined
          ? undefined
          : // eslint-disable-next-line no-await-in-loop -- recovery metadata stages with its backup.
            await stageFile(
              recoveryRoutePath(plan.info.configPath),
              serializeRecoveryRoute(recoveryRouteRecord(plan.route)),
              0o600,
            );
      if (routeTemporary !== undefined) temporaryPaths.push(routeTemporary.path);
      // eslint-disable-next-line no-await-in-loop -- all configs stage before target changes.
      const temporary = await stageFile(plan.route.targetPath, plan.data, plan.mode);
      temporaryPaths.push(temporary.path);
      staged.push({
        backupTemporary,
        committedRoute: committedRoute(plan.route, temporary.identity),
        plan,
        routeTemporary,
        temporary,
      });
    }
  } catch (error) {
    await cleanupTemporaries(temporaryPaths);
    throw error;
  }

  const createdRecovery = new Map<ServerWritePlan, string[]>();
  const committed: StagedServerWrite[] = [];
  const recordRecovery = (plan: ServerWritePlan, path: string): void => {
    const paths = createdRecovery.get(plan) ?? [];
    paths.push(path);
    createdRecovery.set(plan, paths);
  };
  try {
    for (const entry of staged) {
      if (entry.backupTemporary !== undefined) {
        const destination = backupPath(entry.plan.info.configPath);
        // eslint-disable-next-line no-await-in-loop -- backup bytes must still name this config.
        await assertConfigRoute(entry.plan.route);
        // eslint-disable-next-line no-await-in-loop -- publication must not replace a new artifact.
        await assertPathMissing(destination, "recovery backup");
        // eslint-disable-next-line no-await-in-loop -- commit order is deterministic for rollback.
        await rename(entry.backupTemporary.path, destination);
        recordRecovery(entry.plan, destination);
      }
      if (entry.routeTemporary !== undefined) {
        const destination = recoveryRoutePath(entry.plan.info.configPath);
        // eslint-disable-next-line no-await-in-loop -- route metadata must still name this config.
        await assertConfigRoute(entry.plan.route);
        // eslint-disable-next-line no-await-in-loop -- publication must not replace a new artifact.
        await assertPathMissing(destination, "recovery route sidecar");
        // eslint-disable-next-line no-await-in-loop -- commit order is deterministic for rollback.
        await rename(entry.routeTemporary.path, destination);
        recordRecovery(entry.plan, destination);
      }
    }
    for (const entry of staged) {
      // eslint-disable-next-line no-await-in-loop -- every write reauthenticates its logical route.
      await assertConfigRoute(entry.plan.route);
      // eslint-disable-next-line no-await-in-loop -- recovery must remain usable before target change.
      await assertRecoveryUnit(entry);
      // eslint-disable-next-line no-await-in-loop -- commit order is deterministic for rollback.
      await rename(entry.temporary.path, entry.plan.route.targetPath);
      committed.push(entry);
    }
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const entry of committed.toReversed()) {
      const { plan } = entry;
      try {
        if (plan.mode === undefined) {
          // eslint-disable-next-line no-await-in-loop -- never remove a replacement target.
          await assertConfigRoute(entry.committedRoute);
          // eslint-disable-next-line no-await-in-loop -- rollback must finish before reporting failure.
          await rm(plan.route.targetPath, { force: true });
          // eslint-disable-next-line no-await-in-loop -- removal is complete only after verification.
          await assertConfigRoute(plan.route);
        } else {
          // eslint-disable-next-line no-await-in-loop -- rollback must finish before reporting failure.
          await replaceExpectedRoute(entry.committedRoute, plan.raw, plan.mode);
          // eslint-disable-next-line no-await-in-loop -- restored bytes, mode, and topology must agree.
          await assertRestoredPlan(plan);
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    for (const paths of createdRecovery.values()) {
      for (const path of paths) {
        try {
          // eslint-disable-next-line no-await-in-loop -- recovery is discarded only after restore.
          await rm(path, { force: true });
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
          break;
        }
      }
    }
    await cleanupTemporaries(temporaryPaths);
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `swap failed and ${String(rollbackFailures.length)} rollback operation(s) also failed`,
      );
    }
    throw error;
  }
  await cleanupTemporaries(temporaryPaths);
  return plans.map(({ outcome }) => outcome);
}

/** Point one CLI at `spec`, backing the file up first. */
export async function writeServer(
  info: CliInfo,
  name: string,
  spec: ServerSpec,
): Promise<WriteServerOutcome> {
  return (await writeServers([info], name, spec))[0]!;
}

/** Restore a config from the backup a swap wrote, and drop the backup. */
export async function revertConfig(info: CliInfo): Promise<boolean> {
  const route = await inspectConfigRoute(info.configPath);
  const recovery = await readRecoveryState(info.configPath, route);
  if (recovery.backup === undefined) return false;
  await replaceExpectedRoute(route, recovery.backup.raw, recovery.backup.mode);
  const restored = await inspectConfigRoute(info.configPath);
  if (
    restored.kind !== route.kind ||
    restored.targetPath !== route.targetPath ||
    (restored.kind === "symlink" && restored.logicalIdentity !== route.logicalIdentity) ||
    (await readFile(restored.targetPath, "utf8")) !== recovery.backup.raw ||
    (await fileMode(restored.targetPath)) !== recovery.backup.mode
  ) {
    throw new Error(`config restore could not be verified: ${info.configPath}`);
  }
  await rm(backupPath(info.configPath), { force: true });
  if (recovery.route !== undefined) {
    await rm(recoveryRoutePath(info.configPath), { force: true });
  }
  return true;
}

/** Whether a CLI is installed, judged by its executable being on PATH. */
export async function isInstalled(info: CliInfo): Promise<boolean> {
  return Bun.which(info.binary) !== null || exists(info.configPath);
}

/**
 * Launch a spec and complete one MCP `initialize` round trip.
 *
 * A spec that cannot start is worth catching here rather than in every config
 * that received it, where it surfaces as an agent that quietly has no tools.
 * Closing stdin lets a well-behaved stdio server exit on its own.
 */
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
      env: { ...process.env, ...spec.env },
      maxOutputBytes: MAX_PREFLIGHT_OUTPUT_BYTES,
      stdin: frames,
      timeoutMilliseconds: timeoutMs,
    });
  } catch (error) {
    return `could not start ${spec.command}: ${(error as Error).message}`;
  }
  if (result.termination === "timed_out") return `initialize exceeded ${String(timeoutMs)}ms`;
  if (result.termination === "output_limit_exceeded") {
    return `initialize exceeded ${String(MAX_PREFLIGHT_OUTPUT_BYTES)} output bytes`;
  }
  if (result.termination === "signaled") {
    return `server terminated by ${result.signalCode ?? "an unknown signal"}`;
  }
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const message = JSON.parse(line) as { id?: number; result?: { serverInfo?: unknown } };
      if (message.id === 1 && message.result !== undefined) return undefined;
    } catch {
      continue;
    }
  }
  const stderr = result.stderr.trim();
  return `no initialize reply${stderr === "" ? "" : `: ${stderr.split("\n")[0]!}`}`;
}

interface Options {
  readonly dryRun: boolean;
  readonly repo: string;
  readonly server: string;
  readonly skipPreflight: boolean;
  readonly source: SourceOptions;
}

function usage(): string {
  return [
    "Point every installed agent CLI at one build of this MCP server.",
    "",
    "  bun scripts/mcp_swap.ts detect",
    "  bun scripts/mcp_swap.ts status",
    "  bun scripts/mcp_swap.ts use --source dev [--dry-run]",
    "  bun scripts/mcp_swap.ts use --source build",
    "  bun scripts/mcp_swap.ts use --source published --version 1.2.3",
    "  bun scripts/mcp_swap.ts revert",
    "",
    "  --server NAME   registration slug (default: libtmux)",
    "  --repo PATH     checkout for dev and build (default: this one)",
    "  --no-preflight  register without starting the server first",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const kind = (value("--source") ?? "dev") as SourceKind;
  if (!["build", "dev", "published"].includes(kind)) {
    throw new Error(`unknown source ${kind}; expected dev, build, or published`);
  }
  // The workspace root, not this package: the entries below are workspace
  // paths because the server is a sibling package, and this script only lives
  // here because it is where the repository keeps its tooling.
  const repo = value("--repo") ?? join(import.meta.dir, "..", "..", "..");
  const version = value("--version");
  return {
    dryRun: argv.includes("--dry-run"),
    repo,
    server: value("--server") ?? "libtmux",
    skipPreflight: argv.includes("--no-preflight"),
    source: { kind, repo, ...(version === undefined ? {} : { version }) },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "status";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const options = parseOptions(argv.slice(1));
  const clis = knownClis();

  if (command === "detect") {
    for (const info of clis) {
      // eslint-disable-next-line no-await-in-loop -- each CLI is reported in order, and one failing must not race the next.
      const installed = await isInstalled(info);
      process.stdout.write(
        `${installed ? "present" : "absent "}  ${info.name.padEnd(9)}${info.configPath}\n`,
      );
    }
    return 0;
  }

  if (command === "status") {
    for (const info of clis) {
      // eslint-disable-next-line no-await-in-loop -- each CLI is reported in order, and one failing must not race the next.
      if (!(await isInstalled(info))) continue;
      // eslint-disable-next-line no-await-in-loop -- each CLI is reported in order, and one failing must not race the next.
      const spec = await readServer(info, options.server);
      const shown =
        spec === undefined ? "(not registered)" : `${classifySpec(spec)}: ${describeSpec(spec)}`;
      process.stdout.write(`${info.name.padEnd(9)} ${shown}\n`);
    }
    return 0;
  }

  if (command === "use") {
    const spec = buildSpec(options.source);
    process.stdout.write(`${options.source.kind}: ${describeSpec(spec)}\n`);
    if (!options.skipPreflight && !options.dryRun) {
      const reason = await preflight(spec);
      if (reason !== undefined) {
        process.stderr.write(`refusing to register a server that did not answer — ${reason}\n`);
        return 1;
      }
    }
    const selected: CliInfo[] = [];
    for (const info of clis) {
      // eslint-disable-next-line no-await-in-loop -- each CLI is reported in order, and one failing must not race the next.
      if (!(await isInstalled(info))) continue;
      selected.push(info);
    }
    try {
      if (options.dryRun) {
        await planServerWrites(selected, options.server, spec);
        for (const info of selected) {
          process.stdout.write(`would update ${info.name} (${info.configPath})\n`);
        }
        return 0;
      }
      const outcomes = await writeServers(selected, options.server, spec);
      for (const [index, info] of selected.entries()) {
        process.stdout.write(
          `${outcomes[index]!} ${options.server} in ${info.name} (${info.configPath})\n`,
        );
      }
      return 0;
    } catch (error) {
      process.stderr.write(`refusing partial client update: ${(error as Error).message}\n`);
      return 1;
    }
  }

  if (command === "revert") {
    for (const info of clis) {
      if (options.dryRun) {
        // eslint-disable-next-line no-await-in-loop -- each CLI is reported in order, and one failing must not race the next.
        if (await exists(backupPath(info.configPath))) {
          process.stdout.write(`would restore ${info.name} (${info.configPath})\n`);
        }
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- each CLI is reported in order, and one failing must not race the next.
      if (await revertConfig(info)) {
        process.stdout.write(`restored ${info.name} (${info.configPath})\n`);
      }
    }
    return 0;
  }

  process.stderr.write(`${usage()}\n`);
  return 2;
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.path === invokedAs) {
  process.exitCode = await main(process.argv.slice(2));
}
