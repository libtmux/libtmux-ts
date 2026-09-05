import type {
  McpServer,
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeObjectSchema,
  objectFromShape,
  safeParseAsync,
  type AnySchema,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { Policy, Toolset } from "./policy.js";
import {
  TMUX_FORMAT_LITERALIZATION,
  TMUX_FORMAT_SCHEMA_KEY,
  TMUX_FORMAT_VALIDATED_VARIABLE,
} from "./schemas.js";

export type ProcessReach = "none" | "configured-process" | "pane-input" | "pane-command";
export type TmuxEffect = "observe" | "change" | "delete";
export type OutputClass =
  | "tmux-metadata"
  | "terminal-content"
  | "process-environment"
  | "configured-command";
export type InputSink =
  | "none"
  | "tmux-lookup"
  | "tmux-state"
  | "tmux-format"
  | "pane-input"
  | "shell-command"
  | "process-argv"
  | "regex"
  | "nested-tool";

export type ExplicitAnnotations = Readonly<{
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
  readonly readOnlyHint: boolean;
}>;

export const CONSERVATIVE_ANNOTATIONS: ExplicitAnnotations = Object.freeze({
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
});

export const CAPABILITY_META_KEY = "com.git-pull.libtmux-mcp/capability";

// These names keep the declarations beside handlers concise. Every final row
// owns the conservative four-field value above.
export const READ_ONLY = CONSERVATIVE_ANNOTATIONS;
export const MUTATING = CONSERVATIVE_ANNOTATIONS;
export const DESTRUCTIVE = CONSERVATIVE_ANNOTATIONS;
export const MUTATING_OPEN_WORLD = CONSERVATIVE_ANNOTATIONS;
export const OPEN_WORLD = CONSERVATIVE_ANNOTATIONS;

interface CapabilitySeed {
  readonly amplifiesFutureInput: boolean;
  readonly toolset: Toolset;
  readonly processReach: ProcessReach;
  readonly tmuxEffects: readonly TmuxEffect[];
  readonly outputClasses: readonly OutputClass[];
  readonly nestedAuthority?: readonly string[];
}

const c = (
  toolset: Toolset,
  processReach: ProcessReach,
  tmuxEffects: readonly TmuxEffect[],
  outputClasses: readonly OutputClass[],
  nestedAuthority?: readonly string[],
  amplifiesFutureInput = false,
): CapabilitySeed => ({
  amplifiesFutureInput,
  toolset,
  processReach,
  tmuxEffects,
  outputClasses,
  ...(nestedAuthority === undefined ? {} : { nestedAuthority }),
});

const META = ["tmux-metadata"] as const;
const CONTENT = ["tmux-metadata", "terminal-content"] as const;
export const READ_BATCH_TOOLS = [
  "list_sessions",
  "list_windows",
  "list_panes",
  "get_pane_info",
  "get_server_info",
  "capture_pane",
  "capture_since",
  "search_panes",
  "show_option",
  "show_hooks",
  "show_environment",
  "get_session_info",
  "get_window_info",
  "find_pane_by_position",
  "get_tmux_variables",
  "snapshot_pane",
] as const;
const CAPABILITY_SEEDS = Object.freeze({
  call_read_tools_batch: c(
    "inspect",
    "none",
    ["observe", "change"],
    ["tmux-metadata", "terminal-content", "process-environment", "configured-command"],
    READ_BATCH_TOOLS,
  ),
  capture_pane: c("inspect", "none", ["observe"], CONTENT),
  capture_since: c("inspect", "none", ["observe"], CONTENT),
  clear_pane_scrollback: c("teardown", "none", ["delete"], META),
  create_session: c("execute", "configured-process", ["observe", "change"], META),
  create_window: c("execute", "configured-process", ["observe", "change"], META),
  find_pane_by_position: c("inspect", "none", ["observe"], META),
  get_pane_info: c("inspect", "none", ["observe"], META),
  get_server_info: c("inspect", "none", ["observe"], META),
  get_session_info: c("inspect", "none", ["observe"], META),
  get_tmux_variables: c("inspect", "none", ["observe"], ["tmux-metadata", "configured-command"]),
  get_window_info: c("inspect", "none", ["observe"], META),
  kill_pane: c("teardown", "none", ["observe", "delete"], META),
  kill_session: c("teardown", "none", ["observe", "delete"], META),
  kill_window: c("teardown", "none", ["observe", "delete"], META),
  list_panes: c("inspect", "none", ["observe"], META),
  list_sessions: c("inspect", "none", ["observe"], META),
  list_windows: c("inspect", "none", ["observe"], META),
  move_window: c("manage", "none", ["observe", "change"], META),
  paste_text: c("execute", "pane-input", ["observe", "change"], META),
  rename_session: c("manage", "none", ["observe", "change"], META),
  rename_window: c("manage", "none", ["observe", "change"], META),
  resize_pane: c("manage", "none", ["observe", "change"], META),
  resize_window: c("manage", "none", ["observe", "change"], META),
  respawn_pane: c("execute", "configured-process", ["observe", "change", "delete"], META),
  run_shell_command: c("execute", "pane-command", ["observe", "change"], CONTENT),
  search_panes: c("inspect", "none", ["observe"], CONTENT),
  select_layout: c("manage", "none", ["observe", "change"], META),
  select_pane: c("manage", "none", ["observe", "change"], META),
  select_window: c("manage", "none", ["observe", "change"], META),
  send_keys: c("execute", "pane-input", ["observe", "change"], META),
  send_keys_batch: c("execute", "pane-input", ["observe", "change"], META),
  set_history_limit: c("manage", "none", ["change"], META),
  set_mouse_enabled: c("manage", "none", ["change"], META),
  set_pane_title: c("manage", "none", ["observe", "change"], META),
  set_synchronize_panes: c("execute", "none", ["change"], META, undefined, true),
  show_option: c("inspect", "none", ["observe"], ["tmux-metadata", "configured-command"]),
  show_environment: c("inspect", "none", ["observe"], ["process-environment"]),
  show_hooks: c("inspect", "none", ["observe"], ["configured-command"]),
  signal_channel: c("manage", "none", ["change"], META),
  snapshot_pane: c("inspect", "none", ["observe"], CONTENT),
  split_window: c("execute", "configured-process", ["observe", "change"], META),
  swap_pane: c("manage", "none", ["observe", "change"], META),
  wait_for_text: c("inspect", "none", ["observe"], CONTENT),
  wait_for_channel: c("manage", "none", ["change"], META),
} satisfies Readonly<Record<string, CapabilitySeed>>);

export type PublicToolName = keyof typeof CAPABILITY_SEEDS;

/** Reject named selection before constructing or probing a tmux client. */
export function assertKnownPolicyTools(policy: Pick<Policy, "excludeTools" | "tools">): void {
  for (const name of [...policy.tools, ...policy.excludeTools]) {
    if (!(name in CAPABILITY_SEEDS)) throw new TypeError(`unknown tool ${name}`);
  }
}

const INPUT_KEYS = Object.freeze({
  call_read_tools_batch: ["onError", "operations"],
  capture_pane: ["end", "joinWrapped", "maxLines", "paneId", "start"],
  capture_since: ["cursor", "maxLines", "paneId", "waitMs"],
  clear_pane_scrollback: ["paneId"],
  create_session: ["height", "name", "startDirectory", "width", "windowName"],
  create_window: ["name", "session", "startDirectory"],
  find_pane_by_position: ["corner", "windowId"],
  get_pane_info: ["paneId"],
  get_server_info: [],
  get_session_info: ["session"],
  get_tmux_variables: ["names", "paneId"],
  get_window_info: ["windowId"],
  kill_pane: ["force", "paneId"],
  kill_session: ["force", "session"],
  kill_window: ["force", "windowId"],
  list_panes: ["session", "window"],
  list_sessions: [],
  list_windows: ["session"],
  move_window: ["index", "session", "sourceIndex", "sourceSession", "windowId"],
  paste_text: ["enter", "force", "paneId", "text"],
  rename_session: ["name", "session"],
  rename_window: ["name", "windowId"],
  resize_pane: ["amount", "direction", "height", "paneId", "width", "zoom"],
  resize_window: ["height", "width", "windowId"],
  respawn_pane: ["force", "killFirst", "paneId", "startDirectory"],
  run_shell_command: ["command", "force", "maxLines", "paneId", "timeoutMs"],
  search_panes: ["maxMatchesPerPane", "pattern", "regex", "scrollbackLines", "session"],
  select_layout: ["layout", "windowId"],
  select_pane: ["paneId"],
  select_window: ["sourceIndex", "sourceSession", "windowId"],
  send_keys: ["enter", "force", "keys", "literal", "paneId"],
  send_keys_batch: ["onError", "operations"],
  set_history_limit: ["lines"],
  set_mouse_enabled: ["enabled"],
  set_pane_title: ["paneId", "title"],
  set_synchronize_panes: ["enabled", "windowId"],
  show_environment: ["session"],
  show_hooks: ["session"],
  show_option: ["name", "scope", "target"],
  signal_channel: ["channel"],
  snapshot_pane: ["maxLines", "paneId"],
  split_window: ["direction", "paneId", "startDirectory"],
  swap_pane: ["otherPaneId", "paneId"],
  wait_for_text: ["cursor", "maxLines", "paneId", "patterns", "regex", "timeoutMs"],
  wait_for_channel: ["channel", "timeoutMs"],
} satisfies Readonly<Record<PublicToolName, readonly string[]>>);

const sink = (...values: readonly InputSink[]): readonly InputSink[] => Object.freeze(values);
const NONE = sink("none");
const LOOKUP = sink("tmux-lookup");
const STATE = sink("tmux-state");
const LITERAL_STATE = sink("tmux-state", "tmux-format");
const PANE_INPUT = sink("pane-input");
const PANE_COMMAND = sink("pane-input", "shell-command");

const INPUT_SINKS = Object.freeze({
  call_read_tools_batch: { onError: NONE, operations: sink("nested-tool") },
  capture_pane: {
    end: STATE,
    joinWrapped: STATE,
    maxLines: NONE,
    paneId: LOOKUP,
    start: STATE,
  },
  capture_since: { cursor: NONE, maxLines: NONE, paneId: LOOKUP, waitMs: NONE },
  clear_pane_scrollback: { paneId: LOOKUP },
  create_session: {
    height: STATE,
    name: LITERAL_STATE,
    startDirectory: LITERAL_STATE,
    width: STATE,
    windowName: LITERAL_STATE,
  },
  create_window: { name: LITERAL_STATE, session: LOOKUP, startDirectory: LITERAL_STATE },
  find_pane_by_position: { corner: LOOKUP, windowId: LOOKUP },
  get_pane_info: { paneId: LOOKUP },
  get_server_info: {},
  get_session_info: { session: LOOKUP },
  get_tmux_variables: { names: sink("tmux-lookup", "tmux-format"), paneId: LOOKUP },
  get_window_info: { windowId: LOOKUP },
  kill_pane: { force: NONE, paneId: LOOKUP },
  kill_session: { force: NONE, session: LOOKUP },
  kill_window: { force: NONE, windowId: LOOKUP },
  list_panes: { session: LOOKUP, window: LOOKUP },
  list_sessions: {},
  list_windows: { session: LOOKUP },
  move_window: {
    index: STATE,
    session: LOOKUP,
    sourceIndex: LOOKUP,
    sourceSession: LOOKUP,
    windowId: LOOKUP,
  },
  paste_text: { enter: PANE_INPUT, force: NONE, paneId: LOOKUP, text: PANE_INPUT },
  rename_session: { name: LITERAL_STATE, session: LOOKUP },
  rename_window: { name: LITERAL_STATE, windowId: LOOKUP },
  resize_pane: {
    amount: STATE,
    direction: STATE,
    height: STATE,
    paneId: LOOKUP,
    width: STATE,
    zoom: STATE,
  },
  resize_window: { height: STATE, width: STATE, windowId: LOOKUP },
  respawn_pane: {
    force: NONE,
    killFirst: NONE,
    paneId: LOOKUP,
    startDirectory: LITERAL_STATE,
  },
  run_shell_command: {
    command: PANE_COMMAND,
    force: NONE,
    maxLines: NONE,
    paneId: LOOKUP,
    timeoutMs: NONE,
  },
  search_panes: {
    maxMatchesPerPane: NONE,
    pattern: sink("regex"),
    regex: NONE,
    scrollbackLines: NONE,
    session: LOOKUP,
  },
  select_layout: { layout: STATE, windowId: LOOKUP },
  select_pane: { paneId: LOOKUP },
  select_window: { sourceIndex: LOOKUP, sourceSession: LOOKUP, windowId: LOOKUP },
  send_keys: {
    enter: PANE_INPUT,
    force: NONE,
    keys: PANE_INPUT,
    literal: NONE,
    paneId: LOOKUP,
  },
  send_keys_batch: { onError: NONE, operations: sink("tmux-lookup", "pane-input") },
  set_history_limit: { lines: STATE },
  set_mouse_enabled: { enabled: STATE },
  set_pane_title: { paneId: LOOKUP, title: LITERAL_STATE },
  set_synchronize_panes: { enabled: STATE, windowId: LOOKUP },
  show_environment: { session: LOOKUP },
  show_hooks: { session: LOOKUP },
  show_option: { name: LOOKUP, scope: LOOKUP, target: LOOKUP },
  signal_channel: { channel: STATE },
  snapshot_pane: { maxLines: NONE, paneId: LOOKUP },
  split_window: { direction: STATE, paneId: LOOKUP, startDirectory: LITERAL_STATE },
  swap_pane: { otherPaneId: LOOKUP, paneId: LOOKUP },
  wait_for_text: {
    cursor: NONE,
    maxLines: NONE,
    paneId: LOOKUP,
    patterns: sink("regex"),
    regex: NONE,
    timeoutMs: NONE,
  },
  wait_for_channel: { channel: STATE, timeoutMs: NONE },
} satisfies Readonly<Record<PublicToolName, Readonly<Record<string, readonly InputSink[]>>>>);
type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  readonly amplifiesFutureInput: boolean;
  readonly name: PublicToolName;
  readonly title: string;
  readonly description: string;
  readonly descriptionBody: string;
  readonly toolset: Toolset;
  readonly processReach: ProcessReach;
  readonly tmuxEffects: readonly TmuxEffect[];
  readonly outputClasses: readonly OutputClass[];
  readonly mayExposeSecrets: boolean;
  readonly mayReturnUntrustedContent: boolean;
  readonly annotations: ExplicitAnnotations;
  readonly nativeInputSchema: unknown;
  readonly nativeOutputSchema: unknown;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly inputSinks: Readonly<Record<string, readonly InputSink[]>>;
  readonly nestedAuthority: readonly PublicToolName[];
  readonly handler: unknown;
  readonly register: (mcp: McpServer, definition: ToolDefinition) => RegisteredTool;
}

