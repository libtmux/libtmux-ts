// `libtmux/constants` for a consumer: writing commands by hand means
// translating a direction to the flags tmux wants.
import { PANE_DIRECTION_FLAG_MAP, type PaneDirection } from "../src/constants.js";
import type { Server } from "../src/server.js";
import type { Session } from "../src/session.js";

/**
 * Build a development workspace and leave it running.
 *
 * The shape most people reach for tmux to get: one session, a window per
 * concern, each pane already running the thing it is there for. Everything the
 * layout needs is decided here rather than typed afterwards.
 */
export interface WorkspaceLayout {
  /** Variables every process in the session inherits. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly name: string;
  readonly windows: readonly WindowLayout[];
}

export interface WindowLayout {
  /** What the window's first pane runs. */
  readonly command: string;
  readonly name: string;
  /** Extra panes split off the first, in order. */
  readonly panes?: readonly PaneLayout[];
}

export interface PaneLayout {
  readonly command: string;
  readonly direction?: PaneDirection;
}

export async function buildWorkspace(server: Server, layout: WorkspaceLayout): Promise<Session> {
  const first = layout.windows[0];
  if (first === undefined) throw new Error("a workspace needs at least one window");

  // The session's first window is created with it, so the first entry names it
  // rather than being added afterwards — otherwise every workspace opens with a
  // stray shell nobody asked for. This is the one call that has to come first:
  // everything below addresses the session it returns.
  const session = await server.newSession({
    name: layout.name,
    shellCommand: first.command,
    windowName: first.name,
  });

  // Everything else goes in one invocation. Environment entries are written as
  // commands because they print nothing worth resolving; the windows and panes
  // are planned instead, so they come back as handles rather than as lines to
  // parse. Both travel in the same sequence.
  const commands: string[][] = [];

  // The environment is set before any window is added, so every pane below
  // inherits it. A variable set afterwards reaches only what comes next.
  for (const [name, value] of Object.entries(layout.environment ?? {})) {
    commands.push(["set-environment", "-t", session.id, name, value]);
  }

  for (const [index, window] of layout.windows.entries()) {
    // The rest take the default placement: `direction` measures from the
    // session's selected window, which never moves while windows are created
    // detached, so asking for "after" repeatedly stacks them in reverse. The
    // default appends at the first free index, which is the order declared.
    if (index > 0) {
      commands.push([
        "new-window",
        "-d",
        "-t",
        session.id,
        "-n",
        window.name,
        "--",
        window.command,
      ]);
    }
    for (const pane of window.panes ?? []) {
      commands.push([
        "split-window",
        "-d",
        "-t",
        `${layout.name}:${window.name}`,
        ...(pane.direction === undefined ? [] : PANE_DIRECTION_FLAG_MAP[pane.direction]),
        "--",
        pane.command,
      ]);
    }
  }

  await server.pipeline(commands);

  // One snapshot resolves the whole layout, rather than one per window.
  return (await server.snapshot()).sessions.one({ name: layout.name });
}

/**
 * Tear a workspace down without caring whether it is there.
 *
 * Killing a session that has already gone is not a failure worth propagating,
 * which is the one case worth handling separately from every other tmux error.
 */
export async function removeWorkspace(server: Server, name: string): Promise<boolean> {
  const found = (await server.snapshot()).sessions.first({ name });
  if (found === undefined) return false;
  await found.kill();
  return true;
}
