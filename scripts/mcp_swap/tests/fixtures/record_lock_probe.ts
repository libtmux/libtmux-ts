import { closeSync, constants, openSync } from "node:fs";

import { dlopen, FFIType } from "bun:ffi";

// Tries the POSIX record lock on the file named by argv[2] without waiting, as
// a second process, and prints `acquired` or `blocked`.
const F_ULOCK = 0;
const F_TLOCK = 2;

const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  lockf: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
});
const path = process.argv[2];
if (path === undefined) throw new Error("usage: record_lock_probe.ts <lock-file>");
const descriptor = openSync(path, constants.O_RDWR);
try {
  const acquired = library.symbols.lockf(descriptor, F_TLOCK, 0n) === 0;
  if (acquired) library.symbols.lockf(descriptor, F_ULOCK, 0n);
  process.stdout.write(acquired ? "acquired\n" : "blocked\n");
} finally {
  closeSync(descriptor);
  library.close();
}
