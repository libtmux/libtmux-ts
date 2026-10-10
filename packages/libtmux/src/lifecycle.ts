import { randomUUID } from "node:crypto";

import type { CommandOptions, DeliveryStatus } from "./common.js";
import type { DaemonGuard, TmuxInvocationRequest } from "./engine.js";
import {
  LibTmuxError,
  type LibTmuxErrorCode,
  MultipleMatchesError,
  NoMatchError,
  TmuxCommandError,
  TmuxTransportError,
} from "./errors.js";
import type { Pane } from "./pane.js";
import type { Server } from "./server.js";
import type { Session } from "./session.js";
import type { Window } from "./window.js";
import type {
  AbortLike,
  NewSessionOptions,
  NewWindowOptions,
  PlannedOperation,
  ServerSnapshot,
  SplitOptions,
} from "./types.js";
import { isColdEndpoint } from "./_internal/operations/command.js";
import { planNewSession, planNewWindow, planSplitWindow } from "./_internal/operations/plans.js";
import { adaptRawResult, prepareInvocationRequest } from "./_internal/operations/request.js";
import { refreshedHandle } from "./_internal/operations/refreshed.js";
import {
  createRuntimeContext,
  createServerWithRuntime,
  lastObservedDaemon,
  runtimeForServer,
  type RuntimeContext,
} from "./_internal/runtime/context.js";
import { runtimePrototype } from "./_internal/runtime/constructors.js";
import { runtimeForHandle } from "./_internal/runtime/live_handle.js";
import { quoteCommand } from "./_internal/transport/lexer.js";
import { uniqueUnknownCommand } from "./_internal/transport/refusal.js";

const generationOption = "@libtmux_owner_generation";
const generationFormat = `#{${generationOption}}`;
// These fields contain only IDs, decimal digits and hexadecimal tokens. As in the capability
// probe, semicolons survive C-locale tmux output while literal tabs are sanitized.
const identityFormat = `#{pid};#{start_time};${generationFormat}`;
const validGeneration = `#{&&:#{==:#{n:${generationOption}},32},#{m/r:^[0-9a-fA-F]+$,${generationFormat}}}`;
const cleanupDeadlineMs = 30_000;
type ResourceKind = "server" | "session" | "window" | "pane";

/** The endpoint and daemon accepted in the invocation that identified the owned resource. */
export interface OwnershipReceipt {
  readonly daemon: DaemonGuard & { readonly generation: string };
  readonly id: string | undefined;
  readonly kind: ResourceKind;
  readonly socketPath: string;
}

/** Failed cleanup remains inspectable and can be retried with the same guarded identity. */
export type CleanupState =
  | { readonly status: "active" | "cleaned" | "released"; readonly attempts: number }
  | {
      readonly status: "failed";
      readonly attempts: number;
      readonly error: unknown;
      readonly delivery: DeliveryStatus | undefined;
    };

/**
 * Responsibility for remote destruction, separate from a borrowed handle or client connection.
 * Cleanup has its own deadline and ignores body cancellation. A successful repeat is a no-op;
 * failed attempts keep their error and permit another guarded attempt. Killing a window destroys
 * every link and pane in that window. Process exit and SIGKILL need an outer supervisor.
 */
export interface Owned<T> extends AsyncDisposable {
  /** The handle accepted with this ownership receipt. */
  readonly value: T;
  /** Immutable identity used by disposal; changing names or parents does not redirect it. */
  readonly receipt: OwnershipReceipt;
  /** The last cleanup outcome, including an uncertain transport delivery. */
  readonly state: CleanupState;
  /** Destroy the resource without reusing a body's aborted signal. Concurrent calls coalesce. */
  dispose(): Promise<void>;
  /** Leave the remote object alive and return its borrowed handle; refuses during cleanup. */
  release(): T;
}

/**
 * Acquisition failed after a mutation might have run. `cause` retains the initial failure.
 * A known receipt is rolled back without the caller's signal; `cleanupError` records a failed
 * rollback. `retryCleanup` repeats only that receipt's guarded cleanup. An unknown result has
 * no such authority: inspect the endpoint or use an independently owned outer fixture.
 */