export type ToolRegistrar = Pick<McpServer, "registerTool">;

function schemaJson(schema: ZodRawShapeCompat | AnySchema | undefined): JsonSchema {
  const normalized = normalizeObjectSchema(schema);
  return normalized === undefined
    ? Object.freeze({ properties: Object.freeze({}), type: "object" })
    : Object.freeze(toJsonSchemaCompat(normalized, { pipeStrategy: "input", strictUnions: true }));
}

function propertyNames(schema: JsonSchema): readonly string[] {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
  return Object.keys(properties).sort();
}

function controlledDescription(seed: CapabilitySeed, body: string): string {
  let opener: string;
  if (seed.toolset === "teardown") {
    opener = "Delete tmux state; accepts no command payload.";
  } else if (seed.processReach === "configured-process") {
    opener = "Start a pane's configured process; accepts no command payload.";
  } else if (seed.processReach === "pane-input") {
    opener =
      "Send input to a pane's program; a shell that receives it runs it with your user's permissions.";
  } else if (seed.processReach === "pane-command") {
    opener = "Run a shell command in a pane with your user's permissions.";
  } else if (seed.toolset !== "inspect") {
    opener = "Change tmux state; no client-supplied executable input.";
  } else if (seed.outputClasses.includes("terminal-content")) {
    opener =
      "Read pane output; accepts no client-supplied executable input. Returned content may be sensitive or untrusted.";
  } else if (seed.outputClasses.includes("process-environment")) {
    opener =
      "Read the tmux environment; accepts no client-supplied executable input. Returned values may contain secrets.";
  } else if (seed.outputClasses.includes("configured-command")) {
    opener =
      "Read configured tmux commands; accepts no client-supplied executable input. Returned values may contain executable configuration.";
  } else {
    opener = "Inspect tmux metadata; accepts no client-supplied executable input.";
  }
  return `${opener} ${body}`;
}

