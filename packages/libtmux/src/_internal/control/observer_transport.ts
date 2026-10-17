import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeliveryStatus } from "../../common.js";
import type { DaemonGuard, TmuxCommand } from "../../engine.js";
import { TmuxServerRestartedError, TmuxTransportError } from "../../errors.js";
import type { AbortLike } from "../../types.js";
import type { TmuxConnection } from "../runtime/connection.js";
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

function restarted(message: string, subcommand?: string): TmuxServerRestartedError {
  return new TmuxServerRestartedError(message, subcommand === undefined ? {} : { subcommand });
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
      : options.primary instanceof TmuxServerRestartedError
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
      error instanceof TmuxServerRestartedError
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
  const staging = options.staging ?? nodeInputStaging;

  // The daemon was read, hook-free, just before this client attached, and every
  // spawned command is fenced to it, so a command that reaches another daemon
  // is refused there rather than authenticated here.
  const binding = (budget: RequestBudget): AuthenticatedObserver => {
    budget.throwIfStopped();
    const observer = options.observer.observerBinding();
    if (observer.daemon === undefined) {
      throw restarted("the control connection was not attached to an admitted daemon");
    }
    return Object.freeze({ daemon: observer.daemon, observer });
  };

  return Object.freeze({
    ...(options.commands.endpoint === undefined ? {} : { endpoint: options.commands.endpoint }),
    async execute(request): Promise<RawCommandResult> {
      const budget = new RequestBudget(request);
      try {
        const { daemon } = binding(budget);
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
          error instanceof TmuxTransportError || error instanceof TmuxServerRestartedError
            ? error.delivery
            : ("indeterminate" as const);
        throw budget.translate(error, delivery);
      } finally {
        budget.close();
      }
    },
  });
}
