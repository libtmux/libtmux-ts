/* eslint-disable no-await-in-loop -- Discovery preserves path precedence and bounds concurrent file reads. */
import { randomUUID } from "node:crypto";
import { link, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Document = { [key: string]: Json };
export type FileContext = { cwd: string; env: Record<string, string | undefined> };
export type WorkspaceRecord = {
  name: string;
  path: string;
  format: string;
  size: number;
  mtime: string;
  session_name: Json;
  source: string;
  config?: Document | null;
};
export type DirectoryRecord = {
  path: string;
  source: string;
  exists: boolean;
  workspace_count: number;
  active: boolean;
};
const extensions = [".yaml", ".yml", ".json"];

export function home(context: FileContext): string {
  return context.env.HOME ?? context.env.USERPROFILE ?? homedir();
}
export function expandPath(path: string, context: FileContext): string {
  return path === "~"
    ? home(context)
    : path.startsWith("~/")
      ? join(home(context), path.slice(2))
      : path;
}
export function privatePath(path: string, context: FileContext): string {
  const base = home(context);
  return path === base ? "~" : path.startsWith(base + sep) ? "~" + path.slice(base.length) : path;
}
export function mapping(value: unknown, label = "workspace"): Document {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  return value as Document;
}
export function scalarText(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return String(value);
  throw new Error("Expected a string, boolean, or finite number");
}
export function sequence(value: Json | undefined, label: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value;
}

async function info(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return undefined;
    throw error;
  }
}

function jsonData(value: unknown, active = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || active.has(value) || value instanceof Date)
    throw new Error("Workspace must contain finite, acyclic JSON values");
  active.add(value);
  for (const entry of Object.values(value)) jsonData(entry, active);
  active.delete(value);
}

export async function readDocument(path: string): Promise<Document> {
  const source = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();
  if (!extensions.includes(extension))
    throw new Error(`Unsupported workspace extension: ${extension}`);
  const value: unknown =
    extension === ".json" ? JSON.parse(source) : parse(source, { merge: true, maxAliasCount: 100 });
  jsonData(value);
  return mapping(value);
}

