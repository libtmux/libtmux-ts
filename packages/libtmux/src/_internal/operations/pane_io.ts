import {
  LibTmuxError,
  ObjectNotFoundError,
  TmuxTransportError,
  WaitTimeoutError,
} from "../../errors.js";
import type {
  CaptureOptions,
  PaneExit,
  PaneExitWaitOptions,
  SendKeysOptions,
} from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { timerDuration } from "../timing.js";
import { runCommand, runCommands } from "./command.js";

/**
 * Send keys to a pane.
 *
 * Enter stays its own `send-keys` rather than another argument beside the
 * text, because tmux resolves a command's keys against the pane's state when
 * that command runs: in copy mode, `send-keys q Enter` cancels the mode on `q`
 * and then fails `Enter` with `not in a mode`, where a second command sees the
 * mode already gone and reaches the shell. It also keeps `-l` meaning only
 * what it says about the caller's text, since `-l` applies to every argument
 * and Enter is a carriage return where a literal newline is a line feed.
 *
 * Both travel as one invocation. tmux runs an invocation's commands in order
 * on its own queue, so there is no gap in which another writer's Enter submits
 * this caller's half-typed line.
 */
export async function sendKeys(
  runtime: RuntimeContext,
  paneId: string | null,
  keys: string,
  options: SendKeysOptions = {},
): Promise<void> {
  const at = paneId == null ? [] : ["-t", paneId];
  // tmux stops reading flags at the first positional, so a lone `--` before
  // the caller's text is what keeps a value starting with `-` (`-R` resets
  // the terminal) from being read as one of send-keys's own flags.
  const text = ["send-keys", ...at, ...(options.literal === true ? ["-l"] : []), "--", keys];
  if (options.enter === false) {
    await runCommand(runtime, text, options);
    return;
  }
  await runCommands(runtime, [text, ["send-keys", ...at, "Enter"]], options);
}

/** Capture a pane's contents as lines, without the trailing blank line tmux emits. */
export async function capturePane(
  runtime: RuntimeContext,
  paneId: string | null,
  options: CaptureOptions = {},
): Promise<readonly string[]> {
  const lines = await runCommand(
    runtime,
    [
      "capture-pane",
      "-p",
      ...(paneId == null ? [] : ["-t", paneId]),
      ...(options.alternateScreen === true ? ["-a"] : []),
      ...(options.escapeSequences === true ? ["-e"] : []),
      ...(options.joinWrapped === true ? ["-J"] : []),
      ...(options.start === undefined ? [] : ["-S", String(options.start)]),
      ...(options.end === undefined ? [] : ["-E", String(options.end)]),
    ],
    options,
  );
  let end = lines.length;
  while (lines[end - 1] === "") end -= 1;
  return end === lines.length ? lines : Object.freeze(lines.slice(0, end));
}

/** Discard a pane's scrollback history. */
export async function clearHistory(runtime: RuntimeContext, paneId: string | null): Promise<void> {
  await runCommand(runtime, ["clear-history", ...(paneId == null ? [] : ["-t", paneId])]);
}

/**
 * Send everything a pane writes to a shell command as well as to its screen.
 *
 * A pane keeps `history-limit` lines and a stream reader keeps a bounded
 * buffer, so output larger than either is gone before anyone asks for it. This
 * is tmux's own answer: the command runs for as long as the pipe is open and
 * receives the pane's output on stdin, so a long build is captured whole
 * without holding a connection or spending an agent's context on it.
 *
 * A pane's output goes to the command and nothing is written back into the
 * pane: that is tmux's default when neither `-I` nor `-O` is given.
 *
 * Passing no command stops an open pipe. `toggle` is tmux's `-o`: it starts a
 * pipe when none is open and stops one when there is, which is what makes it a
 * single key binding. tmux destroys the existing pipe before honouring the
 * flag, so it stops a capture rather than leaving it alone — the difference
 * matters when another caller may already be piping this pane.
 */
