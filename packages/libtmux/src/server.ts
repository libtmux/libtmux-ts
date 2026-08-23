import type { CommandOptions } from "./common.js";
import { runPipeline, runPipelineSequentially } from "./_internal/operations/pipeline.js";
import type { TmuxVersion } from "./types.js";
import { parseTmuxVersion, tmuxVersionAtLeast } from "./_internal/runtime/tmux_version.js";
import {
  getEnvironment,
  removeEnvironment,
  setEnvironment,
  showEnvironment,
  unsetEnvironment,
} from "./_internal/operations/environment.js";
import type { EnvironmentValue, SetEnvironmentOptions } from "./types.js";
import type {
  CmdOptions,
  ConnectedServer,
  ManagedServer,
  PlannedOperation,
  IfShellOptions,
  NewSessionOptions,
  RunShellOptions,
  ServerSnapshot,
  SetOptionOptions,
  TmuxEventStream,
  TransportMode,
  WatchOptions,
} from "./types.js";
import { randomUUID } from "node:crypto";

import { runRawCommand } from "./_internal/operations/raw.js";

import type { Client } from "./client.js";
import type { ConnectionAlias, DaemonEpoch } from "./common.js";
import { LibTmuxException, WaitTimeout } from "./exc.js";
import type { Pane } from "./pane.js";
import type { Selection } from "./selection.js";
import type { Session } from "./session.js";
import type { Window } from "./window.js";
import { setHook, showHooks, unsetHook } from "./_internal/operations/hooks.js";
import { killServer, newSession } from "./_internal/operations/mutations.js";
import { setOption, showOptions, unsetOption } from "./_internal/operations/options.js";
import { ifShell, runShell } from "./_internal/operations/shell.js";
import {
  deleteBuffer,
  isAlive,
  raiseIfDead,
  hasSession,
  listBuffers,
  listCommands,
  loadBuffer,
  saveBuffer,
  setBuffer,
  showBuffer,
  sourceFile,
} from "./_internal/operations/server_utils.js";
import { buildServerSnapshot } from "./_internal/operations/snapshot.js";
import {
  createRuntimeContext,
  invalidateRuntimeEpoch,
  createServerWithRuntime,
  lastObservedDaemon,
  registerServerRuntime,
  runtimeForServer,
  runtimeForServerValue,
  type DaemonIdentity,
  type RuntimeContext,
} from "./_internal/runtime/context.js";
import { TmuxConnection } from "./_internal/runtime/connection.js";

export type { DaemonIdentity } from "./_internal/runtime/context.js";
import { ControlConnection, watchServer } from "./_internal/control/connection.js";
import { NodeSpawnTransport } from "./_internal/transport/node_spawn_transport.js";
import type { CommandTransport } from "./_internal/transport/types.js";

export interface ServerOptions {
  readonly colors?: 88 | 256;
  readonly configFile?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly socketName?: string;
  readonly socketPath?: string;
  /**
   * Default deadline, in milliseconds, for every command this server runs.
   *
   * A single call can override it. Without either, a command waits as long as
   * tmux takes; a long-lived process that cannot bound its work cannot recover
   * from a daemon that stops answering.
   */
  readonly timeoutMs?: number;
  readonly tmuxBin?: string;
  /**
   * Which way commands reach tmux, for {@link Server.open}.
   *
   * Read from `LIBTMUX_TRANSPORT` when this is not set, so a script that hard-codes
   * nothing can still be pointed at a connection from the outside. `new Server()`
   * ignores it: attaching is asynchronous and can fail, and a constructor that
   * appeared to honour it would either hide the wait or defer the failure to
   * whichever command happened to run first.
   */
  readonly transport?: TransportMode;
  /**
   * Run this server's commands somewhere other than a local `tmux`.
   *
   * The built-in engine spawns a process per command; supplying one moves every
   * layer above it — snapshots, queries, handles — to a tmux reached however
   * you reach it. See `libtmux/engine` for what an engine owes its caller.
   *
   * `LIBTMUX_TRANSPORT` is ignored when this is given: the variable comes from
   * whoever started the process and would move every command to *this*
   * machine's tmux. Naming `transport: "control"` here as well is refused
   * instead, because control mode is a process this one spawns and an engine
   * says tmux is not somewhere it can. {@link Server.watch} and
   * {@link Server.connect} refuse for the same reason.
   */
  readonly engine?: CommandTransport;
}

