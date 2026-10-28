/**
 * Writing to panes.
 *
 * Two shapes, and choosing the wrong one is the most common way an agent wastes
 * a turn here. `run_shell_command` is for a shell command you wrote and want the
 * result of; `send_keys` is for keystrokes — a TUI, a signal, a partial line.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LibTmuxError, TmuxTransportError, VersionTooLowError, type Pane } from "libtmux";
import { z } from "zod";

import {
  isPaneInputConflict,
  reserveFramedCommand,
  reservePaneInput,
  runFramedCommand,
  type FramedResult,
} from "../command.js";
import type { ToolContext } from "../context.js";
import { noteLiteralWrite } from "../pane_echo.js";
import {
  busyPane,
  dispatchPaneKeys,
  paneInputChanged,
  planPaneInput,
  type PaneInputPlan,
} from "../pane_input.js";
import type { Policy } from "../policy.js";
import { effectiveResultLines, effectiveWaitMs, MAX_RESULT_BYTES } from "../policy.js";
import { type ToolRegistrar } from "../register.js";
import { boundText, fail, ok, renderBoundedText } from "../results.js";
import {
  fitsInlineRequest,
  framedCommandText,
  inlineRequestText,
  paneIdSchema,
} from "../schemas.js";
import { shellQuote } from "../startup.js";
import { isFailure } from "../target_resolution.js";

/** How long reading a shell's environment may take; `env` answers at once from an idle shell. */
const INHERIT_TIMEOUT_MS = 10_000;
/** The most stdin `run_program` takes, which it writes to a file rather than typing. */
const MAX_INPUT_BYTES = 1_048_576;

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

/**
 * Run `command` in a pane's idle POSIX shell through the framing, holding the
 * pane's input for the run, or answer why it cannot be run there.
 */
async function runInShell(
  context: ToolContext,
  paneId: string,
  command: string,
  force: boolean | undefined,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<FramedResult | ReturnType<typeof fail>> {
  const initialPlan = planPaneInput(await context.observeInput(signal), paneId, force, "run in");
  if (isFailure(initialPlan)) return initialPlan;
  const initial = runPreflight(initialPlan, paneId);
  if (isFailure(initial)) return initial;

  const reservation = reserveFramedCommand(initial.plan.observation.authority, paneId, command);
  if (isPaneInputConflict(reservation)) return busyPane(reservation);
  let result: FramedResult;
  try {
    result = await runFramedCommand(
      context,
      initial.pane,
      command,
      timeoutMs,
      signal,
      true,
      async () => {
        let final: ReturnType<typeof runPreflight>;
        try {
          const finalPlan = planPaneInput(await context.observeInput(), paneId, force, "run in");
          if (isFailure(finalPlan)) throw RUN_TRANSITION;
          final = runPreflight(finalPlan, paneId);
        } catch {
          throw RUN_TRANSITION;
        }
        if (isFailure(final) || final.signature !== initial.signature) {
          throw RUN_TRANSITION;
        }
        return final.pane;
      },
      initial.plan.observation.authority,
    );
  } catch (error) {
    reservation.release();
    if (error === RUN_TRANSITION) return runTransitionFailure(paneId);
    throw error;
  }
  reservation.settleWith(result.settled);
  return result;
}

/** A variable name a POSIX shell can export; `env` also lists names such as `BASH_FUNC_f%%`. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Variables a shell exported, from `env -0` output, as a file `sh` can source.
 * TMUX_PANE names the shell's own pane, which the program's pane is not.
 */
export function sourceableEnvironment(dump: string): string {
  return dump
    .split("\0")
    .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])
    .filter(([name = ""]) => SHELL_NAME.test(name) && name !== "TMUX_PANE")
    .map(([name = "", value = ""]) => `export ${name}=${shellQuote(value)}\n`)
    .join("");
}

/**
 * Read the variables a pane's shell exported, by typing one framed `env -0` into
 * it, and return the file the program sources before it starts.
 */
