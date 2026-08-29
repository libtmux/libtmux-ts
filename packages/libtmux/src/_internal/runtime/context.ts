import type {
  ConnectionAlias,
  DaemonEpoch,
  LogicalRef,
  TmuxLogger,
  TmuxWarningSink,
} from "../../common.js";
import { LibTmuxException } from "../../exc.js";
import { Server, type DaemonIdentity } from "../../server.js";
import { decodeLogicalRef } from "../graph/refs.js";
import type { CommandTransport } from "../transport/types.js";
import { timerDuration } from "../timing.js";
import { LazyCapabilityBinding, type TmuxCapabilities } from "./capabilities.js";
import type { TmuxConnection } from "./connection.js";

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
    throw new LibTmuxException("daemon observation cannot exceed the safe integer range");
  }
  return revision;
}

const runtimeEpochStates = new WeakMap<RuntimeContext, RuntimeEpochState>();
const serverRuntimes = new WeakMap<object, RuntimeContext>();

const noopLogger: TmuxLogger = Object.freeze({
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});
const noopWarnings: TmuxWarningSink = Object.freeze({
  warn: () => undefined,
});

export interface RuntimeContextOptions {
  readonly connection: TmuxConnection;
  readonly connectionAlias: ConnectionAlias;
  readonly daemonEpoch: DaemonEpoch;
  /** The caller's engine, when they supplied one. See {@link RuntimeContext.engine}. */
  readonly engine?: CommandTransport;
  readonly logger?: TmuxLogger;
  readonly timeoutMs?: number;
  readonly transport: CommandTransport;
  readonly warnings?: TmuxWarningSink;
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
  readonly logger: TmuxLogger;
  readonly transport: CommandTransport;
  readonly warnings: TmuxWarningSink;
}

function epochStateFor(runtime: RuntimeContext): RuntimeEpochState {
  const state = runtimeEpochStates.get(runtime);
  if (state === undefined) throw new LibTmuxException("runtime context is not authentic");
  return state;
}

function assertLogicalRefRuntime(runtime: RuntimeContext, ref: LogicalRef): void {
  const daemonEpoch = epochStateFor(runtime).daemonEpoch;
  if (ref.connection !== runtime.connectionAlias) {
    throw new LibTmuxException("logical reference belongs to another runtime");
  }
  if (ref.epoch !== daemonEpoch) {
    throw new LibTmuxException("logical reference daemon epoch is stale");
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
    logger: options.logger ?? noopLogger,
    timeoutMs,
    transport: options.transport,
    warnings: options.warnings ?? noopWarnings,
  });
  runtimeEpochStates.set(runtime, state);
  return runtime;
}

export function registerServerRuntime(server: Server, runtime: RuntimeContext): void {
  epochStateFor(runtime);
  if (serverRuntimes.has(server)) {
    throw new LibTmuxException("Server already has a runtime context");
  }
  serverRuntimes.set(server, runtime);
}

export function runtimeForServerValue(value: unknown): RuntimeContext | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return serverRuntimes.get(value);
}

export function createServerWithRuntime(runtime: RuntimeContext): Server {
  epochStateFor(runtime);
  const server = Object.create(Server.prototype) as Server;
  registerServerRuntime(server, runtime);
  return server;
}

export function invalidateRuntimeEpoch(runtime: RuntimeContext): DaemonEpoch {
  const state = epochStateFor(runtime);
  const daemonEpoch = state.daemonEpoch + 1;
  if (!Number.isSafeInteger(daemonEpoch)) {
    throw new LibTmuxException("daemon epoch cannot exceed the safe integer range");
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
  if (runtime === undefined) throw new LibTmuxException("Server has no runtime context");
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
    throw new LibTmuxException("capability binding belongs to another runtime epoch");
  }
  return ref;
}
