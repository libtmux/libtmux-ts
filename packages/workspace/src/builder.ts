import type { Server } from "libtmux/server";
import type { Session } from "libtmux/session";
import type { Window } from "libtmux/window";
import {
  paneCommands,
  paneStartDirectory,
  paneWantsFocus,
  type Workspace,
  type WorkspaceWindow,
} from "./config.js";

/**
 * When a pane's `shell_command` entries are sent to it.
 *
 * `create-only` sends them to panes this apply created, and to no others. It is
 * the default because the alternative is not idempotent in any useful sense: a
 * pane that is already running `bun run dev` does not want that typed into it a
 * second time, and tmux has no way to tell the difference between a command and
 * a keystroke.
 *
 * `always` is the literal reading — every pane, every apply — and is right only
 * when the commands are known to be safe to repeat.
 */
export type CommandPolicy = "always" | "create-only";

/** How {@link applyWorkspace} should treat a workspace that is already running. */
export interface ApplyWorkspaceOptions {
  readonly commands?: CommandPolicy;
}

/**
 * Build a workspace into a real tmux session, or reconcile one that exists.
 *
 * tmux gives every new session a window and every new window a pane, so the
 * first window and first pane of each level are adopted rather than created.
 * Creating them anyway is the classic workspace-builder bug that leaves an
 * empty leading window behind.
 *
 * What this reconciles is *topology*: which windows exist, in what order, under
 * what names, with how many panes, under which layout. It is safe to apply
 * twice and the second run does not duplicate anything. It is deliberately not
 * a process supervisor — see {@link CommandPolicy} — and it does not unset
 * options a previous version of the file had set, because tmux cannot say which
 * of an option's current values this file is responsible for.
 */
export async function applyWorkspace(
  server: Server,
  workspace: Workspace,
  options: ApplyWorkspaceOptions = {},
): Promise<Session> {
  const commands = options.commands ?? "create-only";
  const snapshot = await server.snapshot();
  const existing = snapshot.sessions.oneOrUndefined({ name: workspace.session_name });
  const created = existing ?? (await createSession(server, workspace));

  // Reconciling re-reads the session after every change, so it runs over one
  // control connection rather than a process per read. The session has to
  // exist first: a control client attaches, and there is nothing to attach to
  // on an empty server.
  await using live = await server.connect({ target: created.id });
  let session = (await live.snapshot()).sessions.one({ id: created.id });

  for (const [option, value] of Object.entries(workspace.options ?? {})) {
    // eslint-disable-next-line no-await-in-loop -- Later options may depend on earlier ones.
    await session.setOption(option, value);
  }

  for (const [index, desired] of workspace.windows.entries()) {
    // eslint-disable-next-line no-await-in-loop -- Window order is observable, so creation is sequential.
    session = await session.refreshed();
    // A session created for this workspace had its first window made by tmux,
    // so that window is this apply's too, and its panes take the commands.
    const born = existing === undefined && index === 0;
    // eslint-disable-next-line no-await-in-loop -- Window order is observable, so creation is sequential.
    const placed = await windowAt(session, index, desired);
    // eslint-disable-next-line no-await-in-loop -- Window order is observable, so creation is sequential.
    await applyWindow(placed.window, desired, workspace, {
      commands,
      windowIsNew: placed.created || born,
    });
  }

  session = await pruneWindows(session, workspace.windows.length);
  await focusRequested(session, workspace);
  // The returned handle outlives the connection, so hand back one bound to the
  // caller's server rather than one that stops working when this scope exits.
  return (await server.snapshot()).sessions.one({ id: created.id });
}

async function createSession(server: Server, workspace: Workspace): Promise<Session> {
  return server.newSession({
    name: workspace.session_name,
    ...(workspace.start_directory === undefined
      ? {}
      : { startDirectory: workspace.start_directory }),
    ...(workspace.windows[0]?.window_name === undefined
      ? {}
      : { windowName: workspace.windows[0].window_name }),
  });
}

/**
 * The window that should hold position `index`, created if it is not there yet.
 *
 * tmux window indexes are not positions — `base-index` shifts them and a killed
 * window leaves a gap — so position is resolved by ordinal, not by index.
 */
