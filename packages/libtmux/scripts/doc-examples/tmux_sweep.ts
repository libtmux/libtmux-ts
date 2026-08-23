import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Kill any tmux server a doc example spawned by constructing its own `Server`.
 *
 * `reapOwnedRunRoot` accounts for every fixture this package's own harness
 * created, but a doc example is free to write `new Server()` or
 * `Server.open()` itself — several TSDoc examples on `Server` do, and so does
 * the README quickstart. Those resolve against `TMUX_TMPDIR` rather than a
 * run root this package tracks, so nothing reaps them.
 *
 * SPIKE finding: this is not hypothetical. `new Server()` followed by
 * `newSession()` and `snapshot()`, run under an isolated `TMUX_TMPDIR` with no
 * further cleanup, left a real tmux daemon running — reachable and holding a
 * session — after the process that started it exited. `close()` on
 * `Server.open()`'s result ends a connection, not the daemon behind it, so
 * that example leaks the same way. Both check-readme-runs.ts and
 * check-symbol-runs.ts point `TMUX_TMPDIR` at a directory nothing else
 * touches, so every socket found under it belongs to a doc example, and
 * `kill-server` on each is safe.
 */
export async function sweepStrayTmux(isolatedTmpdir: string): Promise<readonly string[]> {
  const killed: string[] = [];
  let entries: readonly string[];
  try {
    entries = await readdir(isolatedTmpdir);
  } catch {
    return killed;
  }
  for (const entry of entries) {
    if (!entry.startsWith("tmux-")) continue;
    const directory = join(isolatedTmpdir, entry);
    let sockets: readonly string[];
    try {
      // eslint-disable-next-line no-await-in-loop -- as above.
      sockets = await readdir(directory);
    } catch {
      continue;
    }
    for (const socket of sockets) {
      const socketPath = join(directory, socket);
      const result = Bun.spawnSync(["tmux", "-S", socketPath, "kill-server"], {
        stderr: "pipe",
        stdout: "pipe",
      });
      // tmux exits non-zero when the socket already has no server behind it,
      // which is the common case and not news; only a killed server is.
      if (result.exitCode === 0) killed.push(socketPath);
    }
  }
  return killed;
}
