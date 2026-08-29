import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { delimiter } from "node:path";
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

const identityPattern =
  /^linux:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9]+$/u;

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
    candidate.comm !== "tmux: server" ||
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

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("pid must be a positive integer");
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

export async function readDaemonIdentity(pid: number): Promise<DaemonIdentity | undefined> {
  const identity = await readProcessIdentity(pid);
  if (identity === undefined) return undefined;
  try {
    const [comm, executablePath] = await Promise.all([
      readFile(`/proc/${String(pid)}/comm`, "utf8"),
      realpath(`/proc/${String(pid)}/exe`),
    ]);
    if (comm.trim() !== "tmux: server") return undefined;
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
