import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { NodeSpawnTransport } from "../transport/node_spawn_transport.js";
import { DAEMON_EXIT_DEADLINE_MS, DAEMON_REAPED_DEADLINE_MS, deadlineMs } from "./deadlines.js";
import { ownedTestDirectories } from "./temp_root.js";
import {
  assertExactProcessLaunch,
  controllerEnvironment,
  preflightReservation,
  restoreReservationCapability,
  serializeReservationMutation,
  validateGenerationAuthority,
  type ReservationCapability,
} from "./fixture_launch.js";
import {
  assertControllerCurrent,
  readDaemonIdentity,
  readProcessIdentity,
  resolveControllerIdentity,
  type ControllerIdentity,
  type DaemonIdentity,
} from "./process_identity.js";
import {
  FIXTURE_RECORD_NAME,
  OWNER_RECORD_NAME,
  ForeignSocketEvidenceError,
  assertControllerMatchesOwner,
  assertOwnedDirectory,
  assertSafeAbsoluteRoot,
  entryIdentity,
  fixtureEscrowPrefix,
  fixtureEscrowProtocol,
  fixtureRecordTemporaryName,
  generatedLogicalSocketPattern,
  isErrno,
  logicalSocketPattern,
  parseFixtureEscrowJournal,
  parseFixtureRecord,
  parseOwnerRecord,
  publishRunRootOwner,
  readFixtureRecord,
  readOwnedRecord,
  readOwner,
  recordDigest,
  sameEntry,
  snapshotEnvironment,
  socketIdentityFromMetadata,
  writeAtomicDurableJson,
  writeAtomicJson,
  type EntryIdentity,
  type FixtureEscrowJournal,
  type FixtureRecord,
  type OwnerRecord,
  type SocketIdentity,
} from "./records.js";

export interface ReapReport {
  readonly leaks: readonly string[];
  readonly reservationsFound: number;
  readonly rootRemoved: boolean;
}

interface CollectedChild {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}

export async function prepareRunRoot(
  runRoot: string,
  tmuxExecutable = "tmux",
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const controller = await resolveControllerIdentity(tmuxExecutable, environment);
  await assertSafeAbsoluteRoot(runRoot);
  try {
    await lstat(runRoot);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await reapDetachedOwnerEscrow(runRoot, "stale");
  }
  try {
    await mkdir(runRoot, { mode: 0o700 });
    await chmod(runRoot, 0o700);
    await publishRunRootOwner(runRoot, controller);
    return;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  await assertOwnedDirectory(runRoot, "test run root");
  await restoreEscrowedOwner(runRoot);
  const record = await readOwner(runRoot);
  const observed = await readProcessIdentity(record.owner.pid);
  if (observed?.startIdentity === record.owner.startIdentity) {
    throw new Error(`test run root has a live owner: ${String(record.owner.pid)}`);
  }
  const report = await reapRunRootInternal(runRoot, "stale");
  if (report.leaks.length > 0 || !report.rootRemoved) {
    throw new Error(`stale test run root leaked: ${report.leaks.join("; ")}`);
  }
  await mkdir(runRoot, { mode: 0o700 });
  await chmod(runRoot, 0o700);
  await publishRunRootOwner(runRoot, controller);
}

async function collectChild(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CollectedChild> {
  const child = spawn(executable, [...args], {
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolveChild, reject) => {
    let settled = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    const finish = (result: CollectedChild): void => {
      if (settled) return;
      settled = true;
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      resolveChild(result);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) =>
      finish({
        code,
        signal,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      }),
    );
    termTimer = setTimeout(() => child.kill("SIGTERM"), 750);
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    closeTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({
        code: null,
        signal: "SIGKILL",
        stderr: Buffer.concat([
          ...stderr,
          Buffer.from("helper close exceeded hard deadline", "utf8"),
        ]),
        stdout: Buffer.concat(stdout),
      });
    }, 1_250);
  });
}

const pidfdHelper = String.raw`
import json, os, select, signal, sys

def identity(pid):
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        boot = stream.read().strip()
    with open(f"/proc/{pid}/stat", encoding="utf-8") as stream:
        text = stream.read()
    fields = text[text.rfind(") ") + 2:].split()
    return f"linux:{boot}:{fields[19]}"

def daemon_identity(pid):
    with open(f"/proc/{pid}/comm", encoding="utf-8") as stream:
        comm = stream.read().strip()
    executable = os.path.realpath(f"/proc/{pid}/exe")
    return identity(pid), comm, executable

def nul_frames(path):
    with open(path, "rb") as stream:
        raw = stream.read()
    if not raw or raw[-1:] != b"\0":
        return None
    try:
        values = raw.decode("utf-8", errors="strict").split("\0")
    except UnicodeDecodeError:
        return None
    if values and values[-1] == "":
        values.pop()
    if any(value == "" for value in values):
        return None
    return values

def launch_matches(pid, expected_argv, generation_name, generation_value):
    arguments = nul_frames(f"/proc/{pid}/cmdline")
    with open(f"/proc/{pid}/environ", "rb") as stream:
        environment = stream.read()
    expected_generation = f"{generation_name}={generation_value}".encode("ascii")
    generation_prefix = f"{generation_name}=".encode("ascii")
    valid_environment = bool(environment) and environment[-1:] == b"\0"
    frames = environment[:-1].split(b"\0") if valid_environment else []
    return (
        arguments == expected_argv
        and valid_environment
        and all(frame for frame in frames)
        and [entry for entry in frames if entry.startswith(generation_prefix)]
            == [expected_generation]
    )

def matches(pid, expected_identity, expected_comm, expected_executable, expected_argv, generation_name, generation_value):
    return (
        daemon_identity(pid) == (expected_identity, expected_comm, expected_executable)
        and launch_matches(pid, expected_argv, generation_name, generation_value)
    )

pid = int(sys.argv[1])
expected = sys.argv[2]
expected_comm = sys.argv[3]
expected_executable = sys.argv[4]
expected_argv = json.loads(sys.argv[5])
generation_name = sys.argv[6]
generation_value = sys.argv[7]
try:
    if not matches(pid, expected, expected_comm, expected_executable, expected_argv, generation_name, generation_value):
        print(json.dumps({"status": "identity-mismatch"}))
        raise SystemExit(3)
    descriptor = os.pidfd_open(pid, 0)
    try:
        if not matches(pid, expected, expected_comm, expected_executable, expected_argv, generation_name, generation_value):
            print(json.dumps({"status": "identity-mismatch"}))
            raise SystemExit(3)
        signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        poller = select.poll()
        poller.register(descriptor, select.POLLIN)
        escalated = not bool(poller.poll(500))
        if escalated:
            if not matches(pid, expected, expected_comm, expected_executable, expected_argv, generation_name, generation_value):
                print(json.dumps({"status": "identity-mismatch"}))
                raise SystemExit(3)
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        if not poller.poll(2000):
            print(json.dumps({"status": "still-live"}))
            raise SystemExit(4)
        print(json.dumps({"escalated": escalated, "status": "reaped"}))
    finally:
        os.close(descriptor)
except (ProcessLookupError, FileNotFoundError):
    print(json.dumps({"status": "gone"}))
except (AttributeError, NotImplementedError, OSError) as error:
    print(json.dumps({"status": "unavailable", "error": str(error)}))
    raise SystemExit(5)
`;

