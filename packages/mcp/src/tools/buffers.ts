import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { activeFramedCommand } from "../command.js";
import type { ToolContext } from "../context.js";
import { effectiveResultLines, MAX_INLINE_REQUEST_BYTES, MAX_RESULT_BYTES } from "../policy.js";
import { MUTATING, offers, OPEN_WORLD, READ_ONLY } from "../register.js";
import { fail, limitEntries, ok, renderEntries, tailBytes, tailLines } from "../results.js";
import { fitsInlineRequest, inlineRequestText, paneIdSchema, requestText } from "../schemas.js";
import { isFailure, requireWritablePane } from "../target_resolution.js";

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

export function registerBuffers(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "readonly")) return;

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
        "reading the contents; save_buffer requires the mutating tier and keeps " +
        "those outside the response.",
      inputSchema: {
        maxLines: z.number().int().positive().optional(),
        name: inlineRequestText("name"),
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
            `Buffer ${name} is ${String(staged.totalBytes)} bytes; no content was read because the result ceiling is ${String(MAX_RESULT_BYTES)} bytes. Use save_buffer to write it outside the response; save_buffer requires the mutating tier.`,
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
        const recovery =
          "raise maxLines within the server limit or use save_buffer for all of it; " +
          "save_buffer requires the mutating tier";
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
    "load_buffer",
    {
      annotations: MUTATING,
      description:
        "Put text into a named paste buffer, ready for paste_buffer. Use this for " +
        "content too large or too awkward to type with send_keys.",
      inputSchema: {
        name: inlineRequestText("name"),
        text: requestText("text"),
      },
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
        name: inlineRequestText("name"),
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
      inputSchema: z
        .object({
          append: z.boolean().optional().describe("Add to the file rather than replacing it."),
          name: inlineRequestText("name"),
          path: inlineRequestText("path").describe("Where tmux writes it, on tmux's own machine."),
        })
        .refine(({ name, path }) => fitsInlineRequest([name, path]), {
          message: `save_buffer text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
        }),
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
      inputSchema: { name: inlineRequestText("name") },
      outputSchema: { name: z.string() },
      title: "Delete buffer",
    },
    async ({ name }) => {
      await context.tmux.deleteBuffer(name);
      return ok({ name }, `Deleted buffer ${name}.`);
    },
  );
}
