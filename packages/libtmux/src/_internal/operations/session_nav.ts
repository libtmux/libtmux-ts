import { runCommand } from "./command.js";
import { assertName } from "./names.js";
import type { RuntimeContext } from "../runtime/context.js";

export async function renameSession(
  runtime: RuntimeContext,
  sessionId: string | null,
  name: string,
): Promise<void> {
  await runCommand(runtime, [
    "rename-session",
    ...(sessionId == null ? [] : ["-t", sessionId]),
    // `--` keeps a name starting with `-` from being read as a flag:
    // `assertName` refuses `.`, `:`, and control characters, not a dash.
    "--",
    assertName("session", name),
  ]);
}

/**
 * Select a window within a session.
 *
 * tmux spells relative movement as separate subcommands rather than targets, so
 * the three directions map to `last-window`, `next-window`, and
 * `previous-window`; anything else is treated as a window target.
 */

/**
 * What tmux reads as a position rather than a name: an index, a window id, a
 * relative step, or one of its single-character and braced tokens.
 */
const WINDOW_POSITION = /^(?:\d+|@\d+|[+-]\d*|[\^$!~]|\{[a-z-]+\})$/u;

/**
 * Pin a window name to an exact match.
 *
 * tmux resolves `session:builde` as a prefix of `builder` and `session:buil*`
 * as a glob, so selecting a window by name could land on another one. `=`
 * makes the name exact on every supported release.
 */
function exactWindow(target: string): string {
  return WINDOW_POSITION.test(target) ? target : `=${target}`;
}

export async function selectWindowIn(
  runtime: RuntimeContext,
  sessionId: string | null,
  target: string,
): Promise<void> {
  const scope = sessionId == null ? [] : ["-t", sessionId];
  if (target === "last") return void (await runCommand(runtime, ["last-window", ...scope]));
  if (target === "next") return void (await runCommand(runtime, ["next-window", ...scope]));
  if (target === "previous") {
    return void (await runCommand(runtime, ["previous-window", ...scope]));
  }
  const qualified = sessionId == null ? exactWindow(target) : `${sessionId}:${exactWindow(target)}`;
  await runCommand(runtime, ["select-window", "-t", qualified]);
}
