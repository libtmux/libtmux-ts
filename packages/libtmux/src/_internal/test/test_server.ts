import {
  FIXTURE_BOOTSTRAP_DEADLINE_MS,
  READINESS_DEADLINE_MS,
  READINESS_POLL_INTERVAL_MS,
  deadlineMs,
} from "./deadlines.js";
import { randomUUID } from "node:crypto";

import { adaptRawResult } from "../operations/request.js";
import { NodeSpawnTransport } from "../transport/node_spawn_transport.js";
import { flattenInvocation, tmuxCommand } from "../transport/invocation.js";
import { TmuxTransportError, type RawCommandResult } from "../transport/types.js";
import {
  assertControllerCurrent as assertPersistedControllerCurrent,
  readDaemonIdentity,
  resolveControllerIdentity,
  type ControllerIdentity,
  type DaemonIdentity,
} from "./process_identity.js";
import { reportSecondaryCleanupFailure, runWithCleanup } from "./cleanup.js";
import {
  beginFixtureLaunch,
  promoteFixtureLaunch,
  reserveFixture,
  rollbackFixtureLaunchNotStarted,
  type FixtureControllerRequest,
  type LaunchAttemptCapability,
  type ReservationCapability,
} from "./fixture_launch.js";
import { reapFixture, retireFixtureGeneration } from "./reaper.js";
import { readFixtureRecord, type FixtureRecord, type LaunchGeneration } from "./records.js";

export interface TestServerRequestSnapshot {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly purpose: "bootstrap" | "ordinary" | "readiness" | "validation";
}

