import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * Replace a file's contents without leaving a truncated one behind.
 *
 * A config half-written because the disk filled or the process died is a CLI
 * that no longer starts, so the new bytes land under a temporary name and the
 * rename swaps them in whole.
 */
export async function writeAtomic(path: string, data: string, mode?: number): Promise<void> {
  const temporary = `${path}.mcp-swap-${String(process.pid)}`;
  const targetMode = mode ?? (await fileMode(path));
  await writeFile(temporary, data, targetMode === undefined ? undefined : { mode: targetMode });
  if (targetMode !== undefined) await chmod(temporary, targetMode);
  await rename(temporary, path);
}

/**
 * Take a backup, unless one is already there.
 *
 * Swapping something already swapped keeps the first backup, so `revert` lands
 * on what was there before any of this ran rather than on the previous swap.
 */
export async function backupOnce(path: string): Promise<string | undefined> {
  const backup = `${path}${BACKUP_SUFFIX}`;
  if (await exists(backup)) return backup;
  const mode = await fileMode(path);
  if (mode === undefined) return undefined;
  await writeFile(backup, await readFile(path, "utf8"), { mode });
  await chmod(backup, mode);
  return backup;
}

export function backupPath(configPath: string): string {
  return `${configPath}${BACKUP_SUFFIX}`;
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
  readonly backupExists: boolean;
  readonly data: string;
  readonly info: CliInfo;
  readonly mode: number | undefined;
  readonly outcome: WriteServerOutcome;
  readonly raw: string;
}

/** Parse and render one update without changing its config or backup. */
async function planServerWrite(
  info: CliInfo,
  name: string,
  spec: ServerSpec,
): Promise<ServerWritePlan> {
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

  const mode = await fileMode(info.configPath);
  const backup = backupPath(info.configPath);
  const backupMode = await fileMode(backup);
  if (backupMode !== undefined) await readFile(backup);
  return {
    backupExists: backupMode !== undefined,
    data,
    info,
    mode,
    outcome: had ? "replaced" : "added",
    raw,
  };
}

interface StagedServerWrite {
  readonly backupTemporary: string | undefined;
  readonly plan: ServerWritePlan;
  readonly temporary: string;
}

async function stageFile(path: string, data: string, mode: number | undefined): Promise<string> {
  const temporary = `${path}.mcp-swap-${String(process.pid)}-${randomUUID()}`;
  try {
    await writeFile(temporary, data, mode === undefined ? { flag: "wx" } : { flag: "wx", mode });
    if (mode !== undefined) await chmod(temporary, mode);
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function cleanupTemporaries(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

/** Update a selected client set as one rollback-capable transaction. */
export async function writeServers(
  infos: readonly CliInfo[],
  name: string,
  spec: ServerSpec,
): Promise<readonly WriteServerOutcome[]> {
  const plans: ServerWritePlan[] = [];
  for (const info of infos) {
    try {
      // eslint-disable-next-line no-await-in-loop -- every plan must exist before any staging.
      plans.push(await planServerWrite(info, name, spec));
    } catch (error) {
      throw new Error(`${info.name} (${info.configPath}): ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  const staged: StagedServerWrite[] = [];
  const temporaryPaths: string[] = [];
  try {
    for (const plan of plans) {
      // eslint-disable-next-line no-await-in-loop -- staging preserves deterministic failure ownership.
      await mkdir(join(plan.info.configPath, ".."), { recursive: true });
      const backupTemporary =
        plan.mode === undefined || plan.backupExists
          ? undefined
          : // eslint-disable-next-line no-await-in-loop -- all backups stage before target changes.
            await stageFile(backupPath(plan.info.configPath), plan.raw, plan.mode);
      if (backupTemporary !== undefined) temporaryPaths.push(backupTemporary);
      // eslint-disable-next-line no-await-in-loop -- all configs stage before target changes.
      const temporary = await stageFile(plan.info.configPath, plan.data, plan.mode);
      temporaryPaths.push(temporary);
      staged.push({ backupTemporary, plan, temporary });
    }
  } catch (error) {
    await cleanupTemporaries(temporaryPaths);
    throw error;
  }

  const createdBackups: string[] = [];
  const committed: ServerWritePlan[] = [];
  try {
    for (const entry of staged) {
      if (entry.backupTemporary === undefined) continue;
      const destination = backupPath(entry.plan.info.configPath);
      // eslint-disable-next-line no-await-in-loop -- commit order is deterministic for rollback.
      await rename(entry.backupTemporary, destination);
      createdBackups.push(destination);
    }
    for (const entry of staged) {
      // eslint-disable-next-line no-await-in-loop -- commit order is deterministic for rollback.
      await rename(entry.temporary, entry.plan.info.configPath);
      committed.push(entry.plan);
    }
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const plan of committed.toReversed()) {
      try {
        if (plan.mode === undefined) {
          // eslint-disable-next-line no-await-in-loop -- rollback must finish before reporting failure.
          await rm(plan.info.configPath, { force: true });
        } else {
          // eslint-disable-next-line no-await-in-loop -- rollback must finish before reporting failure.
          await writeAtomic(plan.info.configPath, plan.raw, plan.mode);
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    for (const backup of createdBackups) {
      try {
        // eslint-disable-next-line no-await-in-loop -- rollback must remove every new backup.
        await rm(backup, { force: true });
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
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
  const backup = backupPath(info.configPath);
  const mode = await fileMode(backup);
  if (mode === undefined) return false;
  await writeAtomic(info.configPath, await readFile(backup, "utf8"), mode);
  await rm(backup, { force: true });
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
      if (options.dryRun) {
        process.stdout.write(`would update ${info.name} (${info.configPath})\n`);
      }
    }
    if (options.dryRun) return 0;
    try {
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
