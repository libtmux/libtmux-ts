/**
 * Building a whole workspace in one tool call.
 *
 * Calling `new_window` five times spends five tmux invocations and five
 * snapshots, because each has to find what it just made. A batch shares one
 * final snapshot — and, for the agent, one tool call replaces five plus a
 * `list_panes` call to learn the ids.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { TmuxCommandError, type PlannedOperation } from "libtmux";

import type { ToolContext } from "../context.js";
import { effectiveResultLines } from "../policy.js";
import { MUTATING_OPEN_WORLD, offers } from "../register.js";
import { fail, ok } from "../results.js";
import { sessionIdSchema } from "../schemas.js";
import {
  boundedStrings,
  limitViews,
  paneLine,
  paneView,
  paneViewSchema,
  renderViews,
} from "../views.js";

const FAILURE_METADATA_BYTES = 8 * 1_024;

const windowSpec = z.object({
  name: z.string().describe("Window name."),
  shellCommand: z
    .string()
    .optional()
    .describe("Run this instead of a shell. The window closes when it exits."),
  startDirectory: z.string().optional(),
});

function directoryOption(
  directory: string | undefined,
  fallback: string | undefined,
): { startDirectory?: string } {
  const effective = directory ?? fallback;
  return effective === undefined ? {} : { startDirectory: effective };
}

interface WorkspaceFailure {
  readonly metadataComplete: boolean;
  readonly omittedMetadataBytes: number;
  readonly reason: string;
  readonly windowIndex: number | null;
  readonly windowName: string | null;
}

function failedWindow(
  error: unknown,
  plans: readonly PlannedOperation<unknown>[],
  windows: readonly z.infer<typeof windowSpec>[],
): WorkspaceFailure {
  const matchingPlans =
    error instanceof TmuxCommandError
      ? plans.flatMap(({ argv }, index) =>
          argv.length === error.args.length &&
          argv.every((value, argumentIndex) => value === error.args[argumentIndex])
            ? [index]
            : [],
        )
      : [];
  const plannedIndex = matchingPlans.length === 1 ? matchingPlans[0]! : -1;
  const windowIndex = plannedIndex === -1 ? null : plannedIndex + 1;
  const reason = error instanceof Error ? error.message : String(error);
  const windowName = windowIndex === null ? null : (windows[windowIndex]?.name ?? null);
  const metadata = boundedStrings([reason, windowName ?? ""], FAILURE_METADATA_BYTES);
  return {
    metadataComplete: metadata.omittedBytes === 0,
    omittedMetadataBytes: metadata.omittedBytes,
    reason: metadata.values[0] ?? "",
    windowIndex,
    windowName: windowName === null ? null : (metadata.values[1] ?? ""),
  };
}

export function registerWorkspace(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "mutating")) return;

  mcp.registerTool(
    "build_workspace",
    {
      annotations: MUTATING_OPEN_WORLD,
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
        complete: z.boolean().describe("Whether every requested window was created."),
        failure: z
          .object({
            metadataComplete: z.boolean(),
            omittedMetadataBytes: z.number().int().nonnegative(),
            reason: z.string(),
            windowIndex: z.number().int().nonnegative().nullable(),
            windowName: z.string().nullable(),
          })
          .nullable(),
        omittedPanes: z.number().int().nonnegative(),
        panes: z
          .array(paneViewSchema)
          .describe("One per surviving window, in the order asked for."),
        resultComplete: z.boolean().describe("Whether every surviving pane fits in this result."),
        sessionId: sessionIdSchema,
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
        ...directoryOption(first.startDirectory, startDirectory),
      });

      const plans = rest.map((window) =>
        created.plan.newWindow({
          name: window.name,
          ...(window.shellCommand === undefined ? {} : { shellCommand: window.shellCommand }),
          ...directoryOption(window.startDirectory, startDirectory),
        }),
      );
      let failure: WorkspaceFailure | null = null;
      try {
        if (plans.length > 0) await context.tmux.batch(plans);
      } catch (error) {
        failure = failedWindow(error, plans, windows);
      } finally {
        // The session and any commands before a batch failure already changed
        // topology, so live tails must be invalidated on both result paths.
        context.topologyChanged();
      }

      const after = await context.snapshot();
      const identity = await context.identity(after);
      // Ordered so `panes[i]` is the window `windows[i]` described. Matched by
      // position rather than by name: tmux does not require a window name to be
      // unique, and three windows called "shell" resolved every lookup to the
      // first of them, reporting one pane three times. The windows were made in
      // this order, into a session made for them, so their index is the order
      // they were asked for.
      const inOrder = after.windows
        .toArray()
        .filter((entry) => entry.format.session_id === created.id)
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .slice(0, windows.length);
      const panes = inOrder
        .map((target) => after.panes.toArray().find((pane) => pane.format.window_id === target.id))
        .filter((pane) => pane !== undefined)
        .map((pane) => paneView(pane, identity));
      const bounded = limitViews(panes, effectiveResultLines(context.policy, undefined), paneLine);

      return ok(
        {
          complete: failure === null,
          failure,
          omittedPanes: bounded.omittedEntries,
          panes: bounded.views,
          resultComplete: bounded.complete,
          sessionId: created.id,
        },
        [
          `${failure === null ? "Built" : "Partially built"} ${session} (${created.id}) with ${String(panes.length)} windows:`,
          renderViews(bounded, "panes", "inspect the session with list_panes"),
          failure === null
            ? ""
            : `[stopped at window ${failure.windowIndex === null ? "unknown" : String(failure.windowIndex)}${failure.windowName === null ? "" : ` (${failure.windowName})`}: ${failure.reason}]`,
        ]
          .filter((part) => part !== "")
          .join("\n"),
      );
    },
  );
}
