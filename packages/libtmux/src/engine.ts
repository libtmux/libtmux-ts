/**
 * Running tmux somewhere other than this machine's `tmux`.
 *
 * Everything above this — capabilities, acquisition, the graph, the handles,
 * the query layer — is built on one operation: hand tmux an argument vector and
 * get back what it wrote. An engine is that operation, so replacing it moves the
 * whole library to a tmux over ssh, inside a container, or behind a daemon,
 * without any of the layers above knowing.
 *
 * Deliberately small, and deliberately not the graph. A seam at the graph would
 * make every implementer responsible for framing, capability gating and
 * normalization; a seam here leaves them responsible for bytes, which is the
 * part that differs.
 */

export type {
  CommandRequest as TmuxCommandRequest,
  CommandTransport as TmuxEngine,
  RawCommandResult as TmuxCommandResult,
} from "./_internal/transport/types.js";

export { asSingleInvocation } from "./_internal/transport/group.js";
export { MAX_PACKED_ARGV_BYTES } from "./_internal/transport/group.js";
export type { DaemonGuard } from "./_internal/transport/daemon_guard.js";
