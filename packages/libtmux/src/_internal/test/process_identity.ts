import { execFile, spawnSync } from "node:child_process";
import { constants as fsConstants, readFileSync, realpathSync } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, delimiter } from "node:path";
import { isAbsolute, join, resolve } from "node:path";

export interface ProcessIdentity {
  readonly pid: number;
  readonly startIdentity: string;
}

interface ControllerFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly kind: "file";
  readonly mode: string;
  readonly uid: string;
}

export interface ControllerIdentity {
  readonly executablePath: string;
  readonly fileIdentity: ControllerFileIdentity;
}

export interface DaemonIdentity extends ProcessIdentity {
  readonly comm: string;
  readonly executablePath: string;
}

/**
 * `linux:<boot id>:<clock ticks since boot>` or `darwin:<boot seconds>:<start seconds>`.
 *
 * Darwin has no `/proc`. `ps` answers a start time to the second, which is
 * what separates a process from a later one that reused its PID; the boot time
 * separates one from a process of the same PID before a restart.
 */
const identityPattern =
  /^(?:linux:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|darwin:[0-9]+):[0-9]+$/u;

/** The name a tmux server reports as its command, on every platform. */
const SERVER_COMM = "tmux: server";

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/**
 * Whether a `/proc` probe means "no process of ours here".
 *
 * A PID that is gone reads as ENOENT or ESRCH. A PID that has been recycled to
 * another user's process reads as EACCES or EPERM instead, which is the same
 * answer for this purpose — the fixture's own daemon runs as this user, so a
 * process it cannot inspect is definitively not that daemon. Treating it as a
 * fault instead fails cleanup on a machine that is merely busy enough to recycle
 * PIDs into someone else's work.
 */
function isAbsentProcess(error: unknown): boolean {
  return (
    isErrno(error, "ENOENT") ||
    isErrno(error, "ESRCH") ||
    isErrno(error, "EACCES") ||
    isErrno(error, "EPERM")
  );
}

function assertControllerFileIdentity(value: unknown): ControllerFileIdentity {
  if (typeof value !== "object" || value === null) {
    throw new Error("tmux controller file identity is missing");
  }
  const candidate = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(["device", "inode", "kind", "mode", "uid"]) ||
    candidate.kind !== "file" ||
    [candidate.device, candidate.inode, candidate.mode, candidate.uid].some(
      (part) => typeof part !== "string" || !/^\d+$/u.test(part),
    )
  ) {
    throw new Error("tmux controller file identity is corrupt");
  }
  return candidate as unknown as ControllerFileIdentity;
}

export function assertControllerIdentity(value: unknown): ControllerIdentity {
  if (typeof value !== "object" || value === null) {
    throw new Error("tmux controller identity is missing");
  }
  const candidate = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(["executablePath", "fileIdentity"]) ||
    typeof candidate.executablePath !== "string" ||
    !isAbsolute(candidate.executablePath)
  ) {
    throw new Error("tmux controller identity is corrupt");
  }
  return {
    executablePath: candidate.executablePath,
    fileIdentity: assertControllerFileIdentity(candidate.fileIdentity),
  };
}

export function assertIdentity(value: unknown, label: string): ProcessIdentity {
  if (typeof value !== "object" || value === null) throw new Error(`${label} is missing`);
  const candidate = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(["pid", "startIdentity"])) {
    throw new Error(`${label} is corrupt`);
  }
  if (
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) < 1 ||
    typeof candidate.startIdentity !== "string" ||
    !identityPattern.test(candidate.startIdentity)
  ) {
    throw new Error(`${label} is corrupt`);
  }
  return { pid: candidate.pid as number, startIdentity: candidate.startIdentity };
}

function controllerFileIdentity(
  metadata: Awaited<ReturnType<typeof lstat>>,
): ControllerFileIdentity {
  if (!metadata.isFile()) throw new Error("tmux controller must be a regular file");
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    kind: "file",
    mode: String(metadata.mode),
    uid: String(metadata.uid),
  };
}

