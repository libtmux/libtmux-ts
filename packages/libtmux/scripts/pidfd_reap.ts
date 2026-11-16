import { readFileSync, realpathSync } from "node:fs";

import { dlopen, FFIType, read } from "bun:ffi";

import { reapByPidfd, type PidfdOps, type PidfdTarget } from "../src/_internal/test/pidfd_reap.js";

// Reaps one stale daemon through a pidfd and prints the outcome as JSON:
// pidfd_reap.ts <pid> <start identity> <comm> <executable> <argv JSON>
// <generation name> <generation value>
//
// Bun runs it because Node has no pidfd binding. The syscall numbers are the
// same on every Linux architecture, and `syscall` works on a libc that predates
// the pidfd wrappers.
const SYS_PIDFD_SEND_SIGNAL = 424;
const SYS_PIDFD_OPEN = 434;
const SIGNALS = { SIGKILL: 9, SIGTERM: 15 } as const;
const ERRNO_CODES: Readonly<Record<number, string>> = {
  1: "EPERM",
  3: "ESRCH",
  4: "EINTR",
  22: "EINVAL",
  38: "ENOSYS",
};

const libc = dlopen("libc.so.6", {
  __errno_location: { args: [], returns: FFIType.ptr },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  syscall: {
    args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
    returns: FFIType.i32,
  },
});

function failure(call: string): Error {
  const errno = libc.symbols.__errno_location();
  const number = errno === null ? 0 : read.i32(errno);
  return Object.assign(new Error(`${call} failed with errno ${String(number)}`), {
    code: ERRNO_CODES[number] ?? `E${String(number)}`,
  });
}

const ops: PidfdOps = {
  close(descriptor) {
    libc.symbols.close(descriptor);
  },
  open(pid) {
    const descriptor = libc.symbols.syscall(SYS_PIDFD_OPEN, pid, 0, 0, 0);
    if (descriptor < 0) throw failure("pidfd_open");
    return descriptor;
  },
  poll(descriptor, timeoutMs) {
    const entry = new Uint8Array(8);
    const view = new DataView(entry.buffer);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      view.setInt32(0, descriptor, true);
      view.setInt16(4, 1, true);
      view.setInt16(6, 0, true);
      const ready = libc.symbols.poll(entry, 1n, Math.max(0, deadline - Date.now()));
      if (ready > 0) return [{ descriptor, events: view.getInt16(6, true) }];
      if (ready === 0) return [];
      const error = failure("poll");
      if ((error as NodeJS.ErrnoException).code !== "EINTR") throw error;
    }
  },
  readFile: (path) => readFileSync(path),
  realpath: (path) => realpathSync(path),
  sendSignal(descriptor, signal) {
    if (libc.symbols.syscall(SYS_PIDFD_SEND_SIGNAL, descriptor, SIGNALS[signal], 0, 0) !== 0) {
      throw failure("pidfd_send_signal");
    }
  },
};

const [pid, startIdentity, comm, executable, argv, generationName, generationValue] =
  process.argv.slice(2);
if (
  pid === undefined ||
  startIdentity === undefined ||
  comm === undefined ||
  executable === undefined ||
  argv === undefined ||
  generationName === undefined ||
  generationValue === undefined
) {
  throw new Error(
    "usage: pidfd_reap.ts <pid> <start identity> <comm> <executable> <argv JSON> <generation name> <generation value>",
  );
}
const target: PidfdTarget = {
  argv: JSON.parse(argv) as string[],
  comm,
  executable,
  generationName,
  generationValue,
  pid: Number(pid),
  startIdentity,
};
const { exitCode, report } = reapByPidfd(target, ops);
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = exitCode;
