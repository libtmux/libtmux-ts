import type { Server } from "../../src/server.js";
import type { Session } from "../../src/session.js";
import type { Window } from "../../src/window.js";
import {
  paneCommands,
  paneStartDirectory,
  paneWantsFocus,
  type Workspace,
  type WorkspaceWindow,
} from "./config.js";

/**
 * Build a workspace into a real tmux session, or converge one that exists.
 *
 * tmux gives every new session a window and every new window a pane, so the
 * first window and first pane of each level are adopted rather than created.
 * Creating them anyway is the classic workspace-builder bug that leaves an
 * empty leading window behind.
 *
 * Applying the same workspace twice is not an error and does not duplicate
 * anything: the second run reconciles what is already running against what the
 * file asks for.
 */
export async function applyWorkspace(server: Server, workspace: Workspace): Promise<Session> {
  const snapshot = await server.snapshot();
  const existing = snapshot.sessions.oneOrUndefined({ name: workspace.session_name });
  const created = existing ?? (await createSession(server, workspace));

  // Converging re-reads the session after every change, so it runs over one
  // control connection rather than a process per read. The session has to
  // exist first: a control client attaches, and there is nothing to attach to
  // on an empty server.
  await using live = await server.connect({ target: created.id });
  const session = (await live.snapshot()).sessions.one({ id: created.id });

  for (const [option, value] of Object.entries(workspace.options ?? {})) {
    // eslint-disable-next-line no-await-in-loop -- Later options may depend on earlier ones.
    await session.setOption(option, value);
  }

  for (const [index, desired] of workspace.windows.entries()) {
    // eslint-disable-next-line no-await-in-loop -- Window order is observable, so creation is sequential.
    await applyWindow(await windowAt(session, index, desired), desired, workspace);
  }

  await pruneWindows(session, workspace.windows.length);
  await focusRequested(session, workspace);
  await session.refresh();
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
): Promise<Window> {
  await session.refresh();
  const existing = session.windows.at(index);
  if (existing === undefined) {
    return session.newWindow({
      ...(desired.window_name === undefined ? {} : { name: desired.window_name }),
      ...(desired.start_directory === undefined ? {} : { startDirectory: desired.start_directory }),
    });
  }
  if (desired.window_name !== undefined && existing.name !== desired.window_name) {
    await existing.rename(desired.window_name);
    await existing.refresh();
  }
  return existing;
}

async function applyWindow(
  window: Window,
  desired: WorkspaceWindow,
  workspace: Workspace,
): Promise<void> {
  for (const [option, value] of Object.entries(desired.options ?? {})) {
    // eslint-disable-next-line no-await-in-loop -- Later options may depend on earlier ones.
    await window.setOption(option, value);
  }

  const wanted = desired.panes.length === 0 ? 1 : desired.panes.length;
  await window.refresh();
  // Every surplus pane in one invocation. Killing them one at a time costs a
  // command and a whole snapshot each, and the set is known before any of them
  // goes: the panes past the wanted count, in the order tmux reports them.
  const surplus = window.panes.toArray().slice(wanted);
  if (surplus.length > 0) {
    await window.server.batch(surplus.map((pane) => pane.plan.kill()));
    await window.refresh();
  }
  // Every missing pane in one invocation too, for the same reason: a window
  // only read once it is finished does not need a snapshot per split. `-d`
  // leaves the active pane where it is, so the splits land exactly where they
  // would have one at a time.
  const present = window.panes.length;
  if (present < wanted) {
    await window.server.batch(
      Array.from({ length: wanted - present }, (_, offset) => {
        const entry = desired.panes[present + offset];
        const directory =
          entry === undefined ? undefined : paneStartDirectory(entry, desired, workspace);
        return window.plan.split(directory === undefined ? {} : { startDirectory: directory });
      }),
    );
    await window.refresh();
  }

  for (const [index, entry] of desired.panes.entries()) {
    const pane = window.panes.at(index);
    if (pane === undefined) throw new Error(`window ${window.name} lost pane ${String(index)}`);
    for (const command of paneCommands(entry, desired)) {
      // eslint-disable-next-line no-await-in-loop -- Commands run in the order written.
      await pane.sendKeys(command);
    }
  }

  // Layout applies after the pane count settles; tmux rejects a layout that
  // does not match the number of panes in the window.
  if (desired.layout !== undefined) await window.selectLayout(desired.layout);
}

async function pruneWindows(session: Session, wanted: number): Promise<void> {
  await session.refresh();
  const surplus = session.windows.toArray().slice(wanted);
  if (surplus.length === 0) return;
  await session.server.batch(surplus.map((window) => window.plan.kill()));
  await session.refresh();
}

async function focusRequested(session: Session, workspace: Workspace): Promise<void> {
  await session.refresh();
  for (const [index, desired] of workspace.windows.entries()) {
    const window = session.windows.at(index);
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
