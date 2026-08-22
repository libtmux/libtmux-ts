/**
 * Options, hooks, environment, and buffers.
 *
 * Hooks are readable but not writable here on purpose: a hook outlives the
 * process that set it, so an agent that sets one leaves behaviour behind in
 * somebody's tmux that nothing later will remove. Reading them explains a
 * server that is doing something unexpected, which is the case that comes up.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  isFailure,
  requirePane,
  requireSession,
  requireWritablePane,
  type ToolContext,
} from "../context.js";
import { MUTATING, offers, READ_ONLY } from "../register.js";
import { fail, ok } from "../results.js";

const SCOPES = ["server", "session", "pane"] as const;

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
  if (scope === "server" || target !== undefined) return undefined;
  return fail({
    hint:
      scope === "session"
        ? "Name the session, or leave scope off to reach the server's own options."
        : "Name the pane, or leave scope off to reach the server's own options.",
    reason: `${scope} scope needs a target: it says which ${scope} to act on.`,
  });
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
        target: z
          .string()
          .optional()
          .describe("Session id/name or pane id, for the matching scope."),
      },
      outputSchema: { options: z.record(z.string(), z.string()), scope: z.string() },
      title: "Show options",
    },
    async ({ scope, target }) => {
      const chosen = scope ?? "server";
      const missing = requireTarget(chosen, target);
      if (missing !== undefined) return missing;
      const snapshot = await context.snapshot();
      let read: ReadonlyMap<string, string>;
      if (chosen === "server") {
        read = await context.tmux.showOptions();
      } else if (chosen === "session") {
        const found = requireSession(snapshot, target ?? "");
        if (isFailure(found)) return found;
        read = await found.showOptions();
      } else {
        const pane = requirePane(snapshot, target ?? "");
        if (isFailure(pane)) return pane;
        read = await pane.showOptions();
      }
      const options = Object.fromEntries(read);
      return ok(
        { options, scope: chosen },
        Object.entries(options)
          .map(([name, value]) => `${name} ${value}`)
          .join("\n"),
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
        session: z.string().optional().describe("Session scope; omit for server scope."),
      },
      outputSchema: { hooks: z.record(z.string(), z.string()) },
      title: "Show hooks",
    },
    async ({ session }) => {
      const snapshot = await context.snapshot();
      let read: ReadonlyMap<string, string>;
      if (session === undefined) {
        read = await context.tmux.showHooks();
      } else {
        const found = requireSession(snapshot, session);
        if (isFailure(found)) return found;
        read = await found.showHooks();
      }
      const hooks = Object.fromEntries(read);
      return ok(
        { hooks },
        Object.keys(hooks).length === 0
          ? "No hooks set."
          : Object.entries(hooks)
              .map(([name, value]) => `${name} ${value}`)
              .join("\n"),
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
      inputSchema: { session: z.string().optional() },
      outputSchema: { environment: z.record(z.string(), z.string().nullable()) },
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
      const environment = Object.fromEntries(read);
      return ok(
        { environment },
        Object.entries(environment)
          .map(([name, value]) => (value === null ? `-${name}` : `${name}=${value}`))
          .join("\n"),
      );
    },
  );

  mcp.registerTool(
    "list_buffers",
    {
      annotations: READ_ONLY,
      description:
        "Names of the paste buffers this server holds. Contents are not listed: a " +
        "tmux buffer stack carries whatever a person copied, which may be anything.",
      inputSchema: {},
      outputSchema: { buffers: z.array(z.string()) },
      title: "List buffers",
    },
    async () => {
      const buffers = await context.tmux.listBuffers();
      return ok(
        { buffers: [...buffers] },
        buffers.length === 0 ? "No buffers." : buffers.join("\n"),
      );
    },
  );

  mcp.registerTool(
    "show_buffer",
    {
      annotations: READ_ONLY,
      description: "Read one paste buffer by name.",
      inputSchema: { name: z.string() },
      outputSchema: { name: z.string(), text: z.string() },
      title: "Show buffer",
    },
    async ({ name }) => {
      try {
        const lines = await context.tmux.showBuffer(name);
        const text = lines.join("\n");
        return ok({ name, text }, text);
      } catch (error) {
        return fail({
          hint: "list_buffers shows which names exist.",
          reason: `Could not read buffer ${name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  );

  if (!offers(context.policy, "mutating")) return;

  mcp.registerTool(
    "set_option",
    {
      annotations: MUTATING,
      description:
        "Set a tmux option at server, session, or pane scope. Changes stay until " +
        "something unsets them, including after this process ends.",
      inputSchema: {
        name: z.string(),
        scope: z.enum(SCOPES).optional().describe("Default server."),
        target: z.string().optional(),
        value: z.string(),
      },
      outputSchema: { name: z.string(), scope: z.string(), value: z.string() },
      title: "Set option",
    },
    async ({ name, scope, target, value }) => {
      const chosen = scope ?? "server";
      const missing = requireTarget(chosen, target);
      if (missing !== undefined) return missing;
      const snapshot = await context.snapshot();
      if (chosen === "server") {
        await context.tmux.setOption(name, value);
      } else if (chosen === "session") {
        const found = requireSession(snapshot, target ?? "");
        if (isFailure(found)) return found;
        await found.setOption(name, value);
      } else {
        const pane = requirePane(snapshot, target ?? "");
        if (isFailure(pane)) return pane;
        await pane.setOption(name, value);
      }
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
        name: z.string(),
        scope: z.enum(SCOPES).optional().describe("Default server."),
        target: z
          .string()
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
      const snapshot = await context.snapshot();
      if (chosen === "server") {
        await context.tmux.unsetOption(name);
      } else if (chosen === "session") {
        const found = requireSession(snapshot, target ?? "");
        if (isFailure(found)) return found;
        await found.unsetOption(name);
      } else {
        const pane = requirePane(snapshot, target ?? "");
        if (isFailure(pane)) return pane;
        await pane.unsetOption(name);
      }
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
      inputSchema: {
        name: z.string(),
        session: z.string().optional().describe("Session scope; omit for server scope."),
        value: z.string(),
      },
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

  mcp.registerTool(
    "load_buffer",
    {
      annotations: MUTATING,
      description:
        "Put text into a named paste buffer, ready for paste_buffer. Use this for " +
        "content too large or too awkward to type with send_keys.",
      inputSchema: { name: z.string(), text: z.string() },
      outputSchema: { bytes: z.number().int(), name: z.string() },
      title: "Load buffer",
    },
    async ({ name, text }) => {
      await context.tmux.loadBuffer(name, text);
      const bytes = Buffer.byteLength(text, "utf8");
      return ok({ bytes, name }, `Loaded ${String(bytes)} bytes into buffer ${name}.`);
    },
  );

  mcp.registerTool(
    "paste_buffer",
    {
      annotations: MUTATING,
      description: "Paste a named buffer into a pane.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Write even to the pane this server runs in. Default false."),
        name: z.string(),
        paneId: z.string(),
      },
      outputSchema: { name: z.string(), paneId: z.string() },
      title: "Paste buffer",
    },
    async ({ force, name, paneId }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requireWritablePane(snapshot, identity, paneId, force, "paste into");
      if (isFailure(pane)) return pane;
      await pane.pasteBuffer(name);
      return ok({ name, paneId }, `Pasted buffer ${name} into ${paneId}.`);
    },
  );

  mcp.registerTool(
    "delete_buffer",
    {
      annotations: MUTATING,
      description: "Discard a named paste buffer.",
      inputSchema: { name: z.string() },
      outputSchema: { name: z.string() },
      title: "Delete buffer",
    },
    async ({ name }) => {
      await context.tmux.deleteBuffer(name);
      return ok({ name }, `Deleted buffer ${name}.`);
    },
  );
}