const PIDFD_PROBE_SOURCE = "import os, sys; sys.exit(0 if hasattr(os, 'pidfd_open') else 1)";
const PIDFD_INTERPRETER_CANDIDATES: readonly string[] = ["python3", "/usr/bin/python3"];

/**
 * CPython gates `os.pidfd_open` on a build-time capability check, so an
 * interpreter first on `PATH` — a virtualenv, or a free-threading build — can
 * lack it while another on the same machine has it. Reaping a daemon whose
 * socket was already unlinked has no other route, and an interpreter chosen
 * without checking presents that gap as substrate flakiness: the daemon and its
 * reservation survive, and the next run inherits them.
 */
export async function resolvePidfdInterpreter(
  candidates: readonly string[],
  probe: (executable: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- First match wins, so later candidates must never be spawned.
      if (await probe(candidate)) return candidate;
    } catch {
      // A candidate that cannot be spawned is simply not a usable interpreter.
    }
  }
  return undefined;
}

async function probePidfdInterpreter(executable: string): Promise<boolean> {
  const result = await collectChild(executable, ["-I", "-c", PIDFD_PROBE_SOURCE]);
  return result.code === 0;
}

let resolvedPidfdInterpreter: Promise<string | undefined> | undefined;

function defaultPidfdInterpreter(): Promise<string | undefined> {
  resolvedPidfdInterpreter ??= resolvePidfdInterpreter(
    PIDFD_INTERPRETER_CANDIDATES,
    probePidfdInterpreter,
  );
  return resolvedPidfdInterpreter;
}

async function reapViaPidfd(
  capability: ReservationCapability,
  record: Extract<FixtureRecord, { readonly phase: "launching" | "running" }>,
  identity: DaemonIdentity,
): Promise<string | undefined> {
  const environment = controllerEnvironment(capability, record.generation.name);
  // An explicitly configured interpreter is authoritative and is never probed
  // or substituted; probing it would both override the choice and hang on a
  // helper written to hang.
  const python = environment.LIBTMUX_TEST_PYTHON ?? (await defaultPidfdInterpreter());
  if (python === undefined) {
    return `pidfd cleanup unavailable: no interpreter in ${PIDFD_INTERPRETER_CANDIDATES.join(", ")} exposes os.pidfd_open; set LIBTMUX_TEST_PYTHON to one that does`;
  }
  const result = await collectChild(
    python,
    [
      "-I",
      "-c",
      pidfdHelper,
      String(identity.pid),
      identity.startIdentity,
      identity.comm,
      identity.executablePath,
      JSON.stringify(record.bootstrapArgv),
      record.generation.name,
      record.generation.value,
    ],
    environment,
  ).catch((error: unknown) => ({ error }));
  if ("error" in result) return `pidfd cleanup unavailable: ${String(result.error)}`;
  if (result.code === 0) return undefined;
  const diagnostic = new TextDecoder().decode(result.stdout).trim();
  return `pidfd cleanup refused daemon ${String(identity.pid)}: ${diagnostic || String(result.code)}`;
}

type SocketEvidenceState = "absent" | "authenticated" | "foreign" | "unauthenticated";

function classifySocketEvidence(
  preflight: Awaited<ReturnType<typeof preflightReservation>>,
  authority: SocketIdentity | undefined,
): SocketEvidenceState {
  if (!preflight.socketPresent) return "absent";
  if (authority === undefined) return "unauthenticated";
  if (preflight.socketIdentity === undefined || !sameEntry(preflight.socketIdentity, authority)) {
    return "foreign";
  }
  return "authenticated";
}

function foreignSocketLeak(
  state: SocketEvidenceState,
  observed?: EntryIdentity,
  recorded?: SocketIdentity,
): string {
  if (state === "unauthenticated") {
    return "fixture socket is present without authenticated unlink authority";
  }
  // A different inode is something new bound to the path; the same inode on a
  // different device is the path itself having moved.
  const show = (identity: EntryIdentity | SocketIdentity | undefined): string =>
    identity === undefined
      ? "none"
      : `dev ${identity.device} inode ${identity.inode} ${identity.kind} mode ${identity.mode} uid ${identity.uid}`;
  const seen = show(observed);
  const expected = show(recorded);
  return `foreign socket evidence occupies the fixture socket path (observed ${seen}, recorded ${expected})`;
}

