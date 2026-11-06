import { posix } from "node:path";

import type { ConnectionAlias, DaemonEpoch, LogicalRef } from "../../common.js";
import { LibTmuxError } from "../../errors.js";
import type { DaemonIdentity, Server } from "../../server.js";
import { decodeLogicalRef } from "../graph/refs.js";
import type { CommandTransport } from "../transport/types.js";
import { timerDuration } from "../timing.js";
import { LazyCapabilityBinding, type TmuxCapabilities } from "./capabilities.js";
import type { TmuxConnection } from "./connection.js";
import { registerRuntimeConstructors, type RuntimeConstructors } from "./constructors.js";

export type { DaemonIdentity } from "../../server.js";

interface RuntimeEpochState {
  daemonEpoch: DaemonEpoch;
  daemonRevision: number;
  /** The daemon the last acquisition reached, so the next one can tell it apart. */
  daemon: DaemonIdentity | undefined;
}

export interface DaemonObservation {
  readonly daemonEpoch: DaemonEpoch;
  readonly revision: number;
}

/** Whether two readings describe the same running daemon. */
function sameDaemon(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

function nextDaemonRevision(state: RuntimeEpochState): number {
  const revision = state.daemonRevision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new LibTmuxError("daemon observation cannot exceed the safe integer range");
  }
  return revision;
}

/**
 * An absolute socket path with `.`, `..`, doubled and trailing slashes removed.
 *
 * Lexical only: it reads no file system, because an engine's paths are on a
 * machine this process cannot see. A symbolic link, a relative path (whose
 * meaning is the working directory's) and a `socketName` that resolves to the
 * same file are not recognized as one socket; comparing them reports "different",
 * which refuses a plan rather than running it on the wrong daemon.
 */
function canonicalSocketPath(path: string): string {
  return path.startsWith("/") ? posix.normalize(path).replace(/(?<=.)\/+$/u, "") : path;
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
  if (connection.socketPath !== undefined)
    return `path ${canonicalSocketPath(connection.socketPath)}`;
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
export function serverAddress(runtime: RuntimeContext): string | undefined {
  const socket = socketAddress(runtime.connection);
  if (runtime.engine === undefined) return `local ${socket}`;
  const endpoint = runtime.engine.endpoint;
  if (endpoint === undefined || endpoint === "") return undefined;
  return `engine ${endpoint} ${socket}`;
}

const runtimeEpochStates = new WeakMap<RuntimeContext, RuntimeEpochState>();
const serverRuntimes = new WeakMap<object, RuntimeContext>();

export interface RuntimeContextOptions {
  readonly connection: TmuxConnection;
  readonly connectionAlias: ConnectionAlias;
  readonly daemonEpoch: DaemonEpoch;
  /** The caller's engine, when they supplied one. See {@link RuntimeContext.engine}. */
  readonly engine?: CommandTransport;
  readonly timeoutMs?: number;
  readonly transport: CommandTransport;
}

export interface RuntimeContext {
  readonly capabilities: LazyCapabilityBinding;
  /** Default deadline for every command, when the caller names none. */
  readonly timeoutMs: number | undefined;
  readonly connection: TmuxConnection;
  readonly connectionAlias: ConnectionAlias;
  readonly daemonEpoch: DaemonEpoch;
  /**
   * The engine a caller supplied, separate from the transport in use.
   *
   * `transport` answers what runs a command now, and a connected server
   * replaces it with its own connection. This answers whether tmux is
   * somewhere this process can reach by spawning — which is what the calls
   * that spawn have to know, and what tells two servers apart.
   */
  readonly engine: CommandTransport | undefined;
  readonly transport: CommandTransport;
}

function epochStateFor(runtime: RuntimeContext): RuntimeEpochState {
  const state = runtimeEpochStates.get(runtime);
  if (state === undefined) throw new LibTmuxError("runtime context is not authentic");
  return state;
}

function assertLogicalRefRuntime(runtime: RuntimeContext, ref: LogicalRef): void {
  const daemonEpoch = epochStateFor(runtime).daemonEpoch;
  if (ref.connection !== runtime.connectionAlias) {
    throw new LibTmuxError("logical reference belongs to another runtime");
  }
  if (ref.epoch !== daemonEpoch) {
    throw new LibTmuxError("logical reference daemon epoch is stale");
  }
}

export function createRuntimeContext(options: RuntimeContextOptions): RuntimeContext {
  const timeoutMs =
    options.timeoutMs === undefined ? undefined : timerDuration("timeoutMs", options.timeoutMs);
  const state: RuntimeEpochState = {
    daemon: undefined,
    daemonEpoch: options.daemonEpoch,
    daemonRevision: 0,
  };
  const capabilities = new LazyCapabilityBinding({
    connection: options.connection,
    connectionAlias: options.connectionAlias,
    getDaemonEpoch: (): DaemonEpoch => state.daemonEpoch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    transport: options.transport,
  });
  const runtime: RuntimeContext = Object.freeze({
    capabilities,
    connection: options.connection,
    connectionAlias: options.connectionAlias,
    get daemonEpoch(): DaemonEpoch {
      return state.daemonEpoch;
    },
    engine: options.engine,
    timeoutMs,
    transport: options.transport,
  });
  runtimeEpochStates.set(runtime, state);
  return runtime;
}

export function registerServerRuntime(
  server: Server,
  runtime: RuntimeContext,
  constructors: RuntimeConstructors,
): void {
  epochStateFor(runtime);
  if (serverRuntimes.has(server)) {
    throw new LibTmuxError("Server already has a runtime context");
  }
  serverRuntimes.set(server, runtime);
  registerRuntimeConstructors(server, constructors);
}

export function runtimeForServerValue(value: unknown): RuntimeContext | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return serverRuntimes.get(value);
}