export interface TestServerOptions {
  /**
   * The environment the server is launched with, replacing `process.env`
   * rather than extending it.
   *
   * Spread `process.env` to change one variable. Passing the variable alone
   * launches tmux with no `PATH`, which fails as a malformed launch frame
   * rather than as a missing `PATH`.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly faultInjection?:
    | "after-identity-record"
    | "after-launch"
    | "before-readiness"
    | "identity-record-write"
    | "partial-identity-record-write";
  readonly launchExecutable?: string;
  readonly requestObserver?: (request: TestServerRequestSnapshot) => void;
  readonly runRoot: string;
  readonly sessionName?: string;
  readonly tmuxExecutable?: string;
}

interface EntrySnapshot {
  readonly environment: Readonly<Record<string, string>>;
  readonly faultInjection: TestServerOptions["faultInjection"];
  readonly launchExecutable: string | undefined;
  readonly requestObserver: ((request: TestServerRequestSnapshot) => void) | undefined;
  readonly runRoot: string;
  readonly sessionName: string;
  readonly tmuxExecutable: string | undefined;
}

function snapshotEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  );
}

function snapshotEntry(options: TestServerOptions): EntrySnapshot {
  return Object.freeze({
    environment: snapshotEnvironment(options.environment ?? process.env),
    faultInjection: options.faultInjection,
    launchExecutable: options.launchExecutable,
    requestObserver: options.requestObserver,
    runRoot: options.runRoot,
    sessionName: options.sessionName ?? `fixture-${randomUUID().slice(0, 12)}`,
    tmuxExecutable: options.tmuxExecutable,
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandFailure(command: string, result: RawCommandResult): Error {
  const stderr = new TextDecoder().decode(result.stderr).trim();
  return new Error(
    `${command} failed with status ${String(result.returncode)}${stderr ? `: ${stderr}` : ""}`,
  );
}

function parseLaunchFrame(
  bytes: Uint8Array,
  expectedSocketPath: string,
): { daemonPid: number; observedSocketPath: string; sessionId: string } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    throw new Error("tmux returned an invalid launch frame");
  }
  const fields = text.slice(0, -1).split("\t");
  if (fields.length !== 3) throw new Error("tmux returned an invalid launch frame");
  const [observedSocketPath, rawPid, sessionId] = fields;
  const daemonPid = /^[1-9]\d*$/u.test(rawPid ?? "") ? Number(rawPid) : Number.NaN;
  if (
    observedSocketPath !== expectedSocketPath ||
    !Number.isSafeInteger(daemonPid) ||
    daemonPid < 1 ||
    sessionId === undefined ||
    !/^\$\d+$/u.test(sessionId)
  ) {
    throw new Error("tmux returned an invalid or mismatched socket identity");
  }
  return { daemonPid, observedSocketPath, sessionId };
}

function makeGeneration(): LaunchGeneration {
  const uuid = randomUUID();
  return Object.freeze({
    name: `LIBTMUX_TEST_GENERATION_${uuid.replaceAll("-", "").toUpperCase()}`,
    value: uuid,
  });
}

function observeRequest(
  observer: EntrySnapshot["requestObserver"],
  request: {
    readonly args: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly purpose: TestServerRequestSnapshot["purpose"];
  },
): TestServerRequestSnapshot {
  const snapshot = Object.freeze({
    args: Object.freeze([...request.args]),
    environment: Object.freeze({ ...request.environment }),
    executable: request.executable,
    purpose: request.purpose,
  });
  observer?.(snapshot);
  return snapshot;
}

function sameController(
  left: Awaited<ReturnType<typeof resolveControllerIdentity>>,
  right: FixtureRecord["controller"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface LaunchedFixtureGeneration {
  readonly daemonIdentity: DaemonIdentity;
  readonly observedSocketPath: string;
  readonly record: Extract<FixtureRecord, { readonly phase: "running" }>;
  readonly sessionId: string;
}

async function launchFixtureGeneration(options: {
  readonly capability: ReservationCapability;
  readonly entry: EntrySnapshot;
  readonly record: Extract<FixtureRecord, { readonly phase: "reserved" }>;
  readonly transport: NodeSpawnTransport;
}): Promise<LaunchedFixtureGeneration> {
  const { capability, entry, transport } = options;
  let record: FixtureRecord = options.record;
  const controllerExecutable = record.controller.executablePath;
  const launchExecutable = entry.launchExecutable ?? controllerExecutable;
  const readyChannel = `ready-${randomUUID()}`;
  const generation = makeGeneration();
  const paneCommand = [
    "env",
    "-u",
    shellQuote(generation.name),
    shellQuote(controllerExecutable),
    "-N",
    "-S",
    shellQuote(record.socketPath),
    "wait-for",
    "-S",
    shellQuote(readyChannel),
    "&&",
    "exec",
    "cat",
  ].join(" ");
  const mismatchFrame = `generation-mismatch-${randomUUID()}`;
  const successFormat = "#{socket_path}\t#{pid}\t#{session_id}";
  const newSession = [
    "new-session",
    "-d",
    "-P",
    "-F",
    shellQuote(successFormat),
    "-s",
    shellQuote(entry.sessionName),
    shellQuote(paneCommand),
  ].join(" ");
  const bootstrapGlobalArgs = Object.freeze(["-f", "/dev/null", "-S", record.socketPath]);
  const bootstrapCommands = Object.freeze({
    launch: tmuxCommand([
      "if-shell",
      "-F",
      `#{==:#{${generation.name}},${generation.value}}`,
      newSession,
      `display-message -p ${shellQuote(mismatchFrame)}`,
    ]),
    start: tmuxCommand(["start-server"]),
  });
  const bootstrapArgs = flattenInvocation({
    commands: [bootstrapCommands.start, bootstrapCommands.launch],
    executable: controllerExecutable,
    globalArgs: bootstrapGlobalArgs,
  });
  const bootstrapArgv = Object.freeze([controllerExecutable, ...bootstrapArgs]);
  const bootstrapEnvironment = Object.freeze({
    ...entry.environment,
    [generation.name]: generation.value,
  });
  let attempt: LaunchAttemptCapability | undefined;

  const executeController = async (
    args: readonly string[],
    purpose: "ordinary" | "readiness",
    timeoutMs = deadlineMs(FIXTURE_BOOTSTRAP_DEADLINE_MS),
  ): Promise<RawCommandResult> => {
    const request = observeRequest(entry.requestObserver, {
      args: ["-N", "-S", record.socketPath, ...args],
      environment: entry.environment,
      executable: controllerExecutable,
      purpose,
    });
    await assertPersistedControllerCurrent(record.controller);
    return transport.execute({
      commands: [tmuxCommand(args)],
      environment: request.environment,
      executable: request.executable,
      globalArgs: ["-N", "-S", record.socketPath],
      timeoutMs,
    });
  };

  const promote = async (daemonPid: number): Promise<void> => {
    if (attempt === undefined) throw new Error("fixture launch attempt is missing");
    record = await promoteFixtureLaunch(attempt, daemonPid, {
      ...(entry.faultInjection === "partial-identity-record-write"
        ? { faultInjection: "partial-write" as const }
        : {}),
      observeRequest: (request: FixtureControllerRequest) => {
        observeRequest(entry.requestObserver, request);
      },
    });
  };

  attempt = await beginFixtureLaunch(capability, { bootstrapArgv, generation });
  record = await readFixtureRecord(capability.reservationPath);
  const bootstrapRequest = observeRequest(entry.requestObserver, {
    args: bootstrapArgs,
    environment: bootstrapEnvironment,
    executable: launchExecutable,
    purpose: "bootstrap",
  });
  await assertPersistedControllerCurrent(record.controller);
  let started: RawCommandResult;
  try {
    started = await transport.execute({
      commands: [bootstrapCommands.start, bootstrapCommands.launch],
      environment: bootstrapRequest.environment,
      executable: bootstrapRequest.executable,
      globalArgs: bootstrapGlobalArgs,
      timeoutMs: deadlineMs(FIXTURE_BOOTSTRAP_DEADLINE_MS),
    });
  } catch (error) {
    if (error instanceof TmuxTransportError && error.delivery === "not_started") {
      record = await rollbackFixtureLaunchNotStarted(attempt);
    } else if (error instanceof TmuxTransportError && error.stdout.length > 0) {
      try {
        const partial = parseLaunchFrame(error.stdout, record.socketPath);
        await promote(partial.daemonPid);
      } catch (recoveryError) {
        reportSecondaryCleanupFailure(error, recoveryError);
      }
    }
    throw error;
  }
  if (new TextDecoder().decode(started.stdout) === `${mismatchFrame}\n`) {
    throw new Error("tmux bootstrap generation mismatch");
  }
  if (started.returncode !== 0) {
    const primary = commandFailure("tmux bootstrap", started);
    try {
      const partial = parseLaunchFrame(started.stdout, record.socketPath);
      await promote(partial.daemonPid);
    } catch (recoveryError) {
      reportSecondaryCleanupFailure(primary, recoveryError);
    }
    throw primary;
  }
  const { daemonPid, observedSocketPath, sessionId } = parseLaunchFrame(
    started.stdout,
    record.socketPath,
  );
  if (entry.faultInjection === "identity-record-write") {
    throw new Error("injected identity-record-write failure");
  }
  await promote(daemonPid);
  if (entry.faultInjection === "after-launch") {
    throw new Error("injected after-launch failure");
  }
  if (entry.faultInjection === "after-identity-record") {
    throw new Error("injected after-identity-record failure");
  }
  if (entry.faultInjection === "before-readiness") {
    throw new Error("injected before-readiness failure");
  }
  const daemonIdentity = await readDaemonIdentity(daemonPid);
  if (daemonIdentity === undefined) throw new Error("tmux daemon exited after promotion");

  let paneCommandObserved = false;
  const readinessDeadline = performance.now() + deadlineMs(READINESS_DEADLINE_MS);
  while (performance.now() < readinessDeadline) {
    const remainingMs = Math.max(1, Math.ceil(readinessDeadline - performance.now()));
    // eslint-disable-next-line no-await-in-loop -- each query observes the post-handshake shell transition.
    const pane = await executeController(
      ["display-message", "-p", "-t", sessionId, "#{pane_current_command}"],
      "readiness",
      Math.min(250, remainingMs),
    ).catch((error: unknown) => {
      if (error instanceof TmuxTransportError && error.kind === "timeout") return undefined;
      throw error;
    });
    if (
      pane !== undefined &&
      pane.returncode === 0 &&
      new TextDecoder().decode(pane.stdout).trim() === "cat"
    ) {
      paneCommandObserved = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- readiness polling is paced within one deadline.
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
  }
  if (!paneCommandObserved) throw new Error("tmux pane did not enter its stable readiness hold");
  const readiness = await executeController(["wait-for", readyChannel], "readiness");
  if (readiness.returncode !== 0) throw commandFailure("tmux readiness handshake", readiness);
  if (record.phase !== "running") throw new Error("fixture promotion did not publish authority");

  return { daemonIdentity, observedSocketPath, record, sessionId };
}

export class TestServer {
  daemonIdentity: DaemonIdentity;
  readonly logicalSocketName: string;
  readonly observedSocketPath: string;
  readonly readinessSignaledBeforeControllerWait: boolean;
  readonly recordPath: string;
  readonly reservationPath: string;
  sessionId: string;
  sessionName: string;
  readonly socketPath: string;
  readonly tmuxExecutable: string;
  readonly controllerEnvironment: Readonly<Record<string, string>>;
  readonly #transport: NodeSpawnTransport;
  readonly #controllerIdentity: ControllerIdentity;
  readonly #launchExecutable: string | undefined;
  readonly #reservationCapability: ReservationCapability;
  readonly #requestObserver: EntrySnapshot["requestObserver"];
  #cleanupPromise: Promise<void> | undefined;
  #disposeRequested = false;
  #replacementPromise: Promise<void> | undefined;

  private constructor(options: {
    controllerIdentity: ControllerIdentity;
    controllerEnvironment: Readonly<Record<string, string>>;
    daemonIdentity: DaemonIdentity;
    logicalSocketName: string;
    launchExecutable: string | undefined;
    observedSocketPath: string;
    observedPaneCommand: string;
    recordPath: string;
    requestObserver: EntrySnapshot["requestObserver"];
    reservationPath: string;
    sessionId: string;
    sessionName: string;
    socketPath: string;
    tmuxExecutable: string;
    transport: NodeSpawnTransport;
    reservationCapability: ReservationCapability;
  }) {
    this.#controllerIdentity = options.controllerIdentity;
    this.controllerEnvironment = options.controllerEnvironment;
    this.daemonIdentity = options.daemonIdentity;
    this.logicalSocketName = options.logicalSocketName;
    this.#launchExecutable = options.launchExecutable;
    this.observedSocketPath = options.observedSocketPath;
    this.readinessSignaledBeforeControllerWait = options.observedPaneCommand === "cat";
    this.recordPath = options.recordPath;
    this.reservationPath = options.reservationPath;
    this.sessionId = options.sessionId;
    this.sessionName = options.sessionName;
    this.socketPath = options.socketPath;
    this.tmuxExecutable = options.tmuxExecutable;
    this.#transport = options.transport;
    this.#reservationCapability = options.reservationCapability;
    this.#requestObserver = options.requestObserver;
  }

  static async create(options: TestServerOptions): Promise<TestServer> {
    const entry = snapshotEntry(options);
    const configuredController =
      entry.tmuxExecutable === undefined
        ? undefined
        : await resolveControllerIdentity(entry.tmuxExecutable, entry.environment);
    const reserved = await reserveFixture(entry.runRoot, entry.environment);
    let record: FixtureRecord = reserved.record;
    if (
      configuredController !== undefined &&
      !sameController(configuredController, record.controller)
    ) {
      const mismatch = new Error(
        "configured tmux controller does not match the published run root",
      );
      const cleanup = await reapFixture(reserved.capability).catch((error: unknown) => ({
        leaks: [String(error)],
      }));
      if (cleanup.leaks.length > 0) {
        reportSecondaryCleanupFailure(mismatch, new Error(cleanup.leaks.join("; ")));
      }
      throw mismatch;
    }
    const transport = new NodeSpawnTransport({ terminationGraceMs: 100 });
    try {
      const launched = await launchFixtureGeneration({
        capability: reserved.capability,
        entry,
        record: reserved.record,
        transport,
      });
      record = launched.record;
      return new TestServer({
        controllerIdentity: record.controller,
        controllerEnvironment: entry.environment,
        daemonIdentity: launched.daemonIdentity,
        launchExecutable: entry.launchExecutable,
        logicalSocketName: record.logicalSocketName,
        observedSocketPath: launched.observedSocketPath,
        observedPaneCommand: "cat",
        recordPath: reserved.recordPath,
        requestObserver: entry.requestObserver,
        reservationPath: reserved.reservationPath,
        sessionId: launched.sessionId,
        sessionName: entry.sessionName,
        socketPath: record.socketPath,
        tmuxExecutable: record.controller.executablePath,
        transport,
        reservationCapability: reserved.capability,
      });
    } catch (error) {
      try {
        const cleanup = await reapFixture(reserved.capability);
        if (cleanup.leaks.length > 0) {
          reportSecondaryCleanupFailure(error, new Error(cleanup.leaks.join("; ")));
        }
      } catch (cleanupError) {
        reportSecondaryCleanupFailure(error, cleanupError);
      }
      throw error;
    }
  }

  static async run<T>(
    options: TestServerOptions,
    body: (server: TestServer) => Promise<T>,
  ): Promise<T> {
    const server = await TestServer.create(options);
    return runWithCleanup(
      () => body(server),
      () => server.dispose(),
    );
  }

  /** Replace this fixture's daemon while preserving its exact socket path. */
  replace(sessionName: string): Promise<void> {
    if (this.#disposeRequested) {
      return Promise.reject(new Error("disposed fixture cannot be replaced"));
    }
    if (this.#replacementPromise !== undefined) {
      return Promise.reject(new Error("fixture replacement is already running"));
    }
    let tracked!: Promise<void>;
    tracked = this.#replaceGeneration(sessionName).finally(() => {
      if (this.#replacementPromise === tracked) this.#replacementPromise = undefined;
    });
    this.#replacementPromise = tracked;
    return tracked;
  }

  async #replaceGeneration(sessionName: string): Promise<void> {
    try {
      const reserved = await retireFixtureGeneration(this.#reservationCapability);
      const launched = await launchFixtureGeneration({
        capability: this.#reservationCapability,
        entry: Object.freeze({
          environment: this.controllerEnvironment,
          faultInjection: undefined,
          launchExecutable: this.#launchExecutable,
          requestObserver: this.#requestObserver,
          runRoot: this.#reservationCapability.runRoot,
          sessionName,
          tmuxExecutable: this.tmuxExecutable,
        }),
        record: reserved,
        transport: this.#transport,
      });
      this.daemonIdentity = launched.daemonIdentity;
      this.sessionId = launched.sessionId;
      this.sessionName = sessionName;
    } catch (error) {
      try {
        const cleanup = await reapFixture(this.#reservationCapability);
        if (cleanup.leaks.length > 0) {
          reportSecondaryCleanupFailure(error, new Error(cleanup.leaks.join("; ")));
        }
      } catch (cleanupError) {
        reportSecondaryCleanupFailure(error, cleanupError);
      }
      throw error;
    }
  }

  async executeRaw(args: readonly string[]): Promise<RawCommandResult> {
    const request = observeRequest(this.#requestObserver, {
      args: ["-N", "-S", this.socketPath, ...args],
      environment: this.controllerEnvironment,
      executable: this.tmuxExecutable,
      purpose: "ordinary",
    });
    await this.assertControllerCurrent();
    return this.#transport.execute({
      commands: [tmuxCommand(args)],
      environment: request.environment,
      executable: request.executable,
      globalArgs: ["-N", "-S", this.socketPath],
      timeoutMs: deadlineMs(FIXTURE_BOOTSTRAP_DEADLINE_MS),
    });
  }

  async assertControllerCurrent(): Promise<void> {
    await assertPersistedControllerCurrent(this.#controllerIdentity);
  }

  async executeText(
    args: readonly string[],
  ): Promise<{ readonly stderr: readonly string[]; readonly stdout: readonly string[] }> {
    const result = adaptRawResult(await this.executeRaw(args));
    if (result.returncode !== 0) {
      throw new Error(`tmux ${args[0] ?? "command"} failed: ${result.stderr.join("\n")}`);
    }
    return { stderr: result.stderr, stdout: result.stdout };
  }

  dispose(): Promise<void> {
    if (this.#cleanupPromise === undefined) {
      this.#disposeRequested = true;
      const replacement = this.#replacementPromise;
      this.#cleanupPromise = (async () => {
        await replacement?.catch(() => undefined);
        const report = await reapFixture(this.#reservationCapability);
        if (report.leaks.length > 0) throw new Error(report.leaks.join("; "));
      })();
    }
    return this.#cleanupPromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