/** What `LIBTMUX_TRANSPORT` may say, and what it selects. */
function transportFrom(
  options: ServerOptions | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): TransportMode {
  if (options?.transport !== undefined) return options.transport;
  const named = environment.LIBTMUX_TRANSPORT;
  if (named === undefined || named === "") return "spawn";
  if (named !== "control" && named !== "spawn") {
    throw new TypeError(
      `LIBTMUX_TRANSPORT must be "control" or "spawn", not ${JSON.stringify(named)}`,
    );
  }
  return named;
}

/**
 * How a connection addresses its daemon, as one comparable string.
 *
 * An absolute socket path names the daemon outright. A name does not: it is
 * resolved against `TMUX_TMPDIR` (then the default tmpdir) and a per-user
 * directory, so the tmpdir in force is part of the address. tmux's own default
 * name is `default`, which is why an unnamed connection is not a third case.
 */
function socketAddress(connection: TmuxConnection): string {
  if (connection.socketPath !== undefined) return `path ${connection.socketPath}`;
  const tmpdir = connection.environment.TMUX_TMPDIR ?? "";
  return `name ${tmpdir} ${connection.socketName ?? "default"}`;
}

/**
 * Which tmux this runtime addresses, or `undefined` when that is unknowable.
 *
 * An engine's socket is a path on a machine this process cannot see, so the
 * socket alone does not name the daemon. Unknowable rather than guessed: an
 * engine that declares no endpoint is the one case where answering would mean
 * inventing the fact the comparison turns on.
 */
function serverAddress(runtime: RuntimeContext): string | undefined {
  const socket = socketAddress(runtime.connection);
  if (runtime.engine === undefined) return `local ${socket}`;
  const endpoint = runtime.engine.endpoint;
  if (endpoint === undefined || endpoint === "") return undefined;
  return `engine ${endpoint} ${socket}`;
}

/**
 * Refuse a call that can only reach a tmux this process can spawn.
 *
 * Control mode is a `tmux -C attach` child of this process. An engine exists
 * because tmux is somewhere this process cannot spawn it, so spawning anyway
 * would attach to whatever local tmux happens to be there — and every command
 * afterwards would succeed against the wrong server.
 */
function refuseWithoutLocalTmux(runtime: RuntimeContext, method: string): void {
  if (runtime.engine === undefined) return;
  throw new LibTmuxException(
    `${method}() holds a local tmux control process open, which a server built with an engine has no way to reach. Use snapshot() and the mutating methods, which travel through the engine, or build a Server without one to watch a local daemon.`,
  );
}

export class Server {
  declare private readonly serverBrand: undefined;

