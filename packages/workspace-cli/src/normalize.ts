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

const fields = {
  workspace: [
    "session_name",
    "windows",
    "start_directory",
    "environment",
    "shell_command_before",
    "suppress_history",
    "options",
    "global_options",
    "before_script",
    "workspace_builder_options",
    "plugins",
    "workspace_builder",
    "workspace_builder_paths",
    "description",
  ],
  window: [
    "window_name",
    "window_index",
    "panes",
    "start_directory",
    "environment",
    "shell_command_before",
    "suppress_history",
    "options",
    "options_after",
    "layout",
    "window_shell",
    "focus",
    "description",
  ],
  pane: [
    "shell_command",
    "shell_command_before",
    "start_directory",
    "environment",
    "suppress_history",
    "shell",
    "focus",
    "enter",
    "sleep_before",
    "sleep_after",
    "description",
  ],
  command: ["cmd", "enter", "sleep_before", "sleep_after"],
  readiness: ["pane_readiness"],
};

function validateFields(
  data: Document,
  scope: keyof typeof fields,
  path: string,
  allowExtensionFields: boolean,
): void {
  if (allowExtensionFields) return;
  for (const key of Object.keys(data)) {
    // A key starting with "x-" is a caller's own extension point: inert at
    // load, and left alone by convert. Every other unknown key still refuses.
    if (key.startsWith("x-")) continue;
    if (!fields[scope].includes(key))
      throw new Error(
        `Unsupported field: ${path}.${key} (prefix a custom key with "x-" to have it ignored)`,
      );
  }
}

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
  // tmuxp's freezer writes `focus` as the quoted string 'true'/'false', not a
  // YAML boolean, on every freeze it produces. Coerce that spelling in place
  // so downstream truthiness checks (`desired.data.focus`) see a real
  // boolean, and still refuse anything else.
  if (data.focus === "true" || data.focus === "false") data.focus = data.focus === "true";
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
function readiness(data: Document, allowExtensionFields: boolean): WorkspaceSpec["readiness"] {
  const catalog =
    data.workspace_builder_options == null
      ? {}
      : mapping(data.workspace_builder_options, "workspace_builder_options");
  validateFields(catalog, "readiness", "workspace_builder_options", allowExtensionFields);
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
function environment(
  value: Json | undefined,
  base: string,
  context: FileContext,
): Record<string, string> {
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(mapping(value, "environment")).map(([key, value]) => {
      if (!key || key.includes("=") || key.includes("\0"))
        throw new Error(`Invalid environment name: ${key}`);
      const expanded = expand(optionalString(value, `environment.${key}`) ?? "", context);
      if (expanded.includes("\0")) throw new Error(`Invalid environment value: ${key}`);
      return [key, expanded.startsWith(".") ? resolve(base, expanded) : expanded];
    }),
  );
}
function delays(data: Document): void {
  for (const key of ["sleep_before", "sleep_after"]) {
    const delay = data[key];
    if (
      delay !== undefined &&
      delay !== null &&
      (typeof delay !== "number" || delay < 0 || !Number.isFinite(delay))
    )
      throw new Error(`${key} must be a nonnegative number or null`);
  }
}
function commands(
  value: Json | undefined,
  context: FileContext,
  path: string,
  allowExtensionFields: boolean,
): CommandSpec[] {
  if (value === undefined || value === null || value === "blank" || value === "pane") return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 1 && [null, "blank", "pane"].includes(entries[0] as string | null))
    return [];
  return entries.map((value, index) => {
    const item = typeof value === "string" ? { cmd: value } : mapping(value, "command");
    validateFields(item, "command", `${path}[${index}]`, allowExtensionFields);
    if (typeof item.cmd !== "string") throw new Error("A command needs a string cmd");
    if (item.enter !== undefined && typeof item.enter !== "boolean")
      throw new Error("enter must be boolean");
    delays(item);
    return { ...item, cmd: expand(item.cmd, context) } as CommandSpec;
  });
}
export function workspaceName(document: Document, context: FileContext, override?: string): string {
  const name = expand(
    override ?? optionalString(document.session_name, "session_name") ?? "",
    context,
  );
  if (!isTmuxName(name)) throw new Error("session_name must be a valid tmux name");
  return name;
}
export function normalize(
  document: Document,
  path: string,
  context: FileContext,
  override?: string,
  options: { allowExtensionFields?: boolean } = {},
): WorkspaceSpec {
  const data = structuredClone(document);
  const allowExtensionFields = options.allowExtensionFields ?? false;
  validateFields(data, "workspace", "workspace", allowExtensionFields);
  const name = workspaceName(data, context, override);
  const base = dirname(path);
  behavior(data, base, context);
  const policy = readiness(data, allowExtensionFields);
  const cwd = directory(data.start_directory, undefined, base, context);
  const sessionEnvironment = environment(data.environment, base, context);
  const sessionBefore = commands(
    data.shell_command_before,
    context,
    "shell_command_before",
    allowExtensionFields,
  );
  const windows = sequence(data.windows, "windows");
  if (!windows.length) throw new Error("Workspace must have at least one window");
  const indexes = new Set<number>();
  const normalized = windows.map((value, ordinal): WindowSpec => {
    const windowPath = `windows[${ordinal}]`;
    const window = mapping(value, windowPath);
    validateFields(window, "window", windowPath, allowExtensionFields);
    behavior(window, base, context);
    const windowName = optionalString(window.window_name, "window_name");
    const name = windowName === undefined ? undefined : expand(windowName, context);
    if (name !== undefined && !isTmuxName(name))
      throw new Error("window_name must be a valid tmux name");
    const rawIndex = window.window_index;
    const index =
      rawIndex == null
        ? undefined
        : typeof rawIndex === "number"
          ? rawIndex
          : typeof rawIndex === "string" && /^\d+$/.test(rawIndex)
            ? Number(rawIndex)
            : Number.NaN;
    if (
      index !== undefined &&
      (!Number.isSafeInteger(index) || index < 0 || index > 2147483647 || indexes.has(index))
    )
      throw new Error("window_index must be a distinct integer from 0 through 2147483647");
    if (index !== undefined) indexes.add(index);
    const windowDirectory = directory(window.start_directory, cwd, base, context);
    const windowEnvironment = environment(window.environment, base, context);
    const before = [
      ...sessionBefore,
      ...commands(
        window.shell_command_before,
        context,
        `${windowPath}.shell_command_before`,
        allowExtensionFields,
      ),
    ];
    const declared = sequence(window.panes ?? [null], "panes");
    // A window always has a pane, so an empty list asks for the implicit one.
    const panes = declared.length === 0 ? [null] : declared;
    return {
      data: window,
      name,
      index,
      panes: panes.map((value, paneIndex) => {
        const panePath = `${windowPath}.panes[${paneIndex}]`;
        const pane =
          typeof value === "string" || Array.isArray(value) || value === null
            ? { shell_command: value }
            : mapping(value, "pane");
        validateFields(pane, "pane", panePath, allowExtensionFields);
        const own = commands(
          pane.shell_command,
          context,
          `${panePath}.shell_command`,
          allowExtensionFields,
        );
        behavior(pane, base, context);
        delays(pane);
        return {
          data: pane,
          commands: [
            ...before,
            ...commands(
              pane.shell_command_before,
              context,
              `${panePath}.shell_command_before`,
              allowExtensionFields,
            ),
            ...own,
          ],
          directory: directory(pane.start_directory, windowDirectory, base, context),
          environment: {
            ...sessionEnvironment,
            ...(pane.environment !== undefined
              ? environment(pane.environment, base, context)
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
    bootstrap = tokenize(expand(beforeScript, context));
    if (bootstrap[0]!.startsWith(".")) bootstrap[0] = resolve(base, bootstrap[0]!);
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
