/**
 * Options, hooks, environment, and buffers.
 *
 * Hooks are readable but not writable here on purpose: a hook outlives the
 * process that set it, so an agent that sets one leaves behaviour behind in
 * somebody's tmux that nothing later will remove. Reading them explains a
 * server that is doing something unexpected, which is the case that comes up.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  isFailure,
  requirePane,
  requireSession,
  requireWindow,
  requireWritablePane,
  type ToolContext,
} from "../context.js";
import { activeFramedCommand } from "../command.js";
import { effectiveResultLines, MAX_RESULT_BYTES } from "../policy.js";
import { MUTATING, offers, OPEN_WORLD, READ_ONLY } from "../register.js";
import { boundText, fail, ok, renderBoundedText, tailBytes, tailLines } from "../results.js";
import { paneIdSchema } from "../schemas.js";

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

interface EntryLimit<Entry> {
  readonly complete: boolean;
  readonly entries: readonly Entry[];
  readonly omittedEntries: number;
  readonly text: ReturnType<typeof boundText>;
}

/** Keep a truthful prefix that fits both the structured and text result ceilings. */
function limitEntries<Entry>(
  entries: readonly Entry[],
  lineLimit: number,
  serialize: (entry: Entry) => string,
  render: (entry: Entry) => string,
): EntryLimit<Entry> {
  const kept: Entry[] = [];
  const lines: string[] = [];
  let structuredBytes = 2;
  let textBytes = 0;

  for (const entry of entries) {
    const renderedText = render(entry);
    const rendered = renderedText.split("\n");
    const serialized = serialize(entry);
    const nextStructured =
      structuredBytes + Buffer.byteLength(serialized, "utf8") + (kept.length === 0 ? 0 : 1);
    const nextTextBytes =
      textBytes + Buffer.byteLength(renderedText, "utf8") + (lines.length === 0 ? 0 : 1);
    if (
      nextStructured > MAX_RESULT_BYTES ||
      lines.length + rendered.length > lineLimit ||
      nextTextBytes > MAX_RESULT_BYTES
    ) {
      break;
    }
    kept.push(entry);
    lines.push(...rendered);
    structuredBytes = nextStructured;
    textBytes = nextTextBytes;
  }

  return {
    complete: kept.length === entries.length,
    entries: kept,
    omittedEntries: entries.length - kept.length,
    text: boundText(lines, lineLimit, MAX_RESULT_BYTES),
  };
}

function renderEntries(result: EntryLimit<unknown>, noun: string, recovery: string): string {
  const omission =
    result.omittedEntries === 0
      ? ""
      : `[${String(result.omittedEntries)} later ${noun} omitted; ${recovery}]`;
  return [renderBoundedText(result.text, recovery), omission]
    .filter((part) => part !== "")
    .join("\n");
}

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

interface StagedBuffer {
  readonly bytes: Uint8Array | undefined;
  readonly totalBytes: number;
}