async function inheritedEnvironment(
  context: ToolContext,
  paneId: string,
  directory: string,
  signal: AbortSignal,
): Promise<string | ReturnType<typeof fail>> {
  const dump = join(directory, "env");
  const ran = await runInShell(
    context,
    paneId,
    `env -0 > ${shellQuote(dump)}`,
    false,
    INHERIT_TIMEOUT_MS,
    signal,
  );
  if (isFailure(ran)) return ran;
  if (ran.outcome !== "completed" || ran.exitStatus !== 0) {
    return fail({
      hint: "Run without inheritShell, or check the pane's shell with capture_pane.",
      reason: `Reading the shell's environment ended with ${ran.outcome === "completed" ? `exit ${String(ran.exitStatus)}` : ran.outcome}; no program was started.`,
    });
  }
  let text: string;
  try {
    text = await readFile(dump, "utf8");
  } catch {
    return fail({
      hint: "Run without inheritShell: the pane's shell is on another machine than this server.",
      reason: "The pane's shell wrote its environment where this server cannot read it.",
    });
  }
  const sourced = join(directory, "environment.sh");
  await writeFile(sourced, sourceableEnvironment(text), { mode: 0o600 });
  return sourced;
}

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
  ].filter((text) => text !== "");
}

interface RunPreflight {
  readonly pane: Pane;
  readonly plan: PaneInputPlan;
  readonly signature: string;
}

const RUN_TRANSITION = Symbol("run-transition");

