/**
 * Making and ending tmux objects.
 *
 * Every creating tool answers with the handle it made, so the next call can
 * target it without a list in between — the difference between two calls and
 * four for anything built in steps.
 */

import { z } from "zod";

import type { ServerSnapshot } from "libtmux";
import { PaneDirection } from "libtmux/constants";

import type { CallerIdentity } from "../caller.js";
import type { ToolContext } from "../context.js";
import { MAX_INLINE_REQUEST_BYTES } from "../policy.js";
import { DESTRUCTIVE, MUTATING, MUTATING_OPEN_WORLD, type ToolRegistrar } from "../register.js";
import { fail, ok } from "../results.js";
import {
  fitsInlineRequest,
  literalTmuxText,
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

export function registerLifecycle(mcp: ToolRegistrar, context: ToolContext): void {
  mcp.registerTool(
    "create_session",
    {
      annotations: MUTATING_OPEN_WORLD,
      description:
        "Create a detached session and return it with its first window and pane, " +
        "so you can start working without listing anything first.",
      inputSchema: z
        .object({
          name: literalTmuxText("name")
            .optional()
            .describe("Session name; tmux picks a number when omitted."),
          height: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Rows. Default 24, because a detached session has no client to size it."),
          startDirectory: literalTmuxText("startDirectory").optional(),
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
          windowName: literalTmuxText("windowName").optional(),
        })
        .refine(
          ({ name, startDirectory, windowName }) =>
            fitsInlineRequest([name, startDirectory, windowName]),
          {
            message: `create_session text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
          },
        ),
      outputSchema: {
        paneId: paneIdSchema.describe("The new session's first pane. Target this."),
        session: sessionViewSchema,
        windowId: windowIdSchema,
      },
      title: "Create session",
    },
    async ({ height, name, startDirectory, width, windowName }) => {
      const session = await context.tmux.newSession({
        ...(name === undefined ? {} : { name }),
        ...(startDirectory === undefined ? {} : { startDirectory }),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(windowName === undefined ? {} : { windowName }),
      });
      const snapshot = await context.snapshot();
      const pane = snapshot.panes.first({ session: { is: { id: session.id } } });
      if (pane === undefined) {
        return fail({
          hint: "Inspect the configured default command and create the session again.",
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
    "create_window",
    {
      annotations: MUTATING_OPEN_WORLD,
      description: "Add a window to a session and return it with its pane.",
      inputSchema: z
        .object({
          name: literalTmuxText("name").optional(),
          session: requestText("session").describe("Session id ($1) or name."),
          startDirectory: literalTmuxText("startDirectory").optional(),
        })
        .refine(({ name, startDirectory }) => fitsInlineRequest([name, startDirectory]), {
          message: `create_window text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
        }),
      outputSchema: { paneId: paneIdSchema, window: windowViewSchema },
      title: "Create window",
    },
    async ({ name, session, startDirectory }) => {
      const snapshot = await context.snapshot();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      const window = await found.newWindow({
        ...(name === undefined ? {} : { name }),
        ...(startDirectory === undefined ? {} : { startDirectory }),
      });
      const after = await context.snapshot();
      const pane = after.panes.first({ window: { is: { id: window.id } } });
      if (pane === undefined) {
        return fail({
          hint: "Inspect the configured default command and create the window again.",
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
    "split_window",
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
          startDirectory: literalTmuxText("startDirectory")
            .optional()
            .describe("Defaults to the directory the pane being split is in."),
        })
        .refine(({ startDirectory }) => fitsInlineRequest([startDirectory]), {
          message: `split_window text is too large after tmux quoting; the combined limit is ${String(MAX_INLINE_REQUEST_BYTES)} bytes.`,
        }),
      outputSchema: { pane: paneViewSchema },
      title: "Split window",
    },
    async ({ direction, paneId, startDirectory }) => {
      const snapshot = await context.snapshot();
      const pane = requirePane(snapshot, paneId);
      if (isFailure(pane)) return pane;
      // tmux resolves a split's directory from the client, then the SESSION,
      // and never consults the pane being split — so splitting a pane sitting
      // in /etc produced one in the session's directory. "Split this pane"
      // reads as "keep working here", so the source pane's directory is the
      // default; naming one still overrides it.
      const inherited = startDirectory ?? pane.currentPath ?? undefined;
      const created = await pane.split({
        ...(direction === undefined ? {} : { direction: DIRECTIONS[direction] }),
        ...(inherited === undefined ? {} : { startDirectory: inherited }),
      });
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
      inputSchema: { name: literalTmuxText("name"), session: requestText("session") },
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
      return ok({ session: view }, `Renamed ${found.id} to ${name}.`);
    },
  );

  mcp.registerTool(
    "rename_window",
    {
      annotations: MUTATING,
      description: "Rename a window. Its id does not change.",
      inputSchema: { name: literalTmuxText("name"), windowId: windowIdSchema },
      outputSchema: { window: windowViewSchema },
      title: "Rename window",
    },
    async ({ name, windowId }) => {
      const snapshot = await context.snapshot();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      await window.rename(name);
      const view = projectWindow(await context.snapshot(), windowId);
      if (isFailure(view)) return view;
      return ok({ window: view }, windowLine(view));
    },
  );

  mcp.registerTool(
    "respawn_pane",
    {
      annotations: MUTATING_OPEN_WORLD,
      description:
        "Restart a pane's command in place, keeping the pane and its id. Use to " +
        "recover a pane whose process died, rather than killing and re-splitting.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Restart this server's exact caller pane. Never overrides attention."),
        killFirst: z
          .boolean()
          .optional()
          .describe("Replace a still-running process. Default false."),
        paneId: paneIdSchema,
        startDirectory: literalTmuxText("startDirectory").optional(),
      },
      outputSchema: { pane: paneViewSchema },
      title: "Respawn pane",
    },
    async ({ force, killFirst, paneId, startDirectory }) => {
      const { identity, snapshot } = await context.observeInput();
      const pane = requireWritablePane(snapshot, identity, paneId, force, "restart");
      if (isFailure(pane)) return pane;
      await pane.respawn(undefined, {
        ...(killFirst === undefined ? {} : { kill: killFirst }),
        ...(startDirectory === undefined ? {} : { startDirectory }),
      });
      const view = projectPane(await context.snapshot(), paneId, identity);
      if (isFailure(view)) return view;
      return ok({ pane: view }, paneLine(view));
    },
  );

  mcp.registerTool(
    "kill_pane",
    {
      annotations: DESTRUCTIVE,
      description:
        "Close a pane and the process in it. Refuses the pane this server runs in " +
        "and every pane a person is watching; force confirms only this server's exact caller pane.",
      inputSchema: { force: z.boolean().optional(), paneId: paneIdSchema },
      outputSchema: { killed: paneIdSchema },
      title: "Kill pane",
    },
    async ({ force, paneId }) => {
      const { identity, snapshot } = await context.observeInput();
      const pane = requireWritablePane(snapshot, identity, paneId, force, "kill");
      if (isFailure(pane)) return pane;
      await pane.kill();
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
      const { identity, snapshot } = await context.observeInput();
      const window = requireWindow(snapshot, windowId);
      if (isFailure(window)) return window;
      const inside = paneEntities(
        snapshot.panes.toArray().filter((pane) => pane.format.window_id === windowId),
      );
      for (const pane of inside) {
        const writable = requireWritablePane(snapshot, identity, pane.id, force, "kill");
        if (isFailure(writable)) return writable;
      }
      await window.kill();
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
      const { identity, snapshot } = await context.observeInput();
      const found = requireSession(snapshot, session);
      if (isFailure(found)) return found;
      const inside = paneEntities(
        snapshot.panes.toArray().filter((pane) => pane.format.session_id === found.id),
      );
      for (const pane of inside) {
        const writable = requireWritablePane(snapshot, identity, pane.id, force, "kill");
        if (isFailure(writable)) return writable;
      }
      await found.kill();
      return ok(
        { killed: found.id },
        `Killed session ${found.id}. Windows and panes shared with other sessions remain there.`,
      );
    },
  );
}