function sinksFor(
  name: PublicToolName,
  names: readonly string[],
): Readonly<Record<string, readonly InputSink[]>> {
  const sinks = INPUT_SINKS[name];
  const sinkNames = Object.keys(sinks).sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(sinkNames)) {
    throw new TypeError(`${name} must classify every input sink explicitly`);
  }
  return Object.freeze({ ...sinks });
}

function validateDefinition(definition: ToolDefinition): void {
  if (definition.amplifiesFutureInput !== (definition.name === "set_synchronize_panes")) {
    throw new TypeError(`${definition.name} has an invalid amplifiesFutureInput claim`);
  }
  const schemaKeys = propertyNames(definition.inputSchema);
  const sinkKeys = Object.keys(definition.inputSinks).sort();
  if (JSON.stringify(schemaKeys) !== JSON.stringify(sinkKeys)) {
    throw new TypeError(`${definition.name} input schema and input sinks differ`);
  }
  for (const [name, sinks] of Object.entries(definition.inputSinks)) {
    if (sinks.length === 0) throw new TypeError(`${definition.name}.${name} has no input sink`);
    if (sinks.includes("tmux-format")) {
      const properties = definition.inputSchema.properties;
      const property =
        typeof properties === "object" && properties !== null && !Array.isArray(properties)
          ? (properties as Readonly<Record<string, unknown>>)[name]
          : undefined;
      const literalization =
        typeof property === "object" && property !== null && !Array.isArray(property)
          ? (property as Readonly<Record<string, unknown>>)[TMUX_FORMAT_SCHEMA_KEY]
          : undefined;
      if (
        literalization !== TMUX_FORMAT_LITERALIZATION &&
        literalization !== TMUX_FORMAT_VALIDATED_VARIABLE
      ) {
        throw new TypeError(`${definition.name}.${name} has no tmux-format input control`);
      }
    }
  }
  if (definition.tmuxEffects.length === 0) throw new TypeError(`${definition.name} has no effect`);
  const allSinks = Object.values(definition.inputSinks).flat();
  if (definition.nestedAuthority.length === 0 && allSinks.includes("nested-tool")) {
    throw new TypeError(`${definition.name} has a nested-tool sink without nested authority`);
  }
  if (definition.nestedAuthority.length > 0 && !allSinks.includes("nested-tool")) {
    throw new TypeError(`${definition.name} has nested authority without a nested-tool sink`);
  }
  if (definition.processReach === "pane-command" && !allSinks.includes("shell-command")) {
    throw new TypeError(`${definition.name} pane-command reach has no pane-command sink`);
  }
  if (definition.processReach === "pane-input" && !allSinks.includes("pane-input")) {
    throw new TypeError(`${definition.name} pane-input reach has no pane-input sink`);
  }
  if (
    (definition.processReach === "none" || definition.processReach === "configured-process") &&
    allSinks.some((sink) => sink === "shell-command" || sink === "pane-input")
  ) {
    throw new TypeError(`${definition.name} process reach contradicts its input sinks`);
  }
  if (
    !definition.description.startsWith(controlledDescription(CAPABILITY_SEEDS[definition.name], ""))
  ) {
    throw new TypeError(`${definition.name} description lacks its controlled opener`);
  }
}

