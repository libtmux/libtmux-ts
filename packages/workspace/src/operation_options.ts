import type { PrunePolicy } from "./ownership.js";

/**
 * When a pane's `shell_command` entries are sent to it.
 *
 * `create-only`, the default, sends them only to panes this apply created.
 * `always` sends them to every pane on every apply.
 */
export type CommandPolicy = "always" | "create-only";

/** How `applyWorkspace` should treat a workspace that is already running. */
export interface ApplyWorkspaceOptions {
  readonly commands?: CommandPolicy;
  /** How this apply treats undescribed topology; `always` does not claim ownership. */
  readonly prune?: PrunePolicy;
}

/** Structural planning options; pane command delivery is apply-only. */
export interface PlanWorkspaceOptions {
  /** How this plan treats undescribed topology; `always` does not claim ownership. */
  readonly prune?: PrunePolicy;
}

/** Validate and snapshot apply options before server access. */
export function normalizeApplyWorkspaceOptions(options: ApplyWorkspaceOptions): {
  readonly commands: CommandPolicy;
  readonly prune: PrunePolicy;
} {
  assertOptionBag(options, "applyWorkspace");
  for (const name of Reflect.ownKeys(options)) {
    if (name !== "commands" && name !== "prune") {
      throw new TypeError(`applyWorkspace does not accept option ${String(name)}`);
    }
  }
  const commands = Object.hasOwn(options, "commands") ? options.commands : undefined;
  const prune = Object.hasOwn(options, "prune") ? options.prune : undefined;
  return { commands: commandPolicy(commands), prune: prunePolicy(prune) };
}

/** Validate and snapshot planning options before server access. */
export function normalizePlanWorkspaceOptions(options: PlanWorkspaceOptions): PrunePolicy {
  assertOptionBag(options, "planWorkspace");
  if (Object.hasOwn(options, "commands")) {
    throw new TypeError("planWorkspace does not plan pane command delivery");
  }
  for (const name of Reflect.ownKeys(options)) {
    if (name !== "prune") {
      throw new TypeError(`planWorkspace does not accept option ${String(name)}`);
    }
  }
  const prune = Object.hasOwn(options, "prune") ? options.prune : undefined;
  return prunePolicy(prune);
}

function assertOptionBag(value: unknown, method: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${method} options must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${method} options must be a plain object`);
  }
}

function commandPolicy(value: unknown): CommandPolicy {
  if (value !== undefined && value !== "always" && value !== "create-only") {
    throw new TypeError('workspace commands must be "always" or "create-only"');
  }
  return value ?? "create-only";
}

function prunePolicy(value: unknown): PrunePolicy {
  if (value !== undefined && value !== "always" && value !== "never" && value !== "owned") {
    throw new TypeError('workspace prune must be "always", "never", or "owned"');
  }
  return value ?? "owned";
}
