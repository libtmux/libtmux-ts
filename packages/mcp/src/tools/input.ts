/**
 * Writing to panes.
 *
 * Two shapes, and choosing the wrong one is the most common way an agent wastes
 * a turn here. `run_shell_command` is for a shell command you wrote and want the
 * result of; `send_keys` is for keystrokes — a TUI, a signal, a partial line.
 */

import { randomUUID } from "node:crypto";

import type { Pane, ServerSnapshot } from "libtmux";
import { z } from "zod";

import type { CallerIdentity } from "../caller.js";
import {
  activeFramedCommand,
  reserveFramedCommand,
  runFramedCommand,
  type FramedCommandReservation,
} from "../command.js";
import type { ToolContext } from "../context.js";
import type { Policy } from "../policy.js";
import { effectiveResultLines, MAX_RESULT_BYTES } from "../policy.js";
import { OPEN_WORLD, type ToolRegistrar } from "../register.js";
import { boundText, fail, ok, renderBoundedText } from "../results.js";
import { framedCommandText, inlineRequestText, paneIdSchema } from "../schemas.js";
import {
  isFailure,
  requirePaneInputTarget,
  resolvedPaneInputTargetIds,
} from "../target_resolution.js";

/**
 * Shells whose syntax the command framing is written in.
 *
 * `run_shell_command` uses POSIX subshells, positional parameters, `printf`, and `$?`.
 * fish, csh, and PowerShell do not share that grammar, so a command framed for
 * them fails to parse and the wait runs to its deadline against a syntax error.
 */
const POSIX_SHELLS = new Set(["ash", "bash", "dash", "ksh", "mksh", "sh", "zsh"]);

/**
 * Shells the framing cannot address, named so the refusal can say which.
 *
 * Separate from "not a shell at all": one wants `send_keys`, the other wants a
 * different pane, and telling them apart is the difference between one more
 * call and several.
 */
const OTHER_SHELLS = new Set(["csh", "elvish", "fish", "ion", "nu", "pwsh", "tcsh", "xonsh"]);

/** tmux reports a login shell as `-zsh`; the leading dash is not part of it. */
function shellName(command: string): string {
  return command.replace(/^-/, "");
}

function commandFollowups(policy: Policy, paneId: string): string[] {
  const offered = (name: string): boolean => policy.tools === undefined || policy.tools.has(name);
  return [
    policy.liveEnabled && offered("wait_for_text")
      ? `wait_for_text on ${paneId} keeps waiting for it`
      : "",
    offered("send_keys") ? `send_keys with keys="C-c", enter=false, and force=true stops it` : "",
  ].filter((text) => text !== "");
}

function busyPane(policy: Policy, paneId: string, active: string): ReturnType<typeof fail> {
  const followups = commandFollowups(policy, paneId);
  return fail({
    hint:
      followups.length === 0
        ? "Wait for that command to finish before writing to the pane."
        : `Wait for that command to finish, or ${followups.join(", or ")}.`,
    reason: `Refusing to write into ${paneId}: run_shell_command ${active} is still active.`,
  });
}

interface RunPreflight {
  readonly pane: Pane;
  readonly signature: string;
}

const RUN_TRANSITION = Symbol("run-transition");

