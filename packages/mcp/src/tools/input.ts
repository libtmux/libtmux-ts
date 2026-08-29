/**
 * Writing to panes.
 *
 * Two shapes, and choosing the wrong one is the most common way an agent wastes
 * a turn here. `run_command` is for a shell command you wrote and want the
 * result of; `send_keys` is for keystrokes — a TUI, a signal, a partial line.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { effectiveResultLines, MAX_RESULT_BYTES } from "../policy.js";
import { offers, OPEN_WORLD } from "../register.js";
import { boundText, fail, ok, renderBoundedText } from "../results.js";
import { paneIdSchema } from "../schemas.js";
import { isFailure, requireWritablePane } from "../target_resolution.js";
import { activeFramedCommand, reserveFramedCommand, runFramedCommand } from "../command.js";

/**
 * Shells whose syntax the command framing is written in.
 *
 * `run_command` uses POSIX subshells, positional parameters, `printf`, and `$?`.
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

function busyPane(paneId: string, active: string): ReturnType<typeof fail> {
  return fail({
    hint:
      "Wait for that command to finish, use wait_for_text for its output, or pass force " +
      "to accept interleaved input. Pass force to send C-c when stopping it is the intent.",
    reason: `Refusing to write into ${paneId}: run_command ${active} is still active.`,
  });
}

export function registerInput(mcp: McpServer, context: ToolContext): void {
  if (!offers(context.policy, "mutating")) return;

  mcp.registerTool(
    "send_keys",
    {
      annotations: OPEN_WORLD,
      description:
        "Send keystrokes to a pane. Use for TUIs, control keys (C-c), and partial " +
        "lines. For a shell command whose result you want, use run_command — it " +
        "waits for completion and reports exit status, which this does not.",
      inputSchema: {
        enter: z.boolean().optional().describe("Press Enter afterwards. Default true."),
        force: z
          .boolean()
          .optional()
          .describe("Write even to this server's pane or one a person is watching. Default false."),
        keys: z
          .string()
          .describe("Keys to send. tmux key names like C-c work unless literal is true."),
        literal: z
          .boolean()
          .optional()
          .describe("Send the text as-is, without resolving key names."),
        paneId: paneIdSchema,
      },
      outputSchema: {
        attended: z.boolean().describe("A person is watching the pane this was sent to."),
        paneId: paneIdSchema,
        sent: z.boolean(),
      },
      title: "Send keys",
    },
    async ({ enter, force, keys, literal, paneId }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requireWritablePane(snapshot, identity, paneId, force, "type into");
      if (isFailure(pane)) return pane;
      const active = activeFramedCommand(context, paneId);
      if (active !== undefined && force !== true) return busyPane(paneId, active);

      await pane.sendKeys(keys, {
        ...(enter === undefined ? {} : { enter }),
        ...(literal === undefined ? {} : { literal }),
      });
      const attended = identity.attendedPaneIds.includes(paneId);
      return ok(
        { attended, paneId, sent: true },
        attended ? `Sent to ${paneId}. Somebody is watching that pane.` : `Sent to ${paneId}.`,
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
        text: z.string(),
      },
      outputSchema: { bytes: z.number().int(), paneId: paneIdSchema },
      title: "Paste text",
    },
    async ({ enter, force, paneId, text }) => {
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requireWritablePane(snapshot, identity, paneId, force, "paste into");
      if (isFailure(pane)) return pane;
      const active = activeFramedCommand(context, paneId);
      if (active !== undefined && force !== true) return busyPane(paneId, active);
      await pane.sendKeys(text, { enter: enter ?? false, literal: true });
      return ok(
        { bytes: Buffer.byteLength(text, "utf8"), paneId },
        `Pasted ${String(Buffer.byteLength(text, "utf8"))} bytes into ${paneId}.`,
      );
    },
  );

  mcp.registerTool(
    "run_command",
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
        command: z.string().describe("The shell command to run."),
        force: z
          .boolean()
          .optional()
          .describe("Override pane-attention and shell-prompt checks. Default false."),
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
          .enum(["completed", "timed_out", "pane_died"])
          .describe("Why this returned. Read it rather than inferring from the text."),
        output: z.string().describe("The bounded tail of the command's output."),
        outputComplete: z
          .boolean()
          .describe("False when capture or result limits omitted any command output."),
        paneId: paneIdSchema,
        returnedBytes: z.number().int().describe("UTF-8 output bytes returned."),
        stillRunning: z
          .boolean()
          .describe("True when it timed out; the command keeps running in the pane."),
      },
      title: "Run a command and wait",
    },
    async ({ command, force, maxLines, paneId, timeoutMs }, extra) => {
      if (command.trim() === "") {
        return fail({ reason: "command must not be empty." });
      }
      const snapshot = await context.snapshot();
      const identity = await context.identity(snapshot);
      const pane = requireWritablePane(snapshot, identity, paneId, force, "run in");
      if (isFailure(pane)) return pane;
      const active = activeFramedCommand(context, paneId);
      if (active !== undefined && force !== true) {
        return busyPane(paneId, active);
      }
      if (pane.dead === true) {
        // Not a `force` case: a dead pane has no process to read the command,
        // so forcing it would spend the whole timeout waiting for a marker
        // that cannot be printed. The shell check below would pass — a dead
        // pane still reports the command it last ran.
        return fail({
          hint: "respawn_pane restarts a pane's command, keeping the pane and its id.",
          reason:
            `Pane ${paneId} is dead: its process exited and the pane is kept only because ` +
            `remain-on-exit is set, so nothing there can run a command.`,
        });
      }
      const running = shellName(pane.currentCommand ?? "");
      if (OTHER_SHELLS.has(running)) {
        // Not a `force` case: forcing it would send POSIX syntax to a shell
        // that cannot parse it, and the wait would run to its deadline against
        // an error message.
        return fail({
          hint:
            "This tool frames commands in POSIX shell syntax, which that shell does not " +
            "share. Use send_keys, or run the command in a pane running sh, bash, or zsh.",
          reason: `Pane ${paneId} is running ${running}, which run_command cannot address.`,
        });
      }
      if (force !== true && !POSIX_SHELLS.has(running)) {
        return fail({
          hint:
            "A shell command typed into a program that is not a shell goes to that program. " +
            "Use send_keys if that is what you meant, or pass force.",
          reason: `Pane ${paneId} is running ${running === "" ? "an unknown command" : running}, not a shell.`,
        });
      }

      const reservation = reserveFramedCommand(context, paneId, command);

      const result = await runFramedCommand(context, pane, command, timeoutMs, extra.signal).catch(
        (error: unknown) => {
          reservation.release();
          throw error;
        },
      );
      reservation.settleWith(result.settled);
      const bounded = boundText(
        result.output === "" ? [] : result.output.split("\n"),
        effectiveResultLines(context.policy, maxLines),
        MAX_RESULT_BYTES,
      );
      const outputComplete =
        result.outputComplete && bounded.droppedLines === 0 && bounded.omittedBytes === 0;

      const headline =
        result.outcome === "completed"
          ? `exit ${String(result.exitStatus ?? -1)}`
          : result.outcome === "pane_died"
            ? "the pane exited while the command ran"
            : // Not "call again": a second call mints a fresh marker and sends a
              // whole new command, so it cannot resume this wait even in
              // principle — and the shell guard refuses it anyway, because the
              // pane is now running the first command rather than a shell.
              `still running after ${String(result.effectiveTimeoutMs)}ms — wait_for_text on ${paneId} keeps waiting for it, or send_keys C-c stops it`;

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
          stillRunning: result.outcome === "timed_out",
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
