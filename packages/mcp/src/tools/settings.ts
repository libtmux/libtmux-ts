/**
 * Options, hooks, and environment.
 *
 * Hooks are readable but not writable here on purpose: a hook outlives the
 * process that set it, so an agent that sets one leaves behaviour behind in
 * somebody's tmux that nothing later will remove. Reading them explains a
 * server that is doing something unexpected, which is the case that comes up.
 */

import { z } from "zod";

import type { ToolContext } from "../context.js";
import { effectiveResultLines } from "../policy.js";
import { READ_ONLY, type ToolRegistrar } from "../register.js";
import { fail, limitEntries, ok, renderEntries } from "../results.js";
import { inlineRequestText, requestText } from "../schemas.js";
import { isFailure, requirePane, requireSession, requireWindow } from "../target_resolution.js";

/**
 * The six scopes tmux keeps options in.
 *
 * The two global ones hold most of them: a session that has set nothing
 * reports nothing, while the values actually governing it are the global
 * session defaults. `history-limit`, which decides how far a capture reaches
 * back, and `default-shell`, which decides what a new pane runs, are only
 * readable there.
 */
const SCOPES = ["server", "session", "global-session", "window", "global-window", "pane"] as const;

/** Whether a scope names one object, and so needs a target. */
function targeted(scope: (typeof SCOPES)[number]): boolean {
  return scope === "session" || scope === "window" || scope === "pane";
}

/**
 * Refuse a scope that names nothing.
 *
 * "" is a legal tmux session name, so using it as the absent-target sentinel
 * meant an untargeted call was a lookup that could succeed — against whichever
 * session happened to be called "". Every write it made went somewhere the
 * caller never named.
 */
function requireTarget(
  scope: (typeof SCOPES)[number],
  target: string | undefined,
): ReturnType<typeof fail> | undefined {
  if (!targeted(scope) || target !== undefined) return undefined;
  return fail({
    hint:
      `Name the ${scope}, or use global-${scope === "pane" ? "window" : scope} for the ` +
      `default every ${scope} inherits.`,
    reason: `${scope} scope needs a target: it says which ${scope} to act on.`,
  });
}

/** The three things every scope can do, whichever object holds it. */
interface OptionSite {
  set(name: string, value: string): Promise<void>;
  show(): Promise<ReadonlyMap<string, string>>;
  unset(name: string): Promise<void>;
}

/**
 * Resolve a scope to the thing that holds its options.
 *
 * One dispatch for reading, writing and unsetting, so a scope cannot be
 * offered by one and quietly fall through to another in the next.
 */
async function optionSite(
  context: ToolContext,
  scope: (typeof SCOPES)[number],
  target: string | undefined,
): Promise<ReturnType<typeof fail> | OptionSite> {
  if (scope === "server") {
    return {
      set: (name, value) => context.tmux.setOption(name, value),
      show: () => context.tmux.showOptions(),
      unset: (name) => context.tmux.unsetOption(name),
    };
  }
  if (scope === "global-session" || scope === "global-window") {
    const inner = scope === "global-session" ? "session" : "window";
    return {
      set: (name, value) => context.tmux.setGlobalOption(inner, name, value),
      show: () => context.tmux.showGlobalOptions(inner),
      unset: (name) => context.tmux.unsetGlobalOption(inner, name),
    };
  }
  const snapshot = await context.snapshot();
  const found =
    scope === "session"
      ? requireSession(snapshot, target ?? "")
      : scope === "window"
        ? requireWindow(snapshot, target ?? "")
        : requirePane(snapshot, target ?? "");
  if (isFailure(found)) return found;
  return {
    set: (name, value) => found.setOption(name, value),
    show: () => found.showOptions(),
    unset: (name) => found.unsetOption(name),
  };
}

