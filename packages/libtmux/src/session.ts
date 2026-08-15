import {
  getEnvironment,
  removeEnvironment,
  setEnvironment,
  showEnvironment,
  unsetEnvironment,
} from "./_internal/operations/environment.js";
import type { EnvironmentValue, PlannedOperation, SetEnvironmentOptions } from "./types.js";
import type { CmdOptions } from "./types.js";
import { runRawCommand } from "./_internal/operations/raw.js";
import type { SetOptionOptions } from "./types.js";
import type { NewWindowOptions, WindowTarget } from "./types.js";
import { SESSION_ALIASES, type SessionAliasMap } from "./_generated/field_aliases.js";
import type { AliasedFields, RowWithIdentities } from "./_internal/codec/schemas.js";
import { readTmuxEnvironment } from "./_internal/operations/env.js";
import { detachClient } from "./_internal/operations/shell.js";
import { panesOfSession, windowsOfSession } from "./_internal/operations/relations.js";
import { LibTmuxException } from "./exc.js";
import { setHook, showHooks, unsetHook } from "./_internal/operations/hooks.js";
import { killTarget, newWindow } from "./_internal/operations/mutations.js";
import { planKill, planNewWindow } from "./_internal/operations/plans.js";
import { setOption, showOptions, unsetOption } from "./_internal/operations/options.js";
import { renameSession, selectWindowIn } from "./_internal/operations/session_nav.js";
import { runtimeForServer } from "./_internal/runtime/context.js";
import { refreshHandle } from "./_internal/operations/refresh.js";
import { originGraphForHandle } from "./_internal/runtime/live_handle.js";
import type { Pane } from "./pane.js";
import type { Selection } from "./selection.js";
import type { Window } from "./window.js";
import { installLiveHandlePrototype, liveHandlesEqual } from "./_internal/runtime/live_handle.js";
import type { Server } from "./server.js";

/** What {@link Session.plan} offers, one entry per mutation it can describe. */
export interface SessionPlans {
  readonly kill: () => PlannedOperation<void>;
  readonly newWindow: (options?: NewWindowOptions) => PlannedOperation<Window>;
}

// eslint-disable-next-line typescript/no-unsafe-declaration-merging -- CompleteFormatRow declaration merging exposes the frozen scalar snapshot on the nominal handle.
export class Session {
  declare private readonly sessionBrand: undefined;
  /**
   * The server this handle addresses.
   *
   * ```ts
   * session.server.socketPath;
   * ```
   */
  declare readonly server: Server;

  private constructor() {
    throw new Error("Session cannot be constructed directly");
  }

  /**
   * Windows placed in this session, in listing order.
   *
   * Resolved from the graph this handle was materialized against, so it issues
   * no tmux command and reports the instant the handle came from.
   *
   * ```ts
   * session.windows.count();
   * session.windows.where({ name: "editor" }).first();
   * ```
   */
  get windows(): Selection<Window> {
    return windowsOfSession(originGraphForHandle(this), this.id);
  }

  /**
   * Panes contained by this session's windows.
   *
   * ```ts
   * session.panes.where({ currentCommand: "vim" }).count();
   * ```
   */
  get panes(): Selection<Pane> {
    return panesOfSession(originGraphForHandle(this), this.id);
  }

  /**
   * Every option this session currently sees, including inherited values.
   *
   * ```ts
   * const options = await session.showOptions();
   * options.get("status");
   * ```
   */
  showOptions(): Promise<ReadonlyMap<string, string>> {
    return showOptions(runtimeForServer(this.server), "session", this.id);
  }

  /**
   * Set an option on this session.
   *
   * ```ts
   * await session.setOption("status", "off");
   * ```
   */
  setOption(name: string, value: string, options?: SetOptionOptions): Promise<void> {
    return setOption(runtimeForServer(this.server), "session", this.id, name, value, options);
  }