export async function pipePane(
  runtime: RuntimeContext,
  paneId: string,
  command?: string,
  options: { readonly toggle?: boolean } = {},
): Promise<void> {
  await runCommand(runtime, [
    "pipe-pane",
    ...(options.toggle === true ? ["-o"] : []),
    "-t",
    paneId,
    // `--` before the command keeps a leading `-` from being read as another
    // of pipe-pane's own flags (`-I` or `-O` close the existing pipe).
    ...(command === undefined ? [] : ["--", command]),
  ]);
}

const DEFAULT_EXIT_WAIT_MS = 30_000;
const EXIT_POLL_START_MS = 10;
const EXIT_POLL_CAP_MS = 100;

/** The pane's exit once its process has ended, or `undefined` while it runs. */
async function readExit(runtime: RuntimeContext, paneId: string): Promise<PaneExit | undefined> {
  // `display-message -p` succeeds with empty fields for a pane that does not
  // exist, so the id is part of the format and the answer is trusted only when
  // it comes back.
  const [row = ""] = await runCommand(runtime, [
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{pane_id};#{pane_dead};#{pane_dead_status};#{pane_dead_signal}",
  ]);
  const [id, dead, status, signal] = row.split(";");
  if (id !== paneId) {
    throw new ObjectNotFoundError({ message: `Pane ${paneId} no longer exists` });
  }
  if (dead !== "1") return undefined;
  return Object.freeze({
    signal: signal === undefined || signal === "" ? null : Number(signal),
    status: status === undefined || status === "" ? null : Number(status),
  });
}

function pause(ms: number, signal: PaneExitWaitOptions["signal"]): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Block until the process tmux started in a pane has exited.
 *
 * tmux closes a pane when its process exits and takes the exit status with
 * it, so this sets `remain-on-exit` on the pane for the call and puts it back,
 * leaving a dead pane the caller can read and then remove. It polls rather than
 * waiting on a `pane-died` hook: that hook never fires for a pane that is
 * killed, so a wait with no deadline would block forever, and setting one
 * replaces whatever hook the pane already has.
 */
export async function waitForPaneExit(
  runtime: RuntimeContext,
  paneId: string,
  options: PaneExitWaitOptions = {},
): Promise<PaneExit> {
  const limit =
    options.timeoutMs === null
      ? undefined
      : timerDuration("timeoutMs", options.timeoutMs ?? DEFAULT_EXIT_WAIT_MS);
  const deadline = limit === undefined ? undefined : performance.now() + limit;
  const cancelled = (): TmuxTransportError =>
    new TmuxTransportError("pane exit wait cancelled", {
      delivery: "indeterminate",
      kind: "cancelled",
      ...(options.signal?.reason === undefined ? {} : { cause: options.signal.reason }),
    });
  const aborted = (): boolean => options.signal?.aborted === true;
  if (aborted()) throw cancelled();

  const already = await readExit(runtime, paneId);
  if (already !== undefined) return already;

  const [previous] = await runCommand(runtime, [
    "show-options",
    "-p",
    "-q",
    "-v",
    "-t",
    paneId,
    "remain-on-exit",
  ]);
  await runCommand(runtime, ["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
  try {
    let interval = EXIT_POLL_START_MS;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Each poll follows the wait before it.
      const exit = await readExit(runtime, paneId);
      if (exit !== undefined) return exit;
      if (aborted()) throw cancelled();
      if (deadline !== undefined && performance.now() >= deadline) {
        throw new WaitTimeoutError(`pane ${paneId} was still running at the deadline`);
      }
      // eslint-disable-next-line no-await-in-loop -- Polling is inherently sequential.
      await pause(interval, options.signal);
      interval = Math.min(interval * 2, EXIT_POLL_CAP_MS);
    }
  } finally {
    // The pane may be gone by now; restoring an option on it is then moot.
    await runCommand(
      runtime,
      previous === undefined || previous === ""
        ? ["set-option", "-p", "-u", "-t", paneId, "remain-on-exit"]
        : ["set-option", "-p", "-t", paneId, "remain-on-exit", previous],
    ).catch((error: unknown) => {
      if (error instanceof LibTmuxError && !(error instanceof TmuxTransportError)) return;
      throw error;
    });
  }
}
