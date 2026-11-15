import { runCommand } from "./command.js";
import { assertName } from "./names.js";
import { guardPlacements, placementRefusal, type Placement } from "./plans.js";
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

export async function selectWindowIn(
  runtime: RuntimeContext,
  sessionId: string | null,
  target: string,
  held?: Pick<Placement, "daemon" | "windowId">,
): Promise<void> {
  const scope = sessionId == null ? [] : ["-t", sessionId];
  if (target === "last") return void (await runCommand(runtime, ["last-window", ...scope]));
  if (target === "next") return void (await runCommand(runtime, ["next-window", ...scope]));
  if (target === "previous") {
    return void (await runCommand(runtime, ["previous-window", ...scope]));
  }
  const qualified = sessionId == null ? target : `${sessionId}:${target}`;
  const select = ["select-window", "-t", qualified];
  if (held === undefined || sessionId == null) {
    await runCommand(runtime, select);
    return;
  }
  // A window handle names an index only because it held it when it was read.
  try {
    await runCommand(
      runtime,
      guardPlacements([{ target: qualified, windowId: held.windowId }], select),
      {
        daemon: held.daemon,
      },
    );
  } catch (error) {
    throw placementRefusal(error);
  }
}
