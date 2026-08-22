/**
 * Arranging panes and windows.
 *
 * These change what a person sees. Selecting a window in a session somebody is
 * attached to moves their screen, which is why the results say so rather than
 * reporting a bare success.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ResizeAdjustmentDirection } from "libtmux/constants";

import {
  isFailure,
  requirePane,
  requireSession,
  requireWindow,
  type ToolContext,
} from "../context.js";
import { MUTATING, offers } from "../register.js";
import { ok } from "../results.js";
import {
  paneLine,
  paneView,
  paneViewSchema,
  windowLine,
  windowView,
  windowViewSchema,
} from "../views.js";

const ADJUSTMENTS = {
  down: ResizeAdjustmentDirection.Down,
  left: ResizeAdjustmentDirection.Left,
  right: ResizeAdjustmentDirection.Right,
  up: ResizeAdjustmentDirection.Up,
} as const;

/** tmux's named arrangements, which `select_layout` also accepts a layout string for. */
const LAYOUTS = [
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
  "tiled",
] as const;

export function registerLayout(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "mutating")) return;

  mcp.registerTool(
    "resize_pane",
    {
      annotations: MUTATING,
      description:
        "Resize a pane, either to a size or by an amount in a direction. Give " +
        "width/height for an absolute size, or direction with amount for a nudge.",
      inputSchema: {
        amount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cells to move by. Needs direction."),
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        height: z.number().int().positive().optional(),
        paneId: z.string(),
        width: z.number().int().positive().optional(),
        zoom: z.boolean().optional().describe("Toggle this pane filling its window."),
      },
      outputSchema: { pane: paneViewSchema },
      title: "Resize pane",
    },
    async ({ amount, direction, height, paneId, width, zoom }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      if (zoom === true) {
        await pane.cmd("resize-pane", ["-Z"]);
      } else {
        await pane.resize({
          ...(amount === undefined ? {} : { amount }),
          ...(direction === undefined ? {} : { direction: ADJUSTMENTS[direction] }),
          ...(height === undefined ? {} : { height }),
          ...(width === undefined ? {} : { width }),
        });
      }
      const after = await context.snapshot();
      const view = paneView(after.panes.one({ id: paneId }), await context.identity(after));
      return ok({ pane: view }, paneLine(view));
    },
  );

  mcp.registerTool(
    "select_pane",
    {
      annotations: MUTATING,
      description:
        "Make a pane the active one in its window. Moves the cursor of anyone " +
        "attached to that window.",
      inputSchema: { paneId: z.string() },
      outputSchema: { pane: paneViewSchema },
      title: "Select pane",
    },
    async ({ paneId }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      await pane.select();
      const after = await context.snapshot();
      const view = paneView(after.panes.one({ id: paneId }), await context.identity(after));
      return ok({ pane: view }, paneLine(view));
    },
  );

  mcp.registerTool(
    "select_window",
    {
      annotations: MUTATING,
      description: "Make a window the current one in its session.",
      inputSchema: { windowId: z.string() },
      outputSchema: { window: windowViewSchema },
      title: "Select window",
    },
    async ({ windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      await window.select();
      const view = windowView((await context.snapshot()).windows.one({ id: windowId }));
      return ok({ window: view }, windowLine(view));
    },
  );

  mcp.registerTool(
    "select_layout",
    {
      annotations: MUTATING,
      description:
        "Rearrange a window's panes. Takes one of tmux's named layouts, or a layout " +
        "string from an earlier window's `layout` field to reproduce it exactly.",
      inputSchema: {
        layout: z.string().describe(`One of ${LAYOUTS.join(", ")}, or a tmux layout string.`),
        windowId: z.string(),
      },
      outputSchema: { window: windowViewSchema },
      title: "Select layout",
    },
    async ({ layout, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      await window.selectLayout(layout);
      const view = windowView((await context.snapshot()).windows.one({ id: windowId }));
      return ok({ window: view }, windowLine(view));
    },
  );

  mcp.registerTool(
    "swap_pane",
    {
      annotations: MUTATING,
      description: "Exchange two panes' positions. Their ids and contents travel with them.",
      inputSchema: { otherPaneId: z.string(), paneId: z.string() },
      outputSchema: { panes: z.array(paneViewSchema) },
      title: "Swap panes",
    },
    async ({ otherPaneId, paneId }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      const other = requirePane(snapshot, otherPaneId);
      if (isFailure(other)) return other;
      // Validated above for the not-found message. Swapping arranges two panes
      // rather than writing into either, so neither needs the write guard —
      // but swapWith takes the pane itself, which the read-only view withholds.
      await pane.swapWith(snapshot.panes.one({ id: otherPaneId }));
      const after = await context.snapshot();
      const identity = await context.identity(after);
      const views = [paneId, otherPaneId].map((id) => paneView(after.panes.one({ id }), identity));
      return ok({ panes: views }, views.map(paneLine).join("\n"));
    },
  );

  mcp.registerTool(
    "move_window",
    {
      annotations: MUTATING,
      description: "Move a window to another index, or into another session.",
      inputSchema: {
        index: z.number().int().nonnegative().optional(),
        session: z.string().optional().describe("Destination session id or name."),
        windowId: z.string(),
      },
      outputSchema: { window: windowViewSchema },
      title: "Move window",
    },
    async ({ index, session, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      let destination: string | undefined;
      if (session !== undefined) {
        const found = requireSession(snapshot, session);
        if (isFailure(found)) return found;
        destination = found.id;
      }
      await window.move({
        ...(index === undefined ? {} : { index }),
        ...(destination === undefined ? {} : { session: destination }),
      });
      const view = windowView((await context.snapshot()).windows.one({ id: windowId }));
      context.topologyChanged();
      return ok({ window: view }, windowLine(view));
    },
  );

  mcp.registerTool(
    "move_pane",
    {
      annotations: MUTATING,
      description:
        "Move a pane into another window as a split, or break it out into a window " +
        "of its own by naming no destination. The pane keeps its id and whatever is " +
        "running in it, which killing it and splitting again does not. Moving a " +
        "window's last pane destroys that window.",
      inputSchema: {
        paneId: z.string(),
        vertical: z
          .boolean()
          .optional()
          .describe(
            "Join as a horizontal split rather than a vertical one. Unused when breaking out.",
          ),
        windowId: z
          .string()
          .optional()
          .describe("Window to move it into. Omit to break it out into a window of its own."),
        windowName: z.string().optional().describe("Name for the window a break-out creates."),
      },
      outputSchema: { pane: paneViewSchema },
      title: "Move pane",
    },
    async ({ paneId, vertical, windowId, windowName }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      if (windowId === undefined) {
        await pane.breakOut(windowName);
      } else {
        const window = requireWindow(snapshot, windowId);
        if (isFailure(window)) return window;
        await pane.joinTo(window.id, vertical === undefined ? {} : { vertical });
      }
      const after = await context.snapshot();
      const view = paneView(after.panes.one({ id: paneId }), await context.identity(after));
      context.topologyChanged();
      return ok({ pane: view }, paneLine(view));
    },
  );

  mcp.registerTool(
    "swap_window",
    {
      annotations: MUTATING,
      description:
        "Exchange the positions of two windows, which may be in different sessions. " +
        "Each keeps its id, its panes and what is running in them; only where they " +
        "sit changes. This is swap_pane's analogue one level up.",
      inputSchema: { otherWindowId: z.string(), windowId: z.string() },
      outputSchema: { windows: z.array(windowViewSchema) },
      title: "Swap windows",
    },
    async ({ otherWindowId, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      const other = requireWindow(snapshot, otherWindowId);
      if (isFailure(other)) return other;
      await window.swapWith(other);
      const after = await context.snapshot();
      const views = [windowId, otherWindowId].map((id) => windowView(after.windows.one({ id })));
      context.topologyChanged();
      return ok({ windows: views }, views.map(windowLine).join("\n"));
    },
  );

  mcp.registerTool(
    "set_pane_title",
    {
      annotations: MUTATING,
      description:
        "Give a pane a title. Useful for labelling what an agent put where, since " +
        "the title shows in list_panes and survives the command changing.",
      inputSchema: { paneId: z.string(), title: z.string() },
      outputSchema: { pane: paneViewSchema },
      title: "Set pane title",
    },
    async ({ paneId, title }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      await pane.setTitle(title);
      const after = await context.snapshot();
      const view = paneView(after.panes.one({ id: paneId }), await context.identity(after));
      return ok({ pane: view }, paneLine(view));
    },
  );
}
