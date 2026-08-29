import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { tmuxCommand } from "../transport/invocation.js";
import { NodeSpawnTransport } from "../transport/node_spawn_transport.js";
import {
  assertControllerCurrent,
  readDaemonIdentity,
  readProcessIdentity,
  sameControllerIdentity,
  sameDaemonIdentity,
  type DaemonIdentity,
} from "./process_identity.js";
import {
  FIXTURE_RECORD_NAME,
  ForeignSocketEvidenceError,
  assertBootstrapArgv,
  assertLaunchGeneration,
  assertOwnedDirectory,
  assertSafeAbsoluteRoot,
  entryIdentity,
  fixtureProtocol,
  fixtureRecordTemporaryName,
  isErrno,
  readFixtureRecord,
  readOwnedRecord,
  readOwner,
  sameEntry,
  snapshotEnvironment,
  socketExists,
  socketIdentityFromMetadata,
  validateSocketPath,
  writeAtomicJson,
  type EntryIdentity,
  type FixtureRecord,
  type LaunchGeneration,
  type SocketIdentity,
} from "./records.js";

declare const reservationCapabilityBrand: unique symbol;

export interface ReservationCapability {
  readonly [reservationCapabilityBrand]: true;
  readonly recordPath: string;
  readonly reservationPath: string;
  readonly runId: string;
  readonly runRoot: string;
}

declare const launchAttemptCapabilityBrand: unique symbol;

export interface LaunchAttemptCapability {
  readonly [launchAttemptCapabilityBrand]: true;
  readonly attemptId: string;
  readonly recordPath: string;
  readonly reservationPath: string;
  readonly runId: string;
  readonly runRoot: string;
}

const reservationCapabilities = new WeakSet<object>();
const reservationEnvironments = new WeakMap<object, Readonly<Record<string, string>>>();
const launchAttemptCapabilities = new WeakSet<object>();
const launchAttemptReservations = new WeakMap<object, ReservationCapability>();
const launchAttemptSnapshots = new WeakMap<
  object,
  {
    readonly bootstrapArgv: readonly string[];
    readonly generation: LaunchGeneration;
  }
>();
const reservationMutationTails = new Map<string, Promise<void>>();

function mintReservationCapability(
  fields: Readonly<{
    recordPath: string;
    reservationPath: string;
    runId: string;
    runRoot: string;
  }>,
  environment: Readonly<Record<string, string | undefined>>,
): ReservationCapability {
  const capability = Object.freeze({ ...fields }) as ReservationCapability;
  reservationCapabilities.add(capability);
  reservationEnvironments.set(capability, snapshotEnvironment(environment));
  return capability;
}

/** Reconstitute cleanup authority only for the exact-root reaper. */
export function restoreReservationCapability(
  fields: Readonly<{
    recordPath: string;
    reservationPath: string;
    runId: string;
    runRoot: string;
  }>,
  environment: Readonly<Record<string, string | undefined>>,
): ReservationCapability {
  return mintReservationCapability(fields, environment);
}