export function registerSettings(mcp: ToolRegistrar, context: ToolContext): void {
  mcp.registerTool(
    "show_option",
    {
      annotations: READ_ONLY,
      description: "Read one named tmux option at server, session, window, or pane scope.",
      inputSchema: {
        name: inlineRequestText("name"),
        scope: z.enum(SCOPES).optional().describe("Default server."),
        target: requestText("target")
          .optional()
          .describe("Session id/name or pane id, for the matching scope."),
      },
      outputSchema: {
        name: z.string(),
        scope: z.string(),
        value: z.string().nullable(),
      },
      title: "Show option",
    },
    async ({ name, scope, target }) => {
      const chosen = scope ?? "server";
      const missing = requireTarget(chosen, target);
      if (missing !== undefined) return missing;
      const site = await optionSite(context, chosen, target);
      if (isFailure(site)) return site;
      const read = await site.show();
      const value = read.get(name) ?? null;
      return ok(
        { name, scope: chosen, value },
        value === null ? `${chosen} option ${name} is unset.` : `${name} ${value}`,
      );
    },
  );

  mcp.registerTool(
    "show_hooks",
    {
      annotations: READ_ONLY,
      description:
        "Read the hooks a server or session runs. Read-only: a hook set here would " +
        "outlive this process and keep firing in somebody's tmux. Put hooks a " +
        "server should keep in its config file.",
      inputSchema: {
        session: requestText("session")
          .optional()
          .describe("Session scope; omit for server scope."),
      },
      outputSchema: {
        complete: z.boolean(),
        hooks: z.record(z.string(), z.string()),
        omittedEntries: z.number().int(),
        unset: z
          .number()
          .int()
          .describe("Hook names tmux defines that carry no command, and so are not listed."),
      },
      title: "Show hooks",
    },
    async ({ session }) => {
      const snapshot = await context.snapshot();
      let read: ReadonlyMap<string, readonly string[]>;
      if (session === undefined) {
        read = await context.tmux.showHooks();
      } else {
        const found = requireSession(snapshot, session);
        if (isFailure(found)) return found;
        read = await found.showHooks();
      }
      // tmux reports its whole hook table, roughly a hundred names, nearly all
      // carrying nothing. The question a caller is asking is which hooks run,
      // and a wall of empty strings buries the handful that do.
      const configured = [...read]
        .filter(([, commands]) => commands.some((command) => command !== ""))
        .map(([name, commands]) => [name, commands.join("\n")] as const);
      const bounded = limitEntries(
        configured,
        effectiveResultLines(context.policy, undefined),
        ([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`,
        ([name, value]) => `${name} ${value}`,
      );
      const hooks = Object.fromEntries(bounded.entries);
      const unset = read.size - configured.length;
      return ok(
        {
          complete: bounded.complete,
          hooks,
          omittedEntries: bounded.omittedEntries,
          unset,
        },
        configured.length === 0
          ? `No hooks set. ${String(unset)} hook names exist and carry nothing.`
          : renderEntries(bounded, "hooks", "read one session scope at a time"),
      );
    },
  );

  mcp.registerTool(
    "show_environment",
    {
      annotations: READ_ONLY,
      description:
        "The environment tmux gives processes it starts, at server or session " +
        "scope. This is what a new pane will inherit, not what a running one has.",
      inputSchema: { session: requestText("session").optional() },
      outputSchema: {
        complete: z.boolean(),
        environment: z.record(z.string(), z.string().nullable()),
        omittedEntries: z.number().int(),
      },
      title: "Show environment",
    },
    async ({ session }) => {
      const snapshot = await context.snapshot();
      let read: ReadonlyMap<string, string | null>;
      if (session === undefined) {
        read = await context.tmux.showEnvironment();
      } else {
        const found = requireSession(snapshot, session);
        if (isFailure(found)) return found;
        read = await found.showEnvironment();
      }
      const bounded = limitEntries(
        [...read],
        effectiveResultLines(context.policy, undefined),
        ([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`,
        ([name, value]) => (value === null ? `-${name}` : `${name}=${value}`),
      );
      const environment = Object.fromEntries(bounded.entries);
      return ok(
        {
          complete: bounded.complete,
          environment,
          omittedEntries: bounded.omittedEntries,
        },
        renderEntries(bounded, "variables", "read one session scope at a time"),
      );
    },
  );
}
