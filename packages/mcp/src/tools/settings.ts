/**
 * Options, hooks, and environment.
 *
 * Hooks are readable but not writable here on purpose: a hook outlives the
 * process that set it, so an agent that sets one leaves behaviour behind in
 * somebody's tmux that nothing later will remove. Reading them explains a
 * server that is doing something unexpected, which is the case that comes up.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { effectiveResultLines, MAX_INLINE_REQUEST_BYTES } from "../policy.js";
import { MUTATING, offers, OPEN_WORLD, READ_ONLY } from "../register.js";
import { fail, limitEntries, ok, renderEntries } from "../results.js";
import { fitsInlineRequest, inlineRequestText, requestText } from "../schemas.js";
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

export function registerSettings(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "readonly")) return;

  mcp.registerTool(
    "show_options",
    {
      annotations: READ_ONLY,
      description: "Read tmux options at server, session, or pane scope.",
      inputSchema: {
        scope: z.enum(SCOPES).optional().describe("Default server."),
        target: requestText("target")
          .optional()
          .describe("Session id/name or pane id, for the matching scope."),
      },
      outputSchema: {
        complete: z.boolean(),
        omittedEntries: z.number().int(),
        options: z.record(z.string(), z.string()),
        scope: z.string(),
      },
      title: "Show options",
    },
    async ({ scope, target }) => {
      const chosen = scope ?? "server";
      const missing = requireTarget(chosen, target);
      if (missing !== undefined) return missing;
      const site = await optionSite(context, chosen, target);
      if (isFailure(site)) return site;
      const read = await site.show();
      const bounded = limitEntries(
        [...read],
        effectiveResultLines(context.policy, undefined),
        ([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`,
        ([name, value]) => `${name} ${value}`,
      );
      const options = Object.fromEntries(bounded.entries);
      return ok(
        {
          complete: bounded.complete,
          omittedEntries: bounded.omittedEntries,
          options,
          scope: chosen,
        },
        renderEntries(bounded, "options", "narrow the scope before reading again"),
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

  if (!offers(context.policy, "mutating")) return;

  mcp.registerTool(
    "set_option",
    {
      annotations: OPEN_WORLD,
      description:
        "Set a tmux option at server, session, or pane scope. Changes stay until " +
        "something unsets them, including after this process ends. Format-valued " +
        "options such as status-right may contain #() jobs that run host shell commands.",
      inputSchema: z
        .object({
          name: inlineRequestText("name"),
          scope: z.enum(SCOPES).optional().describe("Default server."),
          target: requestText("target").optional(),
          value: inlineRequestText("value"),
        })
        .refine(({ name, value }) => fitsInlineRequest([name, value]), {
          message: `set_option text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
        }),
      outputSchema: { name: z.string(), scope: z.string(), value: z.string() },
      title: "Set option",
    },
    async ({ name, scope, target, value }) => {
      const chosen = scope ?? "server";
      const missing = requireTarget(chosen, target);
      if (missing !== undefined) return missing;
      const site = await optionSite(context, chosen, target);
      if (isFailure(site)) return site;
      await site.set(name, value);
      return ok({ name, scope: chosen, value }, `Set ${chosen} option ${name} to ${value}.`);
    },
  );

  mcp.registerTool(
    "unset_option",
    {
      annotations: MUTATING,
      description:
        "Remove one tmux option at a scope, so it falls back to the value it " +
        "inherits. This is how a set_option is undone: without it a wrong value " +
        "set from here could not be taken back from here.",
      inputSchema: {
        name: inlineRequestText("name"),
        scope: z.enum(SCOPES).optional().describe("Default server."),
        target: requestText("target")
          .optional()
          .describe("Session id/name or pane id, required for those scopes."),
      },
      outputSchema: { name: z.string(), scope: z.string() },
      title: "Unset option",
    },
    async ({ name, scope, target }) => {
      const chosen = scope ?? "server";
      const missing = requireTarget(chosen, target);
      if (missing !== undefined) return missing;
      const site = await optionSite(context, chosen, target);
      if (isFailure(site)) return site;
      await site.unset(name);
      return ok({ name, scope: chosen }, `Unset ${chosen} option ${name}; it now inherits.`);
    },
  );

  mcp.registerTool(
    "set_environment",
    {
      annotations: MUTATING,
      description:
        "Set a variable in tmux's environment. Affects processes tmux starts after " +
        "this, not ones already running.",
      inputSchema: z
        .object({
          name: inlineRequestText("name"),
          session: requestText("session")
            .optional()
            .describe("Session scope; omit for server scope."),
          value: inlineRequestText("value"),
        })
        .refine(({ name, value }) => fitsInlineRequest([name, value]), {
          message: `set_environment text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
        }),
      outputSchema: { name: z.string(), scope: z.string() },
      title: "Set environment",
    },
    async ({ name, session, value }) => {
      const snapshot = await context.snapshot();
      if (session === undefined) {
        await context.tmux.setEnvironment(name, value);
      } else {
        const found = requireSession(snapshot, session);
        if (isFailure(found)) return found;
        await found.setEnvironment(name, value);
      }
      return ok(
        { name, scope: session === undefined ? "server" : "session" },
        `Set ${name} for new processes.`,
      );
    },
  );
}