export class TmuxAcquisitionError extends LibTmuxError {
  static override readonly code: LibTmuxErrorCode = "TmuxAcquisitionError";
  readonly outcome: "unknown" | "rolled_back" | "rollback_failed";
  readonly receipt: OwnershipReceipt | undefined;
  readonly cleanupError: unknown;
  readonly #cleanup: (() => Promise<void>) | undefined;

  constructor(options: {
    readonly cause: unknown;
    readonly outcome: "unknown" | "rolled_back" | "rollback_failed";
    readonly receipt?: OwnershipReceipt;
    readonly cleanupError?: unknown;
    readonly cleanup?: () => Promise<void>;
  }) {
    super(`tmux acquisition failed (${options.outcome})`, { cause: options.cause });
    this.outcome = options.outcome;
    this.receipt = options.receipt;
    this.cleanupError = options.cleanupError;
    this.#cleanup = options.cleanup;
  }

  /** Retry a failed rollback; unknown acquisition results have no known cleanup target. */
  retryCleanup(): Promise<void> {
    if (this.#cleanup === undefined)
      return Promise.reject(new TypeError("no known resource can be cleaned"));
    return this.#cleanup();
  }
}

function cancellationError(signal: AbortLike): TmuxTransportError {
  return new TmuxTransportError("ownership acquisition cancelled", {
    cause: signal.reason,
    delivery: "not_started",
    kind: "cancelled",
  });
}

function cancelled(signal: AbortLike | undefined): void {
  if (signal?.aborted === true) throw cancellationError(signal);
}

async function waitForTurn(before: Promise<void>, signal?: AbortLike): Promise<void> {
  if (signal === undefined) return before;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancellationError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([before, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function capturedServer(server: Server, daemon: OwnershipReceipt["daemon"]): Server {
  const runtime = runtimeForServer(server);
  const transport = runtime.transport;
  const bound = createRuntimeContext({
    connection: runtime.connection,
    connectionAlias: runtime.connectionAlias,
    daemonEpoch: runtime.daemonEpoch,
    ...(runtime.engine === undefined ? {} : { engine: runtime.engine }),
    ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
    transport: {
      execute(request) {
        return transport.execute({
          ...request,
          globalArgs: ["-N", ...request.globalArgs],
          daemonGuard: daemon,
        });
      },
    },
  });
  return createServerWithRuntime(bound, {
    server: runtimePrototype(server, "server"),
    session: runtimePrototype(server, "session"),
    window: runtimePrototype(server, "window"),
    pane: runtimePrototype(server, "pane"),
    client: runtimePrototype(server, "client"),
  });
}

async function execute(
  runtime: RuntimeContext,
  commands: readonly (readonly string[])[],
  options: CommandOptions = {},
  extra: {
    readonly daemon?: DaemonGuard;
    readonly start?: boolean;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<readonly string[]> {
  const timeoutMs =
    options.timeoutMs === null ? undefined : (options.timeoutMs ?? runtime.timeoutMs);
  const request = prepareInvocationRequest(runtime.connection, commands, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(extra.daemon === undefined ? {} : { daemonGuard: extra.daemon }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const submitted: TmuxInvocationRequest = {
    ...request,
    globalArgs: extra.start === true ? request.globalArgs : ["-N", ...request.globalArgs],
    ...(extra.environment === undefined ? {} : { environment: extra.environment }),
  };
  const result = adaptRawResult(await runtime.transport.execute(submitted));
  if (result.exitCode !== 0) {
    throw new TmuxCommandError({
      args: commands.flat(),
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  return result.stdout;
}

function initGeneration(): readonly string[] {
  // -o preserves even an existing empty value; the following guard rejects it.
  return ["set-option", "-s", "-o", "-q", generationOption, randomUUID().replaceAll("-", "")];
}

function checkedGeneration(commands: readonly (readonly string[])[]): readonly string[] {
  return [
    "if-shell",
    "-F",
    validGeneration,
    commands.map(quoteCommand).join(" ; "),
    quoteCommand([uniqueUnknownCommand("invalid-owner-generation")]),
  ];
}

function receiptFrom(
  lines: readonly string[],
  kind: ResourceKind,
  path: string,
  marker: string,
): OwnershipReceipt | undefined {
  const line = lines.find((value) => value.startsWith(`${marker};`));
  if (line === undefined) return undefined;
  const parts = line.split(";");
  const [, id, pid, startTime, generation] = parts;
  const prefix = { server: "", session: "$", window: "@", pane: "%" }[kind];
  if (
    parts.length !== 5 ||
    id === undefined ||
    pid === undefined ||
    startTime === undefined ||
    generation === undefined ||
    (kind === "server" ? id !== "server" : !new RegExp(`^[${prefix}][0-9]+$`, "u").test(id)) ||
    !/^[0-9]+$/u.test(pid) ||
    /^0+$/u.test(pid) ||
    !/^[0-9]+$/u.test(startTime) ||
    !/^[0-9a-fA-F]{32}$/u.test(generation)
  ) {
    throw new LibTmuxError("ownership reply contains an invalid identity receipt");
  }
  return Object.freeze({
    kind,
    id: kind === "server" ? undefined : id,
    socketPath: path,
    daemon: Object.freeze({ pid, startTime, generation }),
  });
}

function errorLines(error: unknown): readonly string[] {
  if (error instanceof TmuxCommandError) return error.stdout;
  if (error instanceof TmuxTransportError)
    return new TextDecoder().decode(error.stdout).split("\n");
  return [];
}

function receiptAfterFailure(
  error: unknown,
  kind: ResourceKind,
  path: string,
  marker: string,
): OwnershipReceipt | undefined {
  try {
    return receiptFrom(errorLines(error), kind, path, marker);
  } catch (invalidReceipt) {
    throw new TmuxAcquisitionError({
      cause: new AggregateError([error, invalidReceipt], "invalid partial acquisition receipt"),
      outcome: "unknown",
    });
  }
}

async function destroy(runtime: RuntimeContext, receipt: OwnershipReceipt): Promise<void> {
  const options = { timeoutMs: cleanupDeadlineMs };
  const extra = { daemon: receipt.daemon };
  if (receipt.kind === "server") {
    await execute(runtime, [["kill-server"]], options, extra);
    return;
  }
  // IDs are not reissued within one daemon. A guarded absence also resolves an uncertain retry.
  const listings = {
    session: "list-sessions",
    window: "list-windows",
    pane: "list-panes",
  } as const;
  const listing = [
    listings[receipt.kind],
    ...(receipt.kind === "session" ? [] : ["-a"]),
    "-F",
    `#{${receipt.kind}_id}`,
  ];
  const ids = await execute(runtime, [listing], options, extra);
  if (!ids.includes(receipt.id!)) return;
  await execute(runtime, [[`kill-${receipt.kind}`, "-t", receipt.id!]], options, extra);
}

class ResourceOwner<T> implements Owned<T> {
  readonly value: T;
  readonly receipt: OwnershipReceipt;
  readonly #runtime: RuntimeContext;
  #state: CleanupState = Object.freeze({ status: "active", attempts: 0 });
  #pending: Promise<void> | undefined;

  constructor(value: T, runtime: RuntimeContext, receipt: OwnershipReceipt) {
    this.value = value;
    this.#runtime = runtime;
    this.receipt = receipt;
    Object.freeze(this);
  }

  get state(): CleanupState {
    return this.#state;
  }

  dispose(): Promise<void> {
    if (this.#pending !== undefined) return this.#pending;
    if (this.#state.status === "cleaned" || this.#state.status === "released")
      return Promise.resolve();
    const attempts = this.#state.attempts + 1;
    const pending = destroy(this.#runtime, this.receipt).then(
      () => {
        this.#state = Object.freeze({ status: "cleaned", attempts });
      },
      (error: unknown) => {
        this.#state = Object.freeze({
          status: "failed",
          attempts,
          error,
          delivery: error instanceof TmuxTransportError ? error.delivery : undefined,
        });
        throw error;
      },
    );
    this.#pending = pending;
    void pending.then(
      () => {
        this.#pending = undefined;
      },
      () => {
        this.#pending = undefined;
      },
    );
    return pending;
  }

  release(): T {
    if (this.#pending !== undefined) throw new TypeError("cannot release during cleanup");
    if (this.#state.status === "cleaned") throw new TypeError("cannot release a cleaned resource");
    this.#state = Object.freeze({ status: "released", attempts: this.#state.attempts });
    return this.value;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}

async function failedAcquisition(
  runtime: RuntimeContext,
  error: unknown,
  receipt: OwnershipReceipt | undefined,
): Promise<never> {
  if (receipt === undefined) {
    if (error instanceof TmuxTransportError && error.delivery !== "not_started") {
      throw new TmuxAcquisitionError({ cause: error, outcome: "unknown" });
    }
    throw error;
  }
  const cleanup = (): Promise<void> => destroy(runtime, receipt);
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new TmuxAcquisitionError({
      cause: error,
      outcome: "rollback_failed",
      receipt,
      cleanupError,
      cleanup,
    });
  }
  throw new TmuxAcquisitionError({ cause: error, outcome: "rolled_back", receipt, cleanup });
}

async function completeOwner<T>(
  server: Server,
  runtime: RuntimeContext,
  receipt: OwnershipReceipt,
  resolve: (server: Server) => Promise<T>,
  signal?: AbortLike,
): Promise<Owned<T>> {
  try {
    cancelled(signal);
    const value = await resolve(capturedServer(server, receipt.daemon));
    cancelled(signal);
    return new ResourceOwner(value, runtime, receipt);
  } catch (error) {
    return failedAcquisition(runtime, error, receipt);
  }
}

async function createOwned<T>(
  server: Server,
  runtime: RuntimeContext,
  kind: Exclude<ResourceKind, "server">,
  plan: PlannedOperation<T>,
  options: CommandOptions,
  afterCreate?: (receipt: OwnershipReceipt) => Promise<void>,
): Promise<Owned<T>> {
  cancelled(options.signal);
  const marker = `ltx-owned-${randomUUID()}`;
  const argv = [...plan.argv];
  const formatIndex = argv.indexOf("-F") + 1;
  argv[formatIndex] = `${marker};#{${kind}_id};${identityFormat}`;
  const commands = [initGeneration(), checkedGeneration([argv])];
  if (kind === "session") commands.unshift(["start-server"]);
  let receipt: OwnershipReceipt | undefined;
  let receivedReply = false;
  try {
    const daemon = lastObservedDaemon(runtime);
    const lines = await execute(runtime, commands, options, {
      start: kind === "session",
      ...(daemon === undefined ? {} : { daemon }),
    });
    receivedReply = true;
    receipt = receiptFrom(lines, kind, runtime.connection.socketPath, marker);
    if (receipt === undefined)
      throw new TmuxAcquisitionError({
        cause: new LibTmuxError("creation returned no identity receipt"),
        outcome: "unknown",
      });
  } catch (error) {
    receipt ??= receiptAfterFailure(error, kind, runtime.connection.socketPath, marker);
    if (receivedReply && receipt === undefined && !(error instanceof TmuxAcquisitionError)) {
      throw new TmuxAcquisitionError({ cause: error, outcome: "unknown" });
    }
    return failedAcquisition(runtime, error, receipt);
  }
  return completeOwner(
    server,
    runtime,
    receipt,
    async (bound) => {
      await afterCreate?.(receipt);
      return plan.resolve(
        await bound.snapshot(options.signal === undefined ? {} : { signal: options.signal }),
        [receipt.id!],
      );
    },
    options.signal,
  );
}

/**
 * Create a session and destroy it at scope exit, including its windows and panes.
 * Readback or cancellation after receiving an ID rolls back that ID on its creating daemon.
 *
 * ```ts
 * import { Server, ownSession } from "libtmux";
 * await using owned = await ownSession(new Server(), { name: `work-${crypto.randomUUID()}` });
 * console.log(owned.value.id);
 * ```
 */
export async function ownSession(
  server: Server,
  options: NewSessionOptions = {},
): Promise<Owned<Session>> {
  return createOwned(server, runtimeForServer(server), "session", planNewSession(options), options);
}

/**
 * Create a window owned until disposal, which destroys all of its links and panes.
 *
 * ```ts
 * import { Server, ownSession, ownWindow } from "libtmux";
 * await using session = await ownSession(new Server());
 * await using window = await ownWindow(session.value, { name: "build" });
 * console.log(window.value.id);
 * ```
 */
export async function ownWindow(
  session: Session,
  options: NewWindowOptions = {},
): Promise<Owned<Window>> {
  return createOwned(
    session.server,
    runtimeForHandle(session),
    "window",
    planNewWindow(session.id, options),
    options,
  );
}

/**
 * Split a pane or window, owning the new pane until disposal.
 *
 * ```ts
 * import { Server, ownSession, ownPane } from "libtmux";
 * await using session = await ownSession(new Server());
 * await using pane = await ownPane(session.value.windows.one());
 * console.log(pane.value.id);
 * ```
 */
export async function ownPane(
  parent: Pane | Window,
  options: SplitOptions = {},
): Promise<Owned<Pane>> {
  return createOwned(
    parent.server,
    runtimeForHandle(parent),
    "pane",
    planSplitWindow(parent.id, options),
    options,
  );
}

async function adopt<T>(
  server: Server,
  kind: ResourceKind,
  id: string | undefined,
  select: (server: Server) => Promise<T>,
  options: CommandOptions,
): Promise<Owned<T>> {
  cancelled(options.signal);
  if (
    kind !== "server" &&
    (id === undefined ||
      !new RegExp(`^[${{ session: "$", window: "@", pane: "%" }[kind]}][0-9]+$`, "u").test(id))
  ) {
    throw new TypeError(`adoption requires an exact ${kind} ID`);
  }
  const runtime = runtimeForServer(server);
  const marker = `ltx-adopt-${randomUUID()}`;
  const target = kind === "server" ? [] : ["-t", id!];
  const format = `${marker};${kind === "server" ? "server" : `#{${kind}_id}`};${identityFormat}`;
  let receipt: OwnershipReceipt | undefined;
  try {
    const lines = await execute(
      runtime,
      [initGeneration(), checkedGeneration([["display-message", "-p", ...target, format]])],
      options,
    );
    receipt = receiptFrom(lines, kind, runtime.connection.socketPath, marker);
  } catch (error) {
    receipt = receiptAfterFailure(error, kind, runtime.connection.socketPath, marker);
    if (receipt !== undefined && receipt.id === id)
      return failedAcquisition(runtime, error, receipt);
    throw error;
  }
  if (receipt === undefined || receipt.id !== id)
    throw new LibTmuxError("adoption returned a different resource identity");
  return completeOwner(server, runtime, receipt, select, options.signal);
}

/**
 * Accept destruction of the daemon now answering this endpoint. Use only an explicit disposable
 * endpoint for whole-server examples. Writes the reserved server option @libtmux_owner_generation
 * if absent; callers must not shadow or change that key. Existing malformed values fail.
 * This whole-server demonstration takes an explicit socket path inside an existing private directory.
 *
 * ```ts
 * import { Server, adoptServer } from "libtmux";
 * const socketPath = process.argv[2];
 * if (socketPath === undefined) throw new Error("Pass a disposable socket path");
 * const disposable = new Server({ socketPath });
 * await disposable.newSession();
 * await using owned = await adoptServer(disposable);
 * console.log(owned.receipt.daemon.generation);
 * ```
 */
export function adoptServer(server: Server, options: CommandOptions = {}): Promise<Owned<Server>> {
  return adopt(server, "server", undefined, async (bound) => bound, options);
}

/**
 * Accept destruction of the current endpoint's exact session ID, including its windows and panes.
 * The ID selects the object at adoption time; passing an old handle's ID does not prove it is
 * still the old object. Use the returned receipt for subsequent cleanup.
 *
 * ```ts
 * import { Server, adoptSession } from "libtmux";
 * const server = new Server();
 * const existing = await server.newSession();
 * await using owned = await adoptSession(server, existing.id);
 * console.log(owned.value.name);
 * ```
 */
export function adoptSession(
  server: Server,
  id: string,
  options: CommandOptions = {},
): Promise<Owned<Session>> {
  return adopt(
    server,
    "session",
    id,
    async (bound) => (await bound.snapshot()).sessions.one({ id }),
    options,
  );
}

/**
 * Accept destruction of this endpoint's exact window ID, all links, and all its panes.
 *
 * ```ts
 * import { Server, ownSession, adoptWindow } from "libtmux";
 * await using session = await ownSession(new Server());
 * const existing = await session.value.newWindow({ name: "adopted" });
 * await using window = await adoptWindow(session.value.server, existing.id);
 * console.log(window.value.name);
 * ```
 */
export function adoptWindow(
  server: Server,
  id: string,
  options: CommandOptions = {},
): Promise<Owned<Window>> {
  return adopt(
    server,
    "window",
    id,
    async (bound) =>
      (await bound.snapshot()).windows.filter((window) => window.id === id).first() ?? missing(id),
    options,
  );
}

/**
 * Accept destruction of this endpoint's exact pane ID even if it later moves to another window.
 *
 * ```ts
 * import { Server, ownSession, adoptPane } from "libtmux";
 * await using session = await ownSession(new Server());
 * const pane = await session.value.windows.one().split();
 * await using owned = await adoptPane(session.value.server, pane.id);
 * console.log(owned.value.id);
 * ```
 */
export function adoptPane(
  server: Server,
  id: string,
  options: CommandOptions = {},
): Promise<Owned<Pane>> {
  return adopt(
    server,
    "pane",
    id,
    async (bound) =>
      (await bound.snapshot()).panes.filter((pane) => pane.id === id).first() ?? missing(id),
    options,
  );
}

function missing(id: string): never {
  throw new NoMatchError({ message: `owned resource ${id} disappeared during acquisition` });
}

/**
 * Run a body and dispose on return or throw. A combined failure raises AggregateError with the
 * body first and cleanup second. This block idiom also works without native await-using syntax.
 *
 * ```ts
 * import { Server, ownSession, withOwned } from "libtmux";
 * await withOwned(await ownSession(new Server()), async (session) => console.log(session.id));
 * ```
 */
export async function withOwned<T, R>(owned: Owned<T>, body: (value: T) => Promise<R>): Promise<R> {
  let result: R;
  try {
    result = await body(owned.value);
  } catch (bodyError) {
    try {
      await owned.dispose();
    } catch (cleanupError) {
      throw new AggregateError([bodyError, cleanupError], "body and owned cleanup failed");
    }
    throw bodyError;
  }
  await owned.dispose();
  return result;
}

/** A reused object carries no owner. Only a confirmed creation grants cleanup responsibility. */
export type FindOrCreateResult<T> =
  | { readonly created: true; readonly value: T; readonly owner: Owned<T> }
  | { readonly created: false; readonly value: T };

function created<T>(owner: Owned<T>): FindOrCreateResult<T> {
  return Object.freeze({ created: true, value: owner.value, owner });
}
function reused<T>(value: T): FindOrCreateResult<T> {
  return Object.freeze({ created: false, value });
}

const queues = new WeakMap<object, Promise<void>>();
async function serialized<T>(
  parent: object,
  signal: AbortLike | undefined,
  body: () => Promise<T>,
): Promise<T> {
  cancelled(signal);
  const before = queues.get(parent) ?? Promise.resolve();
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // A cancelled waiter settles immediately, but its place still follows its predecessor.
  // Otherwise a third caller could overtake the request that is currently running.
  const after = before.then(() => done);
  queues.set(parent, after);
  void after.then(() => {
    if (queues.get(parent) === after) queues.delete(parent);
  });
  try {
    await waitForTurn(before, signal);
    cancelled(signal);
    return await body();
  } finally {
    finish();
  }
}

function oneOrNone<T>(values: readonly T[], description: string): T | undefined {
  if (values.length > 1)
    throw new MultipleMatchesError({ count: values.length, message: `ambiguous ${description}` });
  return values[0];
}

/**
 * Start this endpoint or reuse its daemon. A random child environment marker, tested inside the
 * startup command queue, proves which client started it. A reused daemon stays borrowed.
 * Calls sharing this Server serialize. Other clients can start a daemon concurrently; the marker
 * decides created versus reused without claiming ownership merely from a missing socket.
 * This whole-server demonstration takes an explicit socket path inside an existing private directory.
 *
 * ```ts
 * import { Server, findOrCreateServer } from "libtmux";
 * const socketPath = process.argv[2];
 * if (socketPath === undefined) throw new Error("Pass a disposable socket path");
 * const result = await findOrCreateServer(new Server({ socketPath }));
 * if (result.created) {
 *   await using owner = result.owner;
 *   console.log(owner.value.socketPath);
 * } else console.log(result.value.socketPath);
 * ```
 */
export async function findOrCreateServer(
  server: Server,
  options: NewSessionOptions = {},
): Promise<FindOrCreateResult<Server>> {
  return serialized(server, options.signal, async () => {
    const runtime = runtimeForServer(server);
    const marker = `ltx-start-${randomUUID()}`;
    const launchToken = randomUUID().replaceAll("-", "");
    const launchKey = `LIBTMUX_OWNER_START_${launchToken.toUpperCase()}`;
    const plan = planNewSession(options);
    const args = [...plan.argv];
    args[args.indexOf("-F") + 1] = `${marker}-created;server;${identityFormat}`;
    const newBranch = [
      initGeneration(),
      checkedGeneration([args]),
      ["set-environment", "-g", "-u", launchKey],
    ];
    const reuseBranch = [
      initGeneration(),
      checkedGeneration([["display-message", "-p", `${marker}-reused;server;${identityFormat}`]]),
    ];
    let receipt: OwnershipReceipt | undefined;
    let isCreated = false;
    let receivedReply = false;
    try {
      const lines = await execute(
        runtime,
        [
          ["start-server"],
          [
            "if-shell",
            "-F",
            `#{==:#{${launchKey}},${launchToken}}`,
            newBranch.map(quoteCommand).join(" ; "),
            reuseBranch.map(quoteCommand).join(" ; "),
          ],
        ],
        options,
        {
          start: true,
          environment: { ...runtime.connection.environment, [launchKey]: launchToken },
        },
      );
      receivedReply = true;
      receipt = receiptFrom(lines, "server", runtime.connection.socketPath, `${marker}-created`);
      isCreated = receipt !== undefined;
      receipt ??= receiptFrom(lines, "server", runtime.connection.socketPath, `${marker}-reused`);
      if (receipt === undefined)
        throw new TmuxAcquisitionError({
          cause: new LibTmuxError("startup returned no identity receipt"),
          outcome: "unknown",
        });
    } catch (error) {
      const known = receiptAfterFailure(
        error,
        "server",
        runtime.connection.socketPath,
        `${marker}-created`,
      );
      if (receivedReply && known === undefined && !(error instanceof TmuxAcquisitionError)) {
        throw new TmuxAcquisitionError({ cause: error, outcome: "unknown" });
      }
      return failedAcquisition(runtime, error, known);
    }
    if (!isCreated) {
      cancelled(options.signal);
      return reused(capturedServer(server, receipt.daemon));
    }
    return created(
      await completeOwner(server, runtime, receipt, async (bound) => bound, options.signal),
    );
  });
}

/**
 * Match one exact session name, creating that name when absent. Calls sharing this Server
 * serialize; another client can win tmux's native duplicate-name check, which remains an error.
 *
 * ```ts
 * import { Server, findOrCreateSession } from "libtmux";
 * const result = await findOrCreateSession(new Server(), `work-${crypto.randomUUID()}`);
 * if (result.created) {
 *   await using owner = result.owner;
 *   console.log(true, owner.value.id);
 * } else console.log(false, result.value.id);
 * ```
 */
export async function findOrCreateSession(
  server: Server,
  name: string,
  options: Omit<NewSessionOptions, "name"> = {},
): Promise<FindOrCreateResult<Session>> {
  const plan = planNewSession({ ...options, name });
  return serialized(server, options.signal, async () => {
    let snapshot: ServerSnapshot | undefined;
    try {
      snapshot = await server.snapshot(
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch (error) {
      if (!isColdEndpoint(error)) throw error;
    }
    const existing = oneOrNone(
      snapshot?.sessions.filter((session) => session.name === name).toArray() ?? [],
      `session name ${name}`,
    );
    if (existing !== undefined) {
      cancelled(options.signal);
      return reused(existing);
    }
    return created(await createOwned(server, runtimeForServer(server), "session", plan, options));
  });
}

/**
 * Match a window's exact name within this session. Duplicate names raise MultipleMatchesError.
 * Calls sharing this Session object serialize; other handles and external clients can race.
 *
 * ```ts
 * import { Server, ownSession, findOrCreateWindow } from "libtmux";
 * await using session = await ownSession(new Server());
 * const result = await findOrCreateWindow(session.value, "build");
 * if (result.created) {
 *   await using owner = result.owner;
 *   console.log(true, owner.value.id);
 * } else console.log(false, result.value.id);
 * ```
 */
export async function findOrCreateWindow(
  session: Session,
  name: string,
  options: Omit<NewWindowOptions, "name"> = {},
): Promise<FindOrCreateResult<Window>> {
  const plan = planNewWindow(session.id, { ...options, name });
  return serialized(session, options.signal, async () => {
    const runtime = runtimeForHandle(session);
    const current = await refreshedHandle(session, runtime, options.signal);
    cancelled(options.signal);
    const existing = oneOrNone(
      current.windows.filter((window) => window.name === name).toArray(),
      `window name ${name}`,
    );
    if (existing !== undefined) {
      cancelled(options.signal);
      return reused(existing);
    }
    return created(await createOwned(session.server, runtime, "window", plan, options));
  });
}

/** A nonempty application value in a pane user option, scoped to the selected window. */
export interface PaneIdentity {
  readonly option: string;
  readonly value: string;
}

/**
 * Match a pane user-option value inside this window. Creation writes that identity before
 * returning; write/readback failures roll back the known pane. Duplicate matches raise
 * MultipleMatchesError. Calls sharing this Window object serialize, but another client can
 * observe the pane before its identity write or create a duplicate concurrently.
 *
 * ```ts
 * import { Server, ownSession, findOrCreatePane } from "libtmux";
 * await using session = await ownSession(new Server());
 * const result = await findOrCreatePane(session.value.windows.one(), {
 *   option: "@app_role",
 *   value: "worker",
 * });
 * if (result.created) {
 *   await using owner = result.owner;
 *   console.log(true, owner.value.id);
 * } else console.log(false, result.value.id);
 * ```
 */
export async function findOrCreatePane(
  window: Window,
  identity: PaneIdentity,
  options: SplitOptions = {},
): Promise<FindOrCreateResult<Pane>> {
  const { option, value } = identity;
  if (
    !/^@[A-Za-z0-9_]+$/u.test(option) ||
    option === generationOption ||
    value === "" ||
    value.includes("\0")
  )
    throw new TypeError(
      "pane identity requires a non-reserved user option and a nonempty value without NUL",
    );
  const plan = planSplitWindow(window.id, options);
  return serialized(window, options.signal, async () => {
    const runtime = runtimeForHandle(window);
    const current = await refreshedHandle(window, runtime, options.signal);
    cancelled(options.signal);
    const panes = current.panes.toArray();
    const matches: Pane[] = [];
    for (const pane of panes) {
      // eslint-disable-next-line no-await-in-loop -- The queue holds a consistent parent across these probes.
      const lines = await execute(
        runtime,
        [["display-message", "-p", "-t", pane.id, `#{${option}}`]],
        options,
        lastObservedDaemon(runtime) === undefined ? {} : { daemon: lastObservedDaemon(runtime)! },
      );
      if (lines.join("\n") === value) matches.push(pane);
    }
    const existing = oneOrNone(matches, `pane identity ${option}=${value}`);
    if (existing !== undefined) {
      cancelled(options.signal);
      return reused(existing);
    }
    const owner = await createOwned(
      window.server,
      runtime,
      "pane",
      plan,
      options,
      async (receipt) => {
        await execute(runtime, [["set-option", "-p", "-t", receipt.id!, option, value]], options, {
          daemon: receipt.daemon,
        });
      },
    );
    return created(owner);
  });
}
