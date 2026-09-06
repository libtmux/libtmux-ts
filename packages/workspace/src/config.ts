import { workspaceSchema } from "./schema.js";

/** A value tmux stores for a session or window option. */
export type WorkspaceOptionValue = string | number | boolean;

/** A pane: a bare command string, or the settings the pane is created with. */
export type WorkspacePane =
  | string
  | {
      focus?: boolean | undefined;
      shell_command?: string | string[] | undefined;
      start_directory?: string | undefined;
    };

/** A window with every schema default applied. */
export type WorkspaceWindow = {
  focus?: boolean | undefined;
  layout?: string | undefined;
  options?: Record<string, WorkspaceOptionValue> | undefined;
  panes: WorkspacePane[];
  shell_command_before?: string | string[] | undefined;
  start_directory?: string | undefined;
  window_name?: string | undefined;
};

/** A window as written, before `panes` defaults to one implicit pane. */
export type WorkspaceWindowInput = {
  focus?: boolean | undefined;
  layout?: string | undefined;
  options?: Record<string, WorkspaceOptionValue> | undefined;
  panes?: WorkspacePane[] | undefined;
  shell_command_before?: string | string[] | undefined;
  start_directory?: string | undefined;
  window_name?: string | undefined;
};

/** A validated workspace with every schema default and transform applied. */
export type Workspace = {
  options?: Record<string, WorkspaceOptionValue> | undefined;
  session_name: string;
  start_directory?: string | undefined;
  windows: WorkspaceWindow[];
};

/** Workspace data before schema defaults and transforms are applied. */
export type WorkspaceInput = {
  options?: Record<string, WorkspaceOptionValue> | undefined;
  session_name: string;
  start_directory?: string | undefined;
  windows: WorkspaceWindowInput[];
};

/** Validate a parsed workspace, rejecting anything the schema does not allow. */
export function parseWorkspace(value: unknown): Workspace {
  return workspaceSchema.parse(value);
}

/**
 * Parse a YAML or JSON workspace, then validate it.
 *
 * YAML parsing is Bun's, and this package otherwise runs anywhere — so this is
 * the one function that does not. Reached from Node it says so, rather than
 * failing on an undefined global; parse the document yourself and hand the
 * result to {@link parseWorkspace}.
 */
export function parseWorkspaceYaml(source: string): Workspace {
  const yaml = (globalThis as { Bun?: { YAML?: { parse: (source: string) => unknown } } }).Bun
    ?.YAML;
  if (yaml === undefined) {
    throw new Error(
      "parseWorkspaceYaml needs Bun's YAML parser; parse the document yourself and use parseWorkspace",
    );
  }
  return parseWorkspace(yaml.parse(source));
}

function asCommands(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/**
 * Normalize a pane entry to the commands it should run, in order.
 *
 * A window's `shell_command_before` runs in every one of its panes, ahead of
 * that pane's own commands, which is how tmuxp seeds a common environment.
 */
export function paneCommands(pane: WorkspacePane, window?: WorkspaceWindow): readonly string[] {
  const own = typeof pane === "string" ? [pane] : asCommands(pane.shell_command);
  return [...asCommands(window?.shell_command_before), ...own].filter(
    (command) => command.length > 0,
  );
}

/** Whether a pane entry asked to be the focused one. */
export function paneWantsFocus(pane: WorkspacePane): boolean {
  return typeof pane !== "string" && pane.focus === true;
}

/** A pane's start directory, falling back to its window's and then the session's. */
export function paneStartDirectory(
  pane: WorkspacePane,
  window: WorkspaceWindow,
  workspace: Workspace,
): string | undefined {
  if (typeof pane !== "string" && pane.start_directory !== undefined) return pane.start_directory;
  return window.start_directory ?? workspace.start_directory;
}

/** A window's directory, inherited from its workspace when it has none. */
export function windowStartDirectory(
  window: WorkspaceWindow,
  workspace: Workspace,
): string | undefined {
  return window.start_directory ?? workspace.start_directory;
}

/** The directory tmux needs when it creates the session's first pane. */
export function initialPaneStartDirectory(workspace: Workspace): string | undefined {
  const window = workspace.windows[0];
  if (window === undefined) return workspace.start_directory;
  const pane = window.panes[0];
  return pane === undefined
    ? windowStartDirectory(window, workspace)
    : paneStartDirectory(pane, window, workspace);
}

/** Convert a YAML scalar to the string tmux accepts for an option value. */
export function optionValue(value: WorkspaceOptionValue): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}