async function removeReservationFiles(
  capability: ReservationCapability,
  expected: Awaited<ReturnType<typeof preflightReservation>>,
  authorizedSocketIdentity: SocketIdentity | undefined,
): Promise<void> {
  const { recordPath, reservationPath, runRoot } = capability;
  const socketPath = join(reservationPath, "s");
  const current = await preflightReservation(capability);
  if (
    !sameEntry(current.reservationIdentity, expected.reservationIdentity) ||
    !sameEntry(current.recordIdentity, expected.recordIdentity) ||
    current.socketPresent !== expected.socketPresent ||
    (current.socketIdentity !== undefined &&
      expected.socketIdentity !== undefined &&
      !sameEntry(current.socketIdentity, expected.socketIdentity))
  ) {
    throw new Error("fixture cleanup evidence changed after preflight");
  }
  const socketState = classifySocketEvidence(current, authorizedSocketIdentity);
  if (socketState === "foreign" || socketState === "unauthenticated") {
    throw new ForeignSocketEvidenceError(foreignSocketLeak(socketState));
  }
  if (current.record.phase === "launching") {
    throw new Error("a launching fixture cannot authorize a cleanup journal");
  }

  const escrow = fixtureEscrowPath(runRoot, current.record.logicalSocketName, current.record.runId);
  await mkdir(escrow, { mode: 0o700 });
  await chmod(escrow, 0o700);
  const journalPath = join(escrow, "journal.json");
  const movedReservation = join(escrow, "reservation");
  let committed = false;
  try {
    const recordText = await readOwnedRecord(recordPath, "fixture identity record");
    await writeAtomicDurableJson(journalPath, {
      logicalSocketName: current.record.logicalSocketName,
      protocol: fixtureEscrowProtocol,
      record: current.recordIdentity,
      recordDigest: recordDigest(recordText),
      recordPath,
      recordSnapshot: current.record,
      reservation: current.reservationIdentity,
      reservationPath,
      runId: current.record.runId,
      ...(current.socketIdentity === undefined ? {} : { socket: current.socketIdentity }),
      socketPath,
    } satisfies FixtureEscrowJournal);
    await rename(reservationPath, movedReservation);
    committed = true;
    if (!sameEntry(entryIdentity(await lstat(movedReservation)), current.reservationIdentity)) {
      throw new Error("fixture reservation changed while being escrowed");
    }
    const movedEntries = await readdir(movedReservation);
    const expectedEntries = [
      FIXTURE_RECORD_NAME,
      ...(current.socketIdentity === undefined ? [] : ["s"]),
    ].sort();
    if (JSON.stringify(movedEntries.sort()) !== JSON.stringify(expectedEntries)) {
      throw new Error(`reservation contains unexpected entries: ${movedEntries.join(", ")}`);
    }
    const movedRecord = join(movedReservation, FIXTURE_RECORD_NAME);
    const movedRecordText = await readOwnedRecord(movedRecord, "escrowed fixture record");
    if (
      !sameEntry(entryIdentity(await lstat(movedRecord)), current.recordIdentity) ||
      recordDigest(movedRecordText) !== recordDigest(recordText)
    ) {
      throw new Error("fixture record changed while its reservation was escrowed");
    }
    if (current.socketIdentity !== undefined) {
      const movedSocket = join(movedReservation, "s");
      if (!sameEntry(entryIdentity(await lstat(movedSocket)), current.socketIdentity)) {
        throw new Error("fixture socket changed while its reservation was escrowed");
      }
      await unlink(movedSocket);
    }
    await unlink(movedRecord);
    await rmdir(movedReservation);
    parseFixtureEscrowJournal(
      await readOwnedRecord(journalPath, "fixture escrow journal"),
      current.record.controller,
    );
    await unlink(journalPath);
    await rmdir(escrow);
  } catch (error) {
    if (!committed) {
      await unlink(join(escrow, ".journal.tmp")).catch(() => undefined);
      await unlink(journalPath).catch(() => undefined);
      await rmdir(escrow).catch(() => undefined);
    }
    throw error;
  }
}

function generationCondition(
  record: Extract<FixtureRecord, { readonly phase: "launching" | "running" }>,
): string {
  return `#{==:#{${record.generation.name}},${record.generation.value}}`;
}

function pidGenerationCondition(
  record: Extract<FixtureRecord, { readonly phase: "launching" | "running" }>,
  pid: number,
): string {
  return `#{&&:#{==:#{pid},${String(pid)}},${generationCondition(record)}}`;
}

async function discoverLaunchingDaemon(
  capability: ReservationCapability,
  current: Awaited<ReturnType<typeof preflightReservation>>,
): Promise<Awaited<ReturnType<typeof preflightReservation>>> {
  if (current.record.phase !== "launching" || !current.socketPresent) {
    throw new Error("fixture daemon identity is missing after launch");
  }
  await assertControllerCurrent(current.record.controller);
  const before = current.socketIdentity;
  if (before === undefined) throw new Error("fixture socket is missing during discovery");
  const success = `generation-discovery-${randomUUID()}`;
  const mismatch = `generation-mismatch-${randomUUID()}`;
  const environment = controllerEnvironment(capability, current.record.generation.name);
  await assertControllerCurrent(current.record.controller);
  const result = await new NodeSpawnTransport({ terminationGraceMs: 100 }).execute({
    commands: [
      [
        "if-shell",
        "-F",
        generationCondition(current.record),
        `display-message -p '${success}\t#{pid}\t#{${current.record.generation.name}}'`,
        `display-message -p '${mismatch}'`,
      ],
    ],
    environment,
    executable: current.record.controller.executablePath,
    globalArgs: ["-N", "-S", current.record.socketPath],
    timeoutMs: 1_000,
  });
  const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  if (result.returncode !== 0) throw new Error("fixture generation discovery failed");
  if (output === `${mismatch}\n`)
    throw new ForeignSocketEvidenceError("fixture generation mismatch");
  const fields = output.endsWith("\n") ? output.slice(0, -1).split("\t") : [];
  const pid =
    fields.length === 3 && /^[1-9]\d*$/u.test(fields[1] ?? "") ? Number(fields[1]) : Number.NaN;
  if (
    fields[0] !== success ||
    fields[2] !== current.record.generation.value ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  ) {
    throw new Error("fixture generation discovery returned an invalid frame");
  }
  const after = socketIdentityFromMetadata(await lstat(current.record.socketPath));
  if (!sameEntry(before, after))
    throw new ForeignSocketEvidenceError("fixture socket changed during discovery");
  const authority = await validateGenerationAuthority(capability, current.record, pid);
  const running: Extract<FixtureRecord, { readonly phase: "running" }> = {
    ...current.record,
    daemon: authority.daemon,
    phase: "running",
    socketIdentity: authority.socketIdentity,
  };
  await writeAtomicJson(capability.recordPath, running);
  return preflightReservation(capability);
}

