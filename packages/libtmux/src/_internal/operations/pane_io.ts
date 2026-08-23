import type { CaptureOptions, SendKeysOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand } from "./command.js";

/**
 * Send keys to a pane.
 *
 * Enter is a separate `send-keys` rather than a newline appended to the string,
 * because `-l` would send a literal newline character while an unquoted `Enter`
 * is a key name tmux resolves. Keeping them separate makes `literal` mean only
 * what it says about the caller's own text.
 */
export async function sendKeys(
  runtime: RuntimeContext,
  paneId: string | null,
  keys: string,
  options: SendKeysOptions = {},
): Promise<void> {
  const target = paneId == null ? [] : ["-t", paneId];
  await runCommand(
    runtime,
    ["send-keys", ...target, ...(options.literal === true ? ["-l"] : []), keys],
    options,
  );
  if (options.enter !== false)
    await runCommand(runtime, ["send-keys", ...target, "Enter"], options);
}

/** Capture a pane's contents as lines, without the trailing blank line tmux emits. */
export async function capturePane(
  runtime: RuntimeContext,
  paneId: string | null,
  options: CaptureOptions = {},
): Promise<readonly string[]> {
  return runCommand(
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
    ...(command === undefined ? [] : [command]),
  ]);
}