function runPreflight(
  context: ToolContext,
  snapshot: ServerSnapshot,
  identity: CallerIdentity,
  paneId: string,
  force: boolean | undefined,
  reservation?: FramedCommandReservation,
): ReturnType<typeof fail> | RunPreflight {
  const pane = requirePaneInputTarget(snapshot, identity, paneId, force, "run in");
  if (isFailure(pane)) return pane;
  const resolvedPaneIds = resolvedPaneInputTargetIds(pane);
  if (isFailure(resolvedPaneIds)) return resolvedPaneIds;

  for (const resolvedPaneId of resolvedPaneIds) {
    const writable = requirePaneInputTarget(snapshot, identity, resolvedPaneId, force, "run in");
    if (isFailure(writable)) return writable;
    const active =
      reservation?.conflictingCommand(resolvedPaneId) ??
      (reservation === undefined ? activeFramedCommand(context, resolvedPaneId) : undefined);
    if (active !== undefined && force !== true) {
      return busyPane(context.policy, resolvedPaneId, active);
    }
  }

  if (resolvedPaneIds.length !== 1 || resolvedPaneIds[0] !== paneId) {
    return fail({
      hint: "Disable synchronize-panes for this pane before running a framed command.",
      reason:
        `Refusing to run in ${paneId}: its configured input cohort contains ` +
        `${String(resolvedPaneIds.length)} panes (${resolvedPaneIds.join(", ")}).`,
    });
  }

  const rawCommand = pane.currentCommand;
  const running = shellName(typeof rawCommand === "string" ? rawCommand : "");
  if (!POSIX_SHELLS.has(running)) {
    return fail({
      hint: OTHER_SHELLS.has(running)
        ? "Use send_keys, or run the command in a pane running sh, bash, dash, or zsh."
        : "Use send_keys if input belongs to that program, or choose a pane at a supported POSIX shell prompt.",
      reason:
        running === ""
          ? `Pane ${paneId} has no trusted foreground shell state.`
          : `Pane ${paneId} is running ${running}, which run_shell_command cannot address.`,
    });
  }

  const sessionId = pane.format.session_id;
  const windowId = pane.window?.id ?? pane.format.window_id;
  if (
    typeof identity.serverPid !== "string" ||
    identity.serverPid === "" ||
    typeof sessionId !== "string" ||
    sessionId === "" ||
    typeof windowId !== "string" ||
    windowId === ""
  ) {
    return fail({
      hint: "Refresh the pane snapshot before running a framed command.",
      reason: `Pane ${paneId} has no usable daemon or placement identity.`,
    });
  }

  return {
    pane,
    signature: JSON.stringify({
      cohort: resolvedPaneIds,
      command: rawCommand,
      dead: pane.dead,
      mode: pane.inMode,
      paneId,
      serverPid: identity.serverPid,
      sessionId,
      synchronized: pane.synchronized,
      windowId,
    }),
  };
}

function runTransitionFailure(paneId: string): ReturnType<typeof fail> {
  return fail({
    hint: "Take a fresh snapshot and retry only after the pane is stable and unattended.",
    reason: `Pane ${paneId} changed during run_shell_command setup; no command was sent.`,
  });
}

