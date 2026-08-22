/**
 * Making and ending tmux objects.
 *
 * Every creating tool answers with the handle it made, so the next call can
 * target it without a list in between — the difference between two calls and
 * four for anything built in steps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PaneDirection } from "libtmux/constants";

import {
  isFailure,
  requirePane,
  requireSession,
  requireWritablePane,
  requireWindow,
  type ToolContext,
} from "../context.js";
import { DESTRUCTIVE, MUTATING, offers } from "../register.js";
import { fail, ok } from "../results.js";
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

const DIRECTIONS = {
  above: PaneDirection.Above,
  below: PaneDirection.Below,
  left: PaneDirection.Left,
  right: PaneDirection.Right,
} as const;

export function registerLifecycle(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "mutating")) return;

  mcp.registerTool(
    "new_session",
    {
      annotations: MUTATING,
      description:
        "Create a detached session and return it with its first window and pane, " +
        "so you can start working without listing anything first.",
      inputSchema: {
        name: z.string().optional().describe("Session name; tmux picks a number when omitted."),
        shellCommand: z
          .string()
          .optional()
          .describe("Run this instead of a shell. The session ends when it exits."),
        startDirectory: z.string().optional(),
        windowName: z.string().optional(),
      },
      outputSchema: {
        paneId: z.string().describe("The new session's first pane. Target this."),
        session: sessionViewSchema,
        windowId: z.string(),
      },
      title: "New session",
    },
    async ({ name, shellCommand, startDirectory, windowName }) => {
      const session = await context.tmux.newSession({
        ...(name === undefined ? {} : { name }),
        ...(shellCommand === undefined ? {} : { shellCommand }),
        ...(startDirectory === undefined ? {} : { startDirectory }),
        ...(windowName === undefined ? {} : { windowName }),
      });
      const snapshot = await context.snapshot();
      const pane = snapshot.panes.first({ session: { is: { id: session.id } } });
      const view = sessionView(
        session,
        snapshot.windows.count({ session: { is: { id: session.id } } }),
      );
      context.topologyChanged();
      return ok(
        { paneId: pane?.id ?? "", session: view, windowId: pane?.windowId ?? "" },
        `Created ${view.name} (${view.id}); its pane is ${pane?.id ?? "unknown"}.`,
      );
    },
  );

  mcp.registerTool(
    "new_window",
    {
      annotations: MUTATING,
      description: "Add a window to a session and return it with its pane.",
      inputSchema: {
        name: z.string().optional(),
        session: z.string().describe("Session id ($1) or name."),
        shellCommand: z.string().optional(),
        startDirectory: z.string().optional(),
      },
      outputSchema: { paneId: z.string(), window: windowViewSchema },
      title: "New window",
    },
    async ({ name, session, shellCommand, startDirectory }) => {
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      const window = await found.newWindow({
        ...(name === undefined ? {} : { name }),
        ...(shellCommand === undefined ? {} : { shellCommand }),
        ...(startDirectory === undefined ? {} : { startDirectory }),
      });
      const after = await context.snapshot();
      const pane = after.panes.first({ window: { is: { id: window.id } } });
      const view = windowView(window);
      context.topologyChanged();
      return ok(
        { paneId: pane?.id ?? "", window: view },
        `${windowLine(view)}; its pane is ${pane?.id ?? "unknown"}.`,
      );
    },
  );

  mcp.registerTool(
    "split_pane",
    {
      annotations: MUTATING,
      description:
        "Split a pane and return the new one. Direction is where the new pane goes " +
        "relative to the one you split.",
      inputSchema: {
        direction: z
          .enum(["above", "below", "left", "right"])
          .optional()
          .describe("Default below."),
        paneId: z.string(),
        shellCommand: z.string().optional(),
        startDirectory: z.string().optional(),
      },
      outputSchema: { pane: paneViewSchema },
      title: "Split pane",
    },
    async ({ direction, paneId, shellCommand, startDirectory }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      const created = await pane.split({
        ...(direction === undefined ? {} : { direction: DIRECTIONS[direction] }),
        ...(shellCommand === undefined ? {} : { shellCommand }),
        ...(startDirectory === undefined ? {} : { startDirectory }),
      });
      const view = paneView(created, await context.identity(snapshot));
      context.topologyChanged();
      return ok({ pane: view }, paneLine(view));
    },
  );

  mcp.registerTool(
    "rename_session",
    {
      annotations: MUTATING,
      description: "Rename a session. Its id does not change, so targets by id keep working.",
      inputSchema: { name: z.string(), session: z.string() },
      outputSchema: { session: sessionViewSchema },
      title: "Rename session",
    },
    async ({ name, session }) => {
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      await found.rename(name);
      const after = await context.snapshot();
      const view = sessionView(
        after.sessions.one({ id: found.id }),
        after.windows.count({ session: { is: { id: found.id } } }),
      );
      context.topologyChanged();
      return ok({ session: view }, `Renamed ${found.id} to ${name}.`);
    },
  );

  mcp.registerTool(
    "rename_window",
    {
      annotations: MUTATING,
      description: "Rename a window. Its id does not change.",
      inputSchema: { name: z.string(), windowId: z.string() },
      outputSchema: { window: windowViewSchema },
      title: "Rename window",
    },
    async ({ name, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      await window.rename(name);
      const view = windowView((await context.snapshot()).windows.one({ id: windowId }));
      context.topologyChanged();
      return ok({ window: view }, windowLine(view));
    },
  );

  mcp.registerTool(
    "respawn_pane",
    {
      annotations: MUTATING,
      description:
        "Restart a pane's command in place, keeping the pane and its id. Use to " +
        "recover a pane whose process died, rather than killing and re-splitting.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Write even to the pane this server runs in. Default false."),
        killFirst: z
          .boolean()
          .optional()
          .describe("Replace a still-running process. Default false."),
        paneId: z.string(),
        shellCommand: z.string().optional(),
      },
      outputSchema: { pane: paneViewSchema },
      title: "Respawn pane",
    },
    async ({ force, killFirst, paneId, shellCommand }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requireWritablePane(snapshot, identity, paneId, force, "restart");
      if (isFailure(pane)) return pane;
      if (killFirst === true) {
        // Respawning a dead pane is recovery and belongs at this tier. Killing
        // what is still running is tmux's own kill by another name, and a tier
        // that hides kill_pane cannot offer the same end by another road.
        if (!offers(context.policy, "destructive")) {
          return fail({
            hint:
              "Respawn without killFirst to recover a pane whose process has already " +
              "exited, or run this server at the destructive tier.",
            reason:
              `Refusing to replace what is running in ${paneId}: killFirst ends that ` +
              `process, and this server offers the ${context.policy.safety} tier.`,
          });
        }
        const guard = guardDestructive(
          identity.callerPaneId,
          identity.attendedPaneIds,
          paneId,
          force,
        );
        if (guard !== undefined) return guard;
      }
      await pane.respawn(shellCommand, killFirst === undefined ? {} : { kill: killFirst });
      const view = paneView((await context.snapshot()).panes.one({ id: paneId }), identity);
      return ok({ pane: view }, paneLine(view));
    },
  );

  if (!offers(context.policy, "destructive")) return;

  mcp.registerTool(
    "kill_pane",
    {
      annotations: DESTRUCTIVE,
      description:
        "Close a pane and the process in it. Refuses the pane this server runs in " +
        "and any pane a person is watching unless you pass force.",
      inputSchema: { force: z.boolean().optional(), paneId: z.string() },
      outputSchema: { killed: z.string() },
      title: "Kill pane",
    },
    async ({ force, paneId }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requireWritablePane(snapshot, identity, paneId, force, "kill");
      if (isFailure(pane)) return pane;
      // requireWritablePane already refused this server's own pane; this adds
      // the refusal for a pane somebody else is watching.
      const guard = guardDestructive(
        identity.callerPaneId,
        identity.attendedPaneIds,
        paneId,
        force,
      );
      if (guard !== undefined) return guard;
      await pane.kill();
      context.topologyChanged();
      return ok({ killed: paneId }, `Killed ${paneId}.`);
    },
  );

  mcp.registerTool(
    "kill_window",
    {
      annotations: DESTRUCTIVE,
      description: "Close a window and every pane in it.",
      inputSchema: { force: z.boolean().optional(), windowId: z.string() },
      outputSchema: { killed: z.string() },
      title: "Kill window",
    },
    async ({ force, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      const identity = await context.identity(snapshot);
      const inside = snapshot.panes.toArray().filter((pane) => pane.windowId === windowId);
      for (const pane of inside) {
        const guard = guardDestructive(
          identity.callerPaneId,
          identity.attendedPaneIds,
          pane.id,
          force,
        );
        if (guard !== undefined) return guard;
      }
      await window.kill();
      context.topologyChanged();
      return ok({ killed: windowId }, `Killed ${windowId} and its ${String(inside.length)} panes.`);
    },
  );

  mcp.registerTool(
    "kill_session",
    {
      annotations: DESTRUCTIVE,
      description: "End a session and everything in it.",
      inputSchema: { force: z.boolean().optional(), session: z.string() },
      outputSchema: { killed: z.string() },
      title: "Kill session",
    },
    async ({ force, session }) => {
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      const identity = await context.identity(snapshot);
      const inside = snapshot.panes.toArray().filter((pane) => pane.sessionId === found.id);
      for (const pane of inside) {
        const guard = guardDestructive(
          identity.callerPaneId,
          identity.attendedPaneIds,
          pane.id,
          force,
        );
        if (guard !== undefined) return guard;
      }
      await found.kill();
      context.topologyChanged();
      return ok({ killed: found.id }, `Killed ${found.id} and its ${String(inside.length)} panes.`);
    },
  );
}

/**
 * Refuse to end something in use.
 *
 * A killed pane cannot be brought back, and the two panes worth refusing are
 * this process's own terminal and one somebody is looking at. `force` is how a
 * caller says it meant that one.
 */
function guardDestructive(
  callerPaneId: string | undefined,
  attended: readonly string[],
  paneId: string,
  force: boolean | undefined,
): ReturnType<typeof fail> | undefined {
  if (force === true) return undefined;
  if (callerPaneId === paneId) {
    return fail({
      hint: "Pass force if you mean to end the terminal this server runs in.",
      reason: `Refusing to kill ${paneId}: it is the pane this MCP server runs in.`,
    });
  }
  if (attended.includes(paneId)) {
    return fail({
      hint: "whoami lists who is attached. Pass force if you mean it.",
      reason: `Refusing to kill ${paneId}: somebody is watching it.`,
    });
  }
  return undefined;
}
