import type { CaptureOptions, SendKeysOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand, runCommands } from "./command.js";
import { setOption, showOptions, unsetOption } from "./options.js";

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

/** The user option that holds a pane's label. */
const LABEL_OPTION = "@name";

/** Put a name on a pane that survives any change to its index, title or command. */
export async function setPaneLabel(
  runtime: RuntimeContext,
  paneId: string,
  label: string,
): Promise<void> {
  await setOption(runtime, "pane", paneId, LABEL_OPTION, label);
}

/** The label set on this pane itself, or `undefined` when it has none. */
export async function getPaneLabel(
  runtime: RuntimeContext,
  paneId: string,
): Promise<string | undefined> {
  return (await showOptions(runtime, "pane", paneId)).get(LABEL_OPTION);
}

/** Remove a pane's label. */
export async function clearPaneLabel(runtime: RuntimeContext, paneId: string): Promise<void> {
  await unsetOption(runtime, "pane", paneId, LABEL_OPTION);
}

/**
 * The ids of every pane carrying exactly this label.
 *
 * A format reads `@name` through the window and server tables as well, so a
 * window or global `@name` would name every pane under it; each candidate is
 * confirmed against the option set on the pane itself.
 */
export async function paneIdsLabelled(
  runtime: RuntimeContext,
  label: string,
): Promise<readonly string[]> {
  const rows = await runCommand(runtime, [
    "list-panes",
    "-a",
    "-F",
    `#{pane_id};#{${LABEL_OPTION}}`,
  ]);
  const candidates: string[] = [];
  for (const row of rows) {
    const split = row.indexOf(";");
    if (split !== -1 && row.slice(split + 1) === label) candidates.push(row.slice(0, split));
  }
  const own = await Promise.all(
    candidates.map(async (id) => ((await getPaneLabel(runtime, id)) === label ? id : undefined)),
  );
  return own.filter((id): id is string => id !== undefined);
}
