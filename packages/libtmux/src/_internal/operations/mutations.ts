import type {
  NewSessionOptions,
  NewWindowOptions,
  PlannedOperation,
  SplitOptions,
} from "../../types.js";
import type { CommandOptions } from "../../common.js";
import type { Pane } from "../../pane.js";
import type { Server } from "../../server.js";
import type { Session } from "../../session.js";
import type { Window } from "../../window.js";
import type { RuntimeContext } from "../runtime/context.js";
import { parseTmuxVersion, tmuxVersionAtLeast } from "../runtime/tmux_version.js";
import { LibTmuxError } from "../../errors.js";
import { runCommand, runCommands } from "./command.js";
import {
  planKill,
  planKillPaneIfUnshared,
  planNewSession,
  planNewWindow,
  planSplitWindow,
} from "./plans.js";
import { buildServerSnapshot } from "./snapshot.js";

/**
 * Run one planned operation on its own, resolving what it made into a handle.
 *
 * The same description a batch would carry, spent on a single command: the
 * arguments go out, a snapshot comes back, and the plan reads its result from
 * it. Running one this way costs the snapshot that a batch would have shared,
 * which is the whole of the difference between the two.
 *
 * `options` reaches the command; its `signal` reaches that snapshot too,
 * because a caller who passed one means it for the create as a whole. A
 * snapshot takes no `timeoutMs` of its own — the server's applies. Dropping
 * either typed exactly like honouring it: `newSession({ signal })` ran
 * against an already-aborted signal and reported success.
 */
async function runPlan<T>(
  server: Server,
  runtime: RuntimeContext,
  plan: PlannedOperation<T>,
  options: CommandOptions = {},
): Promise<T> {
  const lines = await runCommand(runtime, plan.argv, options);
  return plan.resolve(await buildServerSnapshot(server, runtime, options.signal), lines);
}

/** The first tmux that sizes a detached session's window from `new-session -x -y`. */
const NEW_SESSION_SIZE_SINCE = parseTmuxVersion("3.3");

/** The first tmux where a session's own `history-limit` resizes the panes it already has. */
const SESSION_HISTORY_SINCE = parseTmuxVersion("3.7");

const MAX_HISTORY_LIMIT = 2_147_483_647;

function requiredIdentity(lines: readonly string[]): string {
  const identity = lines[0];
  if (identity === undefined || identity === "") {
    throw new LibTmuxError("new-session did not report the created session's identity");
  }
  return identity;
}

/**
 * Create a session whose first pane already has `historyLimit` scrollback.
 *
 * A pane reads `history-limit` as it is created, so the option has to be in
 * place before `new-session` runs. Before 3.7 only the global can be, and it
 * goes out in the same invocation as the creation and is restored in it: a
 * restore from this process would leave a window in which another client
 * creates panes with the temporary value. 3.7 trims or grows the panes of a
 * session whose own option changes, so there the option follows creation.
 */
async function createWithHistory(
  runtime: RuntimeContext,
  args: readonly string[],
  historyLimit: number,
  grouped: boolean,
  options: CommandOptions,
): Promise<readonly string[]> {
  const { tmuxVersion } = await runtime.capabilities.bind(options.signal);
  const own = (lines: readonly string[]): readonly string[] => [
    "set-option",
    "-t",
    requiredIdentity(lines),
    "history-limit",
    String(historyLimit),
  ];
  if (grouped || tmuxVersionAtLeast(tmuxVersion, SESSION_HISTORY_SINCE)) {
    const lines = await runCommand(runtime, args, options);
    await runCommand(runtime, own(lines), options);
    return lines;
  }
  const [previous = ""] = await runCommand(
    runtime,
    ["show-options", "-gv", "history-limit"],
    options,
  );
  const global = (value: string): readonly string[] => ["set-option", "-g", "history-limit", value];
  let lines: readonly string[];
  try {
    lines = await runCommands(
      runtime,
      [global(String(historyLimit)), args, global(previous)],
      options,
    );
  } catch (error) {
    // tmux stops a command list at the first failure, so a failed creation
    // leaves the temporary global in place.
    await runCommand(runtime, global(previous)).catch(() => undefined);
    throw error;
  }
  await runCommand(runtime, own(lines), options);
  return lines;
}

export async function newSession(
  server: Server,
  runtime: RuntimeContext,
  options: NewSessionOptions = {},
): Promise<Session> {
  const { historyLimit, ...creation } = options;
  if (
    historyLimit !== undefined &&
    !(Number.isInteger(historyLimit) && historyLimit >= 0 && historyLimit <= MAX_HISTORY_LIMIT)
  ) {
    throw new TypeError(`historyLimit must be an integer from 0 to ${MAX_HISTORY_LIMIT}`);
  }
  const plan = planNewSession(creation);
  const lines =
    historyLimit === undefined
      ? await runCommand(runtime, plan.argv, options)
      : await createWithHistory(
          runtime,
          plan.argv,
          historyLimit,
          options.groupWith !== undefined,
          options,
        );
  // tmux 3.2a accepts `-x -y` and still gives a detached session 80x23, so the
  // size is applied to the window afterwards, before the snapshot that
  // resolves the handle reads it. A grouped session makes no window of its own.
  const sized = options.width !== undefined || options.height !== undefined;
  if (sized && options.groupWith === undefined && lines[0] !== undefined && lines[0] !== "") {
    const { tmuxVersion } = await runtime.capabilities.bind(options.signal);
    if (!tmuxVersionAtLeast(tmuxVersion, NEW_SESSION_SIZE_SINCE)) {
      await runCommand(
        runtime,
        [
          "resize-window",
          "-t",
          lines[0],
          ...(options.width === undefined ? [] : ["-x", String(options.width)]),
          ...(options.height === undefined ? [] : ["-y", String(options.height)]),
        ],
        options,
      );
    }
  }
  return plan.resolve(await buildServerSnapshot(server, runtime, options.signal), lines);
}

export function newWindow(
  server: Server,
  runtime: RuntimeContext,
  sessionId: string | null,
  options: NewWindowOptions = {},
): Promise<Window> {
  return runPlan(server, runtime, planNewWindow(sessionId, options), options);
}

export function splitWindow(
  server: Server,
  runtime: RuntimeContext,
  target: string | null,
  options: SplitOptions = {},
): Promise<Pane> {
  return runPlan(server, runtime, planSplitWindow(target, options), options);
}

export async function killTarget(
  runtime: RuntimeContext,
  command: "kill-pane" | "kill-session" | "kill-window",
  target: string | null,
): Promise<void> {
  await runCommand(runtime, planKill(command, target).argv);
}

/** Destroy a pane only while no other placement exposes its window. */
export async function killPaneIfWindowUnshared(
  runtime: RuntimeContext,
  target: string,
): Promise<void> {
  await runCommand(runtime, planKillPaneIfUnshared(target).argv);
}

export async function killServer(runtime: RuntimeContext): Promise<void> {
  await runCommand(runtime, ["kill-server"]);
}