export async function reserveFixture(
  runRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{
  capability: ReservationCapability;
  record: Extract<FixtureRecord, { readonly phase: "reserved" }>;
  recordPath: string;
  reservationPath: string;
}> {
  await assertSafeAbsoluteRoot(runRoot);
  await assertOwnedDirectory(runRoot, "test run root");
  const rootOwner = await readOwner(runRoot);
  await assertControllerCurrent(rootOwner.controller);
  const owner = await readProcessIdentity(process.pid);
  if (owner === undefined) throw new Error("cannot identify fixture owner process");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logicalSocketName = `t-${process.pid.toString(36)}-${randomUUID().slice(0, 12)}`;
    const reservationPath = join(runRoot, logicalSocketName);
    try {
      // eslint-disable-next-line no-await-in-loop -- each retry must win one atomic mkdir before proceeding.
      await mkdir(reservationPath, { mode: 0o700 });
      // eslint-disable-next-line no-await-in-loop -- mode belongs to the reservation won in this iteration.
      await chmod(reservationPath, 0o700);
      const socketPath = join(reservationPath, "s");
      validateSocketPath(socketPath);
      const record: Extract<FixtureRecord, { readonly phase: "reserved" }> = {
        controller: rootOwner.controller,
        logicalSocketName,
        owner,
        phase: "reserved",
        protocol: fixtureProtocol,
        runId: rootOwner.runId,
        socketPath,
      };
      const recordPath = join(reservationPath, FIXTURE_RECORD_NAME);
      // eslint-disable-next-line no-await-in-loop -- registration must complete before returning this reservation.
      await writeAtomicJson(recordPath, record);
      const capability = mintReservationCapability(
        { recordPath, reservationPath, runId: rootOwner.runId, runRoot },
        environment,
      );
      return { capability, record, recordPath, reservationPath };
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      // eslint-disable-next-line no-await-in-loop -- cleanup is scoped to the failed atomic reservation attempt.
      await unlink(join(reservationPath, FIXTURE_RECORD_NAME)).catch(() => undefined);
      // eslint-disable-next-line no-await-in-loop -- cleanup is scoped to the failed atomic reservation attempt.
      await rmdir(reservationPath).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("could not reserve a unique test socket name");
}

export interface FixtureControllerRequest {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly purpose: "validation";
}

interface PromotionOptions {
  readonly faultInjection?: "partial-write";
  readonly observeRequest?: (request: FixtureControllerRequest) => void;
}

function sameLaunchSnapshot(
  record: Extract<FixtureRecord, { readonly phase: "launching" | "running" }>,
  snapshot: { readonly bootstrapArgv: readonly string[]; readonly generation: LaunchGeneration },
): boolean {
  return (
    record.generation.name === snapshot.generation.name &&
    record.generation.value === snapshot.generation.value &&
    JSON.stringify(record.bootstrapArgv) === JSON.stringify(snapshot.bootstrapArgv)
  );
}

function assertLaunchAttempt(attempt: LaunchAttemptCapability): {
  readonly capability: ReservationCapability;
  readonly snapshot: {
    readonly bootstrapArgv: readonly string[];
    readonly generation: LaunchGeneration;
  };
} {
  if (!launchAttemptCapabilities.has(attempt)) {
    throw new Error("fixture transition requires an authenticated launch-attempt capability");
  }
  const capability = launchAttemptReservations.get(attempt);
  const snapshot = launchAttemptSnapshots.get(attempt);
  if (capability === undefined || snapshot === undefined) {
    throw new Error("fixture launch-attempt capability is incomplete");
  }
  return { capability, snapshot };
}

function readNulFrames(bytes: Uint8Array, label: string): readonly string[] {
  if (bytes.length === 0 || bytes.at(-1) !== 0) throw new Error(`${label} has invalid NUL framing`);
  let values: string[];
  try {
    values = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0");
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  if (values.at(-1) === "") values.pop();
  if (values.some((value) => value === "")) throw new Error(`${label} has empty entries`);
  return values;
}

function assertExactGenerationEntry(bytes: Uint8Array, generation: LaunchGeneration): void {
  if (bytes.length === 0 || bytes.at(-1) !== 0) {
    throw new Error("daemon environment has invalid NUL framing");
  }
  const expected = Buffer.from(`${generation.name}=${generation.value}`, "ascii");
  const prefix = Buffer.from(`${generation.name}=`, "ascii");
  const matches: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    const frame = Buffer.from(bytes.slice(start, index));
    if (frame.length === 0) throw new Error("daemon environment has empty entries");
    if (frame.subarray(0, prefix.length).equals(prefix)) matches.push(frame);
    start = index + 1;
  }
  if (matches.length !== 1 || !matches[0]?.equals(expected)) {
    throw new Error("daemon generation mismatch");
  }
}

export async function assertExactProcessLaunch(
  record: Extract<FixtureRecord, { readonly phase: "launching" | "running" }>,
  daemon: DaemonIdentity,
): Promise<void> {
  const observed = await readDaemonIdentity(daemon.pid);
  if (observed === undefined || !sameDaemonIdentity(observed, daemon)) {
    throw new Error(`daemon identity mismatch for PID ${String(daemon.pid)}`);
  }
  if (daemon.executablePath !== record.controller.executablePath) {
    throw new Error(`daemon executable identity mismatch for PID ${String(daemon.pid)}`);
  }
  const arguments_ = readNulFrames(
    await readFile(`/proc/${String(daemon.pid)}/cmdline`),
    "daemon command line",
  );
  if (JSON.stringify(arguments_) !== JSON.stringify(record.bootstrapArgv)) {
    throw new Error(`daemon bootstrap argv mismatch for PID ${String(daemon.pid)}`);
  }
  assertExactGenerationEntry(
    await readFile(`/proc/${String(daemon.pid)}/environ`),
    record.generation,
  );
}

export function controllerEnvironment(
  capability: ReservationCapability,
  generationName: string,
): Readonly<Record<string, string>> {
  const base = reservationEnvironments.get(capability);
  if (base === undefined) {
    throw new Error("fixture reservation environment snapshot is missing");
  }
  const copy = { ...base };
  delete copy[generationName];
  return Object.freeze(copy);
}

export async function validateGenerationAuthority(
  capability: ReservationCapability,
  record: Extract<FixtureRecord, { readonly phase: "launching" | "running" }>,
  daemonPid: number,
  options: PromotionOptions = {},
): Promise<{ readonly daemon: DaemonIdentity; readonly socketIdentity: SocketIdentity }> {
  await assertControllerCurrent(record.controller);
  const daemon = await readDaemonIdentity(daemonPid);
  if (daemon === undefined) {
    throw new Error("tmux daemon identity is missing after launch");
  }
  await assertExactProcessLaunch(record, daemon);
  let beforeMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    beforeMetadata = await lstat(record.socketPath);
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      throw new Error("fixture socket is missing during generation validation");
    throw error;
  }
  const before = socketIdentityFromMetadata(beforeMetadata);
  const matchedMarker = `generation-match-${randomUUID()}`;
  const mismatchMarker = `generation-mismatch-${randomUUID()}`;
  const environment = controllerEnvironment(capability, record.generation.name);
  const globalArgs = Object.freeze(["-N", "-S", record.socketPath]);
  const command = Object.freeze([
    "if-shell",
    "-F",
    `#{&&:#{==:#{pid},${String(daemon.pid)}},#{==:#{${record.generation.name}},${record.generation.value}}}`,
    `show-environment -g ${record.generation.name}`,
    `display-message -p ${mismatchMarker}`,
  ]);
  options.observeRequest?.(
    Object.freeze({
      args: Object.freeze([...globalArgs, ...command]),
      environment,
      executable: record.controller.executablePath,
      purpose: "validation" as const,
    }),
  );
  await assertControllerCurrent(record.controller);
  const result = await new NodeSpawnTransport({ terminationGraceMs: 100 }).execute({
    commands: [tmuxCommand(command)],
    environment,
    executable: record.controller.executablePath,
    globalArgs,
    timeoutMs: 1_000,
  });
  const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  if (result.returncode !== 0) throw new Error("fixture generation validation request failed");
  if (output === `${mismatchMarker}\n`) {
    throw new ForeignSocketEvidenceError("fixture socket server generation mismatch");
  }
  if (output !== `${record.generation.name}=${record.generation.value}\n`) {
    throw new Error(`fixture generation validation returned an invalid frame: ${matchedMarker}`);
  }
  await assertControllerCurrent(record.controller);
  await assertExactProcessLaunch(record, daemon);
  const after = socketIdentityFromMetadata(await lstat(record.socketPath));
  if (!sameEntry(before, after)) {
    throw new ForeignSocketEvidenceError(
      "fixture socket identity changed during generation validation",
    );
  }
  return { daemon, socketIdentity: before };
}

export async function beginFixtureLaunch(
  capability: ReservationCapability,
  launch: {
    readonly bootstrapArgv: readonly string[];
    readonly generation: LaunchGeneration;
  },
): Promise<LaunchAttemptCapability> {
  return serializeReservationMutation(capability, async () => {
    const current = await preflightReservation(capability);
    if (current.record.phase !== "reserved") {
      throw new Error(`fixture launch requires reserved, received ${current.record.phase}`);
    }
    const generation = assertLaunchGeneration(launch.generation);
    const bootstrapArgv = assertBootstrapArgv(
      launch.bootstrapArgv,
      current.record.controller,
      current.record.socketPath,
      generation,
    );
    const updated: Extract<FixtureRecord, { readonly phase: "launching" }> = {
      ...current.record,
      bootstrapArgv,
      generation,
      phase: "launching",
    };
    await writeAtomicJson(capability.recordPath, updated);
    const attempt = Object.freeze({
      attemptId: randomUUID(),
      recordPath: capability.recordPath,
      reservationPath: capability.reservationPath,
      runId: capability.runId,
      runRoot: capability.runRoot,
    }) as LaunchAttemptCapability;
    launchAttemptCapabilities.add(attempt);
    launchAttemptReservations.set(attempt, capability);
    launchAttemptSnapshots.set(attempt, { bootstrapArgv, generation });
    return attempt;
  });
}

export async function rollbackFixtureLaunchNotStarted(
  attempt: LaunchAttemptCapability,
): Promise<Extract<FixtureRecord, { readonly phase: "reserved" }>> {
  const { capability, snapshot } = assertLaunchAttempt(attempt);
  return serializeReservationMutation(capability, async () => {
    const current = await preflightReservation(capability);
    if (current.record.phase !== "launching" || !sameLaunchSnapshot(current.record, snapshot)) {
      throw new Error("fixture launch rollback does not match the durable launch attempt");
    }
    if (current.socketPresent) {
      throw new Error("fixture launch rollback requires an absent socket");
    }
    const updated: Extract<FixtureRecord, { readonly phase: "reserved" }> = {
      controller: current.record.controller,
      logicalSocketName: current.record.logicalSocketName,
      owner: current.record.owner,
      phase: "reserved",
      protocol: fixtureProtocol,
      runId: current.record.runId,
      socketPath: current.record.socketPath,
    };
    await writeAtomicJson(capability.recordPath, updated);
    launchAttemptCapabilities.delete(attempt);
    launchAttemptReservations.delete(attempt);
    launchAttemptSnapshots.delete(attempt);
    return updated;
  });
}

export async function promoteFixtureLaunch(
  attempt: LaunchAttemptCapability,
  daemonPid: number,
  options: PromotionOptions = {},
): Promise<Extract<FixtureRecord, { readonly phase: "running" }>> {
  const { capability, snapshot } = assertLaunchAttempt(attempt);
  return serializeReservationMutation(capability, async () => {
    const current = await preflightReservation(capability);
    if (current.record.phase !== "launching" || !sameLaunchSnapshot(current.record, snapshot)) {
      throw new Error("fixture promotion does not match the durable launch attempt");
    }
    const authority = await validateGenerationAuthority(
      capability,
      current.record,
      daemonPid,
      options,
    );
    const updated: Extract<FixtureRecord, { readonly phase: "running" }> = {
      ...current.record,
      daemon: authority.daemon,
      phase: "running",
      socketIdentity: authority.socketIdentity,
    };
    await writeAtomicJson(capability.recordPath, updated, options.faultInjection);
    launchAttemptCapabilities.delete(attempt);
    launchAttemptReservations.delete(attempt);
    launchAttemptSnapshots.delete(attempt);
    return updated;
  });
}

function assertReservationCapability(capability: ReservationCapability): void {
  if (!reservationCapabilities.has(capability)) {
    throw new Error("fixture cleanup requires an authenticated reservation capability");
  }
}

export async function serializeReservationMutation<T>(
  capability: ReservationCapability,
  operation: () => Promise<T>,
): Promise<T> {
  assertReservationCapability(capability);
  const key = capability.reservationPath;
  const previous = reservationMutationTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.catch(() => undefined).then(() => turn);
  reservationMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (reservationMutationTails.get(key) === tail) reservationMutationTails.delete(key);
  }
}