export function sameControllerIdentity(
  left: ControllerIdentity,
  right: ControllerIdentity,
): boolean {
  return (
    left.executablePath === right.executablePath &&
    left.fileIdentity.device === right.fileIdentity.device &&
    left.fileIdentity.inode === right.fileIdentity.inode &&
    left.fileIdentity.kind === right.fileIdentity.kind &&
    left.fileIdentity.mode === right.fileIdentity.mode &&
    left.fileIdentity.uid === right.fileIdentity.uid
  );
}

export async function resolveControllerIdentity(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ControllerIdentity> {
  if (executable === "" || executable.includes("\0")) {
    throw new Error("tmux controller executable is invalid");
  }
  let candidate: string | undefined;
  if (executable.includes("/")) {
    candidate = resolve(executable);
  } else {
    const pathValue = environment.PATH ?? "";
    for (const directory of pathValue.split(delimiter)) {
      if (directory === "") continue;
      const possible = join(directory, executable);
      try {
        // eslint-disable-next-line no-await-in-loop -- PATH order is part of executable resolution.
        await access(possible, fsConstants.X_OK);
        candidate = possible;
        break;
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "EACCES")) throw error;
      }
    }
  }
  if (candidate === undefined)
    throw new Error(`tmux controller executable not found: ${executable}`);
  const executablePath = await realpath(candidate);
  await access(executablePath, fsConstants.X_OK);
  const metadata = await lstat(executablePath);
  if (metadata.isSymbolicLink()) throw new Error("resolved tmux controller must not be a symlink");
  return { executablePath, fileIdentity: controllerFileIdentity(metadata) };
}

export async function assertControllerCurrent(controller: ControllerIdentity): Promise<void> {
  const executablePath = await realpath(controller.executablePath).catch((error: unknown) => {
    throw new Error("tmux controller path is missing or replaced", { cause: error });
  });
  const observed: ControllerIdentity = {
    executablePath,
    fileIdentity: controllerFileIdentity(await lstat(executablePath)),
  };
  if (!sameControllerIdentity(observed, controller)) {
    throw new Error("tmux controller identity changed");
  }
}

export function assertDaemonIdentity(value: unknown): DaemonIdentity {
  if (typeof value !== "object" || value === null) throw new Error("daemon identity is missing");
  const candidate = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(candidate).sort()) !==
    JSON.stringify(["comm", "executablePath", "pid", "startIdentity"])
  ) {
    throw new Error("daemon identity is corrupt");
  }
  const identity = assertIdentity(
    { pid: candidate.pid, startIdentity: candidate.startIdentity },
    "daemon identity",
  );
  if (
    typeof candidate.comm !== "string" ||
    candidate.comm !== SERVER_COMM ||
    typeof candidate.executablePath !== "string" ||
    !isAbsolute(candidate.executablePath)
  ) {
    throw new Error("daemon identity is corrupt");
  }
  return { ...identity, comm: candidate.comm, executablePath: candidate.executablePath };
}

export function parseProcStatStartTime(line: string): string {
  const closing = line.lastIndexOf(") ");
  if (closing < 0) throw new Error("invalid /proc stat framing");
  const fields = line
    .slice(closing + 2)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new Error("invalid /proc start time");
  }
  return startTime;
}

interface PsResult {
  readonly code: number | null;
  readonly stdout: string;
}

function capture(command: string, args: readonly string[]): Promise<PsResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 30_000 },
      (error, stdout) => {
        if (error === null) return resolveResult({ code: 0, stdout });
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        // `ps -p` exits 1 with no output for a PID that does not exist.
        if (typeof code === "number") return resolveResult({ code, stdout });
        reject(error);
      },
    );
  });
}

let darwinBootSeconds: Promise<string> | undefined;

function readDarwinBootSeconds(): Promise<string> {
  darwinBootSeconds ??= capture("sysctl", ["-n", "kern.boottime"]).then((result) => {
    const seconds = /\bsec = (\d+)/u.exec(result.stdout)?.[1];
    if (result.code !== 0 || seconds === undefined) {
      throw new Error(`cannot read kern.boottime: ${result.stdout.trim()}`);
    }
    return seconds;
  });
  return darwinBootSeconds;
}

