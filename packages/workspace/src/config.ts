import { z } from "zod";

/**
 * A tmuxp-shaped workspace description.
 *
 * The field names follow tmuxp's snake_case config vocabulary rather than this
 * package's camelCase API, because the config is data a user already has on
 * disk. Renaming their keys to suit our API would break the very compatibility
 * the format is here to provide.
 */
/**
 * Every object here is strict, and that is the point.
 *
 * A workspace is applied to a running server, so a key this schema does not
 * know is a key that will not happen — and `z.object` would drop it silently,
 * turning `window_nam: "editor"` into an unnamed window and a puzzled user.
 * Refusing the document is the only failure a caller can act on.
 */
const paneSchema = z.union([
  z.string(),
  z.strictObject({
    focus: z.boolean().optional(),
    shell_command: z.union([z.string(), z.array(z.string())]).optional(),
    start_directory: z.string().optional(),
  }),
]);

const optionValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const windowSchema = z.strictObject({
  focus: z.boolean().optional(),
  layout: z.string().optional(),
  options: z.record(z.string(), optionValueSchema).optional(),
  panes: z.array(paneSchema).default([]),
  shell_command_before: z.union([z.string(), z.array(z.string())]).optional(),
  start_directory: z.string().optional(),
  window_name: z.string().optional(),
});

export const workspaceSchema = z.strictObject({
  options: z.record(z.string(), optionValueSchema).optional(),
  session_name: z.string().min(1),
  start_directory: z.string().optional(),
  // A session always has at least one window, so a workspace with none does not
  // describe a reachable state: applying it would create a session and then try
  // to prune its windows to zero.
  windows: z.array(windowSchema).min(1),
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceWindow = z.infer<typeof windowSchema>;
export type WorkspacePane = z.infer<typeof paneSchema>;
export type WorkspaceOptionValue = z.infer<typeof optionValueSchema>;

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
