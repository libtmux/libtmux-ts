/**
 * Arranging panes and windows.
 *
 * These change what a person sees. Selecting a window in a session somebody is
 * attached to moves their screen, which is why the results say so rather than
 * reporting a bare success.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Pane, ServerSnapshot } from "libtmux";
import { ResizeAdjustmentDirection } from "libtmux/constants";

import type { CallerIdentity } from "../caller.js";
import {
  isFailure,
  panePlacements,
  requirePane,
  requirePanePlacement,
  requireSession,
  requireWindow,
  requireWindowPlacement,
  windowPlacements,
  type SourcePlacement,
  type ToolContext,
} from "../context.js";
import { effectiveResultLines } from "../policy.js";
import { DESTRUCTIVE, MUTATING, offers } from "../register.js";
import { fail, ok } from "../results.js";
import { paneIdSchema, windowIdSchema } from "../schemas.js";
import {
  paneLine,
  paneView,
  paneViewSchema,
  limitViews,
  renderViews,
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

const sourceSessionSchema = z
  .string()
  .optional()
  .describe("Source session id or name. Required when the id has several placements.");
const sourceIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("Source window index. Required when the session has several placements of the id.");

function projectPane(snapshot: ServerSnapshot, paneId: string, identity: CallerIdentity) {
  const pane = requirePane(snapshot, paneId);
  return isFailure(pane) ? pane : paneView(pane, identity, panePlacements(snapshot, paneId));
}

function projectWindow(snapshot: ServerSnapshot, windowId: string) {
  const window = requireWindow(snapshot, windowId);
  return isFailure(window) ? window : windowView(window, windowPlacements(snapshot, windowId));
}

function sourcePlacement(
  sourceSession: string | undefined,
  sourceIndex: number | undefined,
): SourcePlacement {
  return {
    ...(sourceIndex === undefined ? {} : { sourceIndex }),
    ...(sourceSession === undefined ? {} : { sourceSession }),
  };
}

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
        paneId: paneIdSchema,
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
      const view = projectPane(after, paneId, await context.identity(after));
      if (isFailure(view)) return view;
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
      inputSchema: { paneId: paneIdSchema },
      outputSchema: { pane: paneViewSchema },
      title: "Select pane",
    },
    async ({ paneId }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      await pane.select();
      const after = await context.snapshot();
      const view = projectPane(after, paneId, await context.identity(after));
      if (isFailure(view)) return view;
      return ok({ pane: view }, paneLine(view));
    },
  );

  mcp.registerTool(
    "select_window",
    {
      annotations: MUTATING,
      description: "Make a window the current one in its session.",
      inputSchema: {
        sourceIndex: sourceIndexSchema,
        sourceSession: sourceSessionSchema,
        windowId: windowIdSchema,
      },
      outputSchema: { window: windowViewSchema },
      title: "Select window",
    },
    async ({ sourceIndex, sourceSession, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindowPlacement(
        snapshot,
        windowId,
        sourcePlacement(sourceSession, sourceIndex),
      );
      if (isFailure(window)) return window;
      await window.select();
      const after = await context.snapshot();
      const view = projectWindow(after, windowId);
      if (isFailure(view)) return view;
      return ok({ window: view }, windowLine(view));
    },
  );

  mcp.registerTool(
    "select_layout",
    {
      annotations: MUTATING,
      description:
        "Rearrange a window's panes. Takes one of tmux's named layouts, or a layout " +
        "string from an earlier window whose `metadataComplete` is true to reproduce it exactly.",
      inputSchema: {
        layout: z.string().describe(`One of ${LAYOUTS.join(", ")}, or a tmux layout string.`),
        windowId: windowIdSchema,
      },
      outputSchema: { window: windowViewSchema },
      title: "Select layout",
    },
    async ({ layout, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      await window.selectLayout(layout);
      const view = projectWindow(await context.snapshot(), windowId);
      if (isFailure(view)) return view;
      // A layout string describing a different number of panes is accepted and
      // does nothing: tmux exits 0 and leaves the window alone. A named layout
      // is always applied, so only the string form can silently miss — and the
      // window this returns already knows which layout it ended up with.
      const ignored =
        !LAYOUTS.includes(layout as (typeof LAYOUTS)[number]) && view.layout !== layout;
      return ok(
        { window: view },
        windowLine(view) +
          (ignored
            ? `\n\n[the layout string was not applied: the returned window.layout is unchanged. ` +
              `tmux accepts a layout describing a different set of panes and changes nothing.]`
            : ""),
      );
    },
  );

  mcp.registerTool(
    "swap_pane",
    {
      annotations: MUTATING,
      description: "Exchange two panes' positions. Their ids and contents travel with them.",
      inputSchema: { otherPaneId: paneIdSchema, paneId: paneIdSchema },
      outputSchema: {
        complete: z.boolean(),
        omittedEntries: z.number().int().nonnegative(),
        panes: z.array(paneViewSchema),
      },
      title: "Swap panes",
    },
    async ({ otherPaneId, paneId }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      const other = requirePane(snapshot, otherPaneId);
      if (isFailure(other)) return other;
      await pane.swapWith(other as Pane);
      const after = await context.snapshot();
      const identity = await context.identity(after);
      const firstView = projectPane(after, paneId, identity);
      if (isFailure(firstView)) return firstView;
      const otherView = projectPane(after, otherPaneId, identity);
      if (isFailure(otherView)) return otherView;
      const views = [firstView, otherView];
      const bounded = limitViews(views, effectiveResultLines(context.policy, undefined), paneLine);
      return ok(
        {
          complete: bounded.complete,
          omittedEntries: bounded.omittedEntries,
          panes: bounded.views,
        },
        renderViews(bounded, "panes", "inspect each pane separately"),
      );
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
        sourceIndex: sourceIndexSchema,
        sourceSession: sourceSessionSchema,
        windowId: windowIdSchema,
      },
      outputSchema: { window: windowViewSchema },
      title: "Move window",
    },
    async ({ index, session, sourceIndex, sourceSession, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindowPlacement(
        snapshot,
        windowId,
        sourcePlacement(sourceSession, sourceIndex),
      );
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
      const view = projectWindow(await context.snapshot(), windowId);
      if (isFailure(view)) return view;
      context.topologyChanged();
      return ok({ window: view }, windowLine(view));
    },
  );

  mcp.registerTool(
    "resize_window",
    {
      annotations: MUTATING,
      description:
        "Set a window's size in cells. A detached window is whatever size tmux " +
        "guessed, and a program that formats to its terminal width truncates to " +
        "that at the source — no capture option recovers those columns, because " +
        "they were never printed. resize_pane only redistributes space inside a " +
        "window and cannot grow one. A client attached to the window will " +
        "overwrite this when it next changes; window-size manual makes a size of " +
        "your own stick.",
      inputSchema: {
        height: z.number().int().positive().optional(),
        width: z.number().int().positive().optional(),
        windowId: windowIdSchema,
      },
      outputSchema: { window: windowViewSchema },
      title: "Resize window",
    },
    async ({ height, width, windowId }) => {
      if (width === undefined && height === undefined) {
        return fail({
          hint: "Pass width, height, or both.",
          reason: "resize_window needs a size to set.",
        });
      }
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      await window.resize({
        ...(height === undefined ? {} : { height }),
        ...(width === undefined ? {} : { width }),
      });
      const view = projectWindow(await context.snapshot(), windowId);
      if (isFailure(view)) return view;
      return ok({ window: view }, windowLine(view));
    },
  );

  if (offers(context.policy, "destructive")) {
    mcp.registerTool(
      "move_pane",
      {
        annotations: DESTRUCTIVE,
        description:
          "Move a pane into another window as a split, or break it out into a window " +
          "of its own by naming no destination. The pane keeps its id and whatever is " +
          "running in it, which killing it and splitting again does not. Moving a " +
          "window's last pane destroys that window.",
        inputSchema: {
          paneId: paneIdSchema,
          sourceIndex: sourceIndexSchema,
          sourceSession: sourceSessionSchema,
          vertical: z
            .boolean()
            .optional()
            .describe(
              "Join as a horizontal split rather than a vertical one. Unused when breaking out.",
            ),
          windowId: windowIdSchema
            .optional()
            .describe("Window to move it into. Omit to break it out into a window of its own."),
          windowName: z.string().optional().describe("Name for the window a break-out creates."),
        },
        outputSchema: { pane: paneViewSchema },
        title: "Move pane",
      },
      async ({ paneId, sourceIndex, sourceSession, vertical, windowId, windowName }) => {
        const snapshot = await context.snapshot();
        const pane =
          windowId === undefined || sourceIndex !== undefined || sourceSession !== undefined
            ? requirePanePlacement(snapshot, paneId, sourcePlacement(sourceSession, sourceIndex))
            : requirePane(snapshot, paneId);
        if (isFailure(pane)) return pane;
        if (windowId === undefined) {
          await pane.breakOut(windowName);
        } else {
          const window = requireWindow(snapshot, windowId);
          if (isFailure(window)) return window;
          await pane.joinTo(window.id, vertical === undefined ? {} : { vertical });
        }
        const after = await context.snapshot();
        const view = projectPane(after, paneId, await context.identity(after));
        if (isFailure(view)) return view;
        context.topologyChanged();
        return ok({ pane: view }, paneLine(view));
      },
    );
  }

  mcp.registerTool(
    "swap_window",
    {
      annotations: MUTATING,
      description:
        "Exchange the positions of two windows, which may be in different sessions. " +
        "Each keeps its id, its panes and what is running in them; only where they " +
        "sit changes. This is swap_pane's analogue one level up.",
      inputSchema: {
        otherSourceIndex: sourceIndexSchema,
        otherSourceSession: sourceSessionSchema,
        otherWindowId: windowIdSchema,
        sourceIndex: sourceIndexSchema,
        sourceSession: sourceSessionSchema,
        windowId: windowIdSchema,
      },
      outputSchema: {
        complete: z.boolean(),
        omittedEntries: z.number().int().nonnegative(),
        windows: z.array(windowViewSchema),
      },
      title: "Swap windows",
    },
    async ({
      otherSourceIndex,
      otherSourceSession,
      otherWindowId,
      sourceIndex,
      sourceSession,
      windowId,
    }) => {
      const snapshot = await context.snapshot();
      const window = requireWindowPlacement(
        snapshot,
        windowId,
        sourcePlacement(sourceSession, sourceIndex),
      );
      if (isFailure(window)) return window;
      const other = requireWindowPlacement(
        snapshot,
        otherWindowId,
        sourcePlacement(otherSourceSession, otherSourceIndex),
      );
      if (isFailure(other)) return other;
      await window.swapWith(other);
      const after = await context.snapshot();
      const firstView = projectWindow(after, windowId);
      if (isFailure(firstView)) return firstView;
      const otherView = projectWindow(after, otherWindowId);
      if (isFailure(otherView)) return otherView;
      const views = [firstView, otherView];
      context.topologyChanged();
      const bounded = limitViews(
        views,
        effectiveResultLines(context.policy, undefined),
        windowLine,
      );
      return ok(
        {
          complete: bounded.complete,
          omittedEntries: bounded.omittedEntries,
          windows: bounded.views,
        },
        renderViews(bounded, "windows", "inspect each window separately"),
      );
    },
  );

  mcp.registerTool(
    "set_pane_title",
    {
      annotations: MUTATING,
      description:
        "Give a pane a title. Useful for labelling what an agent put where, since " +
        "the title shows in list_panes and survives the command changing.",
      inputSchema: { paneId: paneIdSchema, title: z.string() },
      outputSchema: { pane: paneViewSchema },
      title: "Set pane title",
    },
    async ({ paneId, title }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      await pane.setTitle(title);
      const after = await context.snapshot();
      const view = projectPane(after, paneId, await context.identity(after));
      if (isFailure(view)) return view;
      return ok({ pane: view }, paneLine(view));
    },
  );
}