export class ToolRegistry {
  readonly #definitions = new Map<PublicToolName, ToolDefinition>();
  #callableNames: ReadonlySet<string> | undefined;

  nativeInputShape(name: PublicToolName): ZodRawShapeCompat {
    const definition = this.#definitions.get(name);
    if (definition === undefined) throw new TypeError(`unknown nested tool ${name}`);
    const schema = definition.nativeInputSchema;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new TypeError(`${name} does not own an object input shape`);
    }
    return schema as ZodRawShapeCompat;
  }

  registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      readonly title?: string;
      readonly description?: string;
      readonly inputSchema?: InputArgs;
      readonly outputSchema?: OutputArgs;
      readonly annotations?: ToolAnnotations;
      readonly _meta?: Record<string, unknown>;
    },
    handler: ToolCallback<InputArgs>,
  ): RegisteredTool {
    if (!(name in CAPABILITY_SEEDS)) throw new TypeError(`unknown manifest tool ${name}`);
    const publicName = name as PublicToolName;
    if (this.#definitions.has(publicName)) throw new TypeError(`duplicate tool ${name}`);
    if (config.title === undefined || config.description === undefined) {
      throw new TypeError(`${name} must declare title and description`);
    }
    if (config.inputSchema === undefined || config.outputSchema === undefined) {
      throw new TypeError(`${name} must declare native input and output schemas`);
    }
    const seed = CAPABILITY_SEEDS[publicName];
    const inputSchema = schemaJson(config.inputSchema);
    const description = controlledDescription(seed, config.description);
    const sdkConfig = Object.freeze({
      ...config,
      annotations: CONSERVATIVE_ANNOTATIONS,
      description,
    });
    const definition: ToolDefinition = Object.freeze({
      amplifiesFutureInput: seed.amplifiesFutureInput,
      annotations: CONSERVATIVE_ANNOTATIONS,
      description,
      descriptionBody: config.description,
      handler,
      inputSchema,
      inputSinks: sinksFor(publicName, INPUT_KEYS[publicName]),
      mayExposeSecrets: true,
      mayReturnUntrustedContent: true,
      name: publicName,
      nativeInputSchema: config.inputSchema,
      nativeOutputSchema: config.outputSchema,
      nestedAuthority: Object.freeze([
        ...(seed.nestedAuthority ?? []),
      ]) as readonly PublicToolName[],
      outputClasses: Object.freeze([...seed.outputClasses]),
      outputSchema: schemaJson(config.outputSchema),
      processReach: seed.processReach,
      register: (mcp: McpServer, resolvedDefinition: ToolDefinition): RegisteredTool =>
        mcp.registerTool(
          name,
          {
            ...sdkConfig,
            _meta: {
              ...sdkConfig._meta,
              [CAPABILITY_META_KEY]: capabilityRow(resolvedDefinition),
            },
            description: resolvedDefinition.description,
          },
          handler,
        ),
      title: config.title,
      tmuxEffects: Object.freeze([...seed.tmuxEffects]),
      toolset: seed.toolset,
    });
    validateDefinition(definition);
    this.#definitions.set(publicName, definition);
    return {
      ...sdkConfig,
      disable(): void {},
      enable(): void {},
      enabled: false,
      handler,
      remove(): void {},
      update(): void {},
    } as RegisteredTool;
  }

  resolve(policy: Policy): ResolvedToolRegistry {
    if (this.#definitions.size !== Object.keys(CAPABILITY_SEEDS).length) {
      const missing = Object.keys(CAPABILITY_SEEDS).filter(
        (name) => !this.#definitions.has(name as PublicToolName),
      );
      throw new TypeError(`manifest did not collect every public tool: ${missing.join(", ")}`);
    }
    for (const definition of this.#definitions.values()) {
      const nested = definition.nestedAuthority.map((name) => this.#definitions.get(name));
      const nestedEffects = new Set(nested.flatMap((child) => child?.tmuxEffects ?? []));
      if ([...nestedEffects].some((effect) => !definition.tmuxEffects.includes(effect))) {
        throw new TypeError(`${definition.name} omits a nested tool effect`);
      }
    }
    assertKnownPolicyTools(policy);
    const selected = new Set<PublicToolName>();
    for (const definition of this.#definitions.values()) {
      if (policy.toolsets.has(definition.toolset)) selected.add(definition.name);
    }
    for (const name of policy.tools) selected.add(name as PublicToolName);
    for (const name of policy.excludeTools) selected.delete(name as PublicToolName);
    const resolved = [...this.#definitions.values()].filter((definition) =>
      selected.has(definition.name),
    );
    const nested = resolved.flatMap(({ nestedAuthority }) =>
      nestedAuthority.filter((name) => !policy.excludeTools.has(name)),
    );
    this.#callableNames = new Set([...selected, ...nested]);
    return new ResolvedToolRegistry(resolved, policy.excludeTools, this.#definitions);
  }

  async invoke(
    name: string,
    args: Readonly<Record<string, unknown>>,
    extra: unknown,
  ): Promise<CallToolResult> {
    if (this.#callableNames === undefined || !this.#callableNames.has(name)) {
      throw new TypeError(`tool ${name} is outside the effective surface`);
    }
    const definition = this.#definitions.get(name as PublicToolName);
    if (definition === undefined) throw new TypeError(`unknown tool ${name}`);
    const nativeInputSchema = definition.nativeInputSchema as ZodRawShapeCompat | AnySchema;
    const schema =
      normalizeObjectSchema(nativeInputSchema) ??
      (typeof nativeInputSchema === "object" &&
      nativeInputSchema !== null &&
      Object.keys(nativeInputSchema).length === 0
        ? objectFromShape(nativeInputSchema as ZodRawShapeCompat)
        : undefined);
    if (schema === undefined) throw new TypeError(`${name} has no input schema`);
    const parsed = await safeParseAsync(schema, args);
    if (!parsed.success) throw new TypeError(`${name} arguments failed validation`);
    const handler = definition.handler as (
      value: unknown,
      context: unknown,
    ) => CallToolResult | Promise<CallToolResult>;
    return await handler(parsed.data, extra);
  }
}

export class ResolvedToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  readonly names: ReadonlySet<string>;

  constructor(
    definitions: readonly ToolDefinition[],
    excluded: ReadonlySet<string>,
    allDefinitions: ReadonlyMap<PublicToolName, ToolDefinition>,
  ) {
    this.definitions = Object.freeze(
      definitions.map((definition) => {
        const nestedAuthority = Object.freeze(
          definition.nestedAuthority.filter((name) => !excluded.has(name)),
        );
        if (definition.nestedAuthority.length === 0) {
          return definition;
        }
        const nestedDefinitions = nestedAuthority.map((name) => {
          const nested = allDefinitions.get(name);
          if (nested === undefined) throw new TypeError(`unknown nested tool ${name}`);
          return nested;
        });
        const nestedEffects = (["observe", "change", "delete"] as const).filter((effect) =>
          nestedDefinitions.some((nested) => nested.tmuxEffects.includes(effect)),
        );
        const tmuxEffects = Object.freeze(
          nestedEffects.length === 0 ? (["observe"] as const) : nestedEffects,
        );
        const outputClasses = Object.freeze(
          (
            [
              "tmux-metadata",
              "terminal-content",
              "process-environment",
              "configured-command",
            ] as const
          ).filter((output) =>
            nestedDefinitions.some((nested) => nested.outputClasses.includes(output)),
          ),
        );
        return Object.freeze({
          ...definition,
          description: controlledDescription(
            { ...definition, nestedAuthority, outputClasses, tmuxEffects },
            definition.descriptionBody,
          ),
          nestedAuthority,
          outputClasses,
          tmuxEffects,
        });
      }),
    );
    this.names = new Set(this.definitions.map(({ name }) => name));
    Object.freeze(this.names);
    Object.freeze(this);
  }

  register(mcp: McpServer): void {
    for (const definition of this.definitions) {
      definition.register(mcp, definition);
    }
  }

  report(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      effectiveTools: Object.freeze(this.definitions.map(({ name }) => name)),
      tools: Object.freeze(this.definitions.map(capabilityRow)),
    });
  }
}

