/**
 * Making and ending tmux objects.
 *
 * Every creating tool answers with the handle it made, so the next call can
 * target it without a list in between — the difference between two calls and
 * four for anything built in steps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ServerSnapshot } from "libtmux";
import { PaneDirection } from "libtmux/constants";

import { isAttended, isCallerPane, type CallerIdentity } from "../caller.js";
import { runTopologyMutation, type ToolContext } from "../context.js";
import { MAX_INLINE_REQUEST_BYTES } from "../policy.js";
import { DESTRUCTIVE, MUTATING, MUTATING_OPEN_WORLD, offers } from "../register.js";
import { fail, ok } from "../results.js";
import {
  fitsInlineRequest,
  inlineRequestText,
  paneIdSchema,
  requestText,
  sessionIdSchema,
  windowIdSchema,
} from "../schemas.js";
import {
  isFailure,
  paneEntities,
  panePlacements,
  requirePane,
  requireSession,
  requireWritablePane,
  requireWindow,
  windowPlacements,
} from "../target_resolution.js";
import {
  directoryNote,
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

function projectPane(snapshot: ServerSnapshot, paneId: string, identity: CallerIdentity) {
  const pane = requirePane(snapshot, paneId);
  return isFailure(pane) ? pane : paneView(pane, identity, panePlacements(snapshot, paneId));
}

function projectWindow(snapshot: ServerSnapshot, windowId: string) {
  const window = requireWindow(snapshot, windowId);
  return isFailure(window) ? window : windowView(window, windowPlacements(snapshot, windowId));
}

export function registerLifecycle(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "mutating")) return;

  mcp.registerTool(
    "new_session",
    {
      annotations: MUTATING_OPEN_WORLD,
      description:
        "Create a detached session and return it with its first window and pane, " +
        "so you can start working without listing anything first.",
      inputSchema: z
        .object({
          name: inlineRequestText("name")
            .optional()
            .describe("Session name; tmux picks a number when omitted."),
          shellCommand: inlineRequestText("shellCommand")
            .optional()
            .describe("Run this instead of a shell. The session ends when it exits."),
          height: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Rows. Default 24, because a detached session has no client to size it."),
          startDirectory: inlineRequestText("startDirectory").optional(),
          width: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Columns. Default 80, and a program that formats to its terminal width — ps, " +
                "git log --graph, docker ps — truncates to that at the source, where no " +
                "capture option can recover it.",
            ),
          windowName: inlineRequestText("windowName").optional(),
        })
        .refine(
          ({ name, shellCommand, startDirectory, windowName }) =>
            fitsInlineRequest([name, shellCommand, startDirectory, windowName]),
          {
            message: `new_session text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
          },
        ),
      outputSchema: {
        paneId: paneIdSchema.describe("The new session's first pane. Target this."),
        session: sessionViewSchema,
        windowId: windowIdSchema,
      },
      title: "New session",
    },
    async ({ height, name, shellCommand, startDirectory, width, windowName }) => {
      const session = await runTopologyMutation(context, () =>
        context.tmux.newSession({
          ...(name === undefined ? {} : { name }),
          ...(shellCommand === undefined ? {} : { shellCommand }),
          ...(startDirectory === undefined ? {} : { startDirectory }),
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
          ...(windowName === undefined ? {} : { windowName }),
        }),
      );
      const snapshot = await context.snapshot();
      const pane = snapshot.panes.first({ session: { is: { id: session.id } } });
      if (pane === undefined) {
        return fail({
          hint: "Use a command that stays running, or omit shellCommand to start a shell.",
          reason: `Session ${session.id} ended before its first pane could be read.`,
        });
      }
      const view = sessionView(
        session,
        snapshot.windows.count({ session: { is: { id: session.id } } }),
      );
      return ok(
        { paneId: pane.id, session: view, windowId: pane.format.window_id },
        `Created ${view.name} (${view.id}); its pane is ${pane.id}.` +
          directoryNote(startDirectory, pane.currentPath),
      );
    },
  );

  mcp.registerTool(
    "new_window",
    {
      annotations: MUTATING_OPEN_WORLD,
      description: "Add a window to a session and return it with its pane.",
      inputSchema: z
        .object({
          name: inlineRequestText("name").optional(),
          session: requestText("session").describe("Session id ($1) or name."),
          shellCommand: inlineRequestText("shellCommand").optional(),
          startDirectory: inlineRequestText("startDirectory").optional(),
        })
        .refine(
          ({ name, shellCommand, startDirectory }) =>
            fitsInlineRequest([name, shellCommand, startDirectory]),
          {
            message: `new_window text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
          },
        ),
      outputSchema: { paneId: paneIdSchema, window: windowViewSchema },
      title: "New window",
    },
    async ({ name, session, shellCommand, startDirectory }) => {
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      const window = await runTopologyMutation(context, () =>
        found.newWindow({
          ...(name === undefined ? {} : { name }),
          ...(shellCommand === undefined ? {} : { shellCommand }),
          ...(startDirectory === undefined ? {} : { startDirectory }),
        }),
      );
      const after = await context.snapshot();
      const pane = after.panes.first({ window: { is: { id: window.id } } });
      if (pane === undefined) {
        return fail({
          hint: "Use a command that stays running, or omit shellCommand to start a shell.",
          reason: `Window ${window.id} ended before its first pane could be read.`,
        });
      }
      const view = windowView(window, windowPlacements(after, window.id));
      return ok(
        { paneId: pane.id, window: view },
        `${windowLine(view)}; its pane is ${pane.id}.` +
          directoryNote(startDirectory, pane.currentPath),
      );
    },
  );

  mcp.registerTool(
    "split_pane",
    {
      annotations: MUTATING_OPEN_WORLD,
      description:
        "Split a pane and return the new one. Direction is where the new pane goes " +
        "relative to the one you split.",
      inputSchema: z
        .object({
          direction: z
            .enum(["above", "below", "left", "right"])
            .optional()
            .describe("Default below."),
          paneId: paneIdSchema,
          shellCommand: inlineRequestText("shellCommand").optional(),
          startDirectory: inlineRequestText("startDirectory")
            .optional()
            .describe("Defaults to the directory the pane being split is in."),
        })
        .refine(
          ({ shellCommand, startDirectory }) => fitsInlineRequest([shellCommand, startDirectory]),
          {
            message: `split_pane text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
          },
        ),
      outputSchema: { pane: paneViewSchema },
      title: "Split pane",
    },
    async ({ direction, paneId, shellCommand, startDirectory }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      // tmux resolves a split's directory from the client, then the SESSION,
      // and never consults the pane being split — so splitting a pane sitting
      // in /etc produced one in the session's directory. "Split this pane"
      // reads as "keep working here", so the source pane's directory is the
      // default; naming one still overrides it.
      const inherited = startDirectory ?? pane.currentPath ?? undefined;
      const created = await runTopologyMutation(context, () =>
        pane.split({
          ...(direction === undefined ? {} : { direction: DIRECTIONS[direction] }),
          ...(shellCommand === undefined ? {} : { shellCommand }),
          ...(inherited === undefined ? {} : { startDirectory: inherited }),
        }),
      );
      const after = await context.snapshot();
      const view = projectPane(after, created.id, await context.identity(after));
      if (isFailure(view)) return view;
      return ok({ pane: view }, paneLine(view) + directoryNote(startDirectory, view.cwd));
    },
  );

  mcp.registerTool(
    "rename_session",
    {
      annotations: MUTATING,
      description: "Rename a session. Its id does not change, so targets by id keep working.",
      inputSchema: { name: inlineRequestText("name"), session: requestText("session") },
      outputSchema: { session: sessionViewSchema },
      title: "Rename session",
    },
    async ({ name, session }) => {
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      await runTopologyMutation(context, () => found.rename(name));
      const after = await context.snapshot();
      const view = sessionView(
        after.sessions.one({ id: found.id }),
        after.windows.count({ session: { is: { id: found.id } } }),
      );
      return ok({ session: view }, `Renamed ${found.id} to ${name}.`);
    },
  );

  mcp.registerTool(
    "rename_window",
    {
      annotations: MUTATING,
      description: "Rename a window. Its id does not change.",
      inputSchema: { name: inlineRequestText("name"), windowId: windowIdSchema },
      outputSchema: { window: windowViewSchema },
      title: "Rename window",
    },
    async ({ name, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      await runTopologyMutation(context, () => window.rename(name));
      const view = projectWindow(await context.snapshot(), windowId);
      if (isFailure(view)) return view;
      return ok({ window: view }, windowLine(view));
    },
  );

  mcp.registerTool(
    "respawn_pane",
    {
      annotations: offers(context.policy, "destructive")
        ? { ...MUTATING_OPEN_WORLD, destructiveHint: true }
        : MUTATING_OPEN_WORLD,
      description:
        "Restart a pane's command in place, keeping the pane and its id. Use to " +
        "recover a pane whose process died, rather than killing and re-splitting.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe(
            "Restart even in this server's pane or one a person is watching. Default false.",
          ),
        killFirst: z
          .boolean()
          .optional()
          .describe("Replace a still-running process. Default false."),
        paneId: paneIdSchema,
        shellCommand: inlineRequestText("shellCommand").optional(),
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
        const guard = guardDestructive(identity, paneId, force);
        if (guard !== undefined) return guard;
      }
      await pane.respawn(shellCommand, killFirst === undefined ? {} : { kill: killFirst });
      const view = projectPane(await context.snapshot(), paneId, identity);
      if (isFailure(view)) return view;
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
      inputSchema: { force: z.boolean().optional(), paneId: paneIdSchema },
      outputSchema: { killed: paneIdSchema },
      title: "Kill pane",
    },
    async ({ force, paneId }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requireWritablePane(snapshot, identity, paneId, force, "kill");
      if (isFailure(pane)) return pane;
      // requireWritablePane already refused this server's own pane; this adds
      // the refusal for a pane somebody else is watching.
      const guard = guardDestructive(identity, paneId, force);
      if (guard !== undefined) return guard;
      await runTopologyMutation(context, () => pane.kill());
      return ok({ killed: paneId }, `Killed ${paneId}.`);
    },
  );

  mcp.registerTool(
    "kill_window",
    {
      annotations: DESTRUCTIVE,
      description: "Close a window and every pane in it.",
      inputSchema: { force: z.boolean().optional(), windowId: windowIdSchema },
      outputSchema: { killed: windowIdSchema },
      title: "Kill window",
    },
    async ({ force, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      const identity = await context.identity(snapshot);
      const inside = paneEntities(
        snapshot.panes.toArray().filter((pane) => pane.format.window_id === windowId),
      );
      for (const pane of inside) {
        const guard = guardDestructive(identity, pane.id, force);
        if (guard !== undefined) return guard;
      }
      await runTopologyMutation(context, () => window.kill());
      return ok({ killed: windowId }, `Killed ${windowId} and its ${String(inside.length)} panes.`);
    },
  );

  mcp.registerTool(
    "kill_session",
    {
      annotations: DESTRUCTIVE,
      description:
        "Remove a session. Windows and panes shared with another session remain available there.",
      inputSchema: { force: z.boolean().optional(), session: requestText("session") },
      outputSchema: { killed: sessionIdSchema },
      title: "Kill session",
    },
    async ({ force, session }) => {
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      const identity = await context.identity(snapshot);
      const inside = paneEntities(
        snapshot.panes.toArray().filter((pane) => pane.format.session_id === found.id),
      );
      for (const pane of inside) {
        const guard = guardDestructive(identity, pane.id, force);
        if (guard !== undefined) return guard;
      }
      await runTopologyMutation(context, () => found.kill());
      return ok(
        { killed: found.id },
        `Killed session ${found.id}. Windows and panes shared with other sessions remain there.`,
      );
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
  identity: CallerIdentity,
  paneId: string,
  force: boolean | undefined,
): ReturnType<typeof fail> | undefined {
  if (force === true) return undefined;
  if (isCallerPane(identity, paneId)) {
    return fail({
      hint: "Pass force if you mean to end the terminal this server runs in.",
      reason: `Refusing to kill ${paneId}: it is the pane this MCP server runs in.`,
    });
  }
  if (isAttended(identity, paneId)) {
    return fail({
      hint: "whoami lists who is attached. Pass force if you mean it.",
      reason: `Refusing to kill ${paneId}: somebody is watching it.`,
    });
  }
  return undefined;
}