/** Let tmux write a buffer to disk, then bring at most one bounded copy into memory. */
async function stageBuffer(context: ToolContext, name: string): Promise<StagedBuffer> {
  const directory = await mkdtemp(join(tmpdir(), "ltx-mcp-buffer-"));
  const path = join(directory, "buffer");
  try {
    await context.tmux.saveBuffer(name, path);
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("tmux did not write a regular file");
      if (before.size > MAX_RESULT_BYTES) {
        return { bytes: undefined, totalBytes: before.size };
      }

      const bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        // eslint-disable-next-line no-await-in-loop -- one bounded file read.
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== before.size || offset !== before.size) {
        throw new Error("buffer changed while its saved copy was being read");
      }
      return { bytes, totalBytes: before.size };
    } finally {
      await handle.close();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
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
        target: z
          .string()
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
        session: z.string().optional().describe("Session scope; omit for server scope."),
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
      inputSchema: { session: z.string().optional() },
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

  mcp.registerTool(
    "list_buffers",
    {
      annotations: READ_ONLY,
      description:
        "Names of the paste buffers this server holds. Contents are not listed: a " +
        "tmux buffer stack carries whatever a person copied, which may be anything.",
      inputSchema: {},
      outputSchema: {
        buffers: z.array(z.string()),
        complete: z.boolean(),
        omittedEntries: z.number().int(),
      },
      title: "List buffers",
    },
    async () => {
      const buffers = await context.tmux.listBuffers();
      const bounded = limitEntries(
        buffers,
        effectiveResultLines(context.policy, undefined),
        (name) => JSON.stringify(name),
        (name) => name,
      );
      return ok(
        {
          buffers: bounded.entries,
          complete: bounded.complete,
          omittedEntries: bounded.omittedEntries,
        },
        buffers.length === 0
          ? "No buffers."
          : renderEntries(bounded, "buffers", "remove unused buffers before listing again"),
      );
    },
  );

  mcp.registerTool(
    "show_buffer",
    {
      annotations: READ_ONLY,
      description:
        "Read one paste buffer by name. Large buffers return their size without " +
        "reading the contents; use save_buffer to keep those outside the response.",
      inputSchema: {
        maxLines: z.number().int().positive().optional(),
        name: z.string(),
      },
      outputSchema: {
        droppedLines: z.number().int(),
        name: z.string(),
        omittedBytes: z.number().int(),
        returnedBytes: z.number().int(),
        text: z.string(),
        totalBytes: z.number().int(),
        truncated: z.boolean(),
      },
      title: "Show buffer",
    },
    async ({ maxLines, name }) => {
      try {
        const staged = await stageBuffer(context, name);
        if (staged.bytes === undefined) {
          return ok(
            {
              droppedLines: 0,
              name,
              omittedBytes: staged.totalBytes,
              returnedBytes: 0,
              text: "",
              totalBytes: staged.totalBytes,
              truncated: true,
            },
            `Buffer ${name} is ${String(staged.totalBytes)} bytes; no content was read because the result ceiling is ${String(MAX_RESULT_BYTES)} bytes. Use save_buffer to write it outside the response.`,
          );
        }

        const lines = new TextDecoder().decode(staged.bytes).split("\n");
        const trimmed = tailLines(lines, effectiveResultLines(context.policy, maxLines));
        const byteTrimmed = tailBytes(trimmed.lines.join("\n"), MAX_RESULT_BYTES);
        const returnedBytes = Buffer.byteLength(byteTrimmed.text, "utf8");
        const omittedBytes = Math.max(
          byteTrimmed.droppedBytes,
          staged.totalBytes - returnedBytes,
          0,
        );
        const truncated = trimmed.droppedLines > 0 || omittedBytes > 0;
        const recovery = "raise maxLines within the server limit or use save_buffer for all of it";
        const lineNotice =
          trimmed.droppedLines === 0
            ? ""
            : `[${String(trimmed.droppedLines)} earlier lines omitted; ${recovery}]`;
        const byteNotice =
          byteTrimmed.droppedBytes === 0
            ? ""
            : `[${String(byteTrimmed.droppedBytes)} earlier bytes omitted; ${recovery}]`;
        const text = [lineNotice, byteNotice, byteTrimmed.text]
          .filter((part) => part !== "")
          .join("\n");
        return ok(
          {
            droppedLines: trimmed.droppedLines,
            name,
            omittedBytes,
            returnedBytes,
            text: byteTrimmed.text,
            totalBytes: staged.totalBytes,
            truncated,
          },
          text,
        );
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
      // tmux drops an empty `set-buffer` silently: it exits zero and creates
      // nothing. Reporting a load would name a buffer that does not exist, and
      // the caller would find out one call later against `paste_buffer`.
      if (text === "") {
        return fail({
          hint: "Write at least one byte, or skip the load when the content is empty.",
          reason: `tmux stores no buffer for empty text, so ${name} was not created.`,
        });
      }
      await context.tmux.loadBuffer(name, text);
      const bytes = Buffer.byteLength(text, "utf8");
      return ok({ bytes, name }, `Loaded ${String(bytes)} bytes into buffer ${name}.`);
    },
  );

  mcp.registerTool(
    "paste_buffer",
    {
      annotations: OPEN_WORLD,
      description: "Paste a named buffer into a pane.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Write even to this server's pane or one a person is watching. Default false."),
        name: z.string(),
        paneId: paneIdSchema,
      },
      outputSchema: { name: z.string(), paneId: paneIdSchema },
      title: "Paste buffer",
    },
    async ({ force, name, paneId }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requireWritablePane(snapshot, identity, paneId, force, "paste into");
      if (isFailure(pane)) return pane;
      const active = activeFramedCommand(context, paneId);
      if (active !== undefined && force !== true) {
        return fail({
          hint: "Wait for that command to finish, or pass force to accept interleaved input.",
          reason: `Refusing to paste into ${paneId}: run_command ${active} is still active.`,
        });
      }
      await pane.pasteBuffer(name);
      return ok({ name, paneId }, `Pasted buffer ${name} into ${paneId}.`);
    },
  );

  mcp.registerTool(
    "save_buffer",
    {
      annotations: OPEN_WORLD,
      description:
        "Write a buffer to a file instead of reading it back. show_buffer returns " +
        "the contents, which for anything large means spending your context on " +
        "bytes you only want stored. tmux writes the file itself, on the machine " +
        "tmux runs on. An existing file is replaced unless append is set.",
      inputSchema: {
        append: z.boolean().optional().describe("Add to the file rather than replacing it."),
        name: z.string(),
        path: z.string().describe("Where tmux writes it, on tmux's own machine."),
      },
      outputSchema: { name: z.string(), path: z.string() },
      title: "Save buffer to a file",
    },
    async ({ append, name, path }) => {
      await context.tmux.saveBuffer(name, path, append === undefined ? {} : { append });
      return ok({ name, path }, `Wrote buffer ${name} to ${path}.`);
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