async function awaitDaemonExit(
  daemon: DaemonIdentity,
  boundMs: number = deadlineMs(DAEMON_EXIT_DEADLINE_MS),
): Promise<boolean> {
  const deadline = performance.now() + boundMs;
  while (performance.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- each observation is bounded by one monotonic deadline.
    const current = await readDaemonIdentity(daemon.pid);
    if (current === undefined || current.startIdentity !== daemon.startIdentity) return true;
    // eslint-disable-next-line no-await-in-loop -- yielding permits the daemon's exit notification to run.
    await new Promise((resolve) => setImmediate(resolve));
  }
  const current = await readDaemonIdentity(daemon.pid);
  return current === undefined || current.startIdentity !== daemon.startIdentity;
}

async function connectedGenerationKill(
  capability: ReservationCapability,
  record: Extract<FixtureRecord, { readonly phase: "running" }>,
): Promise<"killed" | "foreign" | "unavailable"> {
  try {
    await validateGenerationAuthority(capability, record, record.daemon.pid);
  } catch (error) {
    if (error instanceof ForeignSocketEvidenceError) return "foreign";
    throw error;
  }
  const mismatch = `kill-generation-mismatch-${randomUUID()}`;
  const environment = controllerEnvironment(capability, record.generation.name);
  await assertControllerCurrent(record.controller);
  const result = await new NodeSpawnTransport({ terminationGraceMs: 100 })
    .execute({
      commands: [
        [
          "if-shell",
          "-F",
          pidGenerationCondition(record, record.daemon.pid),
          "kill-server",
          `display-message -p '${mismatch}'`,
        ],
      ],
      environment,
      executable: record.controller.executablePath,
      globalArgs: ["-N", "-S", record.socketPath],
      timeoutMs: 1_000,
    })
    .catch(() => undefined);
  if (result === undefined || result.returncode !== 0) return "unavailable";
  const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  if (output === `${mismatch}\n`) return "foreign";
  if (output !== "") throw new Error("guarded fixture cleanup returned an invalid frame");
  return "killed";
}

async function reapReservation(capability: ReservationCapability): Promise<ReapReport> {
  const leak = (message: unknown): ReapReport => ({
    leaks: [String(message)],
    reservationsFound: 1,
    rootRemoved: false,
  });
  let preflight: Awaited<ReturnType<typeof preflightReservation>>;
  try {
    preflight = await preflightReservation(capability);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { leaks: [], reservationsFound: 0, rootRemoved: false };
    return leak(error);
  }

  try {
    if (preflight.record.phase === "reserved") {
      if (preflight.socketPresent) return leak(foreignSocketLeak("unauthenticated"));
      await removeReservationFiles(capability, preflight, undefined);
      return { leaks: [], reservationsFound: 1, rootRemoved: false };
    }
    if (preflight.record.phase === "launching") {
      if (!preflight.socketPresent) return leak("fixture daemon identity is missing after launch");
      preflight = await discoverLaunchingDaemon(capability, preflight);
    }
    if (preflight.record.phase !== "running")
      return leak("fixture promotion did not publish running authority");
    const record = preflight.record;
    const initialSocketState = classifySocketEvidence(preflight, record.socketIdentity);
    await assertControllerCurrent(record.controller);
    const observed = await readDaemonIdentity(record.daemon.pid);
    if (observed === undefined) {
      const processAtPid = await readProcessIdentity(record.daemon.pid);
      if (processAtPid?.startIdentity === record.daemon.startIdentity) {
        return leak(`daemon executable identity mismatch for PID ${String(record.daemon.pid)}`);
      }
    } else {
      await assertExactProcessLaunch(record, record.daemon);
      if (initialSocketState === "authenticated") {
        const outcome = await connectedGenerationKill(capability, record);
        if (outcome === "foreign") {
          const failure = await reapViaPidfd(capability, record, record.daemon);
          return leak(failure ?? "fixture socket server generation mismatch");
        }
        if (outcome === "unavailable" || !(await awaitDaemonExit(record.daemon))) {
          const failure = await reapViaPidfd(capability, record, record.daemon);
          if (failure !== undefined) return leak(failure);
        }
      } else {
        const failure = await reapViaPidfd(capability, record, record.daemon);
        if (failure !== undefined) return leak(failure);
      }
    }
    if (!(await awaitDaemonExit(record.daemon, deadlineMs(DAEMON_REAPED_DEADLINE_MS)))) {
      return leak(`daemon ${String(record.daemon.pid)} remained live after cleanup`);
    }
    const finalPreflight = await preflightReservation(capability);
    const finalSocketState = classifySocketEvidence(finalPreflight, record.socketIdentity);
    if (
      initialSocketState === "foreign" ||
      initialSocketState === "unauthenticated" ||
      finalSocketState === "foreign" ||
      finalSocketState === "unauthenticated"
    ) {
      return leak(
        foreignSocketLeak(
          finalSocketState === "absent" ? initialSocketState : finalSocketState,
          finalSocketState === "absent" ? preflight.socketIdentity : finalPreflight.socketIdentity,
          record.socketIdentity,
        ),
      );
    }
    await removeReservationFiles(capability, finalPreflight, record.socketIdentity);
    return { leaks: [], reservationsFound: 1, rootRemoved: false };
  } catch (error) {
    return leak(error);
  }
}

export async function reapFixture(capability: ReservationCapability): Promise<ReapReport> {
  return serializeReservationMutation(capability, () => reapReservation(capability));
}

function ownerEscrowPath(runRoot: string): string {
  return `${runRoot}.owner-escrow`;
}

function fixtureEscrowPath(runRoot: string, logicalSocketName: string, runId: string): string {
  return join(runRoot, `${fixtureEscrowPrefix}${logicalSocketName}.${runId}`);
}