export async function preflightReservation(capability: ReservationCapability): Promise<{
  record: FixtureRecord;
  recordIdentity: EntryIdentity;
  reservationIdentity: EntryIdentity;
  socketIdentity?: EntryIdentity;
  socketPresent: boolean;
}> {
  assertReservationCapability(capability);
  await assertSafeAbsoluteRoot(capability.runRoot);
  await assertOwnedDirectory(capability.runRoot, "test run root");
  await assertOwnedDirectory(capability.reservationPath, "fixture reservation");
  if (
    dirname(capability.reservationPath) !== capability.runRoot ||
    capability.recordPath !== join(capability.reservationPath, FIXTURE_RECORD_NAME)
  ) {
    throw new Error("fixture reservation is not a direct child of its exact run root");
  }
  const owner = await readOwner(capability.runRoot);
  const record = await readFixtureRecord(capability.reservationPath);
  const exactSocketPath = join(capability.reservationPath, "s");
  if (
    owner.runId !== capability.runId ||
    record.runId !== capability.runId ||
    !sameControllerIdentity(owner.controller, record.controller) ||
    record.socketPath !== exactSocketPath ||
    record.logicalSocketName !== basename(capability.reservationPath)
  ) {
    throw new Error("fixture record does not match its exact run-root capability");
  }
  let entries = await readdir(capability.reservationPath, { withFileTypes: true });
  const temporary = entries.find(({ name }) => name === fixtureRecordTemporaryName);
  if (temporary !== undefined) {
    if (temporary.isSymbolicLink() || !temporary.isFile()) {
      throw new Error("fixture identity record temporary must be a regular file");
    }
    const temporaryPath = join(capability.reservationPath, fixtureRecordTemporaryName);
    await readOwnedRecord(temporaryPath, "fixture identity record temporary");
    await unlink(temporaryPath);
    entries = await readdir(capability.reservationPath, { withFileTypes: true });
  }
  for (const entry of entries) {
    if (entry.name !== FIXTURE_RECORD_NAME && entry.name !== "s") {
      throw new Error(`reservation contains unexpected entries: ${entry.name}`);
    }
    if (entry.isSymbolicLink())
      throw new Error(`reservation entry must not be a symlink: ${entry.name}`);
    if (entry.name === FIXTURE_RECORD_NAME && !entry.isFile()) {
      throw new Error("fixture identity record must be a regular file");
    }
  }
  const socketPresent = await socketExists(exactSocketPath);
  if (entries.some((entry) => entry.name === "s") && !socketPresent) {
    throw new Error("fixture socket entry is not a Unix socket");
  }
  return {
    record,
    recordIdentity: entryIdentity(await lstat(capability.recordPath)),
    reservationIdentity: entryIdentity(await lstat(capability.reservationPath)),
    ...(socketPresent ? { socketIdentity: entryIdentity(await lstat(exactSocketPath)) } : {}),
    socketPresent,
  };
}