  /**
   * Remove an option from this session.
   *
   * ```ts
   * await session.unsetOption("status");
   * ```
   */
  unsetOption(name: string): Promise<void> {
    return unsetOption(runtimeForServer(this.server), "session", this.id, name);
  }

  /**
   * Every hook this session reports.
   *
   * ```ts
   * const hooks = await session.showHooks();
   * hooks.get("window-linked");
   * ```
   */
  showHooks(): Promise<ReadonlyMap<string, string>> {
    return showHooks(runtimeForServer(this.server), "session", this.id);
  }

  /**
   * Bind a tmux command to a hook on this session.
   *
   * ```ts
   * await session.setHook("window-linked", "display-message 'linked'");
   * ```
   */
  setHook(name: string, command: string): Promise<void> {
    return setHook(runtimeForServer(this.server), "session", this.id, name, command);
  }

  /**
   * Remove a hook from this session.
   *
   * ```ts
   * await session.unsetHook("window-linked");
   * ```
   */
  unsetHook(name: string): Promise<void> {
    return unsetHook(runtimeForServer(this.server), "session", this.id, name);
  }

  /**
   * Every variable in this session's environment.
   *
   * A `null` value is tmux's `-NAME`: present, and marked for removal from any
   * process tmux starts.
   *
   * ```ts
   * const environment = await session.showEnvironment();
   * environment.get("EDITOR");
   * ```
   */
  showEnvironment(): Promise<ReadonlyMap<string, EnvironmentValue>> {
    return showEnvironment(runtimeForServer(this.server), "session", this.id);
  }

  /**
   * One variable from this session's environment, or `undefined` when tmux carries no entry.
   *
   * ```ts
   * await session.getEnvironment("EDITOR"); // "vim", null, or undefined
   * ```
   */
  getEnvironment(name: string): Promise<EnvironmentValue | undefined> {
    return getEnvironment(runtimeForServer(this.server), "session", this.id, name);
  }

  /**
   * Set a variable in this session's environment.
   *
   * ```ts
   * await session.setEnvironment("EDITOR", "vim");
   * ```
   */
  setEnvironment(name: string, value: string, options?: SetEnvironmentOptions): Promise<void> {
    return setEnvironment(runtimeForServer(this.server), "session", this.id, name, value, options);
  }

  /**
   * Drop a variable from this session's environment entirely.
   *
   * ```ts
   * await session.unsetEnvironment("EDITOR");
   * ```
   */
  unsetEnvironment(name: string): Promise<void> {
    return unsetEnvironment(runtimeForServer(this.server), "session", this.id, name);
  }

  /**
   * Mark a variable in this session's environment for removal from the environment of processes
   * tmux starts, leaving the entry in place.
   *
   * ```ts
   * await session.removeEnvironment("EDITOR");
   * ```
   */
  removeEnvironment(name: string): Promise<void> {
    return removeEnvironment(runtimeForServer(this.server), "session", this.id, name);
  }

  /**
   * The window tmux marks active in this session.
   *
   * ```ts
   * session.activeWindow?.name;
   * ```
   */
  get activeWindow(): Window | undefined {
    return this.windows.where({ active: "1" }).first();
  }

  /**
   * The pane tmux marks active in this session's active window.
   *
   * This is two hops rather than one because `pane_active` is per window: every
   * window has an active pane, and only the active window's is the session's.
   *
   * ```ts
   * await session.activePane?.sendKeys("echo hello");
   * ```
   */
  get activePane(): Pane | undefined {
    return this.activeWindow?.activePane;
  }

  /**
   * Create a window in this session and resolve it as a handle.
   *
   * ```ts
   * const created = await session.newWindow({ name: "editor" });
   * created.name; // "editor"
   * ```
   */
  newWindow(options?: NewWindowOptions): Promise<Window> {
    return newWindow(this.server, runtimeForServer(this.server), this.id, options);
  }

