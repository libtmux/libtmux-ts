import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ServerSnapshot } from "libtmux";

import type { ToolContext } from "../context.js";
import {
  effectiveResultLines,
  effectiveWaitMs,
  MAX_REQUEST_ITEMS,
  MAX_RESULT_BYTES,
} from "../policy.js";
import {
  MUTATING,
  OPEN_WORLD,
  READ_BATCH_TOOLS,
  READ_ONLY,
  type ToolRegistry,
} from "../register.js";
import { boundText, fail, ok, renderBoundedText } from "../results.js";
import {
  inlineRequestText,
  paneIdSchema,
  requestText,
  TMUX_FORMAT_SCHEMA_KEY,
  TMUX_FORMAT_VALIDATED_VARIABLE,
  windowIdSchema,
} from "../schemas.js";
import {
  isFailure,
  panePlacements,
  requirePane,
  resolvedPaneInputTargetIds,
  requireSession,
  requireWindow,
  requireWritablePane,
  windowPlacements,
} from "../target_resolution.js";
import {
  paneLine,
  paneView,
  paneViewSchema,
  sessionView,
  sessionViewSchema,
  windowLine,
  windowView,
  windowViewSchema,
} from "../views.js";

const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
const nestedToolResultSchema = z
  .object({
    content: z.array(z.unknown()),
    isError: z.boolean().optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

interface ReadBatchResult {
  readonly error: string | null;
  readonly index: number;
  result: CallToolResult | null;
  resultTruncated: boolean;
  readonly success: boolean;
  readonly tool: string;
}

interface ReadBatchOperation {
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
  readonly tool: (typeof READ_BATCH_TOOLS)[number];
}

export type ReadBatchAnswer = {
  readonly failed: number;
  readonly onError: "stop" | "continue";
  readonly results: readonly ReadBatchResult[];
  readonly stoppedAt: number | null;
  readonly succeeded: number;
  readonly truncated: boolean;
  readonly truncatedBytes: number;
};

function readBatchSummary(answer: ReadBatchAnswer): string {
  return `Completed ${String(answer.succeeded + answer.failed)} inspect calls: ${String(answer.succeeded)} succeeded and ${String(answer.failed)} failed.`;
}

export function readBatchWireBytes(
  answer: ReadBatchAnswer,
  requestId: RequestHandlerExtra<ServerRequest, ServerNotification>["requestId"],
): number {
  const response = {
    id: requestId,
    jsonrpc: "2.0",
    result: ok(answer, readBatchSummary(answer)),
  };
  return Buffer.byteLength(JSON.stringify(response), "utf8") + 1;
}

export class ReadBatchAccumulator {
  readonly #maximumBytes: number;
  readonly #results: ReadBatchResult[] = [];
  #stoppedAt: number | null = null;

  constructor(_total: number, maximumBytes = MAX_RESULT_BYTES) {
    this.#maximumBytes = maximumBytes;
  }

  append(entry: Pick<ReadBatchResult, "result" | "tool">): boolean {
    const result = entry.result;
    const success = result !== null && result.isError !== true;
    this.#results.push({
      error: success ? null : this.#errorText(result),
      index: this.#results.length,
      result,
      resultTruncated: false,
      success,
      tool: entry.tool,
    });
    return true;
  }

  stopAt(index: number): void {
    this.#stoppedAt = index;
  }

  finish(
    onError: "stop" | "continue" = "stop",
    measure: (answer: ReadBatchAnswer) => number = (answer) => this.#bytes(answer),
  ): ReadBatchAnswer {
    const succeeded = this.#results.filter(({ success }) => success).length;
    const failed = this.#results.length - succeeded;
    let truncatedBytes = 0;
    let answer = this.#answer(onError, succeeded, failed, false, truncatedBytes);
    for (const row of this.#results) {
      if (measure(answer) <= this.#maximumBytes) break;
      if (row.result === null) continue;
      const before = Buffer.byteLength(JSON.stringify(row.result), "utf8");
      row.result = null;
      row.resultTruncated = true;
      truncatedBytes += before - 4;
      answer = this.#answer(onError, succeeded, failed, true, truncatedBytes);
    }
    if (measure(answer) > this.#maximumBytes) {
      throw new TypeError("read batch metadata exceeds the result ceiling");
    }
    return answer;
  }

  #answer(
    onError: "stop" | "continue",
    succeeded: number,
    failed: number,
    truncated: boolean,
    truncatedBytes: number,
  ): ReadBatchAnswer {
    return {
      failed,
      onError,
      results: this.#results,
      stoppedAt: this.#stoppedAt,
      succeeded,
      truncated,
      truncatedBytes,
    };
  }

  #bytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }

  #errorText(result: CallToolResult | null): string {
    if (result === null) return "nested tool returned no result";
    const text = result.content
      .filter((content) => content.type === "text")
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n");
    return text === "" ? "nested tool returned an error" : text;
  }
}

