import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeliveryStatus } from "../../common.js";
import type { DaemonGuard, TmuxCommand } from "../../engine.js";
import { TmuxServerRestarted, TmuxTransportError } from "../../exc.js";
import type { AbortLike } from "../../types.js";
import {
  executeGuardedList,
  type GuardCodecCapabilities,
  type GuardCodecCapabilityBinding,
} from "../codec/guard_codec.js";
import type { TmuxConnection } from "../runtime/connection.js";
import { parseTmuxVersion } from "../runtime/tmux_version.js";
import type { CommandRequest, CommandTransport, RawCommandResult } from "../transport/types.js";
import type { ControlConnection, ControlObserverBinding } from "./connection.js";

interface ObserverTransportOptions {
  readonly commands: CommandTransport;
  readonly connection: TmuxConnection;
  readonly observer: Pick<ControlConnection, "observerBinding">;
  readonly staging?: InputStaging;
}

interface AuthenticatedObserver {
  readonly daemon: DaemonGuard;
  readonly observer: ControlObserverBinding;
}

interface InputStaging {
  create(signal: AbortSignal): Promise<{ readonly directory: string; readonly inputPath: string }>;
  remove(directory: string): Promise<void>;
  write(inputPath: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
}

type StopKind = "cancelled" | "timeout";

class RequestBudget {
  readonly #controller = new AbortController();
  readonly #deadlineAt: number | undefined;
  readonly #external: AbortLike | undefined;
  #onAbort: (() => void) | undefined;
  #stopKind: StopKind | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(request: CommandRequest) {
    this.#external = request.signal;
    this.#deadlineAt =
      request.timeoutMs === undefined ? undefined : performance.now() + request.timeoutMs;
    this.#onAbort = () => this.#stop("cancelled");
    if (this.#external?.aborted === true) this.#stop("cancelled");
    else this.#external?.addEventListener("abort", this.#onAbort, { once: true });
    if (request.timeoutMs !== undefined && this.#stopKind === undefined) {
      this.#timer = setTimeout(() => this.#stop("timeout"), request.timeoutMs);
      this.#timer.unref?.();
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#external !== undefined && this.#onAbort !== undefined) {
      this.#external.removeEventListener("abort", this.#onAbort);
    }
    this.#onAbort = undefined;
  }

  failure(delivery: DeliveryStatus, cause?: unknown): TmuxTransportError {
    const kind = this.#stopKind;
    if (kind === undefined) throw new Error("request budget has not stopped");
    const transport = cause instanceof TmuxTransportError ? cause : undefined;
    return new TmuxTransportError(kind === "timeout" ? "command timed out" : "command cancelled", {
      ...(cause === undefined ? {} : { cause }),
      delivery,
      kind,
      ...(transport?.signal === undefined ? {} : { signal: transport.signal }),
      ...(transport === undefined ? {} : { stderr: transport.stderr, stdout: transport.stdout }),
    });
  }

  remainingTimeout(): number | undefined {
    this.throwIfStopped();
    const deadlineAt = this.#deadlineAt;
    if (deadlineAt === undefined) return undefined;
    const remaining = Math.ceil(deadlineAt - performance.now());
    if (remaining < 1) {
      this.#stop("timeout");
      this.throwIfStopped();
    }
    return remaining;
  }

  throwIfStopped(): void {
    if (this.#stopKind !== undefined) throw this.failure("not_started");
  }

  translate(error: unknown, delivery: DeliveryStatus): unknown {
    return this.#stopKind === undefined ? error : this.failure(delivery, error);
  }

  #stop(kind: StopKind): void {
    if (this.#stopKind !== undefined) return;
    this.#stopKind = kind;
    this.#controller.abort();
  }
}

const nodeInputStaging: InputStaging = Object.freeze({
  async create(_signal: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), "ltx-input-"));
    return Object.freeze({ directory, inputPath: join(directory, "stdin") });
  },
  remove: (directory: string) => rm(directory, { force: true, recursive: true }),
  write: (inputPath: string, data: Uint8Array, signal: AbortSignal) =>
    writeFile(inputPath, data, { flag: "wx", mode: 0o600, signal }),
});