/** `ps -o lstart=` prints `Sat Oct  4 12:00:00 2026`; read in UTC, so no zone shifts it. */
export function parsePsStartSeconds(text: string): string {
  const milliseconds = Date.parse(`${text.trim().replace(/\s+/gu, " ")} UTC`);
  if (!Number.isFinite(milliseconds)) throw new Error(`invalid ps start time: ${text.trim()}`);
  return String(Math.floor(milliseconds / 1000));
}

async function readDarwinProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  const [boot, started] = await Promise.all([
    readDarwinBootSeconds(),
    capture("ps", ["-o", "lstart=", "-p", String(pid)]),
  ]);
  if (started.code !== 0 || started.stdout.trim() === "") return undefined;
  return { pid, startIdentity: `darwin:${boot}:${parsePsStartSeconds(started.stdout)}` };
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("pid must be a positive integer");
  if (process.platform === "darwin") return readDarwinProcessIdentity(pid);
  try {
    const [bootId, statText] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${String(pid)}/stat`, "utf8"),
    ]);
    return {
      pid,
      startIdentity: `linux:${bootId.trim()}:${parseProcStatStartTime(statText)}`,
    };
  } catch (error) {
    if (isAbsentProcess(error)) return undefined;
    throw error;
  }
}

/**
 * What a process was started with, in the framing `/proc` uses: every argument
 * and every environment entry ends in a NUL.
 */
export interface ProcessLaunch {
  readonly commandLine: Buffer;
  readonly environment: Buffer;
  readonly executablePath: string;
}

/**
 * Not `LIBTMUX_TEST_PYTHON`: that names the interpreter a test hands the Linux
 * pidfd helper, and the suite points it at helpers that hang on purpose.
 */
const PROCARGS_PYTHON = "python3";

const PROCARGS_SCRIPT = [
  "import ctypes, sys",
  "libc = ctypes.CDLL(None, use_errno=True)",
  "mib = (ctypes.c_int * 3)(1, 49, int(sys.argv[1]))",
  "size = ctypes.c_size_t(0)",
  "if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0: sys.exit(2)",
  "buf = ctypes.create_string_buffer(size.value)",
  "if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0: sys.exit(2)",
  "sys.stdout.write(buf.raw[:size.value].hex())",
].join("\n");

/**
 * Split a `KERN_PROCARGS2` buffer: a native-endian argc, the executable path,
 * NUL padding, then argc arguments and the environment, each NUL-terminated.
 */
export function parseProcArgs2(raw: Buffer): ProcessLaunch {
  if (raw.length < 4) throw new Error("KERN_PROCARGS2 answer is truncated");
  const argc = raw.readInt32LE(0);
  let offset = 4;
  const strings = (limit: number): Buffer[] => {
    const found: Buffer[] = [];
    while (offset < raw.length && found.length < limit) {
      const end = raw.indexOf(0, offset);
      if (end < 0) break;
      found.push(raw.subarray(offset, end));
      offset = end + 1;
    }
    return found;
  };
  const executable = strings(1)[0];
  if (executable === undefined) throw new Error("KERN_PROCARGS2 answer has no executable path");
  while (offset < raw.length && raw[offset] === 0) offset += 1;
  const argv = strings(argc);
  if (argv.length !== argc) throw new Error("KERN_PROCARGS2 answer is truncated");
  const environment: Buffer[] = [];
  for (;;) {
    const [entry] = strings(1);
    if (entry === undefined || entry.length === 0) break;
    environment.push(entry);
  }
  const frame = (parts: readonly Buffer[]): Buffer =>
    Buffer.concat(parts.flatMap((part) => [part, Buffer.from([0])]));
  return {
    commandLine: frame(argv),
    environment: frame(environment),
    executablePath: executable.toString("utf8"),
  };
}

async function readDarwinProcessLaunch(pid: number): Promise<ProcessLaunch | undefined> {
  const result = await capture(PROCARGS_PYTHON, ["-I", "-c", PROCARGS_SCRIPT, String(pid)]);
  if (result.code !== 0) return undefined;
  return parseProcArgs2(Buffer.from(result.stdout.trim(), "hex"));
}

/**
 * Synchronous {@link readProcessLaunch}, for the one caller that must observe a
 * process inside a callback its launcher does not await.
 */
export function readProcessLaunchSync(pid: number): ProcessLaunch | undefined {
  if (process.platform === "darwin") {
    const result = spawnSync(PROCARGS_PYTHON, ["-I", "-c", PROCARGS_SCRIPT, String(pid)], {
      encoding: "utf8",
    });
    if (result.status !== 0) return undefined;
    return parseProcArgs2(Buffer.from(result.stdout.trim(), "hex"));
  }
  try {
    return {
      commandLine: readFileSync(`/proc/${String(pid)}/cmdline`),
      environment: readFileSync(`/proc/${String(pid)}/environ`),
      executablePath: realpathSync(`/proc/${String(pid)}/exe`),
    };
  } catch (error) {
    if (isAbsentProcess(error)) return undefined;
    throw error;
  }
}

/** The command line, environment and executable a live process was started with. */
export async function readProcessLaunch(pid: number): Promise<ProcessLaunch | undefined> {
  if (process.platform === "darwin") return readDarwinProcessLaunch(pid);
  try {
    const [commandLine, environment, executablePath] = await Promise.all([
      readFile(`/proc/${String(pid)}/cmdline`),
      readFile(`/proc/${String(pid)}/environ`),
      realpath(`/proc/${String(pid)}/exe`),
    ]);
    return { commandLine, environment, executablePath };
  } catch (error) {
    if (isAbsentProcess(error)) return undefined;
    throw error;
  }
}

/** The parent of a live process, or `undefined` once it is gone. */
export async function readParentPid(pid: number): Promise<number | undefined> {
  if (process.platform === "darwin") {
    const result = await capture("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parent = Number(result.stdout.trim());
    return result.code === 0 && Number.isSafeInteger(parent) ? parent : undefined;
  }
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch (error) {
    if (isAbsentProcess(error)) return undefined;
    throw error;
  }
}

/**
 * The command name a process reports, where a tmux server says `tmux: server`.
 *
 * Unlike {@link readDaemonIdentity} this still answers for a daemon whose
 * executable was replaced on disk, which is what a test of that replacement
 * needs. Darwin has no such name, so a process running `tmux` reports it.
 */
export async function readProcessComm(pid: number): Promise<string | undefined> {
  if (process.platform === "darwin") {
    const launch = await readProcessLaunch(pid);
    if (launch === undefined) return undefined;
    const name = basename(launch.executablePath);
    return name === "tmux" ? SERVER_COMM : name;
  }
  try {
    return (await readFile(`/proc/${String(pid)}/comm`, "utf8")).trim();
  } catch (error) {
    if (isAbsentProcess(error)) return undefined;
    throw error;
  }
}

export async function readDaemonIdentity(pid: number): Promise<DaemonIdentity | undefined> {
  const identity = await readProcessIdentity(pid);
  if (identity === undefined) return undefined;
  if (process.platform === "darwin") {
    const launch = await readProcessLaunch(pid);
    if (launch === undefined) return undefined;
    const executablePath = await realpath(launch.executablePath).catch(() => undefined);
    if (executablePath === undefined || basename(executablePath) !== "tmux") return undefined;
    return { ...identity, comm: SERVER_COMM, executablePath };
  }
  try {
    const [comm, executablePath] = await Promise.all([
      readFile(`/proc/${String(pid)}/comm`, "utf8"),
      realpath(`/proc/${String(pid)}/exe`),
    ]);
    if (comm.trim() !== SERVER_COMM) return undefined;
    return { ...identity, comm: comm.trim(), executablePath };
  } catch (error) {
    if (isAbsentProcess(error)) return undefined;
    throw error;
  }
}

export function sameDaemonIdentity(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.startIdentity === right.startIdentity &&
    left.comm === right.comm &&
    left.executablePath === right.executablePath
  );
}