async function windowAt(
  session: Session,
  index: number,
  desired: WorkspaceWindow,
): Promise<{ readonly created: boolean; readonly window: Window }> {
  const existing = session.windows.at(index);
  if (existing === undefined) {
    return {
      created: true,
      window: await session.newWindow({
        ...(desired.window_name === undefined ? {} : { name: desired.window_name }),
        ...(desired.start_directory === undefined
          ? {}
          : { startDirectory: desired.start_directory }),
      }),
    };
  }
  if (desired.window_name !== undefined && existing.name !== desired.window_name) {
    await existing.rename(desired.window_name);
    return { created: false, window: await existing.refreshed() };
  }
  return { created: false, window: existing };
}

interface ApplyWindowContext {
  readonly commands: CommandPolicy;
  readonly windowIsNew: boolean;
}

async function applyWindow(
  window: Window,
  desired: WorkspaceWindow,
  workspace: Workspace,
  context: ApplyWindowContext,
): Promise<void> {
  for (const [option, value] of Object.entries(desired.options ?? {})) {
    // eslint-disable-next-line no-await-in-loop -- Later options may depend on earlier ones.
    await window.setOption(option, value);
  }

  const wanted = desired.panes.length === 0 ? 1 : desired.panes.length;
  let current = await window.refreshed();
  // Every surplus pane in one invocation. Killing them one at a time costs a
  // command and a whole snapshot each, and the set is known before any of them
  // goes: the panes past the wanted count, in the order tmux reports them.
  const surplus = current.panes.toArray().slice(wanted);
  if (surplus.length > 0) {
    await current.server.batch(surplus.map((pane) => pane.plan.kill()));
    current = await current.refreshed();
  }
  // Every missing pane in one invocation too, for the same reason: a window
  // only read once it is finished does not need a snapshot per split. `-d`
  // leaves the active pane where it is, so the splits land exactly where they
  // would have one at a time.
  const present = current.panes.length;
  if (present < wanted) {
    await current.server.batch(
      Array.from({ length: wanted - present }, (_, offset) => {
        const entry = desired.panes[present + offset];
        const directory =
          entry === undefined ? undefined : paneStartDirectory(entry, desired, workspace);
        return current.plan.split(directory === undefined ? {} : { startDirectory: directory });
      }),
    );
    current = await current.refreshed();
  }

  // Panes at or past the count this apply found are the ones it just split; a
  // window it created has no older panes at all.
  const firstNewPane = context.windowIsNew ? 0 : present;
  for (const [index, entry] of desired.panes.entries()) {
    if (context.commands === "create-only" && index < firstNewPane) continue;
    const pane = current.panes.at(index);
    if (pane === undefined) throw new Error(`window ${current.name} lost pane ${String(index)}`);
    for (const command of paneCommands(entry, desired)) {
      // eslint-disable-next-line no-await-in-loop -- Commands run in the order written.
      await pane.sendKeys(command);
    }
  }

  // Layout applies after the pane count settles; tmux rejects a layout that
  // does not match the number of panes in the window.
  if (desired.layout !== undefined) await current.selectLayout(desired.layout);
}

async function pruneWindows(session: Session, wanted: number): Promise<Session> {
  const current = await session.refreshed();
  const surplus = current.windows.toArray().slice(wanted);
  if (surplus.length === 0) return current;
  await current.server.batch(surplus.map((window) => window.plan.kill()));
  return current.refreshed();
}

async function focusRequested(session: Session, workspace: Workspace): Promise<void> {
  const current = await session.refreshed();
  for (const [index, desired] of workspace.windows.entries()) {
    const window = current.windows.at(index);
    if (window === undefined) continue;
    const paneIndex = desired.panes.findIndex((entry) => paneWantsFocus(entry));
    if (paneIndex >= 0) {
      const pane = window.panes.at(paneIndex);
      // eslint-disable-next-line no-await-in-loop -- Selection is ordered; the last one wins.
      if (pane !== undefined) await pane.select();
    }
    // eslint-disable-next-line no-await-in-loop -- Selection is ordered; the last one wins.
    if (desired.focus === true) await window.select();
  }
}