function sameDaemon(left: DaemonGuard, right: DaemonGuard): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

function restarted(message: string, subcommand?: string): TmuxServerRestarted {
  return new TmuxServerRestarted(message, subcommand === undefined ? {} : { subcommand });
}

async function authenticateObserver(
  options: ObserverTransportOptions,
  observer: ControlObserverBinding,
  capabilities: GuardCodecCapabilityBinding,
  budget: RequestBudget,
): Promise<AuthenticatedObserver> {
  const timeoutMs = budget.remainingTimeout();
  const rows = await executeGuardedList({
    capabilities,
    connection: options.connection,
    listCommand: "list-clients",
    signal: budget.signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    transport: options.commands,
  });
  budget.throwIfStopped();
  if (options.observer.observerBinding() !== observer) {
    throw restarted("tmux control connection changed while its daemon was authenticated");
  }
  const matches = rows.filter((row) => row.client_pid === String(observer.clientPid));
  if (matches.length !== 1) {
    throw restarted("spawned commands no longer reach the control connection's daemon");
  }
  const { pid, start_time: startTime } = matches[0]!;
  if (pid === null || startTime === null) {
    throw restarted("the control connection's daemon identity is incomplete");
  }
  const daemon = Object.freeze({ pid, startTime });
  for (const row of rows) {
    if (row.pid !== daemon.pid || row.start_time !== daemon.startTime) {
      throw restarted("the control connection's client listing crossed daemon identities");
    }
  }
  return Object.freeze({ daemon, observer });
}

function authenticationFailure(error: unknown, budget: RequestBudget): unknown {
  const interrupted = budget.translate(error, "not_started");
  if (interrupted !== error || error instanceof TmuxServerRestarted) return interrupted;
  if (error instanceof TmuxTransportError) {
    return new TmuxTransportError(`tmux observer authentication failed: ${error.message}`, {
      cause: error,
      delivery: "not_started",
      kind: error.kind,
      ...(error.signal === undefined ? {} : { signal: error.signal }),
      stderr: error.stderr,
      stdout: error.stdout,
    });
  }
  return new TmuxTransportError("tmux observer authentication returned invalid data", {
    cause: error,
    delivery: "not_started",
    kind: "protocol",
  });
}