  constructor(...[options]: [options?: ServerOptions]) {
    if (!(this instanceof Server)) {
      throw new TypeError("Server constructor requires a Server instance");
    }
    if (options?.socketName !== undefined && options.socketPath !== undefined) {
      throw new TypeError("socketName and socketPath are mutually exclusive");
    }

    const connection = new TmuxConnection({
      executable: options?.tmuxBin ?? "tmux",
      environment: options?.environment ?? process.env,
      ...(options?.colors === undefined ? {} : { colors: options.colors }),
      ...(options?.configFile === undefined ? {} : { configFile: options.configFile }),
      ...(options?.socketName === undefined ? {} : { socketName: options.socketName }),
      ...(options?.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    });
    const runtime = createRuntimeContext({
      connection,
      connectionAlias: randomUUID() as ConnectionAlias,
      daemonEpoch: 0 as DaemonEpoch,
      ...(options?.engine === undefined ? {} : { engine: options.engine }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      transport: options?.engine ?? new NodeSpawnTransport(),
    });
    registerServerRuntime(this, runtime);
  }

  /**
   * Build a server with its transport already chosen.
   *
   * The same API either way: what changes is whether a command spawns a process
   * or travels over a connection this holds open. The mode comes from
   * `transport`, or from `LIBTMUX_TRANSPORT` when that is not set — so a script
   * can be pointed at a connection without editing it, and a test can force
   * either mode around code that names neither.
   *
   * Asynchronous because attaching is: a control connection has to reach tmux
   * before it can carry anything, and a server with no sessions has nothing to
   * attach to. `close` is safe on both, and does nothing on a spawning server.
   *
   * ```ts
   * await using managed = await Server.open({ transport: "control" });
   * (await managed.snapshot()).sessions.count();
   * ```
   */
  static async open(options?: ServerOptions): Promise<ManagedServer> {
    const environment = options?.environment ?? process.env;
    // Named together, these contradict: control mode is a process this one
    // spawns, and an engine says tmux is not somewhere this process spawns.
    // Refused rather than resolved, the way socketName and socketPath are.
    if (options?.engine !== undefined && options.transport === "control") {
      throw new TypeError('transport: "control" and engine are mutually exclusive');
    }
    const server = new Server(options);
    // An engine ignores `LIBTMUX_TRANSPORT` rather than obeying it. The
    // variable is set by whoever started the process; the engine is written by
    // the caller, about where their tmux is. Obeying the variable would move
    // every command to this machine's tmux, and report success.
    if (options?.engine === undefined && transportFrom(options, environment) === "control") {
      return server.connect();
    }
    // Nothing is held, so releasing it is a no-op — but the call has to exist,
    // or switching modes by configuration would mean editing the caller.
    return Object.defineProperties(server, {
      close: { value: async (): Promise<void> => undefined },
      [Symbol.asyncDispose]: { value: async (): Promise<void> => undefined },
    }) as ManagedServer;
  }

  /**
   * Run `body` against a connected server, closing it afterwards.
   *
   * The scoped form of {@link connect}, for code that cannot use `await using`
   * — it needs `Symbol.asyncDispose` in the consumer's `lib` — or would rather
   * not manage the lifetime by hand. The connection closes on the way out
   * whether `body` returns or throws.
   *
   * ```ts
   * const opened = await server.withConnection(async (live) => {
   *   await session.newWindow({ name: "build" });
   *   return live.waitFor((current) => current.windows.exists({ name: "build" }));
   * });
   * opened.windows.count({ name: "build" }); // 1
   * ```
   */
  async withConnection<T>(
    body: (live: ConnectedServer) => Promise<T>,
    options?: WatchOptions,
  ): Promise<T> {
    const live = await this.connect(options);
    try {
      return await body(live);
    } finally {
      await live.close();
    }
  }

  /**
   * How many colours this server was told the terminal has.
   *
   * ```ts
   * new Server({ colors: 256 }).colors; // 256
   * ```
   */
  get colors(): 88 | 256 | undefined {
    return runtimeForServerValue(this)?.connection.colors;
  }

  /**
   * The configuration file this server was pointed at, if any.
   *
   * ```ts
   * new Server({ configFile: "~/.tmux.conf" }).configFile;
   * ```
   *
   * ```ts
   * new Server({ configFile: "~/.tmux.conf" }).configFile;
   * ```
   */
  get configFile(): string | undefined {
    return runtimeForServerValue(this)?.connection.configFile;
  }

  /**
   * The socket name this server addresses, if it was named rather than pathed.
   *
   * ```ts
   * new Server({ socketName: "work" }).socketName; // "work"
   * ```
   *
   * ```ts
   * new Server({ socketName: "work" }).socketName; // "work"
   * ```
   */
  get socketName(): string | undefined {
    return runtimeForServerValue(this)?.connection.socketName;
  }

  /**
   * The socket path this server addresses, if it was given one.
   *
   * ```ts
   * new Server({ socketPath: "/tmp/tmux-1000/work" }).socketPath;
   * ```
   *
   * ```ts
   * new Server({ socketPath: "/tmp/tmux-1000/work" }).socketPath;
   * ```
   */
  get socketPath(): string | undefined {
    return runtimeForServerValue(this)?.connection.socketPath;
  }

  /**
   * The engine this server was built with, if it was given one.
   *
   * `undefined` means tmux is a process this one can spawn, which is what
   * {@link Server.watch} and {@link Server.connect} need and what a caller
   * choosing between a connection and a command per read has to know.
   *
   * ```ts
   * const reader = server.engine === undefined ? await server.connect() : server;
   * (await reader.snapshot()).windows.count();
   * ```
   */
  get engine(): CommandTransport | undefined {
    return runtimeForServerValue(this)?.engine;
  }

  /**
   * The tmux executable this server runs.
   *
   * ```ts
   * new Server().tmuxBin; // "tmux"
   * ```
   *
   * ```ts
   * new Server().tmuxBin; // "tmux"
   * ```
   */
  get tmuxBin(): string {
    return runtimeForServerValue(this)?.connection.executable ?? "tmux";
  }

  /**
   * How this server renders in a log line or an error.
   *
   * A server is identified by the socket it talks to, so that is what the
   * description carries; without one the default rendering is `[object Object]`,
   * which says nothing about which of several servers a message is about.
   */
  toString(): string {
    return `Server(${this.socketPath ?? this.socketName ?? "default"})`;
  }

  /**
   * Stream tmux's control-mode notifications until the stream is disposed.
   *
   * A snapshot answers what is true now; this answers what changed. The stream
   * holds one `tmux -C attach-session` process for its lifetime, so it reports
   * events without polling and without a command per read.
   *
   * ```ts
   * await using events = server.watch();
   * for await (const event of events) {
   *   if (event.kind === "window-add") console.log(event.windowId);
   * }
   * ```
   *
   * tmux sends a control client no pane output until it attaches, so this
   * attaches to a session; a server with no sessions has nothing to watch.
   */
  watch(options?: WatchOptions): TmuxEventStream {
    const runtime = runtimeForServer(this);
    refuseWithoutLocalTmux(runtime, "watch");
    return watchServer(runtime.connection, options);
  }

  /**
   * Bind this server to one control-mode connection and return it.
   *
   * The returned server has the same API, but its commands travel over an
   * already-open connection instead of spawning a `tmux` process each. A
   * snapshot costs four writes rather than four processes, which is what makes
   * reacting to {@link watch} events affordable in a loop.
   *
   * ```ts
   * await using live = await server.connect();
   * for await (const event of live.subscribe()) {
   *   if (event.kind === "window-add") console.log((await live.snapshot()).windows.count());
   * }
   * ```
   *
   * `loadBuffer` and anything else that feeds a command stdin still needs the
   * spawning server, since control mode has no channel for it.
   */
  async connect(options?: WatchOptions): Promise<ConnectedServer> {
    const runtime = runtimeForServer(this);
    refuseWithoutLocalTmux(runtime, "connect");
    const connection = new ControlConnection(
      runtime.connection,
      options,
      false,
      new NodeSpawnTransport(),
    );
    try {
      await connection.ready();
    } catch (error) {
      await connection.close();
      throw new LibTmuxException(
        error instanceof Error ? error.message : "tmux control mode could not attach",
        { cause: error },
      );
    }
    const boundRuntime = createRuntimeContext({
      connection: runtime.connection,
      connectionAlias: randomUUID() as ConnectionAlias,
      daemonEpoch: 0 as DaemonEpoch,
      ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
      transport: connection,
    });
    // A control client proves which daemon it is talking to for as long as it
    // stays up. When it does not, every handle read through it is from a daemon
    // this connection can no longer vouch for.
    connection.onDaemonLost(() => {
      invalidateRuntimeEpoch(boundRuntime);
    });
    const bound = createServerWithRuntime(boundRuntime) as ConnectedServer;
    Object.defineProperties(bound, {
      close: { value: () => connection.close() },
      subscribe: { value: () => connection.subscribe() },
      waitFor: {
        value: async (
          matches: (snapshot: ServerSnapshot) => boolean,
          options: { readonly timeoutMs?: number } = {},
        ): Promise<ServerSnapshot> => {
          // Subscribe before reading, or a change that lands between the read
          // and the subscription is never seen and the wait hangs on a
          // condition that is already true.
          const events = connection.subscribe();
          let deadlinePassed = false;
          const deadline = setTimeout(() => {
            deadlinePassed = true;
            void events.close();
          }, options.timeoutMs ?? 30_000);
          try {
            let snapshot = await bound.snapshot();
            if (matches(snapshot)) return snapshot;
            for await (const _event of events) {
              snapshot = await bound.snapshot();
              if (matches(snapshot)) return snapshot;
            }
          } finally {
            clearTimeout(deadline);
            await events.close();
          }
          // Waiting out a deadline and losing the connection are different
          // outcomes, and only one of them says anything about the condition.
          throw deadlinePassed
            ? new WaitTimeout("the awaited tmux state did not arrive before the deadline")
            : new LibTmuxException("the tmux event stream ended before the awaited state arrived");
        },
      },
      // A chained line draws one response block per command from tmux, and this
      // connection pairs one block with one request, so the sequence goes down
      // it one command at a time. That costs the same here: the process is
      // already running and these are writes on its socket.
      pipeline: {
        value: (
          commands: readonly (readonly string[])[],
          options?: CommandOptions,
        ): Promise<readonly (readonly string[])[]> =>
          runPipelineSequentially(boundRuntime, commands, options),
      },
      [Symbol.asyncDispose]: { value: () => connection.close() },
    });
    return bound;
  }

  /**
   * Acquire an immutable view of the server at this instant.
   *
   * Acquisition is the only step that talks to tmux. Everything reachable from
   * the returned value resolves locally, so traversal and filtering issue no
   * commands and an earlier snapshot keeps reporting its own instant.
   *
   * ```ts
   * const now = await server.snapshot();
   * now.windows.count();
   * ```
   */
  snapshot(): Promise<ServerSnapshot> {
    return buildServerSnapshot(this, runtimeForServer(this));
  }

  /**
   * Every session on the server, read now.
   *
   * This and its three siblings each take a snapshot of their own — four tmux
   * commands per call — so calling several in a row describes several different
   * instants and pays for each. Inside a loop that is an N+1: prefer one
   * {@link snapshot} and read `sessions`, `windows`, `panes`, and `clients`
   * off it, which is both cheaper and consistent.
   *
   * ```ts
   * // Four commands, and every collection agrees with the others.
   * const now = await server.snapshot();
   * for (const session of now.sessions) console.log(session.name, session.windows.length);
   * ```
   *
   * ```ts
   * const sessions = await server.sessions();
   * sessions.where({ name: "work" }).count();
   * ```
   */
  async sessions(): Promise<Selection<Session>> {
    return (await this.snapshot()).sessions;
  }

  /**
   * Every window on the server, including each placement of a linked window.
   *
   * ```ts
   * const windows = await server.windows();
   * windows.first()?.name;
   * ```
   */
  async windows(): Promise<Selection<Window>> {
    return (await this.snapshot()).windows;
  }

  /**
   * Every pane on the server.
   *
   * ```ts
   * const panes = await server.panes();
   * panes.where({ currentCommand: "vim" }).count();
   * ```
   */
  async panes(): Promise<Selection<Pane>> {
    return (await this.snapshot()).panes;
  }

  /**
   * Which daemon is answering on this socket right now.
   *
   * A socket path names a place, not a process. `kill-server` followed by a
   * restart puts a different daemon at the same path, and that daemon numbers
   * its panes from `%0` again — so a handle held across the restart names an
   * object that no longer exists, at an id something else now has. Comparing
   * this before and after is how a long-running caller can tell.
   *
   * `undefined` when the server has nothing to list, which is also the only
   * case where it has handed out no handles to invalidate.
   *
   * ```ts
   * const before = await server.daemonIdentity();
   * const after = await server.daemonIdentity();
   * before?.pid === after?.pid;
   * ```
   */
  async daemonIdentity(): Promise<DaemonIdentity | undefined> {
    // Acquisition reads `pid` and `start_time` on every row already, so this
    // costs the snapshot it would have taken anyway and no command of its own.
    await this.snapshot();
    return lastObservedDaemon(runtimeForServer(this));
  }

  /**
   * Every client attached to the server.
   *
   * ```ts
   * const clients = await server.clients();
   * clients.map((entry) => entry.tty);
   * ```
   */
  async clients(): Promise<Selection<Client>> {
    return (await this.snapshot()).clients;
  }

  /**
   * Every server-scope option tmux currently reports.
   *
   * ```ts
   * const options = await server.showOptions();
   * options.get("escape-time");
   * ```
   */
  showOptions(): Promise<ReadonlyMap<string, string>> {
    return showOptions(runtimeForServer(this), "server");
  }

  /**
   * Set a server-scope option.
   *
   * ```ts
   * await server.setOption("escape-time", "0");
   * ```
   */
  setOption(name: string, value: string, options?: SetOptionOptions): Promise<void> {
    return setOption(runtimeForServer(this), "server", null, name, value, options);
  }

  /**
   * Remove a server-scope option.
   *
   * ```ts
   * await server.unsetOption("escape-time");
   * ```
   */
  unsetOption(name: string): Promise<void> {
    return unsetOption(runtimeForServer(this), "server", null, name);
  }

  /**
   * Write a paste buffer to a file instead of reading it back.
   *
   * `showBuffer` returns the contents through this process; for a large buffer
   * that means holding it in memory to put it somewhere else. tmux writes the
   * file itself, on the machine tmux is running on.
   *
   * ```ts
   * await server.saveBuffer("captured", "/tmp/build.log");
   * ```
   */
  saveBuffer(name: string, path: string, options?: { readonly append?: boolean }): Promise<void> {
    return saveBuffer(runtimeForServer(this), name, path, options);
  }

  /**
   * Read the defaults every session or window inherits.
   *
   * Most of tmux's options live here rather than on an object: a session that
   * has set nothing reports nothing, while the values actually governing it
   * are these. `history-limit` and `default-shell` are both global session
   * options and `remain-on-exit` a global window one; none of the three is
   * readable any other way.
   *
   * ```ts
   * const defaults = await server.showGlobalOptions("session");
   * defaults.get("default-shell");
   * ```
   */
  showGlobalOptions(scope: "session" | "window"): Promise<ReadonlyMap<string, string>> {
    return showOptions(runtimeForServer(this), scope, null, { global: true });
  }

  /**
   * Set a default every session or window inherits.
   *
   * ```ts
   * await server.setGlobalOption("session", "history-limit", "50000");
   * ```
   */
  setGlobalOption(
    scope: "session" | "window",
    name: string,
    value: string,
    options?: SetOptionOptions,
  ): Promise<void> {
    return setOption(runtimeForServer(this), scope, null, name, value, {
      ...options,
      global: true,
    });
  }

  /**
   * Remove a default, so tmux falls back to its own built-in value.
   *
   * ```ts
   * await server.unsetGlobalOption("session", "history-limit");
   * ```
   */
  unsetGlobalOption(scope: "session" | "window", name: string): Promise<void> {
    return unsetOption(runtimeForServer(this), scope, null, name, { global: true });
  }

  /**
   * Every global hook tmux currently reports.
   *
   * A hook is an array of commands, keyed by the name `setHook` takes, so
   * what was set reads back under the name it was set with. tmux prints each
   * element as `name[0]`, which composes with neither of the writers.
   *
   * ```ts
   * const hooks = await server.showHooks();
   * hooks.get("session-created")?.[0];
   * ```
   */
  showHooks(): Promise<ReadonlyMap<string, readonly string[]>> {
    return showHooks(runtimeForServer(this), "server");
  }

  /**
   * Bind a tmux command to a global hook.
   *
   * ```ts
   * await server.setHook("session-created", "display-message 'hello'");
   * ```
   */
  setHook(name: string, command: string): Promise<void> {
    return setHook(runtimeForServer(this), "server", null, name, command);
  }

  /**
   * Remove a global hook.
   *
   * ```ts
   * await server.unsetHook("session-created");
   * ```
   */
  unsetHook(name: string): Promise<void> {
    return unsetHook(runtimeForServer(this), "server", null, name);
  }

  /**
   * The tmux version this server is running.
   *
   * The version is probed once per connection and cached with the rest of the
   * server's capabilities, so asking repeatedly costs nothing after the first.
   *
   * ```ts
   * const version = await server.version();
   * version.major; // 3
   * ```
   */
  async version(): Promise<TmuxVersion> {
    return (await runtimeForServer(this).capabilities.bind()).tmuxVersion;
  }

  /**
   * Whether this server is at least `minimum`, written the way tmux writes it.
   *
   * This is how a caller gates on a feature that arrived in a known release
   * without parsing `#{version}` themselves. A `master` build compares above
   * every tagged release.
   *
   * ```ts
   * if (await server.versionAtLeast("3.3")) {
   *   await server.setOption("extended-keys", "on");
   * }
   * ```
   */
  async versionAtLeast(minimum: string): Promise<boolean> {
    return tmuxVersionAtLeast(await this.version(), parseTmuxVersion(minimum));
  }

  /**
   * Every variable in the server's global environment.
   *
   * A `null` value is tmux's `-NAME`: present, and marked for removal from any
   * process tmux starts.
   *
   * ```ts
   * const environment = await server.showEnvironment();
   * environment.get("EDITOR");
   * ```
   */
  showEnvironment(): Promise<ReadonlyMap<string, EnvironmentValue>> {
    return showEnvironment(runtimeForServer(this), "server", null);
  }

  /**
   * One variable from the server's global environment, or `undefined` when tmux carries no entry.
   *
   * ```ts
   * await server.getEnvironment("EDITOR"); // "vim", null, or undefined
   * ```
   */
  getEnvironment(name: string): Promise<EnvironmentValue | undefined> {
    return getEnvironment(runtimeForServer(this), "server", null, name);
  }

  /**
   * Set a variable in the server's global environment.
   *
   * ```ts
   * await server.setEnvironment("EDITOR", "vim");
   * ```
   */
  setEnvironment(name: string, value: string, options?: SetEnvironmentOptions): Promise<void> {
    return setEnvironment(runtimeForServer(this), "server", null, name, value, options);
  }

  /**
   * Drop a variable from the server's global environment entirely.
   *
   * ```ts
   * await server.unsetEnvironment("EDITOR");
   * ```
   */
  unsetEnvironment(name: string): Promise<void> {
    return unsetEnvironment(runtimeForServer(this), "server", null, name);
  }

  /**
   * Mark a variable in the server's global environment for removal from the environment of processes
   * tmux starts, leaving the entry in place.
   *
   * ```ts
   * await server.removeEnvironment("EDITOR");
   * ```
   */
  removeEnvironment(name: string): Promise<void> {
    return removeEnvironment(runtimeForServer(this), "server", null, name);
  }

  /**
   * Create a detached session and resolve it as a handle.
   *
   * ```ts
   * const created = await server.newSession({ name: "work" });
   * created.name; // "work"
   * ```
   */
  newSession(options?: NewSessionOptions): Promise<Session> {
    return newSession(this, runtimeForServer(this), options);
  }

  /**
   * Terminate the tmux server and every session on it.
   *
   * ```ts
   * await server.kill();
   * ```
   */
  kill(): Promise<void> {
    return killServer(runtimeForServer(this));
  }

  /**
   * Whether a session with this name exists.
   *
   * ```ts
   * if (!(await server.hasSession("work"))) {
   *   await server.newSession({ name: "work" });
   * }
   * ```
   */
  hasSession(name: string): Promise<boolean> {
    return hasSession(runtimeForServer(this), name);
  }

  /**
   * Run a tmux config file against this server.
   *
   * ```ts
   * await server.sourceFile("~/.tmux.conf");
   * ```
   */
  sourceFile(path: string): Promise<void> {
    return sourceFile(runtimeForServer(this), path);
  }

  /**
   * Every command name the running tmux understands.
   *
   * ```ts
   * const commands = await server.listCommands();
   * commands.includes("new-window"); // true
   * ```
   */
  listCommands(): Promise<readonly string[]> {
    return listCommands(runtimeForServer(this));
  }

  /** Store a named paste buffer. */
  /**
   * Fill a paste buffer from data fed through tmux's stdin.
   *
   * Use this over {@link Server.setBuffer} for anything large or binary: that
   * one passes its data as a command-line argument, and this one does not.
   * Control mode has no channel for stdin, so this needs the spawning server.
   *
   * ```ts
   * await server.loadBuffer("payload", new Uint8Array([0x68, 0x69]));
   * ```
   */
  loadBuffer(name: string, data: string | Uint8Array): Promise<void> {
    return loadBuffer(runtimeForServer(this), name, data);
  }

  /**
   * Put a string into a named paste buffer.
   *
   * ```ts
   * await server.setBuffer("greeting", "hello");
   * ```
   */
  setBuffer(name: string, data: string): Promise<void> {
    return setBuffer(runtimeForServer(this), name, data);
  }

  /**
   * Read a named paste buffer's contents.
   *
   * Over a control connection this stops at the first NUL byte: tmux writes a
   * command's output to a control client as a C string. The buffer is unharmed
   * — `saveBuffer` and a spawning server both read it whole — and a pane's own
   * output is unaffected, being escaped before it is written.
   *
   * ```ts
   * const lines = await server.showBuffer("greeting");
   * lines[0]; // "hello"
   * ```
   */
  showBuffer(name: string): Promise<readonly string[]> {
    return showBuffer(runtimeForServer(this), name);
  }

  /**
   * Every buffer name this server holds.
   *
   * ```ts
   * const names = await server.listBuffers();
   * names.length;
   * ```
   */
  listBuffers(): Promise<readonly string[]> {
    return listBuffers(runtimeForServer(this));
  }

  /**
   * Discard a named paste buffer.
   *
   * ```ts
   * await server.deleteBuffer("greeting");
   * ```
   */
  deleteBuffer(name: string): Promise<void> {
    return deleteBuffer(runtimeForServer(this), name);
  }

  /**
   * Run a shell command through tmux and return whatever it printed.
   *
   * ```ts
   * const lines = await server.runShell("echo hello");
   * lines[0]; // "hello"
   * ```
   */
  runShell(command: string, options?: RunShellOptions): Promise<readonly string[]> {
    return runShell(runtimeForServer(this), command, options);
  }

  /**
   * Run one command or another depending on a condition.
   *
   * ```ts
   * await server.ifShell("test -d /tmp", "display-message 'present'");
   * ```
   */
  ifShell(condition: string, command: string, options?: IfShellOptions): Promise<void> {
    return ifShell(runtimeForServer(this), condition, command, options);
  }

  /**
   * Whether the tmux server is reachable.
   *
   * ```ts
   * if (await server.isAlive()) {
   *   await server.snapshot();
   * }
   * ```
   */
  isAlive(): Promise<boolean> {
    return isAlive(runtimeForServer(this));
  }

  /**
   * Assert the server is reachable, raising with tmux's reason if not.
   *
   * Every read already raises on an unreachable server, so this is not what
   * tells an empty result from a missing one — it is the assertion form of
   * {@link isAlive}, for a caller that wants the check and the reason without a
   * read to hang it on.
   *
   * ```ts
   * await server.raiseIfDead(); // throws when no tmux server is listening
   * ```
   */
  raiseIfDead(): Promise<void> {
    return raiseIfDead(runtimeForServer(this));
  }

  /**
   * Run a tmux command this package does not model.
   *
   * tmux has many more commands than any wrapper types. Rather than leaving a
   * caller to build their own subprocess — and reproduce the socket, the
   * environment, the deadline, and the error handling — this runs one through
   * the same path every other operation uses.
   *
   * ```ts
   * await server.cmd("list-keys", ["-T", "copy-mode"]);
   * ```
   *
   * Failure raises {@link TmuxCommandError} like any other command, carrying
   * tmux's own stderr.
   */
  cmd(
    command: string,
    args: readonly string[] = [],
    options?: CmdOptions,
  ): Promise<readonly string[]> {
    return runRawCommand(runtimeForServer(this), null, command, args, options);
  }
  /**
   * Run several tmux commands in one invocation.
   *
   * tmux takes a sequence of commands, which is the difference between building
   * a ten-window workspace with one process and doing it with ten. The result is
   * positional — `results[i]` holds what `commands[i]` printed, empty for a
   * command that prints nothing — so a creating command's `-P -F` lands where
   * you asked for it.
   *
   * ```ts
   * const [[first], [second]] = await server.pipeline([
   *   ["new-window", "-d", "-P", "-F", "#{window_id}"],
   *   ["new-window", "-d", "-P", "-F", "#{window_id}"],
   * ]);
   * ```
   *
   * Not atomic. tmux runs the commands in order and stops at the first failure,
   * leaving everything before it applied; the error names the command that
   * failed. Take a {@link Server.snapshot} afterwards if you need to know what
   * survived.
   *
   * A connected server sends these one at a time instead, which costs the same
   * over a connection that is already open.
   */
  pipeline(
    commands: readonly (readonly string[])[],
    options?: CommandOptions,
  ): Promise<readonly (readonly string[])[]> {
    return runPipeline(runtimeForServer(this), commands, options);
  }

  /**
   * Run planned mutations as one invocation, resolving each to what it made.
   *
   * The batched form of calling them one at a time: the same options go in and
   * the same handles come out, positionally and individually typed. What
   * changes is the cost. Calling `newWindow` ten times spends ten invocations
   * and ten snapshots, because each has to find what it just created; a batch
   * spends one of each for the whole group.
   *
   * ```ts
   * const [editor, logs] = await server.batch([
   *   session.plan.newWindow({ name: "editor" }),
   *   session.plan.newWindow({ name: "logs" }),
   * ]);
   * ```
   *
   * Not atomic, for the same reason {@link Server.pipeline} is not: tmux runs
   * them in order and stops at the first failure, leaving everything before it
   * applied.
   */
  async batch<const T extends readonly PlannedOperation<unknown>[]>(
    operations: T,
    options?: CommandOptions,
  ): Promise<{
    -readonly [K in keyof T]: T[K] extends PlannedOperation<infer R> ? R : never;
  }> {
    const printed = await this.pipeline(
      operations.map((operation) => operation.argv),
      options,
    );
    // One snapshot for the whole group, taken after every command has run, so
    // each plan reads the same instant and the group costs one snapshot rather
    // than one per mutation.
    const snapshot = await this.snapshot();
    return operations.map((operation, index) =>
      operation.resolve(snapshot, printed[index] ?? []),
    ) as { -readonly [K in keyof T]: T[K] extends PlannedOperation<infer R> ? R : never };
  }

  /**
   * Whether `other` is a handle addressing the same tmux server.
   *
   * Compared by the socket the connection resolves to rather than by object
   * identity, so a server constructed twice against one socket is equal to
   * itself. A socket *name* is not that socket: tmux resolves `-L work` under
   * `TMUX_TMPDIR`, so the same name with two different tmpdirs addresses two
   * different daemons, and this reports them as different. Accepts `unknown`
   * because the interesting comparisons are against values a caller has not
   * narrowed yet.
   *
   * ```ts
   * server.equals(new Server({ socketPath: server.socketPath ?? "" }));
   * ```
   */
  equals(other: unknown): boolean {
    const runtime = runtimeForServerValue(this);
    const otherRuntime = runtimeForServerValue(other);
    if (runtime === undefined || otherRuntime === undefined) return false;
    if (runtime === otherRuntime) return true;
    const address = serverAddress(runtime);
    return address !== undefined && address === serverAddress(otherRuntime);
  }
}