function logicalSocketFromEscrow(name: string, runId: string): string | undefined {
  const suffix = `.${runId}`;
  if (!name.startsWith(fixtureEscrowPrefix) || !name.endsWith(suffix)) return undefined;
  const logicalSocketName = name.slice(fixtureEscrowPrefix.length, -suffix.length);
  return logicalSocketPattern.test(logicalSocketName) ? logicalSocketName : undefined;
}

async function restoreEscrowedOwner(runRoot: string): Promise<void> {
  const ownerPath = join(runRoot, OWNER_RECORD_NAME);
  try {
    await lstat(ownerPath);
    return;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  const escrow = ownerEscrowPath(runRoot);
  try {
    await assertOwnedDirectory(escrow, "owner escrow");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  const entries = await readdir(escrow);
  if (entries.length !== 1 || entries[0] !== OWNER_RECORD_NAME) {
    throw new Error(`owner escrow contains unexpected entries: ${entries.join(", ")}`);
  }
  const escrowOwner = join(escrow, OWNER_RECORD_NAME);
  parseOwnerRecord(await readOwnedRecord(escrowOwner, "escrowed owner record"));
  const escrowIdentity = entryIdentity(await lstat(escrowOwner));
  await link(escrowOwner, ownerPath);
  if (!sameEntry(entryIdentity(await lstat(ownerPath)), escrowIdentity)) {
    throw new Error("restored owner record does not match its escrow hardlink");
  }
}

async function reapDetachedOwnerEscrow(
  runRoot: string,
  authority: "owned" | "stale",
): Promise<ReapReport | undefined> {
  const escrow = ownerEscrowPath(runRoot);
  try {
    await assertOwnedDirectory(escrow, "owner escrow");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const entries = await readdir(escrow);
  if (entries.length === 0) {
    await rmdir(escrow);
    return { leaks: [], reservationsFound: 0, rootRemoved: true };
  }
  if (entries.length !== 1 || entries[0] !== OWNER_RECORD_NAME) {
    throw new Error(`owner escrow contains unexpected entries: ${entries.join(", ")}`);
  }
  const escrowOwner = join(escrow, OWNER_RECORD_NAME);
  const owner = parseOwnerRecord(await readOwnedRecord(escrowOwner, "escrowed owner record"));
  const observed = await readProcessIdentity(owner.owner.pid);
  const ownerIsLive = observed?.startIdentity === owner.owner.startIdentity;
  if (authority === "stale" && ownerIsLive) {
    throw new Error(`test run root has a live owner: ${String(owner.owner.pid)}`);
  }
  if (authority === "owned") {
    const current = await readProcessIdentity(process.pid);
    if (
      current === undefined ||
      owner.owner.pid !== current.pid ||
      owner.owner.startIdentity !== current.startIdentity
    ) {
      throw new Error("test run root is not owned by this supervisor");
    }
  }
  await unlink(escrowOwner);
  await rmdir(escrow);
  return { leaks: [], reservationsFound: 0, rootRemoved: true };
}

async function recoverOwnedOwnerEscrow(
  runRoot: string,
  ownerIdentity: EntryIdentity,
): Promise<void> {
  const escrow = ownerEscrowPath(runRoot);
  try {
    await assertOwnedDirectory(escrow, "owner escrow");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  const entries = await readdir(escrow);
  if (entries.length !== 0) {
    if (entries.length !== 1 || entries[0] !== OWNER_RECORD_NAME) {
      throw new Error(`owner escrow contains unexpected entries: ${entries.join(", ")}`);
    }
    const escrowOwner = join(escrow, OWNER_RECORD_NAME);
    parseOwnerRecord(await readOwnedRecord(escrowOwner, "escrowed owner record"));
    if (!sameEntry(entryIdentity(await lstat(escrowOwner)), ownerIdentity)) {
      throw new Error("canonical and escrow owner inodes conflict");
    }
    await unlink(escrowOwner);
  }
  await rmdir(escrow);
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function verifyJournaledRecord(
  path: string,
  journal: FixtureEscrowJournal,
  ownerController: ControllerIdentity,
): Promise<void> {
  const text = await readOwnedRecord(path, "journaled fixture record");
  if (
    !sameEntry(entryIdentity(await lstat(path)), journal.record) ||
    recordDigest(text) !== journal.recordDigest
  ) {
    throw new Error("journaled fixture record identity or digest changed");
  }
  const record = parseFixtureRecord(text);
  assertControllerMatchesOwner(record, ownerController);
  if (
    JSON.stringify(record) !== JSON.stringify(journal.recordSnapshot) ||
    record.runId !== journal.runId ||
    record.logicalSocketName !== journal.logicalSocketName ||
    record.socketPath !== journal.socketPath
  ) {
    throw new Error("journaled fixture record does not match its reservation");
  }
  if (record.phase === "launching")
    throw new Error("a launching fixture record cannot authorize journal recovery");
  if (record.phase === "reserved" && journal.socket !== undefined) {
    throw new Error("journaled socket authority does not match its fixture record");
  }
  if (
    record.phase === "running" &&
    journal.socket !== undefined &&
    (record.socketIdentity === undefined || !sameEntry(record.socketIdentity, journal.socket))
  ) {
    throw new Error("journaled socket authority does not match its fixture record");
  }
}

async function authenticateCompleteReservation(
  reservationPath: string,
  owner: OwnerRecord,
  logicalSocketName: string,
): Promise<void> {
  await assertOwnedDirectory(reservationPath, "fixture reservation");
  const record = await readFixtureRecord(reservationPath);
  assertControllerMatchesOwner(record, owner.controller);
  if (
    record.runId !== owner.runId ||
    record.logicalSocketName !== logicalSocketName ||
    record.socketPath !== join(reservationPath, "s")
  ) {
    throw new Error("fixture reservation does not authenticate its escrow");
  }
  const entries = await readdir(reservationPath, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        entry.isSymbolicLink() ||
        (entry.name !== FIXTURE_RECORD_NAME && entry.name !== "s") ||
        (entry.name === FIXTURE_RECORD_NAME && !entry.isFile()) ||
        (entry.name === "s" && !entry.isSocket()),
    ) ||
    !entries.some(({ name }) => name === FIXTURE_RECORD_NAME)
  ) {
    throw new Error(
      `fixture reservation contains unexpected entries: ${entries.map(({ name }) => name).join(", ")}`,
    );
  }
}

async function recoverFixtureEscrows(runRoot: string, owner: OwnerRecord): Promise<string[]> {
  const leaks: string[] = [];
  const entries = await readdir(runRoot, { withFileTypes: true });
  for (const entry of entries) {
    const logicalSocketName = logicalSocketFromEscrow(entry.name, owner.runId);
    if (logicalSocketName === undefined) continue;
    const escrow = join(runRoot, entry.name);
    try {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`fixture escrow must be a directory: ${entry.name}`);
      }
      // eslint-disable-next-line no-await-in-loop -- every escrow is authenticated and recovered before root enumeration.
      await assertOwnedDirectory(escrow, "fixture escrow");
      // eslint-disable-next-line no-await-in-loop -- exact journal contents determine the crash boundary.
      const escrowEntries = await readdir(escrow, { withFileTypes: true });
      if (escrowEntries.length === 0) {
        const reservationPath = join(runRoot, logicalSocketName);
        // eslint-disable-next-line no-await-in-loop -- an existing reservation authenticates a pre-journal crash.
        const reservation = await lstatIfPresent(reservationPath);
        if (reservation !== undefined) {
          // eslint-disable-next-line no-await-in-loop -- the pre-journal reservation is recovered serially.
          await authenticateCompleteReservation(reservationPath, owner, logicalSocketName);
        }
        // eslint-disable-next-line no-await-in-loop -- rmdir refuses content added after authentication.
        await rmdir(escrow);
        continue;
      }
      const journalEntry = escrowEntries.find(({ name }) => name === "journal.json");
      if (journalEntry === undefined) {
        const temporaryEntry = escrowEntries.find(({ name }) => name === ".journal.tmp");
        if (
          temporaryEntry === undefined ||
          escrowEntries.length !== 1 ||
          temporaryEntry.isSymbolicLink() ||
          !temporaryEntry.isFile()
        ) {
          throw new Error("fixture escrow journal is missing");
        }
        const reservationPath = join(runRoot, logicalSocketName);
        // eslint-disable-next-line no-await-in-loop -- the partial journal belongs to this one authenticated reservation.
        await authenticateCompleteReservation(reservationPath, owner, logicalSocketName);
        const temporary = join(escrow, ".journal.tmp");
        // eslint-disable-next-line no-await-in-loop -- temporary metadata is authenticated before exact removal.
        await readOwnedRecord(temporary, "fixture escrow journal temporary");
        // eslint-disable-next-line no-await-in-loop -- the exact recognized temporary is removed serially.
        await unlink(temporary);
        // eslint-disable-next-line no-await-in-loop -- rmdir refuses late journal entries.
        await rmdir(escrow);
        continue;
      }
      if (
        journalEntry.isSymbolicLink() ||
        !journalEntry.isFile() ||
        escrowEntries.some(({ name }) => name !== "journal.json" && name !== "reservation")
      ) {
        throw new Error(
          `fixture escrow contains unexpected entries: ${escrowEntries.map(({ name }) => name).join(", ")}`,
        );
      }
      const journalPath = join(escrow, "journal.json");
      // eslint-disable-next-line no-await-in-loop -- journal bytes and inode are rechecked before deletion.
      const journalText = await readOwnedRecord(journalPath, "fixture escrow journal");
      const journal = parseFixtureEscrowJournal(journalText, owner.controller);
      // eslint-disable-next-line no-await-in-loop -- journal inode identity is captured before recovery mutation.
      const journalIdentity = entryIdentity(await lstat(journalPath));
      const reservationPath = join(runRoot, logicalSocketName);
      const movedReservation = join(escrow, "reservation");
      if (
        journal.runId !== owner.runId ||
        journal.logicalSocketName !== logicalSocketName ||
        journal.reservationPath !== reservationPath ||
        journal.recordPath !== join(reservationPath, FIXTURE_RECORD_NAME) ||
        journal.socketPath !== join(reservationPath, "s")
      ) {
        throw new Error("fixture escrow journal does not match its exact reservation");
      }
      // eslint-disable-next-line no-await-in-loop -- both locations are compared before any recovery mutation.
      const [reservation, moved] = await Promise.all([
        lstatIfPresent(reservationPath),
        lstatIfPresent(movedReservation),
      ]);
      if (reservation !== undefined && moved !== undefined) {
        throw new Error("fixture escrow has both original and moved reservations");
      }
      if (reservation !== undefined) {
        if (!sameEntry(entryIdentity(reservation), journal.reservation)) {
          throw new Error("fixture reservation identity changed before escrow recovery");
        }
        // eslint-disable-next-line no-await-in-loop -- an uncommitted reservation must retain all journaled evidence.
        const reservationEntries = (await readdir(reservationPath)).sort();
        const expectedEntries = [
          FIXTURE_RECORD_NAME,
          ...(journal.socket === undefined ? [] : ["s"]),
        ].sort();
        if (JSON.stringify(reservationEntries) !== JSON.stringify(expectedEntries)) {
          throw new Error(
            `fixture reservation contains unexpected entries: ${reservationEntries.join(", ")}`,
          );
        }
        // eslint-disable-next-line no-await-in-loop -- the uncommitted record is authenticated serially.
        await verifyJournaledRecord(journal.recordPath, journal, owner.controller);
        if (
          journal.socket !== undefined &&
          // eslint-disable-next-line no-await-in-loop -- the uncommitted socket is authenticated serially.
          !sameEntry(entryIdentity(await lstat(journal.socketPath)), journal.socket)
        ) {
          throw new Error("journaled fixture socket identity changed");
        }
      } else if (moved !== undefined) {
        if (!sameEntry(entryIdentity(moved), journal.reservation)) {
          throw new Error("moved fixture reservation identity changed");
        }
        // eslint-disable-next-line no-await-in-loop -- the committed reservation is recovered serially.
        const movedEntries = (await readdir(movedReservation)).sort();
        if (
          movedEntries.some((name) => name !== FIXTURE_RECORD_NAME && name !== "s") ||
          (journal.socket === undefined && movedEntries.includes("s"))
        ) {
          throw new Error(
            `moved fixture reservation contains unexpected entries: ${movedEntries.join(", ")}`,
          );
        }
        if (movedEntries.length === 1 && movedEntries[0] === "s") {
          throw new Error("fixture escrow has an impossible committed socket-only state");
        }
        const movedRecord = join(movedReservation, FIXTURE_RECORD_NAME);
        if (movedEntries.includes(FIXTURE_RECORD_NAME)) {
          // eslint-disable-next-line no-await-in-loop -- record authority is required before any committed socket mutation.
          await verifyJournaledRecord(movedRecord, journal, owner.controller);
        }
        const movedSocket = join(movedReservation, "s");
        if (movedEntries.includes("s")) {
          if (
            journal.socket === undefined ||
            // eslint-disable-next-line no-await-in-loop -- the committed socket is checked immediately before deletion.
            !sameEntry(entryIdentity(await lstat(movedSocket)), journal.socket)
          ) {
            throw new Error("journaled moved socket identity changed");
          }
          // eslint-disable-next-line no-await-in-loop -- only the verified committed socket is removed.
          await unlink(movedSocket);
        }
        if (movedEntries.includes(FIXTURE_RECORD_NAME)) {
          // eslint-disable-next-line no-await-in-loop -- the committed record is rechecked immediately before deletion.
          await verifyJournaledRecord(movedRecord, journal, owner.controller);
          // eslint-disable-next-line no-await-in-loop -- only the verified committed record is removed.
          await unlink(movedRecord);
        }
        // eslint-disable-next-line no-await-in-loop -- rmdir refuses any late committed-reservation entry.
        await rmdir(movedReservation);
      }
      // eslint-disable-next-line no-await-in-loop -- journal bytes are rechecked after reservation recovery.
      const currentJournalText = await readOwnedRecord(journalPath, "fixture escrow journal");
      if (
        currentJournalText !== journalText ||
        // eslint-disable-next-line no-await-in-loop -- the journal inode is rechecked immediately before deletion.
        !sameEntry(entryIdentity(await lstat(journalPath)), journalIdentity)
      ) {
        throw new Error("fixture escrow journal changed during recovery");
      }
      // eslint-disable-next-line no-await-in-loop -- journal removal is the final serialized recovery mutation.
      await unlink(journalPath);
      // eslint-disable-next-line no-await-in-loop -- rmdir refuses any late escrow entry.
      await rmdir(escrow);
    } catch (error) {
      leaks.push(String(error));
    }
  }
  return leaks;
}

async function recoverUnpublishedReservations(runRoot: string): Promise<string[]> {
  const leaks: string[] = [];
  const entries = await readdir(runRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !generatedLogicalSocketPattern.test(entry.name)) continue;
    const reservationPath = join(runRoot, entry.name);
    try {
      // eslint-disable-next-line no-await-in-loop -- each unpublished reservation is an independent trust boundary.
      await assertOwnedDirectory(reservationPath, "unpublished fixture reservation");
      // eslint-disable-next-line no-await-in-loop -- only empty or one recognized temp entry proves launch never began.
      const reservationEntries = await readdir(reservationPath, { withFileTypes: true });
      if (reservationEntries.length === 0) {
        // eslint-disable-next-line no-await-in-loop -- rmdir refuses any late registration entry.
        await rmdir(reservationPath);
        continue;
      }
      const temporary = reservationEntries[0];
      if (
        reservationEntries.length !== 1 ||
        temporary === undefined ||
        temporary.name !== fixtureRecordTemporaryName ||
        temporary.isSymbolicLink() ||
        !temporary.isFile()
      ) {
        continue;
      }
      const temporaryPath = join(reservationPath, fixtureRecordTemporaryName);
      // eslint-disable-next-line no-await-in-loop -- metadata authentication precedes removal of the unpublished temp.
      await readOwnedRecord(temporaryPath, "unpublished fixture record temporary");
      // eslint-disable-next-line no-await-in-loop -- launch cannot precede the absent canonical registration record.
      await unlink(temporaryPath);
      // eslint-disable-next-line no-await-in-loop -- rmdir refuses any entry added after temp removal.
      await rmdir(reservationPath);
    } catch (error) {
      leaks.push(String(error));
    }
  }
  return leaks;
}

async function reapRunRootInternal(
  runRoot: string,
  authority: "owned" | "stale",
): Promise<ReapReport> {
  const reaperEnvironment = snapshotEnvironment(process.env);
  await assertSafeAbsoluteRoot(runRoot);
  try {
    await assertOwnedDirectory(runRoot, "test run root");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return (
        (await reapDetachedOwnerEscrow(runRoot, authority)) ?? {
          leaks: [],
          reservationsFound: 0,
          rootRemoved: true,
        }
      );
    }
    throw error;
  }
  await restoreEscrowedOwner(runRoot);
  const ownerPath = join(runRoot, OWNER_RECORD_NAME);
  const ownerText = await readOwnedRecord(ownerPath, "test run owner record");
  const owner = parseOwnerRecord(ownerText);
  const ownerIdentity = entryIdentity(await lstat(ownerPath));
  const rootIdentity = entryIdentity(await lstat(runRoot));
  const observedOwner = await readProcessIdentity(owner.owner.pid);
  const ownerIsLive = observedOwner?.startIdentity === owner.owner.startIdentity;
  if (authority === "stale" && ownerIsLive) {
    throw new Error(`test run root has a live owner: ${String(owner.owner.pid)}`);
  }
  if (authority === "owned") {
    const current = await readProcessIdentity(process.pid);
    if (
      current === undefined ||
      owner.owner.pid !== current.pid ||
      owner.owner.startIdentity !== current.startIdentity
    ) {
      throw new Error("test run root is not owned by this supervisor");
    }
  }

  await recoverOwnedOwnerEscrow(runRoot, ownerIdentity);

  const leaks = await recoverFixtureEscrows(runRoot, owner);
  leaks.push(...(await recoverUnpublishedReservations(runRoot)));
  let reservationsFound = 0;
  const entries = await readdir(runRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === OWNER_RECORD_NAME) continue;
    if (entry.isSymbolicLink()) {
      leaks.push(`reservation symlink refused: ${entry.name}`);
      continue;
    }
    if (!entry.isDirectory()) {
      leaks.push(`unexpected run-root entry: ${entry.name}`);
      continue;
    }
  }
  if (leaks.length > 0) return { leaks, reservationsFound, rootRemoved: false };

  for (const entry of entries) {
    if (entry.name === OWNER_RECORD_NAME) continue;
    const entryPath = join(runRoot, entry.name);
    // eslint-disable-next-line no-await-in-loop -- each record is authenticated before any cleanup starts.
    const record = await readFixtureRecord(entryPath).catch((error: unknown) => {
      leaks.push(String(error));
      return undefined;
    });
    if (record === undefined) continue;
    const capability = restoreReservationCapability(
      {
        recordPath: join(entryPath, FIXTURE_RECORD_NAME),
        reservationPath: entryPath,
        runId: owner.runId,
        runRoot,
      },
      reaperEnvironment,
    );
    // eslint-disable-next-line no-await-in-loop -- exact-root cleanup stays serial to preserve deterministic diagnostics.
    const report = await serializeReservationMutation(capability, () =>
      reapReservation(capability),
    );
    reservationsFound += report.reservationsFound;
    leaks.push(...report.leaks);
  }

  if (leaks.length > 0) return { leaks, reservationsFound, rootRemoved: false };

  const finalEntries = await readdir(runRoot);
  if (finalEntries.length !== 1 || finalEntries[0] !== OWNER_RECORD_NAME) {
    return {
      leaks: [`run root contains late entries: ${finalEntries.join(", ")}`],
      reservationsFound,
      rootRemoved: false,
    };
  }
  if (
    !sameEntry(entryIdentity(await lstat(runRoot)), rootIdentity) ||
    !sameEntry(entryIdentity(await lstat(ownerPath)), ownerIdentity)
  ) {
    return {
      leaks: ["run root or owner record changed during cleanup"],
      reservationsFound,
      rootRemoved: false,
    };
  }
  const ownerEscrow = ownerEscrowPath(runRoot);
  const escrowOwner = join(ownerEscrow, OWNER_RECORD_NAME);
  await mkdir(ownerEscrow, { mode: 0o700 });
  await chmod(ownerEscrow, 0o700);
  await link(ownerPath, escrowOwner);
  if (!sameEntry(entryIdentity(await lstat(escrowOwner)), ownerIdentity)) {
    throw new Error("owner record changed while being hard-linked into escrow");
  }
  await unlink(ownerPath);
  try {
    await rmdir(runRoot);
  } catch (error) {
    await link(escrowOwner, ownerPath);
    if (!sameEntry(entryIdentity(await lstat(ownerPath)), ownerIdentity)) {
      throw new Error("restored owner record does not match its escrow hardlink", { cause: error });
    }
    await unlink(escrowOwner);
    await rmdir(ownerEscrow);
    return {
      leaks: [`run root finalization failed: ${String(error)}`],
      reservationsFound,
      rootRemoved: false,
    };
  }
  await unlink(escrowOwner);
  await rmdir(ownerEscrow);
  return { leaks, reservationsFound, rootRemoved: true };
}