export async function saveDocument(
  document: Document,
  path: string,
  format: string,
  force: boolean,
): Promise<void> {
  jsonData(document);
  if (!["json", "yaml"].includes(format))
    throw new Error(`Unsupported workspace format: ${format}`);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        format === "json" ? JSON.stringify(document, null, 2) + "\n" : stringify(document),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A link publishes without replacing a destination created after our check.
    if (force) await rename(temporary, path);
    else {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(`Destination exists: ${path}; use --force to replace it`);
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function directories(context: FileContext) {
  const entries: { path: string; source: string; exists: boolean }[] = [];
  const candidates: [string, string][] = [];
  if (context.env.TMUXP_CONFIGDIR !== undefined)
    candidates.push([context.env.TMUXP_CONFIGDIR, "$TMUXP_CONFIGDIR"]);
  candidates.push(
    context.env.XDG_CONFIG_HOME !== undefined
      ? [join(context.env.XDG_CONFIG_HOME, "tmuxp"), "$XDG_CONFIG_HOME/tmuxp"]
      : ["~/.config/tmuxp", "XDG default"],
  );
  candidates.push(["~/.tmuxp", "Legacy"]);
  for (const [path, source] of candidates) {
    const expanded = resolve(context.cwd, expandPath(path, context));
    entries.push({
      path: expanded,
      source,
      exists: (await info(expanded))?.isDirectory() ?? false,
    });
  }
  const active = entries.find((entry) => entry.exists)?.path ?? entries.at(-1)!.path;
  return { entries, active };
}

export async function resolveWorkspace(
  input: string,
  context: FileContext,
  workspaceDirectory?: string,
): Promise<string> {
  const expanded = expandPath(input, context);
  const pureName =
    !isAbsolute(expanded) &&
    dirname(expanded) === "." &&
    !expanded.includes(sep) &&
    !extname(expanded) &&
    ![".", ""].includes(expanded);
  const target = resolve(context.cwd, expanded);
  let candidates: string[];
  if (pureName) {
    const active = workspaceDirectory ?? (await directories(context)).active;
    candidates = extensions.map((extension) => resolve(context.cwd, active, expanded + extension));
  } else if ((await info(target))?.isDirectory() || !extname(expanded)) {
    candidates = extensions.map((extension) => join(target, `.tmuxp${extension}`));
  } else candidates = [target];
  for (const candidate of candidates) if ((await info(candidate))?.isFile()) return candidate;
  throw new Error(`Workspace not found: ${input}`);
}

export async function discover(
  context: FileContext,
  full = false,
): Promise<{ workspaces: WorkspaceRecord[]; global_workspace_dirs: DirectoryRecord[] }> {
  const files: { path: string; source: string }[] = [];
  let current = resolve(context.cwd);
  while (true) {
    for (const extension of extensions) {
      const path = join(current, `.tmuxp${extension}`);
      if ((await info(path))?.isFile()) {
        files.push({ path, source: "local" });
        break;
      }
    }
    const parent = dirname(current);
    if (current === parent || current === resolve(home(context))) break;
    current = parent;
  }
  const { entries, active } = await directories(context);
  const global_workspace_dirs: DirectoryRecord[] = [];
  for (const entry of entries) {
    const names = entry.exists ? (await readdir(entry.path)).sort() : [];
    const eligible = names.filter((name) => extensions.includes(extname(name).toLowerCase()));
    global_workspace_dirs.push({
      ...entry,
      path: privatePath(entry.path, context),
      workspace_count: eligible.filter((name) => !name.startsWith(".")).length,
      active: entry.path === active,
    });
    if (entry.path === active)
      for (const name of eligible) {
        const path = join(entry.path, name);
        if ((await info(path))?.isFile()) files.push({ path, source: "global" });
      }
  }
  const workspaces: WorkspaceRecord[] = [];
  for (const file of files) {
    const details = await info(file.path);
    if (!details) continue;
    let config: Document | null = null;
    try {
      config = await readDocument(file.path);
    } catch {
      /* Listing retains unreadable workspace metadata. */
    }
    const record: WorkspaceRecord = {
      name: basename(file.path, extname(file.path)),
      path: privatePath(file.path, context),
      format: extname(file.path).toLowerCase() === ".json" ? "json" : "yaml",
      size: details.size,
      mtime: details.mtime.toISOString(),
      session_name: config?.session_name ?? null,
      source: file.source,
    };
    if (full) record.config = config;
    workspaces.push(record);
  }
  return { workspaces, global_workspace_dirs };
}

export function importDocument(kind: "teamocil" | "tmuxinator", source: Document): Document {
  const input = structuredClone(source);
  if (kind === "teamocil") {
    const session = mapping(input.session ?? input);
    const result: Document = { session_name: session.name ?? null, windows: [] };
    if (session.root !== undefined) result.start_directory = session.root;
    result.windows = sequence(session.windows, "windows").map((value) => {
      const window = mapping(value, "window");
      const result: Document = { window_name: window.name ?? null };
      for (const key of ["clear", "layout"])
        if (window[key] !== undefined) result[key] = window[key]!;
      if (window.root !== undefined) result.start_directory = window.root;
      if (window.filters) {
        const filters = mapping(window.filters, "filters");
        if (Array.isArray(filters.before) && filters.before.length)
          result.shell_command_before = filters.before;
        if (Array.isArray(filters.after) && filters.after.length)
          result.shell_command_after = filters.after;
      }
      if (window.splits !== undefined || window.panes !== undefined)
        result.panes = sequence(window.splits ?? window.panes, "panes").map((value) => {
          const pane = mapping(value, "pane");
          if (pane.cmd !== undefined) {
            pane.shell_command = pane.cmd;
            delete pane.cmd;
          }
          delete pane.width;
          return pane;
        });
      return result;
    });
    return result;
  }
  const result: Document = { session_name: input.project_name ?? input.name ?? null, windows: [] };
  if (input.project_root !== undefined || input.root !== undefined)
    result.start_directory = input.project_root ?? input.root!;
  if (input.cli_args !== undefined || input.tmux_options !== undefined)
    result.config = scalarText(input.cli_args ?? input.tmux_options)
      .replaceAll("-f", "")
      .trim();
  if (input.socket_name !== undefined) result.socket_name = input.socket_name;
  if (input.pre !== undefined && input.pre_window !== undefined) {
    result.shell_command = input.pre;
    result.shell_command_before =
      typeof input.pre === "string" ? [input.pre_window] : input.pre_window;
  } else if (input.pre !== undefined)
    result.shell_command_before = typeof input.pre === "string" ? [input.pre] : input.pre;
  if (input.rbenv !== undefined)
    result.shell_command_before = [
      ...sequence(result.shell_command_before ?? [], "shell_command_before"),
      `rbenv shell ${scalarText(input.rbenv)}`,
    ];
  result.windows = sequence(input.tabs ?? input.windows, "windows").flatMap((value) =>
    Object.entries(mapping(value, "window")).map(([name, value]) => {
      const result: Document = { window_name: name };
      if (typeof value === "string" || value === null) result.panes = [value];
      else if (Array.isArray(value)) result.panes = value;
      else {
        const window = mapping(value, "window");
        for (const [from, to] of [
          ["pre", "shell_command_before"],
          ["panes", "panes"],
          ["root", "start_directory"],
          ["layout", "layout"],
        ] as const)
          if (window[from] !== undefined) result[to] = window[from]!;
      }
      return result;
    }),
  );
  return result;
}
