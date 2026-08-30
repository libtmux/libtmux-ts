import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

import {
  assertControllerIdentity,
  assertDaemonIdentity,
  assertIdentity,
  readProcessIdentity,
  sameControllerIdentity,
  type ControllerIdentity,
  type DaemonIdentity,
  type ProcessIdentity,
} from "./process_identity.js";
import { SOCKET_PATH_UTF8_LIMIT } from "./temp_root.js";

export const OWNER_RECORD_NAME = ".owner.json";
export const FIXTURE_RECORD_NAME = "fixture.json";
// Declared beside the temp root that must fit inside it, and re-exported here.
export { SOCKET_PATH_UTF8_LIMIT };

export const fixtureProtocol = "libtmux-test-fixture-v3" as const;
const ownerProtocolV2 = "libtmux-test-run-v2" as const;

export interface OwnerRecord {
  readonly controller: ControllerIdentity;
  readonly owner: ProcessIdentity;
  readonly protocol: typeof ownerProtocolV2;
  readonly runId: string;
}

export interface SocketIdentity {
  readonly device: string;
  readonly inode: string;
  readonly kind: "socket";
  readonly mode: string;
  readonly uid: string;
}

export interface LaunchGeneration {
  readonly name: string;
  readonly value: string;
}

interface FixtureRecordBase {
  readonly controller: ControllerIdentity;
  readonly logicalSocketName: string;
  readonly owner: ProcessIdentity;
  readonly protocol: typeof fixtureProtocol;
  readonly runId: string;
  readonly socketPath: string;
}

export type FixtureRecord =
  | (FixtureRecordBase & { readonly phase: "reserved" })
  | (FixtureRecordBase & {
      readonly bootstrapArgv: readonly string[];
      readonly generation: LaunchGeneration;
      readonly phase: "launching";
    })
  | (FixtureRecordBase & {
      readonly bootstrapArgv: readonly string[];
      readonly daemon: DaemonIdentity;
      readonly generation: LaunchGeneration;
      readonly phase: "running";
      readonly socketIdentity: SocketIdentity;
    });

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const logicalSocketPattern: RegExp = /^[A-Za-z0-9_-]+$/u;
export const generatedLogicalSocketPattern: RegExp = /^t-[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{3}$/u;
export const fixtureEscrowPrefix = ".fixture-escrow-";
export const fixtureRecordTemporaryName = ".fixture.json.tmp";
const generationNamePattern = /^LIBTMUX_TEST_GENERATION_[A-F0-9]{32}$/u;
const generationValuePattern = runIdPattern;

export function snapshotEnvironment(
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

export function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function assertSocketIdentity(value: unknown): SocketIdentity {
  if (typeof value !== "object" || value === null) {
    throw new Error("fixture socket identity is missing");
  }
  const candidate = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(["device", "inode", "kind", "mode", "uid"]) ||
    candidate.kind !== "socket" ||
    [candidate.device, candidate.inode, candidate.mode, candidate.uid].some(
      (part) => typeof part !== "string" || !/^\d+$/u.test(part),
    ) ||
    (process.geteuid?.() !== undefined && candidate.uid !== String(process.geteuid?.()))
  ) {
    throw new Error("fixture socket identity is corrupt");
  }
  return candidate as unknown as SocketIdentity;
}

export function assertLaunchGeneration(value: unknown): LaunchGeneration {
  if (typeof value !== "object" || value === null) {
    throw new Error("fixture launch generation is missing");
  }
  const candidate = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(["name", "value"]) ||
    typeof candidate.name !== "string" ||
    !generationNamePattern.test(candidate.name) ||
    typeof candidate.value !== "string" ||
    !generationValuePattern.test(candidate.value)
  ) {
    throw new Error("fixture launch generation is corrupt");
  }
  return { name: candidate.name, value: candidate.value };
}

function commandQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isGeneratedNewSessionBranch(
  value: string,
  controller: ControllerIdentity,
  socketPath: string,
  generation: LaunchGeneration,
): boolean {
  const prefix = "new-session -d -P -F '#{socket_path}\t#{pid}\t#{session_id}' -s '";
  if (!value.startsWith(prefix)) return false;
  const sessionEnd = value.indexOf("' ", prefix.length);
  if (sessionEnd < 0) return false;
  const sessionName = value.slice(prefix.length, sessionEnd);
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionName)) return false;
  const pane = value.slice(sessionEnd + 2);
  const panePrefix = commandQuote(
    [
      "env",
      "-u",
      commandQuote(generation.name),
      commandQuote(controller.executablePath),
      "-N",
      "-S",
      commandQuote(socketPath),
      "wait-for",
      "-S",
    ].join(" "),
  ).slice(0, -1);
  if (!pane.startsWith(panePrefix)) return false;
  const suffix = pane.slice(panePrefix.length);
  return /^ '"'"'ready-[0-9a-f-]+'"'"' && exec cat'$/u.test(suffix);
}

export function assertBootstrapArgv(
  value: unknown,
  controller: ControllerIdentity,
  socketPath: string,
  generation: LaunchGeneration,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length !== 12 ||
    value.some((part) => typeof part !== "string" || part.includes("\0")) ||
    value[0] !== controller.executablePath ||
    JSON.stringify(value.slice(1, 10)) !==
      JSON.stringify([
        "-f",
        "/dev/null",
        "-S",
        socketPath,
        "start-server",
        ";",
        "if-shell",
        "-F",
        `#{==:#{${generation.name}},${generation.value}}`,
      ]) ||
    value.filter((part) => part === "-S" || part.startsWith("-S")).length !== 1 ||
    value.some((part) => part === "-L" || part.startsWith("-L")) ||
    value.filter((part) => part === ";").length !== 1 ||
    !isGeneratedNewSessionBranch(value[10] ?? "", controller, socketPath, generation) ||
    !/^display-message -p 'generation-mismatch-[0-9a-f-]+'$/u.test(value[11] ?? "")
  ) {
    throw new Error("fixture bootstrap argv or generation is corrupt");
  }
  return Object.freeze([...value]) as readonly string[];
}

export function assertControllerMatchesOwner(
  record: Pick<FixtureRecord, "controller">,
  ownerController: ControllerIdentity,
): void {
  if (!sameControllerIdentity(record.controller, ownerController)) {
    throw new Error("fixture controller does not match test run owner");
  }
}

export async function assertSafeAbsoluteRoot(runRoot: string): Promise<void> {
  if (!isAbsolute(runRoot)) throw new Error("test run root must be absolute");
  if (resolve(runRoot) !== runRoot) throw new Error("test run root must be canonical");
  if (runRoot === parse(runRoot).root || runRoot === resolve(tmpdir())) {
    throw new Error(`unsafe run root: ${runRoot}`);
  }
  if (basename(runRoot) === "") throw new Error(`unsafe run root: ${runRoot}`);
  const parsed = parse(runRoot);
  const components = runRoot.slice(parsed.root.length).split("/").filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = join(current, component);
    let metadata;
    try {
      // eslint-disable-next-line no-await-in-loop -- every existing component is an independent trust boundary.
      metadata = await lstat(current);
    } catch (error) {
      if (isErrno(error, "ENOENT")) break;
      throw error;
    }
    if (metadata.isSymbolicLink())
      throw new Error(`test run root has a symlink component: ${current}`);
  }
}

export async function assertOwnedDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  if ((metadata.mode & 0o777) !== 0o700) throw new Error(`${label} must have mode 0700`);
  const uid = process.geteuid?.();
  if (uid !== undefined && metadata.uid !== uid) throw new Error(`${label} has the wrong uid`);
  if ((await realpath(path)) !== path) throw new Error(`${label} must be canonical`);
}

