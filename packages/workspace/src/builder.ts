import type { Server } from "libtmux/server";
import type { Session } from "libtmux/session";
import type { Window } from "libtmux/window";
import {
  initialPaneStartDirectory,
  optionValue,
  paneCommands,
  paneStartDirectory,
  paneWantsFocus,
  parseWorkspace,
  windowStartDirectory,
  type Workspace,
  type WorkspaceWindow,
} from "./config.js";
import {
  normalizeApplyWorkspaceOptions,
  normalizePlanWorkspaceOptions,
  type ApplyWorkspaceOptions,
  type CommandPolicy,
  type PlanWorkspaceOptions,
} from "./operation_options.js";
import { claimSession, mayPrune, ownedByWorkspace } from "./ownership.js";
import {
  planWorkspace as createWorkspacePlan,
  runningSession,
  windowIsShared,
  type WorkspacePlan,
} from "./planning.js";

export type {
  WorkspacePaneCreation,
  WorkspacePaneRemoval,
  WorkspacePlan,
  WorkspaceRetention,
  WorkspaceWindowCreation,
  WorkspaceWindowPlacement,
  WorkspaceWindowRemoval,
  WorkspaceWindowRename,
} from "./planning.js";
export type {
  ApplyWorkspaceOptions,
  CommandPolicy,
  PlanWorkspaceOptions,
} from "./operation_options.js";

/** A high-level apply operation that finished before a later one failed. */
export type WorkspaceApplyMilestone =
  | { readonly kind: "session"; readonly status: "created" | "existing" }
  | { readonly kind: "session-claimed" }
  | { readonly kind: "workspace-option"; readonly name: string }
  | { readonly index: number; readonly kind: "window" }
  | { readonly kind: "windows-reconciled" };

/** The high-level operation an apply was attempting when it failed. */
export type WorkspaceApplyStage =
  | {
      readonly action: "claim" | "create" | "lookup" | "ownership" | "result" | "snapshot";
      readonly kind: "session";
    }
  | { readonly kind: "workspace-option"; readonly name: string }
  | { readonly index: number; readonly kind: "window" }
  | { readonly kind: "windows-reconcile" }
  | { readonly kind: "focus" };

/**
 * Applying stopped after tmux may already have changed.
 *
 * `completed` records whole high-level milestones. The failed stage itself may
 * be partial because mutations are not transactions and transport failure may
 * leave delivery indeterminate. `requiresReplan` asks callers to rediscover
 * session, window, and pane structure; it says nothing about command effects.
 */
export class WorkspaceApplyError extends Error {
  readonly completed: readonly WorkspaceApplyMilestone[];
  readonly failed: WorkspaceApplyStage;
  readonly requiresReplan = true;

