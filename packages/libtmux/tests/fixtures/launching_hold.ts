import { dlopen, FFIType } from "bun:ffi";
import { fsyncSync, openSync, writeSync } from "node:fs";

export interface LaunchingHoldConfig {
  /** Receives `<pid>\n<stdout>` once tmux has run. */
  readonly marker: string;
  readonly tmux: string;
}

const PR_SET_PDEATHSIG = 1;
const SIGKILL = 9;

/**
 * Stands in for the tmux launch wrapper. It asks the kernel to kill it with
 * its parent, runs tmux to completion, forwards what tmux printed, records the
 * marker and then holds, so a test can kill the launching worker while the
 * wrapper is alive.
 */
export default function launchingHold(config: LaunchingHoldConfig, argv: readonly string[]): void {
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

  const completed = Bun.spawnSync([config.tmux, ...argv], { stderr: "pipe", stdout: "pipe" });
  process.stdout.write(completed.stdout);
  process.stderr.write(completed.stderr);
  const descriptor = openSync(config.marker, "w");
  writeSync(descriptor, Buffer.concat([Buffer.from(`${process.pid}\n`), completed.stdout]));
  fsyncSync(descriptor);

  setInterval(() => undefined, 1 << 30);
}
