/**
 * Building a whole workspace in one invocation.
 *
 * Calling `new_window` five times spends five tmux invocations and five
 * snapshots, because each has to find what it just made. A batch spends one of
 * each for the group — and, for the agent, one tool call instead of five plus a
 * `list_panes` to learn the ids.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { MUTATING, offers } from "../register.js";
import { fail, ok } from "../results.js";
import { paneLine, paneView, paneViewSchema } from "../views.js";

const windowSpec = z.object({
  name: z.string().describe("Window name."),
  shellCommand: z
    .string()
    .optional()
    .describe("Run this instead of a shell. The window closes when it exits."),
  startDirectory: z.string().optional(),
});

export function registerWorkspace(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "mutating")) return;

  mcp.registerTool(
    "build_workspace",
    {
      annotations: MUTATING,
      description:
        "Create a session and all of its windows at once, and get back every pane " +
        "id. Use this instead of new_session followed by a new_window per window: " +
        "it is one tmux invocation rather than one per window, and it saves the " +
        "list_panes you would otherwise need to learn what it made. Not atomic — " +
        "tmux stops at the first failure and leaves what came before it, so the " +
        "result lists what actually exists.",
      inputSchema: {
        session: z.string().describe("Name for the session. It must not already exist."),
        startDirectory: z.string().optional().describe("Default directory for every window."),
        windows: z.array(windowSpec).min(1).describe("The windows to create, in order."),
      },
      outputSchema: {
        panes: z.array(paneViewSchema).describe("One per window, in the order asked for."),
        sessionId: z.string(),
      },
      title: "Build a workspace",
    },
    async ({ session, startDirectory, windows }) => {
      const before = await context.snapshot();
      if (before.sessions.exists({ name: session })) {
        return fail({
          hint: "Pick another name, or kill_session first.",
          reason: `A session named ${session} already exists.`,
        });
      }

      // The session brings its own first window, so the first spec names that
      // one and only the rest are created.
      const [first, ...rest] = windows;
      if (first === undefined) return fail({ reason: "windows must not be empty." });

      const created = await context.tmux.newSession({
        name: session,
        windowName: first.name,
        ...(first.shellCommand === undefined ? {} : { shellCommand: first.shellCommand }),
        ...((first.startDirectory ?? startDirectory === undefined)
          ? {}
          : { startDirectory: first.startDirectory ?? startDirectory }),
      });

      if (rest.length > 0) {
        await context.tmux.batch(
          rest.map((window) =>
            created.plan.newWindow({
              name: window.name,
              ...(window.shellCommand === undefined ? {} : { shellCommand: window.shellCommand }),
              ...((window.startDirectory ?? startDirectory === undefined)
                ? {}
                : { startDirectory: window.startDirectory ?? startDirectory }),
            }),
          ),
        );
      }

      const after = await context.snapshot();
      const identity = await context.identity(after);
      // Ordered by the names asked for rather than by tmux's window index, so
      // `panes[i]` is the window `windows[i]` described.
      const panes = windows
        .map((window) => {
          const target = after.windows
            .toArray()
            .find((entry) => entry.sessionId === created.id && entry.name === window.name);
          return target === undefined
            ? undefined
            : after.panes.toArray().find((pane) => pane.windowId === target.id);
        })
        .filter((pane) => pane !== undefined)
        .map((pane) => paneView(pane, identity));

      context.topologyChanged();
      return ok(
        { panes, sessionId: created.id },
        `Built ${session} (${created.id}) with ${String(panes.length)} windows:\n${panes.map(paneLine).join("\n")}`,
      );
    },
  );
}
