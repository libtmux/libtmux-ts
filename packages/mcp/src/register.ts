/**
 * How a tool declares what it costs a caller to be wrong about it.
 *
 * MCP annotations are how a host decides what to auto-approve, and the safety
 * tier is how an operator decides what to offer at all. Both are properties of
 * the tool rather than of the call, so they are declared once beside it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { tierAllows, type Policy, type SafetyTier } from "./policy.js";

/** Reads state, changes nothing, and can be called again for free. */
export const READ_ONLY: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

/** Changes tmux state, but nothing a later call cannot put back. */
export const MUTATING: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

/** Ends something: a session, a window, a pane, a process. */
export const DESTRUCTIVE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

/**
 * Creates something, and may run a command whose effect is outside tmux.
 *
 * A spawn given a `shellCommand` does whatever that command does, which is as
 * unknowable from here as what `send_keys` types — and `openWorldHint` is the
 * only channel carrying that, since every one of these is legitimately
 * `mutating` and the tier cannot separate them. It is not destructive: these
 * create rather than end, and a host deciding what to approve needs the two
 * answers apart.
 */
export const MUTATING_OPEN_WORLD: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
};

/**
 * Runs something whose effect is outside tmux.
 *
 * `send_keys` types into a shell, so what it does is whatever that shell does —
 * unknowable from here, which is what `openWorldHint` says.
 */
export const OPEN_WORLD: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
};

export function offers(policy: Policy, tier: SafetyTier): boolean {
  return tierAllows(policy.safety, tier);
}

/**
 * The server the tool modules register against, filtered by the allowlist.
 *
 * Wrapped once here rather than checked in each module: a tool that forgot the
 * check would be offered anyway, and "the allowlist covers every tool" is not
 * something a reviewer can see by reading one file. A tool that is not listed
 * is never registered, so it is not merely refused — an agent cannot spend a
 * turn discovering it.
 */
export function offeredTools(mcp: McpServer, policy: Policy): McpServer {
  const allowed = policy.tools;
  if (allowed === undefined) return mcp;
  /**
   * Call the real registration only for a listed name.
   *
   * The method is read off its owner inside the call and invoked on it, so it
   * stays bound to the object the SDK expects `this` to be.
   */
  const filtered =
    (owner: object, method: string) =>
    (name: string, ...rest: readonly unknown[]): unknown => {
      if (!allowed.has(name)) return undefined;
      const register = Reflect.get(owner, method) as (...args: readonly unknown[]) => unknown;
      return register.call(owner, name, ...rest);
    };

  return new Proxy(mcp, {
    get(target, property, receiver): unknown {
      if (property === "registerTool") return filtered(target, "registerTool");
      // A task tool registers through its own object, so filtering only
      // `registerTool` would leave `wait_for_text_task` offered by a server
      // that was told not to.
      if (property === "experimental") {
        const experimental = target.experimental;
        const tasks = experimental.tasks;
        return {
          ...experimental,
          tasks: new Proxy(tasks, {
            get(taskTarget, taskProperty, taskReceiver): unknown {
              if (taskProperty !== "registerToolTask") {
                return Reflect.get(taskTarget, taskProperty, taskReceiver) as unknown;
              }
              return filtered(taskTarget, "registerToolTask");
            },
          }),
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}
