import type { Server } from "libtmux/server";

/** The executable and socket selector captured when this MCP server is built. */
export interface PinnedTmuxRoute {
  readonly executable: string;
  readonly selector: string;
  readonly socketName: string | undefined;
  readonly socketPath: string | undefined;
}

/** Refuse route bytes that cannot be represented safely across process and protocol boundaries. */
export function assertSafeRouteValue(label: string, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) {
      throw new TypeError(`${label} must not contain an ASCII control character or DEL`);
    }
  }
}

/** Capture one immutable route shared by snapshots, handles, and live bookkeeping. */
export function pinTmuxRoute(tmux: Server): PinnedTmuxRoute {
  const executable = tmux.tmuxBin;
  const socketName = tmux.socketName;
  const socketPath = tmux.socketPath;
  assertSafeRouteValue("tmux executable", executable);
  if (socketName !== undefined) assertSafeRouteValue("tmux socket name", socketName);
  if (socketPath !== undefined) assertSafeRouteValue("tmux socket path", socketPath);
  return Object.freeze({
    executable,
    selector: socketPath === undefined ? `name:${socketName ?? "default"}` : `path:${socketPath}`,
    socketName,
    socketPath,
  });
}