export function createServerWithRuntime(
  runtime: RuntimeContext,
  constructors: RuntimeConstructors,
): Server {
  epochStateFor(runtime);
  const server = Object.create(constructors.server) as Server;
  registerServerRuntime(server, runtime, constructors);
  return server;
}

export function invalidateRuntimeEpoch(runtime: RuntimeContext): DaemonEpoch {
  const state = epochStateFor(runtime);
  const daemonEpoch = state.daemonEpoch + 1;
  if (!Number.isSafeInteger(daemonEpoch)) {
    throw new LibTmuxError("daemon epoch cannot exceed the safe integer range");
  }
  state.daemonEpoch = daemonEpoch as DaemonEpoch;
  return state.daemonEpoch;
}

/** Commit an answer unless another daemon transition overtook its observation. */
export function observeDaemonIdentity(
  runtime: RuntimeContext,
  observation: DaemonObservation,
  capabilities: Pick<TmuxCapabilities, "daemon" | "daemonEpoch">,
  captured: DaemonIdentity,
): boolean {
  const state = epochStateFor(runtime);
  const previous = state.daemon;
  const observationIsCurrent =
    state.daemonRevision === observation.revision && state.daemonEpoch === observation.daemonEpoch;
  if (!sameDaemon(capabilities.daemon, captured)) {
    if (observationIsCurrent && capabilities.daemonEpoch === observation.daemonEpoch) {
      const daemonRevision = nextDaemonRevision(state);
      invalidateRuntimeEpoch(runtime);
      state.daemon = undefined;
      state.daemonRevision = daemonRevision;
    }
    return false;
  }
  if (
    capabilities.daemonEpoch !== observation.daemonEpoch ||
    state.daemonEpoch !== observation.daemonEpoch
  ) {
    return false;
  }
  if (state.daemonRevision !== observation.revision) {
    return previous !== undefined && sameDaemon(previous, captured);
  }
  if (previous !== undefined && sameDaemon(previous, captured)) {
    return true;
  }
  const daemonRevision = nextDaemonRevision(state);
  if (previous !== undefined) invalidateRuntimeEpoch(runtime);
  state.daemon = captured;
  state.daemonRevision = daemonRevision;
  return previous === undefined;
}

export function beginDaemonObservation(runtime: RuntimeContext): DaemonObservation {
  const state = epochStateFor(runtime);
  return Object.freeze({ daemonEpoch: state.daemonEpoch, revision: state.daemonRevision });
}

/** The daemon the last acquisition reached, if there has been one. */
export function lastObservedDaemon(runtime: RuntimeContext): DaemonIdentity | undefined {
  return epochStateFor(runtime).daemon;
}

export function runtimeForServer(server: Server): RuntimeContext {
  const runtime = runtimeForServerValue(server);
  if (runtime === undefined) throw new LibTmuxError("Server has no runtime context");
  return runtime;
}

export async function bindLogicalRef(runtime: RuntimeContext, value: unknown): Promise<LogicalRef> {
  const ref = decodeLogicalRef(value);
  assertLogicalRefRuntime(runtime, ref);

  const capabilities = await runtime.capabilities.bind();

  assertLogicalRefRuntime(runtime, ref);
  if (
    capabilities.connectionAlias !== runtime.connectionAlias ||
    capabilities.daemonEpoch !== runtime.daemonEpoch
  ) {
    throw new LibTmuxError("capability binding belongs to another runtime epoch");
  }
  return ref;
}
