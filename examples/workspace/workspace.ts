import type { Server } from "libtmux/server";
import type { Session } from "libtmux/session";
import { applyWorkspace } from "@libtmux/workspace";
import type { Workspace } from "@libtmux/workspace/config";

/**
 * Build the shape most people reach for tmux to get: one session, a window
 * per concern, each pane already running the thing it is there for.
 *
 * `server.batch` plans several windows and resolves them from one final
 * snapshot. `buildWorkspace`, below, delegates declared topology to the
 * workspace package instead of maintaining another reconciler here.
 */
export async function buildSimpleWorkspace(server: Server): Promise<Session> {
  const built = await server.newSession({
    name: "work",
    shellCommand: "sleep 30",
    windowName: "editor",
  });

  const [logs, shell] = await server.batch([
    built.plan.newWindow({ name: "logs", shellCommand: "tail -f /dev/null" }),
    built.plan.newWindow({ name: "shell" }),
  ]);

  await logs.selectLayout("even-horizontal");
  void shell.name; // "shell"

  return built;
}

export const DEVELOPMENT_WORKSPACE = {
  session_name: "workspace-example",
  windows: [
    { panes: ["sleep 30", "sleep 30"], window_name: "editor" },
    { panes: ["sleep 30"], window_name: "server" },
    { panes: ["sleep 30"], window_name: "logs" },
  ],
} satisfies Workspace;

/** Apply the package's declarative workspace to a server. */
export function buildWorkspace(server: Server): Promise<Session> {
  return applyWorkspace(server, DEVELOPMENT_WORKSPACE);
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
