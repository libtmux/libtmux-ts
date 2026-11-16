import { Buffer } from "node:buffer";

/** Linux `poll` event bits. */
export const POLLIN = 1;
export const POLLERR = 8;
export const POLLNVAL = 32;

/** What the daemon looked like when its record was written. */
export interface PidfdTarget {
  readonly argv: readonly string[];
  readonly comm: string;
  readonly executable: string;
  readonly generationName: string;
  readonly generationValue: string;
  readonly pid: number;
  readonly startIdentity: string;
}

/**
 * The system calls the reaper needs. `scripts/pidfd_reap/pidfd_reap.ts` supplies them
 * through `bun:ffi`, which Node lacks; a unit test supplies fakes.
 *
 * Methods that fail throw an error carrying a `code` such as `ENOENT` or
 * `ESRCH`.
 */
export interface PidfdOps {
  close(descriptor: number): void;
  open(pid: number): number;
  /** Events reported for the descriptor, empty once the timeout passes. */
  poll(descriptor: number, timeoutMs: number): readonly { descriptor: number; events: number }[];
  readFile(path: string): Uint8Array;
  realpath(path: string): string;
  sendSignal(descriptor: number, signal: "SIGKILL" | "SIGTERM"): void;
}

interface PidfdReport {
  readonly error?: string;
  readonly escalated?: boolean;
  readonly status: "gone" | "identity-mismatch" | "reaped" | "still-live" | "unavailable";
}

export interface PidfdResult {
  readonly exitCode: number;
  readonly report: PidfdReport;
}

const GONE: PidfdResult = { exitCode: 0, report: { status: "gone" } };

function text(ops: PidfdOps, path: string): string {
  return Buffer.from(ops.readFile(path)).toString("utf8");
}

function statFields(ops: PidfdOps, pid: number): string[] {
  const stat = text(ops, `/proc/${String(pid)}/stat`);
  return stat
    .slice(stat.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/u);
}

function startIdentity(ops: PidfdOps, pid: number): string {
  const boot = text(ops, "/proc/sys/kernel/random/boot_id").trim();
  return `linux:${boot}:${statFields(ops, pid)[19] ?? ""}`;
}

/** NUL-terminated, non-empty UTF-8 frames, or `undefined` for anything else. */
function nulFrames(bytes: Uint8Array): string[] | undefined {
  if (bytes.length === 0 || bytes.at(-1) !== 0) return undefined;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const frames = decoded.split("\0");
  frames.pop();
  return frames.some((frame) => frame === "") ? undefined : frames;
}

function matchesTarget(ops: PidfdOps, target: PidfdTarget): boolean {
  const { pid } = target;
  const root = `/proc/${String(pid)}`;
  if (
    startIdentity(ops, pid) !== target.startIdentity ||
    text(ops, `${root}/comm`).trim() !== target.comm ||
    ops.realpath(`${root}/exe`) !== target.executable
  ) {
    return false;
  }
  const argv = nulFrames(ops.readFile(`${root}/cmdline`));
  if (argv === undefined || JSON.stringify(argv) !== JSON.stringify(target.argv)) return false;
  const environment = Buffer.from(ops.readFile(`${root}/environ`));
  if (environment.length === 0 || environment.at(-1) !== 0) return false;
  const entries: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < environment.length; index += 1) {
    if (environment[index] !== 0) continue;
    if (index === start) return false;
    entries.push(environment.subarray(start, index));
    start = index + 1;
  }
  const prefix = Buffer.from(`${target.generationName}=`);
  const owned = entries.filter((entry) => entry.subarray(0, prefix.length).equals(prefix));
  return (
    owned.length === 1 &&
    owned[0]?.equals(Buffer.from(`${target.generationName}=${target.generationValue}`)) === true
  );
}

/**
 * An exited, unreaped daemon keeps its stat line, start time included, while its
 * exe, cmdline and environ go: that is the daemon gone, not another one.
 */
function refuse(ops: PidfdOps, target: PidfdTarget): PidfdResult {
  const state = statFields(ops, target.pid)[0];
  if ((state === "Z" || state === "X") && startIdentity(ops, target.pid) === target.startIdentity) {
    return GONE;
  }
  return { exitCode: 3, report: { status: "identity-mismatch" } };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Sends TERM, then KILL if it lingers, to the daemon `target` describes, through
 * a pidfd, and only while `/proc` still shows that daemon.
 *
 * Identity is re-read after the pidfd is open and again before KILL, so a pid
 * recycled between a check and a signal is never signalled: the pidfd names the
 * process that was there when it was opened. The exit code is the helper's:
 * 0 for gone or reaped, 3 for an identity mismatch, 4 for a daemon still live
 * after KILL, 5 when the platform has no pidfd.
 */
export function reapByPidfd(target: PidfdTarget, ops: PidfdOps): PidfdResult {
  try {
    if (!matchesTarget(ops, target)) return refuse(ops, target);
    const descriptor = ops.open(target.pid);
    try {
      if (!matchesTarget(ops, target)) return refuse(ops, target);
      ops.sendSignal(descriptor, "SIGTERM");
      const escalated = ops.poll(descriptor, 500).length === 0;
      if (escalated) {
        if (!matchesTarget(ops, target)) {
          // Exit can race the identity read after the TERM wait.
          const exited = ops
            .poll(descriptor, 0)
            .some(
              (entry) =>
                entry.descriptor === descriptor &&
                (entry.events & POLLIN) !== 0 &&
                (entry.events & (POLLERR | POLLNVAL)) === 0,
            );
          return exited ? GONE : refuse(ops, target);
        }
        ops.sendSignal(descriptor, "SIGKILL");
      }
      if (ops.poll(descriptor, 2000).length === 0) {
        return { exitCode: 4, report: { status: "still-live" } };
      }
      return { exitCode: 0, report: { escalated, status: "reaped" } };
    } finally {
      ops.close(descriptor);
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ESRCH") return GONE;
    return {
      exitCode: 5,
      report: {
        error: error instanceof Error ? error.message : String(error),
        status: "unavailable",
      },
    };
  }
}