function projectedPane(snapshot: ServerSnapshot, paneId: string, context: ToolContext) {
  const pane = requirePane(snapshot, paneId);
  if (isFailure(pane)) return pane;
  return context
    .identity(snapshot)
    .then((identity) => paneView(pane, identity, panePlacements(snapshot, paneId)));
}

export function registerTargetTools(registry: ToolRegistry, context: ToolContext): void {
  registry.registerTool(
    "get_session_info",
    {
      annotations: READ_ONLY,
      description: "Return metadata for one session without listing every session.",
      inputSchema: { session: requestText("session") },
      outputSchema: { session: sessionViewSchema },
      title: "Get session info",
    },
    async ({ session }) => {
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      const view = sessionView(
        found,
        snapshot.windows.count({ session: { is: { id: found.id } } }),
      );
      return ok(
        { session: view },
        `${view.name} (${view.id}) has ${String(view.windows)} windows.`,
      );
    },
  );

  registry.registerTool(
    "get_window_info",
    {
      annotations: READ_ONLY,
      description: "Return metadata and placements for one window.",
      inputSchema: { windowId: windowIdSchema },
      outputSchema: { window: windowViewSchema },
      title: "Get window info",
    },
    async ({ windowId }) => {
      const snapshot = await context.snapshot();
      const found = requireWindow(snapshot, windowId);
      if (isFailure(found)) return found;
      const view = windowView(found, windowPlacements(snapshot, windowId));
      return ok({ window: view }, windowLine(view));
    },
  );

  registry.registerTool(
    "find_pane_by_position",
    {
      annotations: READ_ONLY,
      description: "Find the pane occupying a named corner of a window.",
      inputSchema: { corner: z.enum(CORNERS), windowId: windowIdSchema },
      outputSchema: { pane: paneViewSchema },
      title: "Find pane by position",
    },
    async ({ corner, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      const panes = snapshot.panes.toArray().filter((pane) => pane.format.window_id === window.id);
      const found = panes.find((pane) => {
        if (corner === "top-left") return pane.atTop && pane.atLeft;
        if (corner === "top-right") return pane.atTop && pane.atRight;
        if (corner === "bottom-left") return pane.atBottom && pane.atLeft;
        return pane.atBottom && pane.atRight;
      });
      if (found === undefined)
        return fail({ reason: `No pane occupies ${corner} in ${windowId}.` });
      const view = await projectedPane(snapshot, found.id, context);
      if (isFailure(view)) return view;
      return ok({ pane: view }, paneLine(view));
    },
  );

  registry.registerTool(
    "get_tmux_variables",
    {
      annotations: READ_ONLY,
      description: "Resolve validated tmux variable names without accepting raw format syntax.",
      inputSchema: {
        names: z
          .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u))
          .min(1)
          .max(32)
          .meta({ [TMUX_FORMAT_SCHEMA_KEY]: TMUX_FORMAT_VALIDATED_VARIABLE }),
        paneId: paneIdSchema.optional(),
      },
      outputSchema: { values: z.record(z.string(), z.string()) },
      title: "Get tmux variables",
    },
    async ({ names, paneId }) => {
      const snapshot = await context.snapshot();
      const pane = paneId === undefined ? undefined : requirePane(snapshot, paneId);
      if (pane !== undefined && isFailure(pane)) return pane;
      const values: Record<string, string> = {};
      for (const name of names) {
        const lines =
          pane === undefined
            ? // eslint-disable-next-line no-await-in-loop -- names share one bounded tmux lane.
              await context.tmux.cmd("display-message", ["-p", `#{${name}}`], { target: null })
            : // eslint-disable-next-line no-await-in-loop -- names share one bounded tmux lane.
              await pane.displayMessage(`#{${name}}`);
        values[name] = lines.join("\n");
      }
      return ok(
        { values },
        Object.entries(values)
          .map(([name, value]) => `${name}=${value}`)
          .join("\n"),
      );
    },
  );

  registry.registerTool(
    "snapshot_pane",
    {
      annotations: READ_ONLY,
      description:
        "Return pane metadata, mode, cursor, scroll position, and bounded terminal content together.",
      inputSchema: {
        maxLines: z.number().int().positive().optional(),
        paneId: paneIdSchema,
      },
      outputSchema: {
        content: z.string(),
        cursorX: z.number().int(),
        cursorY: z.number().int(),
        droppedLines: z.number().int(),
        inMode: z.number().int(),
        pane: paneViewSchema,
        scrollPosition: z.number().int(),
      },
      title: "Snapshot pane",
    },
    async ({ maxLines, paneId }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      const identity = await context.identity(snapshot);
      const view = paneView(pane, identity, panePlacements(snapshot, paneId));
      const scrollPosition = Number((await pane.displayMessage("#{scroll_position}"))[0] ?? "0");
      const bounded = boundText(
        await pane.capture({ joinWrapped: true }),
        effectiveResultLines(context.policy, maxLines),
        MAX_RESULT_BYTES,
      );
      return ok(
        {
          content: bounded.text,
          cursorX: pane.cursorX,
          cursorY: pane.cursorY,
          droppedLines: bounded.droppedLines,
          inMode: pane.inMode,
          pane: view,
          scrollPosition: Number.isSafeInteger(scrollPosition) ? scrollPosition : 0,
        },
        `${paneLine(view)}\n${renderBoundedText(bounded, "use capture_pane with a narrower range")}`,
      );
    },
  );

  registry.registerTool(
    "enter_copy_mode",
    {
      annotations: MUTATING,
      description: "Enter copy mode in a pane and optionally scroll upward.",
      inputSchema: {
        paneId: paneIdSchema,
        scrollUp: z.number().int().positive().optional(),
      },
      outputSchema: { pane: paneViewSchema },
      title: "Enter copy mode",
    },
    async ({ paneId, scrollUp }) => {
      const before = await context.snapshot();
      const pane = requirePane(before, paneId);
      if (isFailure(pane)) return pane;
      await pane.enterCopyMode();
      if (scrollUp !== undefined) {
        await context.tmux.cmd("send-keys", ["-X", "-N", String(scrollUp), "scroll-up"], {
          target: paneId,
        });
      }
      const view = await projectedPane(await context.snapshot(), paneId, context);
      if (isFailure(view)) return view;
      return ok({ pane: view }, paneLine(view));
    },
  );

  registry.registerTool(
    "exit_copy_mode",
    {
      annotations: MUTATING,
      description: "Leave copy mode in a pane.",
      inputSchema: { paneId: paneIdSchema },
      outputSchema: { pane: paneViewSchema },
      title: "Exit copy mode",
    },
    async ({ paneId }) => {
      const before = await context.snapshot();
      const pane = requirePane(before, paneId);
      if (isFailure(pane)) return pane;
      await pane.exitCopyMode();
      const view = await projectedPane(await context.snapshot(), paneId, context);
      if (isFailure(view)) return view;
      return ok({ pane: view }, paneLine(view));
    },
  );

  registry.registerTool(
    "wait_for_channel",
    {
      annotations: MUTATING,
      description: "Wait until a tmux wait-for channel is signalled.",
      inputSchema: {
        channel: inlineRequestText("channel"),
        timeoutMs: z.number().int().positive().optional(),
      },
      outputSchema: { channel: z.string(), signalled: z.boolean() },
      title: "Wait for channel",
    },
    async ({ channel, timeoutMs }, extra) => {
      await context.tmux.cmd("wait-for", [channel], {
        signal: extra.signal,
        target: null,
        timeoutMs: effectiveWaitMs(context.policy, timeoutMs),
      });
      return ok({ channel, signalled: true }, `Channel ${channel} was signalled.`);
    },
  );

  registry.registerTool(
    "signal_channel",
    {
      annotations: MUTATING,
      description: "Signal a tmux wait-for channel.",
      inputSchema: { channel: inlineRequestText("channel") },
      outputSchema: { channel: z.string(), signalled: z.boolean() },
      title: "Signal channel",
    },
    async ({ channel }) => {
      await context.tmux.cmd("wait-for", ["-S", channel], { target: null });
      return ok({ channel, signalled: true }, `Signalled channel ${channel}.`);
    },
  );

  registry.registerTool(
    "set_mouse_enabled",
    {
      annotations: MUTATING,
      description: "Set the global tmux mouse option through a closed boolean schema.",
      inputSchema: { enabled: z.boolean() },
      outputSchema: { enabled: z.boolean() },
      title: "Set mouse enabled",
    },
    async ({ enabled }) => {
      await context.tmux.setGlobalOption("session", "mouse", enabled ? "on" : "off");
      return ok({ enabled }, `Mouse support is ${enabled ? "enabled" : "disabled"}.`);
    },
  );

  registry.registerTool(
    "set_history_limit",
    {
      annotations: MUTATING,
      description: "Set the default retained scrollback line limit through a bounded integer.",
      inputSchema: { lines: z.number().int().min(0).max(2_000_000) },
      outputSchema: { lines: z.number().int() },
      title: "Set history limit",
    },
    async ({ lines }) => {
      await context.tmux.setGlobalOption("session", "history-limit", String(lines));
      return ok({ lines }, `New panes retain ${String(lines)} history lines.`);
    },
  );

  registry.registerTool(
    "set_synchronize_panes",
    {
      annotations: OPEN_WORLD,
      description:
        "Set whether subsequent input to one pane is copied to every pane in the window.",
      inputSchema: { enabled: z.boolean(), windowId: windowIdSchema },
      outputSchema: { enabled: z.boolean(), windowId: windowIdSchema },
      title: "Set synchronize panes",
    },
    async ({ enabled, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      await window.setOption("synchronize-panes", enabled ? "on" : "off");
      return ok(
        { enabled, windowId },
        `Synchronized pane input is ${enabled ? "enabled" : "disabled"} in ${windowId}.`,
      );
    },
  );

  registry.registerTool(
    "send_keys_batch",
    {
      annotations: OPEN_WORLD,
      description:
        "Send an ordered batch of pane-input operations, stopping or continuing on error.",
      inputSchema: {
        onError: z.enum(["stop", "continue"]).optional(),
        operations: z
          .array(
            z.object({
              enter: z.boolean().optional(),
              force: z.boolean().optional(),
              keys: inlineRequestText("keys"),
              literal: z.boolean().optional(),
              paneId: paneIdSchema,
            }),
          )
          .min(1)
          .max(MAX_REQUEST_ITEMS),
      },
      outputSchema: {
        completed: z.number().int(),
        failures: z.array(z.object({ index: z.number().int(), reason: z.string() })),
        targets: z.array(
          z.object({ index: z.number().int(), resolvedPaneIds: z.array(paneIdSchema) }),
        ),
      },
      title: "Send keys batch",
    },
    async ({ onError, operations }) => {
      const failures: { index: number; reason: string }[] = [];
      const targets: { index: number; resolvedPaneIds: readonly string[] }[] = [];
      let completed = 0;
      for (const [index, operation] of operations.entries()) {
        // eslint-disable-next-line no-await-in-loop -- each operation observes the prior mutation.
        const snapshot = await context.snapshot();
        // eslint-disable-next-line no-await-in-loop -- identity must match this operation's snapshot.
        const identity = await context.identity(snapshot);
        const pane = requireWritablePane(
          snapshot,
          identity,
          operation.paneId,
          operation.force,
          "send keys to",
        );
        if (isFailure(pane)) {
          const reason =
            pane.content[0]?.type === "text" ? pane.content[0].text : "Pane refused input.";
          failures.push({ index, reason });
          if (onError !== "continue") break;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- targets are resolved immediately before input.
        const resolvedPaneIds = await resolvedPaneInputTargetIds(pane);
        let resolvedFailure: string | undefined;
        for (const resolvedPaneId of resolvedPaneIds) {
          const writable = requireWritablePane(
            snapshot,
            identity,
            resolvedPaneId,
            operation.force,
            "send keys to",
          );
          if (isFailure(writable)) {
            resolvedFailure =
              writable.content[0]?.type === "text"
                ? writable.content[0].text
                : "Resolved pane refused input.";
            break;
          }
        }
        if (resolvedFailure !== undefined) {
          failures.push({ index, reason: resolvedFailure });
          if (onError !== "continue") break;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- batch input is deliberately ordered.
        await pane.sendKeys(operation.keys, {
          enter: operation.enter ?? true,
          literal: operation.literal ?? false,
        });
        targets.push({ index, resolvedPaneIds });
        completed += 1;
      }
      return ok(
        { completed, failures, targets },
        `Completed ${String(completed)} input operations with ${String(failures.length)} failures.`,
      );
    },
  );

  registry.registerTool(
    "clear_pane_scrollback",
    {
      annotations: MUTATING,
      description: "Discard the retained scrollback history for one pane.",
      inputSchema: { paneId: paneIdSchema },
      outputSchema: { cleared: paneIdSchema },
      title: "Clear pane scrollback",
    },
    async ({ paneId }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      await pane.clearHistory();
      return ok({ cleared: paneId }, `Cleared retained scrollback for ${paneId}.`);
    },
  );

  const eligibleReadBatchTools = READ_BATCH_TOOLS.filter(
    (name) => !context.policy.excludeTools.has(name),
  );
  const readBatchOperationSchemas = eligibleReadBatchTools.map((tool) =>
    z
      .object({
        arguments: z.object(registry.nativeInputShape(tool)).strict().optional(),
        tool: z.literal(tool),
      })
      .strict(),
  );
  const [firstReadBatchSchema, secondReadBatchSchema, ...remainingReadBatchSchemas] =
    readBatchOperationSchemas;
  const readBatchOperationSchema: z.ZodType<ReadBatchOperation> =
    firstReadBatchSchema === undefined
      ? z.never()
      : secondReadBatchSchema === undefined
        ? firstReadBatchSchema
        : z.union([firstReadBatchSchema, secondReadBatchSchema, ...remainingReadBatchSchemas]);

  registry.registerTool(
    "call_read_tools_batch",
    {
      annotations: READ_ONLY,
      description:
        "Invoke a serial batch of at most 16 inspect tools. One client approval covers every " +
        "nested name; inner tools receive no separate approval. The structured result is capped " +
        "below 1,000,000 bytes, preserves every operation row, and reports explicit stop and truncation accounting.",
      inputSchema: {
        onError: z.enum(["stop", "continue"]).optional(),
        operations: z.array(readBatchOperationSchema).min(1).max(16),
      },
      outputSchema: {
        failed: z.number().int().nonnegative(),
        onError: z.enum(["stop", "continue"]),
        results: z.array(
          z.object({
            error: z.string().nullable(),
            index: z.number().int().nonnegative(),
            result: nestedToolResultSchema.nullable(),
            resultTruncated: z.boolean(),
            success: z.boolean(),
            tool: z.string(),
          }),
        ),
        stoppedAt: z.number().int().nonnegative().nullable(),
        succeeded: z.number().int().nonnegative(),
        truncated: z.boolean(),
        truncatedBytes: z.number().int().nonnegative(),
      },
      title: "Call read tools batch",
    },
    async (
      { onError, operations },
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => {
      const batch = new ReadBatchAccumulator(operations.length);
      for (const [batchIndex, operation] of operations.entries()) {
        let result: CallToolResult;
        try {
          // eslint-disable-next-line no-await-in-loop -- aggregate calls are explicitly serial.
          result = await registry.invoke(operation.tool, operation.arguments ?? {}, extra);
        } catch (error) {
          result = fail({
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        const entry = { result, tool: operation.tool };
        batch.append(entry);
        if (result.isError === true && onError !== "continue") {
          batch.stopAt(batchIndex);
          break;
        }
      }
      const result = batch.finish(onError ?? "stop", (answer) =>
        readBatchWireBytes(answer, extra.requestId),
      );
      return ok(result, readBatchSummary(result));
    },
  );
}