function capabilityRow(definition: ToolDefinition): Readonly<Record<string, unknown>> {
  const properties = definition.inputSchema.properties;
  const inputLiteralization = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.inputSinks)
        .filter(([, sinks]) => sinks.includes("tmux-format"))
        .map(([name]) => {
          const property =
            typeof properties === "object" && properties !== null && !Array.isArray(properties)
              ? (properties as Readonly<Record<string, unknown>>)[name]
              : undefined;
          const control =
            typeof property === "object" && property !== null && !Array.isArray(property)
              ? (property as Readonly<Record<string, unknown>>)[TMUX_FORMAT_SCHEMA_KEY]
              : undefined;
          return [
            name,
            control === TMUX_FORMAT_VALIDATED_VARIABLE
              ? TMUX_FORMAT_VALIDATED_VARIABLE
              : "double-hash-once",
          ];
        }),
    ),
  );
  return Object.freeze({
    amplifiesFutureInput: definition.amplifiesFutureInput,
    annotations: definition.annotations,
    description: definition.description,
    inputSchema: definition.inputSchema,
    inputLiteralization,
    mayExposeSecrets: definition.mayExposeSecrets,
    mayReturnUntrustedContent: definition.mayReturnUntrustedContent,
    name: definition.name,
    nestedAuthority: definition.nestedAuthority,
    outputClasses: definition.outputClasses,
    outputSchema: definition.outputSchema,
    processReach: definition.processReach,
    title: definition.title,
    tmuxEffects: definition.tmuxEffects,
    toolset: definition.toolset,
  });
}
