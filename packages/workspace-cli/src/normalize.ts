import { isTmuxName } from "libtmux";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  expandPath,
  mapping,
  scalarText,
  sequence,
  type Document,
  type FileContext,
  type Json,
} from "./documents.ts";
import { tokenize } from "./process.ts";

export type CommandSpec = {
  cmd: string;
  enter?: boolean;
  sleep_before?: number | null;
  sleep_after?: number | null;
};
export type PaneSpec = {
  data: Document;
  commands: CommandSpec[];
  directory: string | undefined;
  environment: Record<string, string>;
  shell: string | undefined;
  suppress: boolean;
};
export type WindowSpec = {
  data: Document;
  panes: PaneSpec[];
  name: string | undefined;
  index: number | undefined;
};
export type WorkspaceSpec = {
  data: Document;
  name: string;
  directory: string | undefined;
  environment: Record<string, string>;
  windows: WindowSpec[];
  bootstrap: string[] | undefined;
  readiness: "auto" | "always" | "never";
};

export function expand(value: string, context: FileContext): string {
  return expandPath(value, context).replace(
    /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g,
    (original, braced: string | undefined, bare: string | undefined) =>
      context.env[braced ?? bare!] ?? original,
  );
}
function optionalString(value: Json | undefined, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}
function behavior(data: Document, base: string, context: FileContext): void {
  for (const name of ["focus", "suppress_history", "enter"]) {
    if (data[name] !== undefined && typeof data[name] !== "boolean")
      throw new Error(`${name} must be boolean`);
  }
  for (const name of ["options", "global_options", "options_after"])
    if (data[name] !== undefined) {
      const options = mapping(data[name], name);
      for (const [key, value] of Object.entries(options)) {
        scalarText(value);
        if (typeof value === "string") {
          const expanded = expand(value, context);
          options[key] = expanded.startsWith(".") ? resolve(base, expanded) : expanded;
        }
      }
    }
  for (const name of ["layout", "window_shell", "shell"]) optionalString(data[name], name);
}
function readiness(data: Document): WorkspaceSpec["readiness"] {
  const catalog =
    data.workspace_builder_options == null
      ? {}
      : mapping(data.workspace_builder_options, "workspace_builder_options");
  const value =
    catalog.pane_readiness == null
      ? "auto"
      : scalarText(catalog.pane_readiness).trim().toLowerCase();
  if (value === "auto") return "auto";
  if (["always", "true", "on", "yes", "1"].includes(value)) return "always";
  if (["never", "false", "off", "no", "0"].includes(value)) return "never";
  throw new Error("pane_readiness must be auto, always, never, or a boolean");
}
function directory(
  value: Json | undefined,
  parent: string | undefined,
  base: string,
  context: FileContext,
): string | undefined {
  const path = optionalString(value, "start_directory");
  if (path === undefined) return parent;
  const expanded = expand(path, context);
  return isAbsolute(expanded) ? expanded : resolve(parent ?? base, expanded);
}
function environment(value: Json | undefined, context: FileContext): Record<string, string> {
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(mapping(value, "environment")).map(([key, value]) => {
      if (!key || key.includes("=") || key.includes("\0"))
        throw new Error(`Invalid environment name: ${key}`);
      const expanded = expand(optionalString(value, `environment.${key}`) ?? "", context);
      if (expanded.includes("\0")) throw new Error(`Invalid environment value: ${key}`);
      return [key, expanded.startsWith(".") ? resolve(context.cwd, expanded) : expanded];
    }),
  );
}
function commands(value: Json | undefined, context: FileContext): CommandSpec[] {
  if (value === undefined || value === null || value === "blank" || value === "pane") return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 1 && [null, "blank", "pane"].includes(entries[0] as string | null))
    return [];
  return entries.map((value) => {
    const item = typeof value === "string" ? { cmd: value } : mapping(value, "command");
    if (typeof item.cmd !== "string") throw new Error("A command needs a string cmd");
    if (item.enter !== undefined && typeof item.enter !== "boolean")
      throw new Error("enter must be boolean");
    for (const key of ["sleep_before", "sleep_after"]) {
      const delay = item[key];
      if (
        delay !== undefined &&
        delay !== null &&
        (typeof delay !== "number" || delay < 0 || !Number.isFinite(delay))
      )
        throw new Error(`${key} must be a nonnegative number or null`);
    }
    return { ...item, cmd: expand(item.cmd, context) } as CommandSpec;
  });
}
export function normalize(
  document: Document,
  path: string,
  context: FileContext,
  override?: string,
): WorkspaceSpec {
  const data = structuredClone(document);
  const name = expand(override ?? optionalString(data.session_name, "session_name") ?? "", context);
  if (!isTmuxName(name)) throw new Error("session_name must be a valid tmux name");
  const base = dirname(path);
  behavior(data, base, context);
  const policy = readiness(data);
  const cwd = directory(data.start_directory, undefined, base, context);
  const sessionEnvironment = environment(data.environment, context);
  const sessionBefore = commands(data.shell_command_before, context);
  const windows = sequence(data.windows, "windows");
  if (!windows.length) throw new Error("Workspace must have at least one window");
  const indexes = new Set<number>();
  const normalized = windows.map((value, ordinal): WindowSpec => {
    const window = mapping(value, `windows[${ordinal}]`);
    behavior(window, context.cwd, context);
    const windowName = optionalString(window.window_name, "window_name");
    const name = windowName === undefined ? undefined : expand(windowName, context);
    if (name !== undefined && !isTmuxName(name))
      throw new Error("window_name must be a valid tmux name");
    const index = window.window_index === undefined ? undefined : Number(window.window_index);
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || indexes.has(index)))
      throw new Error("window_index must be a distinct nonnegative integer");
    if (index !== undefined) indexes.add(index);
    const windowDirectory = directory(window.start_directory, cwd, base, context);
    const windowEnvironment = environment(window.environment, context);
    const before = [...sessionBefore, ...commands(window.shell_command_before, context)];
    const panes = sequence(window.panes ?? [null], "panes");
    if (!panes.length) throw new Error("Window must have at least one pane");
    return {
      data: window,
      name,
      index,
      panes: panes.map((value) => {
        const pane =
          typeof value === "string" || Array.isArray(value) || value === null
            ? { shell_command: value }
            : mapping(value, "pane");
        const own = commands(pane.shell_command, context);
        behavior(pane, context.cwd, context);
        commands(
          [
            {
              cmd: "",
              ...Object.fromEntries(
                ["enter", "sleep_before", "sleep_after"]
                  .filter((key) => pane[key] !== undefined)
                  .map((key) => [key, pane[key]!]),
              ),
            },
          ],
          context,
        );
        return {
          data: pane,
          commands: [...before, ...commands(pane.shell_command_before, context), ...own],
          directory: directory(pane.start_directory, windowDirectory, base, context),
          environment: {
            ...sessionEnvironment,
            ...(pane.environment !== undefined
              ? environment(pane.environment, context)
              : windowEnvironment),
          },
          shell: optionalString(pane.shell ?? window.window_shell, "shell"),
          suppress: Boolean(
            pane.suppress_history ?? window.suppress_history ?? data.suppress_history ?? true,
          ),
        };
      }),
    };
  });
  const beforeScript = optionalString(data.before_script, "before_script");
  let bootstrap: string[] | undefined;
  if (beforeScript !== undefined) {
    const command = expand(beforeScript, context);
    bootstrap = tokenize(command.startsWith(".") ? resolve(base, command) : command);
  }
  return {
    data,
    name,
    directory: cwd,
    environment: sessionEnvironment,
    windows: normalized,
    bootstrap,
    readiness: policy,
  };
}
