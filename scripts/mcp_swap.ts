import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
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
const LOCK_WORKER_COMMAND = "__mcp-swap-lock-worker";
const LOCK_EX = 2;
const LOCK_UN = 8;
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
  readonly backupDigest: string;
  readonly backupIdentity: string;
  readonly backupMode: number;
  readonly kind: Exclude<ConfigPathKind, "missing">;
  readonly logicalIdentity: string | null;
  readonly targetDigest: string;
  readonly targetIdentity: string;
  readonly targetMode: number;
  readonly targetPath: string;
  readonly version: 2;
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
    flock(descriptor: number, operation: number): number;
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
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
      throw new Error("platform cannot open the swap lock without following links");
    }
    const { dlopen, FFIType } = await import("bun:ffi");
    library = dlopen(nativeLibraryName(), {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
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
    if (library.symbols.flock(lockDescriptor, LOCK_EX) !== 0) {
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
    if (library.symbols.flock(lockDescriptor, LOCK_UN) !== 0) {
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

function recoveryRouteRecord(
  route: ConfigRoute,
  target: RecoveryFile,
  backup: RecoveryFile,
): RecoveryRouteRecord {
  return {
    backupDigest: contentDigest(backup.raw),
    backupIdentity: backup.identity,
    backupMode: backup.mode,
    kind: route.kind === "symlink" ? "symlink" : "regular",
    logicalIdentity: route.kind === "symlink" ? (route.logicalIdentity ?? null) : null,
    targetDigest: contentDigest(target.raw),
    targetIdentity: target.identity,
    targetMode: target.mode,
    targetPath: route.targetPath,
    version: 2,
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

/**
 * Take a backup, unless one is already there.
 *
 * Swapping something already swapped keeps the first backup, so `revert` lands
 * on what was there before any of this ran rather than on the previous swap.
 */
export async function backupOnce(path: string): Promise<string | undefined> {
  const backup = `${path}${BACKUP_SUFFIX}`;
  const inspect = async (lock?: SwapLockState) => {
    const route = await inspectConfigRoute(path);
    const recovery = await readRecoveryState(path, route);
    const current =
      route.kind === "missing" ? undefined : await readRecoveryFile(route.targetPath, "config");
    if (route.kind !== "missing" && current?.identity !== route.targetIdentity) {
      throw new Error(`config changed while backup was planned: ${path}`);
    }
    await assertDistinctTransactionArtifacts(
      [
        {
          info: { configPath: path, name: "backup" },
          recovery,
          route,
        },
      ],
      lock ?? (await inspectSwapLock()),
    );
    return { current, recovery, route };
  };
  const observed = await inspect();
  if (observed.recovery.backup !== undefined) return backup;
  if (observed.current === undefined) return undefined;
  return withSwapLock(async (lock) => {
    const hooks: SwapTransactionHooks = {};
    const { current, recovery, route } = await inspect(lock.state);
    if (recovery.backup !== undefined) return backup;
    if (current === undefined) return undefined;
    const backupTemporary = await stageFile(backup, current.raw, current.mode);
    const routePath = recoveryRoutePath(path);
    const routeTemporary = await stageFile(
      routePath,
      serializeRecoveryRoute(recoveryRouteRecord(route, current, backupTemporary)),
      0o600,
    );
    const backupOperation = fileReplacement(backupTemporary, backup, undefined, "backup");
    const routeOperation = fileReplacement(routeTemporary, routePath, undefined, "state");
    try {
      await assertConfigState(route, current.raw, current.mode);
      await applyReplacement(backupOperation, hooks, lock);
      await applyReplacement(routeOperation, hooks, lock);
    } catch (error) {
      const rollbackFailures: unknown[] = [
        ...(await collectFailures([routeOperation, backupOperation], async (operation) =>
          rollbackReplacement(operation, hooks, lock),
        )),
      ];
      rollbackFailures.push(
        ...(await cleanupFiles([backupTemporary, routeTemporary], hooks, lock)),
      );
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          "backup failed and rollback was incomplete",
        );
      }
      throw error;
    }
    const cleanupFailures = await cleanupFiles([backupTemporary, routeTemporary], hooks, lock);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "backup cleanup was incomplete");
    }
    return backup;
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
  if (
    keys.join(",") !==
    "backupDigest,backupIdentity,backupMode,kind,logicalIdentity,targetDigest,targetIdentity,targetMode,targetPath,version"
  ) {
    throw new TypeError("recovery route metadata has unknown or missing fields");
  }
  if (record.version !== 2 || (record.kind !== "regular" && record.kind !== "symlink")) {
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
  const identityPattern = /^\d+:\d+:-?\d+$/u;
  const digestPattern = /^[0-9a-f]{64}$/u;
  if (
    typeof record.backupIdentity !== "string" ||
    !identityPattern.test(record.backupIdentity) ||
    typeof record.targetIdentity !== "string" ||
    !identityPattern.test(record.targetIdentity) ||
    typeof record.backupDigest !== "string" ||
    !digestPattern.test(record.backupDigest) ||
    typeof record.targetDigest !== "string" ||
    !digestPattern.test(record.targetDigest) ||
    !Number.isInteger(record.backupMode) ||
    (record.backupMode as number) < 0 ||
    (record.backupMode as number) > 0o7777 ||
    !Number.isInteger(record.targetMode) ||
    (record.targetMode as number) < 0 ||
    (record.targetMode as number) > 0o7777
  ) {
    throw new TypeError("recovery route metadata has invalid file ownership");
  }
  return {
    backupDigest: record.backupDigest,
    backupIdentity: record.backupIdentity,
    backupMode: record.backupMode as number,
    kind: record.kind,
    logicalIdentity: record.logicalIdentity as string | null,
    targetDigest: record.targetDigest,
    targetIdentity: record.targetIdentity,
    targetMode: record.targetMode as number,
    targetPath: record.targetPath,
    version: 2,
  };
}

function serializeRecoveryRoute(record: RecoveryRouteRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function persistentRouteMatches(route: ConfigRoute, record: RecoveryRouteRecord): boolean {
  return (
    route.kind === record.kind &&
    route.targetPath === record.targetPath &&
    route.targetIdentity === record.targetIdentity &&
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
    throw new Error(`config path changed since swap: ${configPath}`);
  }
  if (
    backup.identity !== routeRecord.backupIdentity ||
    backup.mode !== routeRecord.backupMode ||
    contentDigest(backup.raw) !== routeRecord.backupDigest
  ) {
    throw new Error(`recovery backup changed since swap: ${configPath}`);
  }
  const targetRaw = await readUtf8File(route.targetPath, "config");
  const targetMode = await fileMode(route.targetPath);
  if (
    targetMode !== routeRecord.targetMode ||
    contentDigest(targetRaw) !== routeRecord.targetDigest
  ) {
    throw new Error(`config contents changed since swap: ${configPath}`);
  }
  return { backup, route: routeFile };
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

export interface SwapTransactionHooks {
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

interface ServerWritePlan {
  readonly data: string;
  readonly info: CliInfo;
  readonly mode: number | undefined;
  readonly outcome: WriteServerOutcome;
  readonly raw: string;
  readonly recovery: RecoveryState;
  readonly route: ConfigRoute;
}

interface TransactionPlan {
  readonly info: CliInfo;
  readonly recovery: RecoveryState;
  readonly route: ConfigRoute;
}

interface RevertPlan extends TransactionPlan {
  readonly mode: number | undefined;
  readonly raw: string;
}

interface TransactionBatch<Plan extends TransactionPlan> {
  readonly plans: readonly Plan[];
  readonly protectedPlans: readonly TransactionPlan[];
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

interface StagedFile extends RecoveryFile {
  readonly path: string;
}

interface HeldFile extends RecoveryFile {
  readonly directory: string;
  readonly path: string;
}

interface StagedServerWrite {
  readonly backupTemporary: StagedFile | undefined;
  readonly committedRoute: ConfigRoute;
  readonly plan: ServerWritePlan;
  readonly routeRaw: string | undefined;
  readonly routeTemporary: StagedFile | undefined;
  readonly temporary: StagedFile;
}

interface PlannedReplacement<Entry> extends FileReplacement {
  readonly entry: Entry;
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
  role: "backup" | "state",
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

async function rollbackReplacements<T extends FileReplacement, Plan>(
  operations: readonly T[],
  failedPlans: Set<Plan>,
  planFor: (operation: T) => Plan,
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
  checks: {
    readonly after?: (operation: T) => Promise<void>;
    readonly before?: (operation: T) => Promise<void>;
    readonly skipFailedPlans?: boolean;
  } = {},
): Promise<readonly Error[]> {
  const failures: Error[] = [];
  for (const operation of operations.toReversed()) {
    const plan = planFor(operation);
    if (checks.skipFailedPlans !== false && failedPlans.has(plan)) continue;
    try {
      if (operation.committed !== undefined) {
        // eslint-disable-next-line no-await-in-loop -- a committed replacement must remain owned.
        await checks.before?.(operation);
      }
      // eslint-disable-next-line no-await-in-loop -- rollback is exact reverse commit order.
      await rollbackReplacement(operation, hooks, lock);
      // eslint-disable-next-line no-await-in-loop -- restored topology is verified before advancing.
      await checks.after?.(operation);
    } catch (error) {
      failures.push(error as Error);
      failedPlans.add(plan);
    }
  }
  return failures;
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

async function protectedTransactionArtifacts(
  selected: readonly CliInfo[],
  protectedInfos: readonly CliInfo[],
): Promise<readonly TransactionPlan[]> {
  const selectedEntries = new Set(selected.map((info) => `${info.name}\u0000${info.configPath}`));
  const plans: TransactionPlan[] = [];
  for (const info of protectedInfos) {
    if (selectedEntries.has(`${info.name}\u0000${info.configPath}`)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- route ownership must be attributed to one client.
      const route = await inspectConfigRoute(info.configPath);
      // eslint-disable-next-line no-await-in-loop -- sidecars are part of the same client's route.
      const recovery = await readRecoveryState(info.configPath, route);
      plans.push({ info, recovery, route });
    } catch (error) {
      throw planError(info, error);
    }
  }
  return plans;
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
  lock?: SwapLockState,
  protectedInfos: readonly CliInfo[] = infos,
): Promise<TransactionBatch<ServerWritePlan>> {
  const lockState = lock ?? (await inspectSwapLock());
  const plans: ServerWritePlan[] = [];
  for (const info of infos) {
    try {
      // eslint-disable-next-line no-await-in-loop -- every config parses before feasibility checks.
      plans.push(await planServerWrite(info, name, spec));
    } catch (error) {
      throw planError(info, error);
    }
  }
  const protectedPlans = await protectedTransactionArtifacts(infos, protectedInfos);
  await assertDistinctTransactionArtifacts([...plans, ...protectedPlans], lockState);
  for (const plan of plans) {
    try {
      // eslint-disable-next-line no-await-in-loop -- stable client ownership keeps failures actionable.
      await assertPlanFeasible(plan);
    } catch (error) {
      throw planError(plan.info, error);
    }
  }
  for (const plan of plans) {
    try {
      // eslint-disable-next-line no-await-in-loop -- all selected state authenticates before staging.
      await assertServerWritePlan(plan);
    } catch (error) {
      throw planError(plan.info, error);
    }
  }
  return { plans, protectedPlans };
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

async function assertRecoveryState(plan: TransactionPlan): Promise<void> {
  if (plan.recovery.backup === undefined) {
    await assertPathMissing(backupPath(plan.info.configPath), "recovery backup");
  } else {
    await assertRecoveryFile(
      backupPath(plan.info.configPath),
      plan.recovery.backup,
      plan.recovery.backup.raw,
      "recovery backup",
      plan.recovery.backup.mode,
    );
  }
  if (plan.recovery.route === undefined) {
    await assertPathMissing(recoveryRoutePath(plan.info.configPath), "recovery route sidecar");
  } else {
    await assertRecoveryFile(
      recoveryRoutePath(plan.info.configPath),
      plan.recovery.route,
      plan.recovery.route.raw,
      "recovery route sidecar",
      0o600,
    );
  }
}

async function assertProtectedTransactionArtifacts(
  plans: readonly TransactionPlan[],
): Promise<void> {
  for (const plan of plans) {
    try {
      // eslint-disable-next-line no-await-in-loop -- every protected route must remain exact at this boundary.
      await assertConfigRoute(plan.route);
      // eslint-disable-next-line no-await-in-loop -- recovery artifacts share the same route boundary.
      await assertRecoveryState(plan);
    } catch (error) {
      throw planError(plan.info, error);
    }
  }
}

function guardTransactionHooks(
  hooks: SwapTransactionHooks,
  protectedPlans: readonly TransactionPlan[],
): SwapTransactionHooks {
  return {
    ...hooks,
    beforeFileOperation: async (operation) => {
      await hooks.beforeFileOperation?.(operation);
      if (!operation.boundary.includes("-rollback-") && !operation.boundary.endsWith("-cleanup")) {
        await assertProtectedTransactionArtifacts(protectedPlans);
      }
    },
  };
}

async function assertServerWritePlan(plan: ServerWritePlan): Promise<void> {
  await assertConfigState(plan.route, plan.raw, plan.mode);
  await assertRecoveryState(plan);
}

async function planRevert(info: CliInfo): Promise<RevertPlan> {
  const route = await inspectConfigRoute(info.configPath);
  const raw = route.kind === "missing" ? "" : await readUtf8File(route.targetPath, "config");
  const mode = await fileMode(route.targetPath);
  const recovery = await readRecoveryState(info.configPath, route);
  const plan = { info, mode, raw, recovery, route };
  await assertConfigState(route, raw, mode);
  return plan;
}

async function assertRevertPlan(plan: RevertPlan): Promise<void> {
  await assertConfigState(plan.route, plan.raw, plan.mode);
  await assertRecoveryState(plan);
}

async function planReverts(
  infos: readonly CliInfo[],
  lock?: SwapLockState,
  protectedInfos: readonly CliInfo[] = infos,
): Promise<TransactionBatch<RevertPlan>> {
  const lockState = lock ?? (await inspectSwapLock());
  const plans: RevertPlan[] = [];
  for (const info of infos) {
    try {
      // eslint-disable-next-line no-await-in-loop -- every selected recovery authenticates first.
      plans.push(await planRevert(info));
    } catch (error) {
      throw planError(info, error);
    }
  }
  const active = plans.filter((plan) => plan.recovery.backup !== undefined);
  const protectedPlans = await protectedTransactionArtifacts(infos, protectedInfos);
  await assertDistinctTransactionArtifacts([...plans, ...protectedPlans], lockState);
  for (const plan of active) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each active route needs writable sibling slots.
      await Promise.all(
        [
          plan.route.targetPath,
          backupPath(plan.info.configPath),
          ...(plan.recovery.route === undefined ? [] : [recoveryRoutePath(plan.info.configPath)]),
        ].map(assertDestinationFeasible),
      );
    } catch (error) {
      throw planError(plan.info, error);
    }
  }
  for (const plan of plans) {
    try {
      // eslint-disable-next-line no-await-in-loop -- all selected state authenticates before staging.
      await assertRevertPlan(plan);
    } catch (error) {
      throw planError(plan.info, error);
    }
  }
  return { plans, protectedPlans };
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
  const route = entry.routeTemporary;
  if (route !== undefined) {
    await assertRecoveryFile(
      recoveryRoutePath(plan.info.configPath),
      route,
      entry.routeRaw!,
      "recovery route sidecar",
      0o600,
    );
  }
}

async function writeServersLocked(
  plans: readonly ServerWritePlan[],
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<readonly WriteServerOutcome[]> {
  await lock.assert();
  const staged: StagedServerWrite[] = [];
  const temporaryFiles: StagedFile[] = [];
  try {
    for (const plan of plans) {
      // eslint-disable-next-line no-await-in-loop -- staging preserves deterministic failure ownership.
      await mkdir(dirname(plan.route.targetPath), { recursive: true });
      const backupTemporary =
        plan.mode === undefined || plan.recovery.backup !== undefined
          ? undefined
          : // eslint-disable-next-line no-await-in-loop -- all backups stage before target changes.
            await stageFile(backupPath(plan.info.configPath), plan.raw, plan.mode);
      if (backupTemporary !== undefined) temporaryFiles.push(backupTemporary);
      // eslint-disable-next-line no-await-in-loop -- all configs stage before target changes.
      const temporary = await stageFile(plan.route.targetPath, plan.data, plan.mode);
      temporaryFiles.push(temporary);
      const backup =
        plan.recovery.backup ??
        (backupTemporary === undefined || plan.mode === undefined
          ? undefined
          : { identity: backupTemporary.identity, mode: plan.mode, raw: plan.raw });
      const routeRaw =
        backup === undefined || plan.mode === undefined
          ? undefined
          : serializeRecoveryRoute(
              recoveryRouteRecord(
                plan.route,
                { identity: temporary.identity, mode: plan.mode, raw: plan.data },
                backup,
              ),
            );
      const routeTemporary =
        routeRaw === undefined
          ? undefined
          : // eslint-disable-next-line no-await-in-loop -- ownership stages beside its recovery unit.
            await stageFile(recoveryRoutePath(plan.info.configPath), routeRaw, 0o600);
      if (routeTemporary !== undefined) temporaryFiles.push(routeTemporary);
      staged.push({
        backupTemporary,
        committedRoute: committedRoute(plan.route, temporary.identity),
        plan,
        routeRaw,
        routeTemporary,
        temporary,
      });
    }
    await hooks.afterStaging?.();
  } catch (error) {
    const cleanupFailures = await cleanupFiles(temporaryFiles, hooks, lock);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `swap staging failed and ${String(cleanupFailures.length)} owned stage(s) were retained`,
      );
    }
    throw error;
  }

  const recoveries: PlannedReplacement<StagedServerWrite>[] = [];
  const configs: PlannedReplacement<StagedServerWrite>[] = [];
  try {
    for (const entry of staged) {
      if (entry.backupTemporary !== undefined) {
        // eslint-disable-next-line no-await-in-loop -- no selected state may drift before publication.
        await assertServerWritePlan(entry.plan);
        const operation = {
          ...fileReplacement(
            entry.backupTemporary,
            backupPath(entry.plan.info.configPath),
            undefined,
            "backup",
          ),
          entry,
        };
        recoveries.push(operation);
        // eslint-disable-next-line no-await-in-loop -- transaction transitions are strictly ordered.
        await applyReplacement(operation, hooks, lock);
      }
      if (entry.routeTemporary !== undefined) {
        const operation = {
          ...fileReplacement(
            entry.routeTemporary,
            recoveryRoutePath(entry.plan.info.configPath),
            entry.plan.recovery.route,
            "state",
          ),
          entry,
        };
        recoveries.push(operation);
        // eslint-disable-next-line no-await-in-loop -- transaction transitions are strictly ordered.
        await applyReplacement(operation, hooks, lock);
      }
    }
    for (const [index, entry] of staged.entries()) {
      // eslint-disable-next-line no-await-in-loop -- tests can force a precise transition boundary.
      await hooks.beforeConfigCommit?.(entry.plan.info, index);
      // eslint-disable-next-line no-await-in-loop -- every write reauthenticates bytes, mode, and route.
      await assertConfigState(entry.plan.route, entry.plan.raw, entry.plan.mode);
      // eslint-disable-next-line no-await-in-loop -- recovery must remain usable before target change.
      await assertRecoveryUnit(entry);
      const original =
        entry.plan.route.kind === "missing"
          ? undefined
          : {
              identity: entry.plan.route.targetIdentity!,
              mode: entry.plan.mode!,
              raw: entry.plan.raw,
            };
      const operation = {
        ...fileReplacement(entry.temporary, entry.plan.route.targetPath, original, "config"),
        entry,
      };
      configs.push(operation);
      // eslint-disable-next-line no-await-in-loop -- transaction transitions are strictly ordered.
      await applyReplacement(operation, hooks, lock);
      // eslint-disable-next-line no-await-in-loop -- committed state is verified before advancing.
      await assertConfigState(entry.committedRoute, entry.plan.data, entry.temporary.mode);
    }
  } catch (error) {
    const failedRollbacks = new Set<ServerWritePlan>();
    const rollbackFailures: unknown[] = [
      ...(await rollbackReplacements(
        configs,
        failedRollbacks,
        ({ entry }) => entry.plan,
        hooks,
        lock,
        {
          after: async ({ entry }) =>
            assertConfigState(entry.plan.route, entry.plan.raw, entry.plan.mode),
          before: async ({ entry }) =>
            assertConfigState(entry.committedRoute, entry.plan.data, entry.temporary.mode),
        },
      )),
      ...(await rollbackReplacements(
        recoveries,
        failedRollbacks,
        ({ entry }) => entry.plan,
        hooks,
        lock,
      )),
    ];
    rollbackFailures.push(...(await cleanupFiles(temporaryFiles, hooks, lock)));
    if (rollbackFailures.length > 0) {
      const retainedRecovery = [...failedRollbacks].flatMap((plan) => {
        const paths = new Set([
          backupPath(plan.info.configPath),
          recoveryRoutePath(plan.info.configPath),
        ]);
        for (const operation of [...configs, ...recoveries]) {
          if (operation.entry.plan === plan && operation.previous !== undefined) {
            paths.add(operation.previous.directory);
          }
        }
        return [...paths];
      });
      const retained =
        retainedRecovery.length === 0
          ? ""
          : `; recovery retained at ${retainedRecovery.join(", ")}`;
      throw new AggregateError(
        [error, ...rollbackFailures],
        `swap failed and ${String(rollbackFailures.length)} rollback operation(s) also failed${retained}`,
      );
    }
    throw error;
  }
  const cleanupFailures = [
    ...(await cleanupReplacements(configs, hooks, lock)),
    ...(await cleanupReplacements(recoveries, hooks, lock)),
  ];
  cleanupFailures.push(...(await cleanupFiles(temporaryFiles, hooks, lock)));
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "swap committed but owned cleanup was incomplete");
  }
  await lock.assert();
  return plans.map(({ outcome }) => outcome);
}

/** Update a selected client set as one rollback-capable transaction. */
export async function writeServers(
  infos: readonly CliInfo[],
  name: string,
  spec: ServerSpec,
  hooks: SwapTransactionHooks = {},
  protectedInfos: readonly CliInfo[] = infos,
): Promise<readonly WriteServerOutcome[]> {
  await planServerWrites(infos, name, spec, undefined, protectedInfos);
  return withSwapLock(async (lock) => {
    await hooks.afterLockAcquired?.();
    await lock.assert();
    const { plans, protectedPlans } = await planServerWrites(
      infos,
      name,
      spec,
      lock.state,
      protectedInfos,
    );
    return writeServersLocked(plans, guardTransactionHooks(hooks, protectedPlans), lock);
  });
}

/** Point one CLI at `spec`, backing the file up first. */
export async function writeServer(
  info: CliInfo,
  name: string,
  spec: ServerSpec,
  hooks: SwapTransactionHooks = {},
): Promise<WriteServerOutcome> {
  return (await writeServers([info], name, spec, hooks))[0]!;
}

interface StagedRevert {
  readonly plan: RevertPlan;
  readonly restoredRoute: ConfigRoute;
  readonly temporary: StagedFile;
}

interface RecoveryRemoval extends FileReplacement {
  readonly label: string;
  readonly mode: number;
  readonly plan: RevertPlan;
}

async function revertConfigsLocked(
  plans: readonly RevertPlan[],
  hooks: SwapTransactionHooks,
  lock: SwapLockHandle,
): Promise<readonly boolean[]> {
  await lock.assert();
  const active = plans.filter((plan) => plan.recovery.backup !== undefined);
  const staged: StagedRevert[] = [];
  const temporaryFiles: StagedFile[] = [];
  try {
    for (const plan of active) {
      const backup = plan.recovery.backup!;
      // eslint-disable-next-line no-await-in-loop -- all restores stage before any config changes.
      const temporary = await stageFile(plan.route.targetPath, backup.raw, backup.mode);
      temporaryFiles.push(temporary);
      staged.push({
        plan,
        restoredRoute: committedRoute(plan.route, temporary.identity),
        temporary,
      });
    }
    await hooks.afterStaging?.();
  } catch (error) {
    const cleanupFailures = await cleanupFiles(temporaryFiles, hooks, lock);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `revert staging failed and ${String(cleanupFailures.length)} owned stage(s) were retained`,
      );
    }
    throw error;
  }

  const configs: PlannedReplacement<StagedRevert>[] = [];
  const retired: RecoveryRemoval[] = [];
  try {
    for (const [index, entry] of staged.entries()) {
      const { plan } = entry;
      // eslint-disable-next-line no-await-in-loop -- tests can force a precise transition boundary.
      await hooks.beforeConfigCommit?.(plan.info, index);
      // eslint-disable-next-line no-await-in-loop -- each restore reauthenticates the complete unit.
      await assertRevertPlan(plan);
      const operation = {
        ...fileReplacement(
          entry.temporary,
          plan.route.targetPath,
          { identity: plan.route.targetIdentity!, mode: plan.mode!, raw: plan.raw },
          "config",
        ),
        entry,
      };
      configs.push(operation);
      // eslint-disable-next-line no-await-in-loop -- transaction transitions are strictly ordered.
      await applyReplacement(operation, hooks, lock);
      // eslint-disable-next-line no-await-in-loop -- restored bytes, mode, topology, and inode must agree.
      await assertConfigState(
        entry.restoredRoute,
        plan.recovery.backup!.raw,
        plan.recovery.backup!.mode,
      );
    }

    for (const [index, entry] of staged.entries()) {
      const { plan } = entry;
      // eslint-disable-next-line no-await-in-loop -- tests can force a precise retirement boundary.
      await hooks.beforeRecoveryRetire?.(plan.info, index);
      // eslint-disable-next-line no-await-in-loop -- config remains verified before recovery retirement.
      await assertConfigState(
        entry.restoredRoute,
        plan.recovery.backup!.raw,
        plan.recovery.backup!.mode,
      );
      // eslint-disable-next-line no-await-in-loop -- both recovery artifacts remain exact before moving.
      await assertRecoveryState(plan);
      const artifacts = [
        ...(plan.recovery.route === undefined
          ? []
          : [
              {
                destination: recoveryRoutePath(plan.info.configPath),
                expected: plan.recovery.route,
                label: "recovery route sidecar",
                mode: 0o600,
              },
            ]),
        {
          destination: backupPath(plan.info.configPath),
          expected: plan.recovery.backup!,
          label: "recovery backup",
          mode: plan.recovery.backup!.mode,
        },
      ];
      for (const artifact of artifacts) {
        // eslint-disable-next-line no-await-in-loop -- each artifact authenticates immediately before move.
        await assertRecoveryFile(
          artifact.destination,
          artifact.expected,
          artifact.expected.raw,
          artifact.label,
          artifact.mode,
        );
        const operation = {
          ...fileRemoval(
            artifact.destination,
            artifact.expected,
            artifact.label === "recovery backup" ? "backup" : "state",
          ),
          label: artifact.label,
          mode: artifact.mode,
          plan,
        };
        retired.push(operation);
        // eslint-disable-next-line no-await-in-loop -- recovery retirement is strictly ordered.
        await applyReplacement(operation, hooks, lock);
      }
    }
  } catch (error) {
    const failedPlans = new Set<RevertPlan>();
    const rollbackFailures: unknown[] = [
      ...(await rollbackReplacements(retired, failedPlans, ({ plan }) => plan, hooks, lock, {
        after: async (artifact) =>
          assertRecoveryFile(
            artifact.destination,
            artifact.original!,
            artifact.original!.raw,
            artifact.label,
            artifact.mode,
          ),
        skipFailedPlans: false,
      })),
      ...(await rollbackReplacements(configs, failedPlans, ({ entry }) => entry.plan, hooks, lock, {
        after: async ({ entry }) =>
          assertConfigState(entry.plan.route, entry.plan.raw, entry.plan.mode),
        before: async ({ entry }) =>
          assertConfigState(
            entry.restoredRoute,
            entry.plan.recovery.backup!.raw,
            entry.plan.recovery.backup!.mode,
          ),
        skipFailedPlans: false,
      })),
    ];
    rollbackFailures.push(...(await cleanupFiles(temporaryFiles, hooks, lock)));
    if (rollbackFailures.length > 0) {
      const retained = [...failedPlans]
        .flatMap((plan) => [
          plan.info.configPath,
          backupPath(plan.info.configPath),
          recoveryRoutePath(plan.info.configPath),
          ...configs
            .filter((candidate) => candidate.entry.plan === plan)
            .flatMap((candidate) =>
              candidate.previous === undefined ? [] : [candidate.previous.directory],
            ),
          ...retired
            .filter((candidate) => candidate.plan === plan)
            .flatMap((candidate) =>
              candidate.previous === undefined ? [] : [candidate.previous.directory],
            ),
        ])
        .join(", ");
      throw new AggregateError(
        [error, ...rollbackFailures],
        `revert failed and ${String(rollbackFailures.length)} rollback operation(s) also failed; recovery retained at ${retained}`,
      );
    }
    throw error;
  }

  const cleanupFailures: Error[] = [
    ...(await cleanupReplacements(configs, hooks, lock)),
    ...(await cleanupReplacements(retired, hooks, lock)),
  ];
  cleanupFailures.push(...(await cleanupFiles(temporaryFiles, hooks, lock)));
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "revert committed but owned cleanup was incomplete");
  }
  await lock.assert();
  const activePlans = new Set(active);
  return plans.map((plan) => activePlans.has(plan));
}

/** Restore a selected client set as one rollback-capable transaction. */
export async function revertConfigs(
  infos: readonly CliInfo[],
  hooks: SwapTransactionHooks = {},
  protectedInfos: readonly CliInfo[] = infos,
): Promise<readonly boolean[]> {
  await planReverts(infos, undefined, protectedInfos);
  return withSwapLock(async (lock) => {
    await hooks.afterLockAcquired?.();
    await lock.assert();
    const { plans, protectedPlans } = await planReverts(infos, lock.state, protectedInfos);
    return revertConfigsLocked(plans, guardTransactionHooks(hooks, protectedPlans), lock);
  });
}

/** Restore one config from the backup a swap wrote. */
export async function revertConfig(info: CliInfo): Promise<boolean> {
  return (await revertConfigs([info]))[0]!;
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
  readonly clients: readonly string[];
  readonly dryRun: boolean;
  readonly repo: string;
  readonly server: string;
  readonly skipPreflight: boolean;
  readonly source: SourceOptions;
}

function usage(): string {
  return [
    "Point selected installed agent CLIs at one build of this MCP server.",
    "",
    "  bun scripts/mcp_swap.ts detect",
    "  bun scripts/mcp_swap.ts status",
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
    "  --no-preflight  register without starting the server first",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  const clients: string[] = [];
  let dryRun = false;
  let skipPreflight = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    const assigned = equals === -1 ? undefined : token.slice(equals + 1);
    if (flag === "--dry-run" || flag === "--no-preflight") {
      if (assigned !== undefined) throw new Error(`${flag} takes no value`);
      if (flag === "--dry-run") dryRun = true;
      else skipPreflight = true;
      continue;
    }
    if (!["--cli", "--client", "--repo", "--server", "--source", "--version"].includes(flag)) {
      throw new Error(`unknown option ${flag}`);
    }
    const value = assigned ?? argv[++index];
    if (value === undefined || value === "" || (assigned === undefined && value.startsWith("--"))) {
      throw new Error(`${flag} wants a value`);
    }
    if (flag === "--cli" || flag === "--client") clients.push(value);
    else values.set(flag, value);
  }

  const kind = (values.get("--source") ?? "dev") as SourceKind;
  if (!["build", "dev", "published"].includes(kind)) {
    throw new Error(`unknown source ${kind}; expected dev, build, or published`);
  }
  // The repository root, one directory above this repository-level script.
  const repo = values.get("--repo") ?? join(import.meta.dir, "..");
  const version = values.get("--version");
  return {
    clients,
    dryRun,
    repo,
    server: values.get("--server") ?? "libtmux",
    skipPreflight,
    source: { kind, repo, ...(version === undefined ? {} : { version }) },
  };
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
    allClis = knownClis();
    clis = selectClis(allClis, options.clients);
  } catch (error) {
    process.stderr.write(`mcp_swap: ${(error as Error).message}\n${usage()}\n`);
    return 2;
  }

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
        await planServerWrites(selected, options.server, spec, undefined, allClis);
        for (const info of selected) {
          process.stdout.write(`would update ${info.name} (${info.configPath})\n`);
        }
        return 0;
      }
      const outcomes = await writeServers(selected, options.server, spec, {}, allClis);
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
    try {
      if (options.dryRun) {
        const { plans } = await planReverts(clis, undefined, allClis);
        for (const plan of plans) {
          if (plan.recovery.backup !== undefined) {
            process.stdout.write(`would restore ${plan.info.name} (${plan.info.configPath})\n`);
          }
        }
        return 0;
      }
      const outcomes = await revertConfigs(clis, {}, allClis);
      for (const [index, info] of clis.entries()) {
        if (outcomes[index] === true) {
          process.stdout.write(`restored ${info.name} (${info.configPath})\n`);
        }
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