export function registerInput(mcp: ToolRegistrar, context: ToolContext): void {
  mcp.registerTool(
    "send_keys",
    {
      annotations: OPEN_WORLD,
      description:
        "Send keystrokes to a pane. Use for TUIs, control keys (C-c), and partial " +
        "lines. For a shell command whose result you want, use run_shell_command — it " +
        "waits for completion and reports exit status, which this does not.",
      inputSchema: {
        enter: z.boolean().optional().describe("Press Enter afterwards. Default true."),
        force: z
          .boolean()
          .optional()
          .describe("Write even to this server's pane or one a person is watching. Default false."),
        keys: inlineRequestText("keys").describe(
          "Keys to send. tmux key names like C-c work unless literal is true.",
        ),
        literal: z
          .boolean()
          .optional()
          .describe("Send the text as-is, without resolving key names."),
        paneId: paneIdSchema,
      },
      outputSchema: {
        attended: z.boolean().describe("A person is watching a configured cohort member."),
        paneId: paneIdSchema,
        resolvedPaneIds: z
          .array(paneIdSchema)
          .describe("Configured cohort at the immediate preflight, not a delivery receipt."),
        sent: z.boolean(),
      },
      title: "Send keys",
    },
    async ({ enter, force, keys, literal, paneId }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requirePaneInputTarget(snapshot, identity, paneId, force, "type into");
      if (isFailure(pane)) return pane;
      const resolvedPaneIds = resolvedPaneInputTargetIds(pane);
      if (isFailure(resolvedPaneIds)) return resolvedPaneIds;
      for (const resolvedPaneId of resolvedPaneIds) {
        const writable = requirePaneInputTarget(
          snapshot,
          identity,
          resolvedPaneId,
          force,
          "type into",
        );
        if (isFailure(writable)) return writable;
        const active = activeFramedCommand(context, resolvedPaneId);
        if (active !== undefined && force !== true) {
          return busyPane(context.policy, resolvedPaneId, active);
        }
      }

      await pane.sendKeys(keys, {
        ...(enter === undefined ? {} : { enter }),
        ...(literal === undefined ? {} : { literal }),
      });
      const attended = resolvedPaneIds.some((id) => identity.attendedPaneIds.includes(id));
      const targetText = resolvedPaneIds.join(", ");
      return ok(
        { attended, paneId, resolvedPaneIds, sent: true },
        attended
          ? `Sent once to ${paneId}; configured input cohort at preflight: ${targetText}. Somebody is watching a configured member.`
          : `Sent once to ${paneId}; configured input cohort at preflight: ${targetText}.`,
      );
    },
  );

  mcp.registerTool(
    "paste_text",
    {
      annotations: OPEN_WORLD,
      description:
        "Put text into a pane without tmux interpreting any of it as key names. " +
        "Use for content — a password, a code block, anything with characters a " +
        "key parser would claim.",
      inputSchema: {
        enter: z.boolean().optional().describe("Press Enter afterwards. Default false."),
        force: z
          .boolean()
          .optional()
          .describe("Write even to this server's pane or one a person is watching. Default false."),
        paneId: paneIdSchema,
        text: inlineRequestText("text"),
      },
      outputSchema: { bytes: z.number().int(), paneId: paneIdSchema },
      title: "Paste text",
    },
    async ({ enter, force, paneId, text }) => {
      const firstSnapshot = await context.snapshot();
      const firstIdentity = await context.identity(firstSnapshot);
      const firstPane = requirePaneInputTarget(
        firstSnapshot,
        firstIdentity,
        paneId,
        force,
        "paste into",
      );
      if (isFailure(firstPane)) return firstPane;
      const active = activeFramedCommand(context, paneId);
      if (active !== undefined && force !== true) return busyPane(context.policy, paneId, active);

      if (text === "" && enter !== true) {
        return ok({ bytes: 0, paneId }, `Pasted 0 bytes into ${paneId}.`);
      }

      const bufferName = `ltx-mcp-paste-${randomUUID().replaceAll("-", "")}`;
      let loaded = false;
      try {
        await context.tmux.loadBuffer(bufferName, enter === true ? `${text}\n` : text);
        loaded = true;

        const finalSnapshot = await context.snapshot();
        const finalIdentity = await context.identity(finalSnapshot);
        const finalPane = requirePaneInputTarget(
          finalSnapshot,
          finalIdentity,
          paneId,
          force,
          "paste into",
        );
        if (isFailure(finalPane)) return finalPane;
        const finalActive = activeFramedCommand(context, paneId);
        if (finalActive !== undefined && force !== true) {
          return busyPane(context.policy, paneId, finalActive);
        }

        await finalPane.pasteBuffer(bufferName);
      } finally {
        try {
          await context.tmux.deleteBuffer(bufferName);
        } catch (error) {
          if (loaded) throw error;
        }
      }
      return ok(
        { bytes: Buffer.byteLength(text, "utf8"), paneId },
        `Pasted ${String(Buffer.byteLength(text, "utf8"))} bytes into ${paneId} only.`,
      );
    },
  );

  mcp.registerTool(
    "run_shell_command",
    {
      annotations: OPEN_WORLD,
      description:
        "Run a shell command in a pane, wait for it to finish, and report its exit " +
        "status and output. Prefer this over send_keys plus capture_pane: it frames " +
        "the command so a pane's echo of what you typed can never be mistaken for " +
        "what the command printed, and it knows when the command actually ended " +
        "rather than guessing from the screen. The command runs in a subshell, so " +
        "cd and export do not persist to a later call. A pane is effectively " +
        "single-writer: this server reserves it until the command settles, but " +
        "another process with the same tmux socket can still write into it.",
      inputSchema: {
        command: framedCommandText("command").describe("The shell command to run."),
        force: z
          .boolean()
          .optional()
          .describe("Write despite caller or pane-attention protection. Default false."),
        maxLines: z.number().int().positive().optional(),
        paneId: paneIdSchema,
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How long to wait. Clamped by the server ceiling; the result says what was used.",
          ),
      },
      outputSchema: {
        effectiveTimeoutMs: z.number().int().describe("The timeout actually enforced."),
        droppedLines: z
          .number()
          .int()
          .describe(
            "Lines of output withheld by maxLines. The text half says so in a " +
              "notice; a caller reading only the structured half would otherwise " +
              "take the tail for the whole.",
          ),
        missedBytes: z
          .number()
          .int()
          .describe(
            "Output that fell out of the pane's buffer before this read reached it. " +
              "Nonzero means the command printed more than was kept, so the output here " +
              "starts partway through it.",
          ),
        omittedBytes: z.number().int().describe("Output bytes omitted by the result ceiling."),
        foreignOutputSuspected: z
          .boolean()
          .describe(
            "Another writer printed into this pane while the command ran. Output " +
              "that could be attributed to them was removed; what is left may still " +
              "include theirs. False means no foreign marker was seen, not that the " +
              "output is certainly this command's.",
          ),
        exitStatus: z
          .number()
          .int()
          .nullable()
          .describe("The command's exit status; null if it did not finish."),
        outcome: z
          .enum(["completed", "timed_out", "pane_died", "cancelled"])
          .describe("Why this returned. Read it rather than inferring from the text."),
        output: z.string().describe("The bounded tail of the command's output."),
        outputComplete: z
          .boolean()
          .describe("False when capture or result limits omitted any command output."),
        paneId: paneIdSchema,
        returnedBytes: z.number().int().describe("UTF-8 output bytes returned."),
        stillRunning: z
          .boolean()
          .describe("Whether the command may still be running after this call returned."),
      },
      title: "Run a shell command and wait",
    },
    async ({ command, force, maxLines, paneId, timeoutMs }, extra) => {
      if (command.trim() === "") {
        return fail({ reason: "command must not be empty." });
      }
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const initial = runPreflight(context, snapshot, identity, paneId, force);
      if (isFailure(initial)) return initial;

      const reservation = reserveFramedCommand(context, paneId, command);
      let result: Awaited<ReturnType<typeof runFramedCommand>>;
      try {
        result = await runFramedCommand(
          context,
          initial.pane,
          command,
          timeoutMs,
          extra.signal,
          true,
          async () => {
            let final: ReturnType<typeof runPreflight>;
            try {
              const finalSnapshot = await context.snapshot(extra.signal);
              const finalIdentity = await context.identity(finalSnapshot);
              final = runPreflight(
                context,
                finalSnapshot,
                finalIdentity,
                paneId,
                force,
                reservation,
              );
            } catch {
              throw RUN_TRANSITION;
            }
            if (isFailure(final) || final.signature !== initial.signature) {
              throw RUN_TRANSITION;
            }
            return final.pane;
          },
        );
      } catch (error) {
        reservation.release();
        if (error === RUN_TRANSITION) return runTransitionFailure(paneId);
        throw error;
      }
      reservation.settleWith(result.settled);
      const bounded = boundText(
        result.output === "" ? [] : result.output.split("\n"),
        effectiveResultLines(context.policy, maxLines),
        MAX_RESULT_BYTES,
      );
      const outputComplete =
        result.outputComplete && bounded.droppedLines === 0 && bounded.omittedBytes === 0;
      const stillRunning =
        result.commandStarted && (result.outcome === "timed_out" || result.outcome === "cancelled");
      const followups = stillRunning ? commandFollowups(context.policy, paneId) : [];

      let headline: string;
      switch (result.outcome) {
        case "completed":
          headline = `exit ${String(result.exitStatus)}`;
          break;
        case "pane_died":
          headline = result.commandStarted
            ? "the pane exited while the command ran"
            : "the pane exited before the command started";
          break;
        case "cancelled":
          headline = stillRunning
            ? `request cancelled after the command started; it may still be running${followups.length === 0 ? "" : ` — ${followups.join(", or ")}`}`
            : "request cancelled before the command started";
          break;
        case "timed_out":
          // Not "call again": a second call mints a fresh marker and sends a
          // whole new command, so it cannot resume this wait even in principle.
          headline = stillRunning
            ? `still running after ${String(result.effectiveTimeoutMs)}ms${followups.length === 0 ? "" : ` — ${followups.join(", or ")}`}`
            : `did not start within ${String(result.effectiveTimeoutMs)}ms`;
          break;
      }

      return ok(
        {
          effectiveTimeoutMs: result.effectiveTimeoutMs,
          exitStatus: result.exitStatus,
          foreignOutputSuspected: result.foreignOutputSuspected,
          droppedLines: bounded.droppedLines,
          missedBytes: result.missedBytes,
          omittedBytes: bounded.omittedBytes,
          outcome: result.outcome,
          output: bounded.text,
          outputComplete,
          paneId,
          returnedBytes: bounded.returnedBytes,
          stillRunning,
        },
        `${renderBoundedText(
          bounded,
          "raise maxLines within the server limit or pipe large output before running",
        )}\n\n[${headline}]${
          outputComplete ? "" : "\n[some command output was omitted by capture or result limits]"
        }${
          result.foreignOutputSuspected
            ? "\n[another writer printed into this pane while the command ran; " +
              "output attributable to them was removed, what remains may still be theirs]"
            : ""
        }`,
      );
    },
  );
}
