import { fsyncSync, openSync, writeSync } from "node:fs";

import { dlopen, FFIType } from "bun:ffi";

/**
 * Stands in for the tmux launch wrapper: `launching_hold.ts <marker> <tmux>
 * <args...>`.
 *
 * It asks the kernel to kill it with its parent, runs tmux to completion,
 * forwards what tmux printed, records `<pid>\n<stdout>` in the marker and then
 * holds, so a test can kill the launching worker while the wrapper is alive.
 */
const PR_SET_PDEATHSIG = 1;
const SIGKILL = 9;

const [marker, tmux, ...args] = process.argv.slice(2);
if (marker === undefined || tmux === undefined) {
  throw new Error("usage: launching_hold.ts <marker> <tmux> [args...]");
}

const parent = process.ppid;
const libc = dlopen("libc.so.6", {
  prctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
});
if (libc.symbols.prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) !== 0) {
  throw new Error("prctl(PR_SET_PDEATHSIG) failed");
}
if (process.ppid !== parent) process.kill(process.pid, "SIGKILL");

const completed = Bun.spawnSync([tmux, ...args], { stderr: "pipe", stdout: "pipe" });
process.stdout.write(completed.stdout);
process.stderr.write(completed.stderr);
const descriptor = openSync(marker, "w");
writeSync(descriptor, Buffer.concat([Buffer.from(`${process.pid}\n`), completed.stdout]));
fsyncSync(descriptor);

setInterval(() => undefined, 1 << 30);