  /**
   * The same mutations, described instead of run.
   *
   * `session.plan.newWindow(…)` takes what `session.newWindow(…)` takes and
   * resolves to what it resolves to; it just hands the work to
   * {@link Server.batch} rather than doing it now. A batch spends one
   * invocation and one snapshot on the whole group, where calling them one at a
   * time spends both per call.
   *
   * ```ts
   * const [editor, logs] = await server.batch([
   *   session.plan.newWindow({ name: "editor" }),
   *   session.plan.newWindow({ name: "logs" }),
   * ]);
   * ```
   */
  get plan(): SessionPlans {
    return {
      kill: () => planKill("kill-session", this.id),
      newWindow: (options?: NewWindowOptions) => planNewWindow(this.id, options),
    };
  }

  /**
   * Destroy this session.
   *
   * ```ts
   * await session.kill();
   * ```
   */
  kill(): Promise<void> {
    return killTarget(runtimeForServer(this.server), "kill-session", this.id);
  }

  /**
   * Re-read this session at the current instant, in place.
   *
   * ```ts
   * await session.refresh();
   * session.windows.count(); // re-read
   * ```
   */
  refresh(): Promise<void> {
    return refreshHandle(this, runtimeForServer(this.server));
  }

  /**
   * Rename this session.
   *
   * ```ts
   * await session.rename("renamed");
   * ```
   */
  rename(name: string): Promise<void> {
    return renameSession(runtimeForServer(this.server), this.id, name);
  }

  /**
   * Select the last, next, or previous window, or one named by target.
   *
   * ```ts
   * await session.selectWindow("next");
   * ```
   */
  selectWindow(target: WindowTarget): Promise<void> {
    return selectWindowIn(runtimeForServer(this.server), this.id, target);
  }

  /**
   * Resolve the session this process is running inside.
   *
   * The pane is authoritative: `$TMUX`'s exported session id goes stale when a
   * pane is moved, so the session is looked up through `$TMUX_PANE` instead.
   *
   * ```ts
   * const current = await Session.fromEnv();
   * current.name;
   * ```
   */
  static async fromEnv(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): Promise<Session> {
    const { paneId, socketPath } = readTmuxEnvironment(environment);
    const { Server } = await import("./server.js");
    const server = new Server({ environment, socketPath });
    const snapshot = await server.snapshot();
    const pane = snapshot.panes.filter((candidate) => candidate.id === paneId).first();
    if (pane === undefined) {
      throw new LibTmuxException(`${paneId} is not present on ${socketPath}`);
    }
    const session = pane.session;
    if (session === undefined) {
      throw new LibTmuxException(`${paneId} has no session on ${socketPath}`);
    }
    return session;
  }

  /**
   * Detach every client attached to this session.
   *
   * ```ts
   * await session.detach();
   * ```
   */
  detach(): Promise<void> {
    return detachClient(runtimeForServer(this.server), this.id);
  }

  /**
   * Run a tmux command this package does not model, addressed at this session.
   *
   * ```ts
   * await session.cmd("rename-session -- new");
   * ```
   *
   * The session's id is sent as the target; pass `target` to address something
   * else, or `null` for a command that takes none.
   */
  cmd(
    command: string,
    args: readonly string[] = [],
    options?: CmdOptions,
  ): Promise<readonly string[]> {
    return runRawCommand(runtimeForServer(this.server), this.id, command, args, options);
  }

  equals(other: unknown): boolean {
    return liveHandlesEqual(this, other);
  }
}

type SessionRow = RowWithIdentities<"session_id">;

export interface Session extends AliasedFields<SessionRow, SessionAliasMap> {
  /**
   * How this handle renders in a log line, a template literal, or an error.
   *
   * Installed with the rest of the live-handle prototype, and declared here so
   * the emitted types advertise it and a caller's own lint does not report the
   * default `[object Object]`.
   */
  toString(): string;
  /** The raw tmux format row, addressed by tmux's own token names. */
  readonly format: SessionRow;
}

installLiveHandlePrototype(Session.prototype, SESSION_ALIASES);