function runPreflight(plan: PaneInputPlan, paneId: string): ReturnType<typeof fail> | RunPreflight {
  const { pane, resolvedPaneIds } = plan;
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

  return {
    pane,
    plan,
    signature: plan.signature,
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
      description:
        "Send keystrokes to a pane. Use for TUIs, control keys (C-c), and partial " +
        "lines. For a shell command whose result you want, use run_shell_command — it " +
        "waits for completion and reports exit status, which this does not. For only a " +
        "program's own output, use run_program.",
      inputSchema: {
        enter: z.boolean().optional().describe("Press Enter afterwards. Default true."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Allow writing to the pane this server itself was called from, which is " +
              "otherwise refused. It does not override the refusal to write to a pane " +
              "a person is watching — a pane an attached client has on screen is " +
              "still refused with force.",
          ),
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
      const initial = planPaneInput(await context.observeInput(), paneId, force, "type into");
      if (isFailure(initial)) return initial;
      const reserved = reservePaneInput(
        initial.observation.authority,
        initial.resolvedPaneIds,
        "input",
        "send_keys",
      );
      if (isPaneInputConflict(reserved)) return busyPane(reserved);
      try {
        const final = planPaneInput(await context.observeInput(), paneId, force, "type into");
        if (isFailure(final) || final.signature !== initial.signature) {
          return paneInputChanged(paneId, "send_keys");
        }
        await dispatchPaneKeys(final.pane, keys, {
          ...(enter === undefined ? {} : { enter }),
          identity: final.observation.authority,
          ...(literal === undefined ? {} : { literal }),
        });
        const attended = final.resolvedPaneIds.some((id) =>
          final.observation.identity.attendedPaneIds.includes(id),
        );
        const targetText = final.resolvedPaneIds.join(", ");
        return ok(
          { attended, paneId, resolvedPaneIds: final.resolvedPaneIds, sent: true },
          attended
            ? `Sent once to ${paneId}; configured input cohort at preflight: ${targetText}. Somebody is watching a configured member.`
            : `Sent once to ${paneId}; configured input cohort at preflight: ${targetText}.`,
        );
      } finally {
        reserved.release();
      }
    },
  );

  mcp.registerTool(
    "paste_text",
    {
      description:
        "Put text into a pane without tmux interpreting any of it as key names. " +
        "Use for content — a password, a code block, anything with characters a " +
        "key parser would claim.",
      inputSchema: {
        enter: z.boolean().optional().describe("Press Enter afterwards. Default false."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Allow writing to the pane this server itself was called from, which is " +
              "otherwise refused. It does not override the refusal to write to a pane " +
              "a person is watching — a pane an attached client has on screen is " +
              "still refused with force.",
          ),
        paneId: paneIdSchema,
        text: inlineRequestText("text").describe(
          "Text to paste. Sent through a tmux buffer, so a shell's line editor does " +
            "not redraw on every character.",
        ),
      },
      outputSchema: { bytes: z.number().int(), paneId: paneIdSchema },
      title: "Paste text",
    },
    async ({ enter, force, paneId, text }) => {
      // A private buffer is created and must be deleted by name, and tmux
      // before 3.4 can delete a different buffer when the name is missing.
      if (!(await context.tmux.versionAtLeast("3.4"))) {
        return fail({
          hint: "send_keys with literal text types it without a buffer, or run this server against tmux 3.4 or newer.",
          reason: `paste_text needs tmux 3.4 or newer; this server is ${(await context.tmux.version()).raw}.`,
        });
      }

      const initial = planPaneInput(await context.observeInput(), paneId, force, "paste into");
      if (isFailure(initial)) return initial;

      if (text === "" && enter !== true) {
        return ok({ bytes: 0, paneId }, `Pasted 0 bytes into ${paneId}.`);
      }
      const reserved = reservePaneInput(
        initial.observation.authority,
        initial.resolvedPaneIds,
        "input",
        "paste_text",
      );
      if (isPaneInputConflict(reserved)) return busyPane(reserved);
      const bufferName = `ltx-mcp-paste-${randomUUID().replaceAll("-", "")}`;
      let cleanupRequired = false;
      let operationFailure: { readonly error: unknown } | undefined;
      let cleanupFailure: { readonly error: unknown } | undefined;
      let refusal: ReturnType<typeof fail> | undefined;
      try {
        cleanupRequired = true;
        try {
          await context.tmux.cmd("load-buffer", ["-b", bufferName, "-"], {
            stdin: enter === true ? `${text}\n` : text,
            target: null,
            timeoutMs: context.policy.commandTimeoutMs,
          });
        } catch (error) {
          if (error instanceof TmuxTransportError && error.delivery === "not_started") {
            cleanupRequired = false;
          }
          operationFailure = { error };
        }
        if (operationFailure === undefined) {
          try {
            const final = planPaneInput(await context.observeInput(), paneId, force, "paste into");
            if (isFailure(final) || final.signature !== initial.signature) {
              refusal = paneInputChanged(paneId, "paste_text");
            } else {
              // Recorded before the paste, not after: tmux can relay the
              // resulting echo to an already-subscribed wait before this
              // call's own paste confirmation returns.
              noteLiteralWrite(final.pane.id, final.observation.authority, text, enter === true);
              await final.pane.pasteBuffer(bufferName);
            }
          } catch (error) {
            operationFailure = { error };
          }
        }
        if (cleanupRequired) {
          try {
            await context.tmux.cmd("delete-buffer", ["-b", bufferName], {
              target: null,
              timeoutMs: context.policy.commandTimeoutMs,
            });
          } catch (error) {
            cleanupFailure = { error };
          }
        }
        if (operationFailure !== undefined && cleanupFailure !== undefined) {
          throw new AggregateError(
            [operationFailure.error, cleanupFailure.error],
            "paste failed and private buffer cleanup also failed",
          );
        }
        if (refusal !== undefined && cleanupFailure !== undefined) {
          const content = refusal.content[0];
          const reason =
            content?.type === "text" ? content.text : "pane input changed before paste";
          throw new AggregateError(
            [new Error(reason, { cause: refusal }), cleanupFailure.error],
            "paste was refused and private buffer cleanup also failed",
          );
        }
        if (operationFailure !== undefined) throw operationFailure.error;
        if (cleanupFailure !== undefined) throw cleanupFailure.error;
        if (refusal !== undefined) return refusal;
        return ok(
          { bytes: Buffer.byteLength(text, "utf8"), paneId },
          `Pasted ${String(Buffer.byteLength(text, "utf8"))} bytes into ${paneId} only.`,
        );
      } finally {
        reserved.release();
      }
    },
  );

  mcp.registerTool(
    "run_shell_command",
    {
      description:
        "Run a shell command in a pane, wait for it to finish, and report its exit " +
        "status and output. Prefer this over send_keys plus capture_pane: it frames " +
        "the command so a pane's echo of what you typed can never be mistaken for " +
        "what the command printed, and it knows when the command actually ended " +
        "rather than guessing from the screen. The command runs in a subshell, so " +
        "cd and export do not persist to a later call. A pane is effectively " +
        "single-writer: this server reserves it until the command settles, but " +
        "another process with the same tmux socket can still write into it. When the " +
        "pane's shell does not matter, run_program returns only the program's output.",
      inputSchema: {
        command: framedCommandText("command").describe("The shell command to run."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Allow writing to the pane this server itself was called from, which is " +
              "otherwise refused. It does not override the refusal to write to a pane " +
              "a person is watching — a pane an attached client has on screen is " +
              "still refused with force.",
          ),
        maxLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Keep at most this many lines, from the end. Defaults to the server limit."),
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
      const result = await runInShell(context, paneId, command, force, timeoutMs, extra.signal);
      if (isFailure(result)) return result;
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
  mcp.registerTool(
    "run_program",
    {
      description:
        "Run a program in a pane of its own and return its output and exit status. " +
        "It runs in a fresh detached session with the tmux server's environment, or with " +
        "fromPaneId beside that pane, in its session and directory. " +
        "No shell parses argv and nothing is typed, so the output holds no command line or echo. " +
        "The pane is removed before this returns, unless keep leaves it for a person. " +
        "A program still running at the timeout is ended. " +
        "Commands are found on the tmux server's PATH; exit 127 means not found. " +
        "Its stdin is input when given, else the terminal, so one that prompts waits until the " +
        "timeout. PAGER and GIT_PAGER are cat unless argv sets them with the env command. " +
        'Use ["sh", "-c", ...] for pipes and redirections. ' +
        "inheritShell adds the variables a fromPaneId shell exported; run_shell_command runs " +
        "shell builtins such as cd. Requires tmux 3.8 or newer.",
      inputSchema: {
        argv: z
          .array(inlineRequestText("argv item"))
          .min(1)
          .max(256)
          .refine(
            (values) =>
              values[0] !== "" && values[0]?.startsWith("-") !== true && fitsInlineRequest(values),
            {
              message:
                "argv must name a program, not starting with -, and fit one tmux command line.",
            },
          )
          .describe(
            'The program and its arguments, as given: ["git", "status", "--short"]. Put ' +
              'variables first with env: ["env", "CI=1", "make", "test"].',
          ),
        fromPaneId: paneIdSchema
          .optional()
          .describe(
            "Run beside this pane, in its directory and session, with that session's tmux " +
              "environment. Variables the pane's shell exported come only with inheritShell.",
          ),
        inheritShell: z
          .boolean()
          .optional()
          .describe(
            "With fromPaneId, first read the variables that pane's idle shell exported, by " +
              "typing one env command into it, then run the program with them. The shell " +
              "must be a POSIX one at its prompt, as run_shell_command requires.",
          ),
        input: z
          .string()
          .refine((value) => Buffer.byteLength(value) <= MAX_INPUT_BYTES, {
            message: `input must be at most ${String(MAX_INPUT_BYTES)} bytes.`,
          })
          .optional()
          .describe(
            "Text the program reads as its stdin, written to a private file rather than typed, " +
              "so no shell quotes it. Needs the tmux server on this machine.",
          ),
        keep: z
          .boolean()
          .optional()
          .describe(
            "Leave the pane, dead and showing the output, for a person to read and close. " +
              "Set it only when a person asked to see the run; the pane is then theirs.",
          ),
        height: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .describe("Rows of the program's terminal. Defaults to tmux's default-size."),
        maxLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Keep at most this many lines, from the end. Defaults to the server limit."),
        placement: z
          .enum(["window", "split"])
          .optional()
          .describe(
            'With fromPaneId: "window", the default, is a background window of its session; ' +
              '"split" splits that pane, so a person watching it sees the run. Focus stays put.',
          ),
        startDirectory: inlineRequestText("startDirectory")
          .optional()
          .describe(
            "Directory the program starts in, taken literally. Defaults to the directory this " +
              "MCP server was started in, or the fromPaneId pane's. One that cannot be entered " +
              "ends the run with exitStatus 126 before the program starts.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How long to let it run; 30 s by default and clamped by the server ceiling. " +
              "The result says what was used.",
          ),
        width: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .describe(
            "Columns of the program's terminal. A program that formats to its width — ls, " +
              "ps, git log --graph — lays out to this at the source.",
          ),
      },
      outputSchema: {
        droppedLines: z.number().int().describe("Lines of output withheld by maxLines."),
        effectiveTimeoutMs: z.number().int().describe("The timeout actually enforced."),
        exitStatus: z
          .number()
          .int()
          .nullable()
          .describe(
            "The exit status. Null in two cases: a signal ended the program (see signal), or " +
              "the timeout did (outcome timed_out, signal null).",
          ),
        omittedBytes: z.number().int().describe("Output bytes omitted by the result ceiling."),
        outcome: z
          .enum(["completed", "timed_out"])
          .describe(
            "completed: it ended on its own, or by the signal reported. timed_out: it was " +
              "ended at the timeout, so a retry starts a new run.",
          ),
        output: z
          .string()
          .describe(
            "The bounded tail of what the program printed, as its terminal shows it; stderr " +
              "and stdout share it.",
          ),
        outputComplete: z
          .boolean()
          .describe("False when scrollback or result limits omitted any of the output."),
        returnedBytes: z.number().int().describe("UTF-8 output bytes returned."),
        signal: z
          .string()
          .nullable()
          .describe(
            'The signal that ended the program, such as "SIGTERM"; otherwise null. An exit ' +
              "status above 128 reads as the signal it encodes, as a shell reports one.",
          ),
      },
      title: "Run a program and wait",
    },
    async (
      {
        argv,
        fromPaneId,
        height,
        inheritShell,
        input,
        keep,
        maxLines,
        placement,
        startDirectory,
        timeoutMs,
        width,
      },
      extra,
    ) => {
      const effectiveTimeoutMs = effectiveWaitMs(context.policy, timeoutMs);
      let from: Pane | undefined;
      if (fromPaneId === undefined) {
        if (placement !== undefined || inheritShell === true) {
          return fail({
            hint: "Name the pane to run beside with fromPaneId.",
            reason: "placement and inheritShell run beside a pane, and none was given.",
          });
        }
      } else {
        if (width !== undefined || height !== undefined) {
          return fail({
            hint: "Leave width and height out; the pane takes that session's size.",
            reason: "fromPaneId runs in that pane's session, whose size is its own.",
          });
        }
        from = (await context.tmux.panes()).toArray().find((pane) => pane.id === fromPaneId);
        if (from === undefined) {
          return fail({
            hint: "list_panes shows the panes that exist.",
            reason: `No pane ${fromPaneId} to start from.`,
          });
        }
      }
      // mkdtemp makes it 0700 whatever the umask: the shell's variables can hold secrets.
      const directory =
        inheritShell === true ? await mkdtemp(join(tmpdir(), "ltx-mcp-inherit-")) : undefined;
      let result: Awaited<ReturnType<typeof context.tmux.run>>;
      try {
        let program = argv;
        if (directory !== undefined && fromPaneId !== undefined) {
          const sourced = await inheritedEnvironment(context, fromPaneId, directory, extra.signal);
          if (typeof sourced !== "string") return sourced;
          // Sourced by the program's own sh, so no variable passes through a tmux command.
          program = ["sh", "-c", '. "$0" && exec "$@"', sourced, ...argv];
        }
        result = await context.tmux.run(program, {
          // A pager waits for keys nobody will press.
          environment: { GIT_PAGER: "cat", PAGER: "cat" },
          ...(from === undefined ? {} : { from }),
          ...(height === undefined ? {} : { height }),
          ...(input === undefined ? {} : { input }),
          ...(keep === undefined ? {} : { keep }),
          ...(placement === undefined ? {} : { placement }),
          ...(startDirectory === undefined ? {} : { startDirectory }),
          ...(width === undefined ? {} : { width }),
          signal: extra.signal,
          timeoutMs: effectiveTimeoutMs,
        });
      } catch (error) {
        if (error instanceof VersionTooLowError) {
          return fail({
            hint: "On this server, run the command with run_shell_command in an existing shell pane.",
            reason: error.message,
          });
        }
        if (error instanceof LibTmuxError && error.message.includes("on this machine")) {
          return fail({
            hint: 'Leave input out, or pipe it in with argv such as ["sh", "-c", "printf ... | program"].',
            reason: error.message,
          });
        }
        throw error;
      } finally {
        if (directory !== undefined) await rm(directory, { force: true, recursive: true });
      }
      const bounded = boundText(
        result.output === "" ? [] : result.output.split("\n"),
        effectiveResultLines(context.policy, maxLines),
        MAX_RESULT_BYTES,
      );
      const outputComplete =
        !result.truncated && bounded.droppedLines === 0 && bounded.omittedBytes === 0;
      let headline: string;
      if (result.timedOut) headline = `ended at the ${String(effectiveTimeoutMs)}ms timeout`;
      else if (result.signalCode !== null) headline = `ended by ${result.signalCode}`;
      else headline = `exit ${String(result.exitCode)}`;
      return ok(
        {
          droppedLines: bounded.droppedLines,
          effectiveTimeoutMs,
          exitStatus: result.exitCode,
          omittedBytes: bounded.omittedBytes,
          outcome: result.timedOut ? "timed_out" : "completed",
          output: bounded.text,
          outputComplete,
          returnedBytes: bounded.returnedBytes,
          signal: result.signalCode,
        },
        `${renderBoundedText(
          bounded,
          "raise maxLines within the server limit or pipe large output before running",
        )}\n\n[${headline}]${
          result.truncated ? "\n[output scrolled past the scrollback limit; its start is gone]" : ""
        }`,
      );
    },
  );
}
