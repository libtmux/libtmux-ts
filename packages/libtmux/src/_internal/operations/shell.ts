import type { JoinOptions } from "../../types.js";
import type { IfShellOptions, RespawnOptions, RunShellOptions } from "../../types.js";
import { TmuxCommandError } from "../../exc.js";
import { runCommand } from "./command.js";
import type { RuntimeContext } from "../runtime/context.js";

/** Run a shell command through tmux and return whatever it printed. */
export async function runShell(
  runtime: RuntimeContext,
  command: string,
  options: RunShellOptions = {},
): Promise<readonly string[]> {
  return runCommand(runtime, [
    "run-shell",
    ...(options.target == null ? [] : ["-t", options.target]),
    command,
  ]);
}

/**
 * Run one command or another depending on a condition.
 *
 * `-b` is deliberately not passed: a backgrounded `if-shell` returns before the
 * branch has run, which would make the resolved promise mean nothing.
 */
export async function ifShell(
  runtime: RuntimeContext,
  condition: string,
  command: string,
  options: IfShellOptions = {},
): Promise<void> {
  await runCommand(
    runtime,
    [
      "if-shell",
      ...(options.format === true ? ["-F"] : []),
      ...(options.target == null ? [] : ["-t", options.target]),
      condition,
      command,
      ...(options.otherwise === undefined ? [] : [options.otherwise]),
    ],
    options,
  );
}

/** Expand a tmux format string against a target and return the result. */
export async function displayMessage(
  runtime: RuntimeContext,
  message: string,
  target: string | null,
): Promise<readonly string[]> {
  return runCommand(runtime, [
    "display-message",
    "-p",
    ...(target == null ? [] : ["-t", target]),
    message,
  ]);
}

/** Restart a pane's command in place. */
export async function respawnPane(
  runtime: RuntimeContext,
  paneId: string | null,
  command: string | undefined,
  options: RespawnOptions = {},
): Promise<void> {
  await runCommand(
    runtime,
    [
      "respawn-pane",
      ...(options.kill === true ? ["-k"] : []),
      ...(options.startDirectory === undefined ? [] : ["-c", options.startDirectory]),
      ...Object.entries(options.environment ?? {}).flatMap(([name, value]) => [
        "-e",
        `${name}=${value}`,
      ]),
      ...(paneId == null ? [] : ["-t", paneId]),
      ...(command === undefined ? [] : [command]),
    ],
    options,
  );
}

/**
 * Restart the command in a window's active pane.
 *
 * tmux refuses a window whose command is still running unless `kill` says to
 * replace it, so the option is what separates reviving a dead window from
 * restarting a live one.
 */
export async function respawnWindow(
  runtime: RuntimeContext,
  windowId: string | null,
  command: string | undefined,
  options: RespawnOptions = {},
): Promise<void> {
  await runCommand(
    runtime,
    [
      "respawn-window",
      ...(options.kill === true ? ["-k"] : []),
      ...(options.startDirectory === undefined ? [] : ["-c", options.startDirectory]),
      ...Object.entries(options.environment ?? {}).flatMap(([name, value]) => [
        "-e",
        `${name}=${value}`,
      ]),
      ...(windowId == null ? [] : ["-t", windowId]),
      ...(command === undefined ? [] : [command]),
    ],
    options,
  );
}

/** Move a pane out into a window of its own. */
export async function breakPane(
  runtime: RuntimeContext,
  paneId: string | null,
  windowName: string | undefined,
): Promise<void> {
  // tmux 3.7 accepts `-n` and ignores it: the window arrives under an
  // automatic name while the command still reports success, so a caller's name
  // is lost with nothing to notice. 3.7a honours it again, which is why this
  // asks for that release exactly rather than for a floor. Asking tmux to
  // print the window it made is what gives the rename something to target,
  // whether or not the break named a source pane.
  const renames =
    windowName === undefined ? false : (await runtime.capabilities.bind()).quirks.breakPane37;
  const printed = await runCommand(runtime, [
    "break-pane",
    "-d",
    ...(paneId == null ? [] : ["-s", paneId]),
    ...(windowName === undefined ? [] : ["-n", windowName]),
    ...(renames ? ["-P", "-F", "#{window_id}"] : []),
  ]);
  if (!renames || windowName === undefined) return;
  const created = printed[0];
  if (created === undefined || created === "") return;
  await runCommand(runtime, ["rename-window", "-t", created, windowName]);
}

/** Move a pane into another window, joining it as a split. */
export async function joinPane(
  runtime: RuntimeContext,
  paneId: string | null,
  target: string,
  options: JoinOptions = {},
): Promise<void> {
  await runCommand(
    runtime,
    [
      "join-pane",
      "-d",
      ...(options.vertical === false ? ["-h"] : []),
      ...(paneId == null ? [] : ["-s", paneId]),
      "-t",
      target,
    ],
    options,
  );
}

/**
 * Enter or leave a pane's mode.
 *
 * Leaving is idempotent; entering is not. Any failure other than "already not
 * in a mode" still propagates.
 */
export async function setCopyMode(
  runtime: RuntimeContext,
  paneId: string | null,
  active: boolean,
): Promise<void> {
  const target = paneId == null ? [] : ["-t", paneId];
  if (active) {
    await runCommand(runtime, ["copy-mode", ...target]);
    return;
  }
  try {
    await runCommand(runtime, ["send-keys", ...target, "-X", "cancel"]);
  } catch (error) {
    // tmux rejects `cancel` on a pane that is not in a mode, but "make sure
    // this pane is not in a mode" is the caller's intent, and failing an
    // already-satisfied condition would push a pre-check into every call site.
    if (!(error instanceof TmuxCommandError) || !error.stderrIncludes("not in a mode")) throw error;
  }
}

/**
 * What to detach: one named client, or every client attached to a session.
 *
 * tmux spells these as two different flags — `-t` names a client, `-s` names a
 * session — and one string parameter cannot say which was meant. Passing a
 * session id where a client name was expected is accepted by every type in
 * sight and rejected by tmux as `can't find client: $0`.
 */
export type DetachTarget = { readonly client: string } | { readonly session: string };

/** Detach every client attached to a session, one named client, or all. */
export async function detachClient(
  runtime: RuntimeContext,
  target: DetachTarget | null,
): Promise<void> {
  const flags =
    target === null ? [] : "client" in target ? ["-t", target.client] : ["-s", target.session];
  await runCommand(runtime, ["detach-client", ...flags]);
}

/** Point a client at a different session. */
export async function switchClient(
  runtime: RuntimeContext,
  clientName: string | null,
  sessionId: string,
): Promise<void> {
  await runCommand(runtime, [
    "switch-client",
    ...(clientName == null ? [] : ["-c", clientName]),
    "-t",
    sessionId,
  ]);
}