export async function reapOwnedRunRoot(runRoot: string): Promise<ReapReport> {
  return reapRunRootInternal(runRoot, "owned");
}

export async function reapStaleRunRoot(runRoot: string): Promise<ReapReport> {
  return reapRunRootInternal(runRoot, "stale");
}

/** Whether a directory carries the record that makes it a run root. */
async function isRunRoot(directory: string): Promise<boolean> {
  try {
    return (await lstat(join(directory, OWNER_RECORD_NAME))).isFile();
  } catch {
    return false;
  }
}

/**
 * The run roots inside one owned temporary directory.
 *
 * Harnesses place a root either at the directory a run made or one level in,
 * under a name of the harness's choosing, so both depths are examined and the
 * owner record is what identifies one.
 */
async function runRootsIn(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  if (await isRunRoot(directory)) found.push(directory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    // eslint-disable-next-line no-await-in-loop -- a bounded probe per entry.
    if (await isRunRoot(child)) found.push(child);
  }
  return found;
}

/**
 * Reap every run root whose owner died without cleaning up after itself.
 *
 * A harness reaps its own root in a `finally`, which `SIGKILL` skips: the tmux
 * daemon then outlives the run with nothing left that knows to collect it. Two
 * were found still serving hours after the processes that started them had
 * gone, because a root is created under a fresh `mkdtemp` name and no later run
 * ever looks at the previous one.
 *
 * Liveness decides, never age. `reapStaleRunRoot` refuses a root whose recorded
 * pid and start identity still match a running process, so a root a concurrent
 * run holds is left alone; anything else it refuses is left for its owner or a
 * later sweep rather than forced.
 */
export async function sweepStaleRunRoots(): Promise<readonly string[]> {
  const reaped: string[] = [];
  for (const directory of await ownedTestDirectories()) {
    let collected = false;
    // eslint-disable-next-line no-await-in-loop -- one owned directory at a time.
    for (const runRoot of await runRootsIn(directory)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- reaping is sequential by design.
        if ((await reapStaleRunRoot(runRoot)).rootRemoved) {
          reaped.push(runRoot);
          collected = true;
        }
      } catch {
        continue;
      }
    }
    // Only the directory a reaped root was in. A run creates its directory
    // before the root inside it, so removing every empty one would delete the
    // directory a concurrent run had just made and was about to fill.
    // eslint-disable-next-line no-await-in-loop -- the husk goes with its root.
    if (collected) await rmdir(directory).catch(() => undefined);
  }
  return reaped;
}