  constructor(
    workspace: string,
    completed: readonly WorkspaceApplyMilestone[],
    failed: WorkspaceApplyStage,
    cause: unknown,
  ) {
    super(`workspace ${workspace} failed during ${failed.kind}`, { cause });
    this.name = "WorkspaceApplyError";
    this.completed = Object.freeze(
      completed.map((milestone) => Object.freeze({ ...milestone } as WorkspaceApplyMilestone)),
    );
    this.failed = Object.freeze({ ...failed } as WorkspaceApplyStage);
  }
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
 *
 * @throws ZodError when the workspace does not satisfy the strict config schema.
 * @throws TypeError when the operation options are invalid.
 * @throws WorkspaceApplyError when tmux fails after applying may have started.
 */
export async function applyWorkspace(
  server: Server,
  workspaceInput: Workspace,
  options: ApplyWorkspaceOptions = {},
): Promise<Session> {
  const workspace = parseWorkspace(workspaceInput);
  const { commands, prune } = normalizeApplyWorkspaceOptions(options);
  const completed: WorkspaceApplyMilestone[] = [];
  let failed: WorkspaceApplyStage = { action: "lookup", kind: "session" };
  try {
    const existing = await runningSession(server, workspace.session_name);
    failed = { action: "create", kind: "session" };
    const created = existing ?? (await createSession(server, workspace));
    completed.push({ kind: "session", status: existing === undefined ? "created" : "existing" });

    // Stamped on the session this apply created, and read back on every later
    // one. A name is a lookup, not a claim: without the mark, converging a
    // hand-made session of the same name would kill windows nobody described.
    failed = { action: "ownership", kind: "session" };
    const owned =
      existing === undefined || (await ownedByWorkspace(existing, workspace.session_name));
    if (existing === undefined) {
      failed = { action: "claim", kind: "session" };
      await claimSession(created, workspace.session_name);
      completed.push({ kind: "session-claimed" });
    }
    const pruning = mayPrune(prune, owned);

    failed = { action: "snapshot", kind: "session" };
    let session = (await server.snapshot()).sessions.one({ id: created.id });

    for (const [option, value] of Object.entries(workspace.options ?? {})) {
      failed = { kind: "workspace-option", name: option };
      // eslint-disable-next-line no-await-in-loop -- Later options may depend on earlier ones.
      await session.setOption(literalOptionName(option), optionValue(value));
      completed.push({ kind: "workspace-option", name: option });
    }

    for (const [index, desired] of workspace.windows.entries()) {
      failed = { index, kind: "window" };
      // eslint-disable-next-line no-await-in-loop -- Window order is observable, so creation is sequential.
      session = await session.refreshed();
      // A session created for this workspace had its first window made by tmux,
      // so that window is this apply's too, and its panes take the commands.
      const born = existing === undefined && index === 0;
      // eslint-disable-next-line no-await-in-loop -- Window order is observable, so creation is sequential.
      const placed = await windowAt(session, index, desired, workspace);
      // eslint-disable-next-line no-await-in-loop -- Window order is observable, so creation is sequential.
      await applyWindow(placed.window, desired, workspace, {
        commands,
        pruning,
        windowIsNew: placed.created || born,
      });
      completed.push({ index, kind: "window" });
    }

    if (pruning) {
      failed = { kind: "windows-reconcile" };
      session = await pruneWindows(session, workspace.windows.length);
      completed.push({ kind: "windows-reconciled" });
    }
    failed = { kind: "focus" };
    await focusRequested(session, workspace);
    failed = { action: "result", kind: "session" };
    return (await server.snapshot()).sessions.one({ id: created.id });
  } catch (error) {
    throw new WorkspaceApplyError(workspace.session_name, completed, failed, error);
  }
}

/**
 * Plan session, window, and pane membership without changing tmux.
 *
 * Reads the server once and answers from that capture, so it costs one snapshot
 * and changes nothing. It reports structural creation, removal, retention, and
 * window renames. It does not predict options, layouts, focus, or pane command
 * effects.
 *
 * ```ts
 * const plan = await planWorkspace(server, workspace);
 * if (plan.removesWindows.length > 0) console.log("would remove", plan.removesWindows);
 * ```
 *
 * @throws ZodError when the workspace does not satisfy the strict config schema.
 * @throws TypeError when planning options are invalid.
 */
export async function planWorkspace(
  server: Server,
  workspaceInput: Workspace,
  options: PlanWorkspaceOptions = {},
): Promise<WorkspacePlan> {
  const workspace = parseWorkspace(workspaceInput);
  const prune = normalizePlanWorkspaceOptions(options);
  return createWorkspacePlan(server, workspace, prune);
}

// Workspace keys are data; core option names retain tmux's format-capable surface.
function literalOptionName(name: string): string {
  return name.replaceAll("#", "##");
}

async function createSession(server: Server, workspace: Workspace): Promise<Session> {
  const directory = initialPaneStartDirectory(workspace);
  return server.newSession({
    name: workspace.session_name,
    ...(directory === undefined ? {} : { startDirectory: directory }),
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
  workspace: Workspace,
): Promise<{ readonly created: boolean; readonly window: Window }> {
  const existing = session.windows.at(index);
  if (existing === undefined) {
    const firstPane = desired.panes[0];
    const directory =
      firstPane === undefined
        ? windowStartDirectory(desired, workspace)
        : paneStartDirectory(firstPane, desired, workspace);
    return {
      created: true,
      window: await session.newWindow({
        ...(desired.window_name === undefined ? {} : { name: desired.window_name }),
        ...(directory === undefined ? {} : { startDirectory: directory }),
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
  readonly pruning: boolean;
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
    await window.setOption(literalOptionName(option), optionValue(value));
  }

  const wanted = desired.panes.length === 0 ? 1 : desired.panes.length;
  let current = await window.refreshed();
  // The surplus set is known before any pane goes, so one final snapshot can
  // resolve all removals.
  const surplus =
    context.pruning && !windowIsShared(current) ? current.panes.toArray().slice(wanted) : [];
  if (surplus.length > 0) {
    await current.server.batch(surplus.map((pane) => pane.plan.killIfWindowUnshared()));
    current = await current.refreshed();
  }
  // The completed window needs one snapshot rather than one per split. `-d`
  // keeps the active pane stable while the missing panes are created.
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

  // Layout requires the final pane count and stays last so its failure cannot
  // strand new panes before create-only command delivery.
  if (desired.layout !== undefined) await current.selectLayout(desired.layout);
}

async function pruneWindows(session: Session, wanted: number): Promise<Session> {
  const current = await session.refreshed();
  if (current.grouped !== false) return current;
  const surplus = current.windows.toArray().slice(wanted);
  if (surplus.length === 0) return current;
  await current.server.batch(surplus.map((window) => window.plan.removePlacement()));
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
