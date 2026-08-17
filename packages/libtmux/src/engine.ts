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
 *
 * Two obligations do not travel in the bytes, and both have a helper here
 * rather than a description to follow: `asSingleInvocation` keeps a grouped
 * read one tmux command list, and `guardRequest` keeps a command addressed by
 * id from running on a daemon that reissued it. `endpoint` says where the
 * engine reaches, which is what tells two servers apart when the socket path
 * cannot.
 *
 * `Server.watch` and `Server.connect` are not available through an engine:
 * both hold a local `tmux -C attach` process, and an engine exists because
 * tmux is not somewhere this process can spawn one. They refuse rather than
 * attaching to whichever local daemon answers.
 */

export type {
  CommandRequest as TmuxCommandRequest,
  CommandTransport as TmuxEngine,
  RawCommandResult as TmuxCommandResult,
} from "./_internal/transport/types.js";

export { asSingleInvocation } from "./_internal/transport/group.js";
export { MAX_PACKED_ARGV_BYTES } from "./_internal/transport/group.js";
export type { DaemonGuard } from "./_internal/transport/daemon_guard.js";
// The guard is the obligation an engine is least likely to meet by accident:
// dropping it costs nothing until a daemon restarts, and then a stale id
// addresses whatever now holds it. Published as the same function the built-in
// engine calls, so the two cannot drift.
export { guardRequest, refusedByGuard } from "./_internal/transport/daemon_guard.js";