function boundRequest(
  request: CommandRequest,
  daemon: DaemonGuard,
  budget: RequestBudget,
): CommandRequest {
  const timeoutMs = budget.remainingTimeout();
  return Object.freeze({
    ...request,
    daemonGuard: daemon,
    signal: budget.signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function cleanupFailure(options: {
  readonly cleanup: unknown;
  readonly commandStarted: boolean;
  readonly failed: boolean;
  readonly primary: unknown;
  readonly result: RawCommandResult | undefined;
}): TmuxTransportError {
  const primaryTransport =
    options.primary instanceof TmuxTransportError ? options.primary : undefined;
  const delivery =
    options.result !== undefined
      ? "replied"
      : options.primary instanceof TmuxServerRestarted
        ? options.primary.delivery
        : (primaryTransport?.delivery ??
          (options.commandStarted ? "indeterminate" : "not_started"));
  const evidence = options.result ?? primaryTransport;
  return new TmuxTransportError("guarded command input cleanup failed", {
    cause: options.failed
      ? new AggregateError([options.primary, options.cleanup], "command and cleanup both failed")
      : options.cleanup,
    delivery,
    kind: "spawn",
    ...(evidence?.signal === undefined ? {} : { signal: evidence.signal }),
    ...(evidence === undefined ? {} : { stderr: evidence.stderr, stdout: evidence.stdout }),
  });
}

async function withMaterializedStdin(
  request: CommandRequest,
  daemon: DaemonGuard,
  budget: RequestBudget,
  execute: (request: CommandRequest) => Promise<RawCommandResult>,
  staging: InputStaging,
): Promise<RawCommandResult> {
  const stdin = request.stdin;
  if (stdin === undefined) return execute(boundRequest(request, daemon, budget));

  const [command] = request.commands;
  if (request.commands.length !== 1 || command[0] !== "load-buffer" || command.at(-1) !== "-") {
    throw new TmuxTransportError("a connected daemon cannot guard this stdin invocation", {
      delivery: "not_started",
      kind: "protocol",
    });
  }

  let location: Awaited<ReturnType<InputStaging["create"]>>;
  try {
    budget.throwIfStopped();
    location = await staging.create(budget.signal);
  } catch (error) {
    throw new TmuxTransportError("could not prepare guarded command input", {
      cause: error,
      delivery: "not_started",
      kind: "spawn",
    });
  }
  let commandStarted = false;
  let failed = false;
  let primary: unknown;
  let result: RawCommandResult | undefined;
  try {
    budget.throwIfStopped();
    await staging.write(location.inputPath, stdin, budget.signal);
    budget.throwIfStopped();
    const fileCommand: TmuxCommand = Object.freeze([
      command[0],
      ...command.slice(1, -1),
      location.inputPath,
    ]);
    const { stdin: staged, ...withoutStdin } = request;
    void staged;
    const guarded = boundRequest(
      Object.freeze({
        ...withoutStdin,
        commands: Object.freeze([fileCommand]) as readonly [TmuxCommand],
      }),
      daemon,
      budget,
    );
    commandStarted = true;
    result = await execute(guarded);
  } catch (error) {
    failed = true;
    const delivery =
      commandStarted && error instanceof TmuxTransportError
        ? error.delivery
        : commandStarted
          ? "indeterminate"
          : "not_started";
    const interrupted = budget.translate(error, delivery);
    primary =
      interrupted !== error ||
      commandStarted ||
      error instanceof TmuxTransportError ||
      error instanceof TmuxServerRestarted
        ? interrupted
        : new TmuxTransportError("could not stage guarded command input", {
            cause: error,
            delivery: "not_started",
            kind: "spawn",
          });
  }
  try {
    await staging.remove(location.directory);
  } catch (cleanup) {
    throw cleanupFailure({ cleanup, commandStarted, failed, primary, result });
  }
  if (failed) throw primary;
  if (result === undefined) throw new Error("guarded command returned no result");
  return result;
}

/** Bind spawned commands to the daemon carrying one control observer. */
export function observerBoundTransport(options: ObserverTransportOptions): CommandTransport {
  // Authentication needs only the fields present at the supported tmux floor,
  // so it must not run a separate version probe before proving the daemon.
  const minimum: GuardCodecCapabilities = Object.freeze({
    fingerprint: "connected-observer-bootstrap:tmux-3.2a",
    rawVersion: "3.2a",
    tmuxVersion: parseTmuxVersion("3.2a"),
  });
  const capabilities: GuardCodecCapabilityBinding = Object.freeze({
    bind: () => Promise.resolve(minimum),
  });
  const staging = options.staging ?? nodeInputStaging;
  let authenticated: AuthenticatedObserver | undefined;

  const binding = async (budget: RequestBudget): Promise<AuthenticatedObserver> => {
    budget.throwIfStopped();
    const observer = options.observer.observerBinding();
    if (authenticated?.observer === observer) return authenticated;
    try {
      const result = await authenticateObserver(options, observer, capabilities, budget);
      if (options.observer.observerBinding() !== observer) {
        throw restarted("tmux control connection changed while its daemon was authenticated");
      }
      authenticated = result;
      return result;
    } catch (error) {
      throw authenticationFailure(error, budget);
    }
  };

  return Object.freeze({
    ...(options.commands.endpoint === undefined ? {} : { endpoint: options.commands.endpoint }),
    async execute(request): Promise<RawCommandResult> {
      const budget = new RequestBudget(request);
      try {
        const { daemon } = await binding(budget);
        if (request.daemonGuard !== undefined && !sameDaemon(request.daemonGuard, daemon)) {
          throw restarted("the command's ids belong to another daemon", request.commands[0][0]);
        }
        return await withMaterializedStdin(
          request,
          daemon,
          budget,
          (guarded) => options.commands.execute(guarded),
          staging,
        );
      } catch (error) {
        const delivery =
          error instanceof TmuxTransportError || error instanceof TmuxServerRestarted
            ? error.delivery
            : ("indeterminate" as const);
        throw budget.translate(error, delivery);
      } finally {
        budget.close();
      }
    },
  });
}