export function validateOwnedRecordMetadata(
  metadata: { readonly isRegularFile: boolean; readonly mode: number; readonly uid: number },
  label: string,
  expectedUid: number | undefined,
): void {
  if (!metadata.isRegularFile) throw new Error(`${label} must be a regular file`);
  if ((metadata.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600`);
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error(`${label} has the wrong uid`);
  }
}

export async function readOwnedRecord(path: string, label: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new Error(`${label} is missing`, { cause: error });
    if (isErrno(error, "ELOOP"))
      throw new Error(`${label} must not be a symlink`, { cause: error });
    throw error;
  }
  try {
    const metadata = await handle.stat();
    validateOwnedRecordMetadata(
      { isRegularFile: metadata.isFile(), mode: metadata.mode, uid: metadata.uid },
      label,
      process.geteuid?.(),
    );
    return await handle.readFile("utf8");
  } catch (error) {
    if (isErrno(error, "ELOOP"))
      throw new Error(`${label} must not be a symlink`, { cause: error });
    throw error;
  } finally {
    await handle.close();
  }
}

export function parseOwnerRecord(text: string): OwnerRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("test run owner record is corrupt", { cause: error });
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("test run owner record is corrupt");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol !== ownerProtocolV2) {
    throw new Error("test run owner record has bad magic or protocol");
  }
  if (
    JSON.stringify(Object.keys(candidate).sort()) !==
    JSON.stringify(["controller", "owner", "protocol", "runId"])
  ) {
    throw new Error("test run owner record is corrupt");
  }
  if (typeof candidate.runId !== "string" || !runIdPattern.test(candidate.runId)) {
    throw new Error("test run owner record is corrupt");
  }
  return {
    controller: assertControllerIdentity(candidate.controller),
    owner: assertIdentity(candidate.owner, "test run owner identity"),
    protocol: ownerProtocolV2,
    runId: candidate.runId,
  };
}

export function parseFixtureRecord(text: string): FixtureRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("fixture identity record is corrupt", { cause: error });
  }
  if (typeof value !== "object" || value === null)
    throw new Error("fixture identity record is corrupt");
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol !== fixtureProtocol) {
    throw new Error("fixture identity record has bad magic or protocol");
  }
  const commonKeys = [
    "controller",
    "logicalSocketName",
    "owner",
    "phase",
    "protocol",
    "runId",
    "socketPath",
  ];
  const phase = candidate.phase;
  const expectedKeys = [
    ...commonKeys,
    ...(phase === "launching" || phase === "running" ? ["bootstrapArgv", "generation"] : []),
    ...(phase === "running" ? ["daemon", "socketIdentity"] : []),
  ].sort();
  if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("fixture identity record is corrupt");
  }
  if (
    typeof candidate.logicalSocketName !== "string" ||
    candidate.logicalSocketName === "" ||
    typeof candidate.socketPath !== "string" ||
    !isAbsolute(candidate.socketPath) ||
    typeof candidate.runId !== "string" ||
    !runIdPattern.test(candidate.runId)
  ) {
    throw new Error("fixture identity record is corrupt");
  }
  const parsedPhase =
    phase === "reserved" || phase === "launching" || phase === "running"
      ? phase
      : (() => {
          throw new Error("fixture identity record is corrupt");
        })();
  const controller = assertControllerIdentity(candidate.controller);
  const base: FixtureRecordBase = {
    controller,
    logicalSocketName: candidate.logicalSocketName,
    owner: assertIdentity(candidate.owner, "fixture owner identity"),
    protocol: fixtureProtocol,
    runId: candidate.runId,
    socketPath: candidate.socketPath,
  };
  if (parsedPhase === "reserved") return { ...base, phase: "reserved" };
  const generation = assertLaunchGeneration(candidate.generation);
  const bootstrapArgv = assertBootstrapArgv(
    candidate.bootstrapArgv,
    controller,
    candidate.socketPath,
    generation,
  );
  if (parsedPhase === "launching") {
    return { ...base, bootstrapArgv, generation, phase: "launching" };
  }
  return {
    ...base,
    bootstrapArgv,
    daemon: assertDaemonIdentity(candidate.daemon),
    generation,
    phase: "running",
    socketIdentity: assertSocketIdentity(candidate.socketIdentity),
  };
}

export class ForeignSocketEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForeignSocketEvidenceError";
  }
}

export function socketIdentityFromMetadata(
  metadata: Awaited<ReturnType<typeof lstat>>,
): SocketIdentity {
  if (!metadata.isSocket()) throw new ForeignSocketEvidenceError("fixture socket is not a socket");
  const uid = process.geteuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new ForeignSocketEvidenceError("fixture socket has the wrong uid");
  }
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    kind: "socket",
    mode: String(metadata.mode),
    uid: String(metadata.uid),
  };
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function writeAtomicDurableJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), ".journal.tmp");
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function writeAtomicJson(
  path: string,
  value: unknown,
  faultInjection?: "partial-write",
): Promise<void> {
  const temporary = join(dirname(path), fixtureRecordTemporaryName);
  try {
    const handle = await open(temporary, "wx", 0o600);
    if (faultInjection === "partial-write") {
      try {
        await handle.writeFile('{"partial":', "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      throw new Error("injected partial identity record write failure");
    }
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readOwner(runRoot: string): Promise<OwnerRecord> {
  try {
    return parseOwnerRecord(
      await readOwnedRecord(join(runRoot, OWNER_RECORD_NAME), "test run owner record"),
    );
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      throw new Error("test run owner record is missing", { cause: error });
    throw error;
  }
}

export async function readFixtureRecord(reservationPath: string): Promise<FixtureRecord> {
  return parseFixtureRecord(
    await readOwnedRecord(join(reservationPath, FIXTURE_RECORD_NAME), "fixture identity record"),
  );
}

export async function publishRunRootOwner(
  runRoot: string,
  controller: ControllerIdentity,
): Promise<void> {
  const owner = await readProcessIdentity(process.pid);
  if (owner === undefined) throw new Error("cannot identify test run owner process");
  await writeExclusiveJson(join(runRoot, OWNER_RECORD_NAME), {
    controller,
    owner,
    protocol: ownerProtocolV2,
    runId: randomUUID(),
  });
}

export function validateSocketPath(socketPath: string): void {
  const byteLength = Buffer.byteLength(socketPath, "utf8");
  if (byteLength > SOCKET_PATH_UTF8_LIMIT) {
    throw new Error(
      `Unix socket path exceeds ${String(SOCKET_PATH_UTF8_LIMIT)} UTF-8 bytes: ${String(byteLength)}`,
    );
  }
}

export async function socketExists(socketPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(socketPath);
    return metadata.isSocket();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

export interface EntryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly kind: "directory" | "file" | "other" | "socket";
  readonly mode: string;
  readonly uid: string;
}

export const fixtureEscrowProtocol = "libtmux-fixture-escrow-v3" as const;

export interface FixtureEscrowJournal {
  readonly logicalSocketName: string;
  readonly protocol: typeof fixtureEscrowProtocol;
  readonly record: EntryIdentity;
  readonly recordDigest: string;
  readonly recordPath: string;
  readonly recordSnapshot: FixtureRecord;
  readonly reservation: EntryIdentity;
  readonly reservationPath: string;
  readonly runId: string;
  readonly socket?: EntryIdentity;
  readonly socketPath: string;
}

export function entryIdentity(metadata: Awaited<ReturnType<typeof lstat>>): EntryIdentity {
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    kind: metadata.isDirectory()
      ? "directory"
      : metadata.isFile()
        ? "file"
        : metadata.isSocket()
          ? "socket"
          : "other",
    mode: String(metadata.mode),
    uid: String(metadata.uid),
  };
}

/**
 * Permission bits tmux owns rather than the fixture.
 *
 * tmux advertises whether a server has clients by setting the owner-execute
 * bit on its socket and clearing it when the last one leaves (server.c, where
 * `mode |= S_IXUSR` pairs with `mode &= ~(S_IXUSR|S_IXGRP|S_IXOTH)`). That is
 * state, not identity: the socket is the same socket either way, and a fixture
 * that attaches a client is not a fixture whose socket was replaced.
 */
const CLIENT_PRESENCE_BITS = 0o111;

function sameMode(left: string, right: string, kind: EntryIdentity["kind"]): boolean {
  if (kind !== "socket") return left === right;
  return (Number(left) & ~CLIENT_PRESENCE_BITS) === (Number(right) & ~CLIENT_PRESENCE_BITS);
}

export function sameEntry(left: EntryIdentity, right: EntryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.kind === right.kind &&
    sameMode(left.mode, right.mode, left.kind) &&
    left.uid === right.uid
  );
}

function parseJournalIdentity(value: unknown, expectedKind: EntryIdentity["kind"]): EntryIdentity {
  if (typeof value !== "object" || value === null) {
    throw new Error("fixture escrow journal identity is missing");
  }
  const candidate = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(["device", "inode", "kind", "mode", "uid"]) ||
    candidate.kind !== expectedKind ||
    [candidate.device, candidate.inode, candidate.mode, candidate.uid].some(
      (part) => typeof part !== "string" || !/^\d+$/u.test(part),
    )
  ) {
    throw new Error("fixture escrow journal identity is corrupt");
  }
  return candidate as unknown as EntryIdentity;
}

export function parseFixtureEscrowJournal(
  value: string,
  ownerController: ControllerIdentity,
): FixtureEscrowJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("fixture escrow journal is corrupt", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("fixture escrow journal is corrupt");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.protocol !== fixtureEscrowProtocol) {
    throw new Error("fixture escrow journal has bad magic or protocol");
  }
  const expectedKeys = [
    "logicalSocketName",
    "protocol",
    "record",
    "recordDigest",
    "recordPath",
    "recordSnapshot",
    "reservation",
    "reservationPath",
    "runId",
    ...(candidate.socket === undefined ? [] : ["socket"]),
    "socketPath",
  ].sort();
  if (
    JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(expectedKeys) ||
    typeof candidate.logicalSocketName !== "string" ||
    !logicalSocketPattern.test(candidate.logicalSocketName) ||
    typeof candidate.runId !== "string" ||
    !runIdPattern.test(candidate.runId) ||
    typeof candidate.recordDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.recordDigest) ||
    typeof candidate.recordPath !== "string" ||
    !isAbsolute(candidate.recordPath) ||
    typeof candidate.reservationPath !== "string" ||
    !isAbsolute(candidate.reservationPath) ||
    typeof candidate.socketPath !== "string" ||
    !isAbsolute(candidate.socketPath)
  ) {
    throw new Error("fixture escrow journal is corrupt");
  }
  const recordSnapshot = parseFixtureRecord(`${JSON.stringify(candidate.recordSnapshot)}\n`);
  assertControllerMatchesOwner(recordSnapshot, ownerController);
  const socket =
    candidate.socket === undefined ? undefined : parseJournalIdentity(candidate.socket, "socket");
  if (recordSnapshot.phase === "launching") {
    throw new Error("a launching fixture record cannot authorize journal recovery");
  }
  if (
    recordSnapshot.runId !== candidate.runId ||
    recordSnapshot.logicalSocketName !== candidate.logicalSocketName ||
    recordSnapshot.socketPath !== candidate.socketPath ||
    (recordSnapshot.phase === "reserved" && socket !== undefined) ||
    (recordSnapshot.phase === "running" &&
      socket !== undefined &&
      !sameEntry(recordSnapshot.socketIdentity, socket))
  ) {
    throw new Error("fixture escrow journal authority is corrupt");
  }
  return {
    logicalSocketName: candidate.logicalSocketName,
    protocol: fixtureEscrowProtocol,
    record: parseJournalIdentity(candidate.record, "file"),
    recordDigest: candidate.recordDigest,
    recordPath: candidate.recordPath,
    recordSnapshot,
    reservation: parseJournalIdentity(candidate.reservation, "directory"),
    reservationPath: candidate.reservationPath,
    runId: candidate.runId,
    ...(socket === undefined ? {} : { socket }),
    socketPath: candidate.socketPath,
  };
}

export function recordDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
