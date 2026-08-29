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

import { guardRequest as guardRequestInternal } from "./_internal/transport/daemon_guard.js";
import {
  asSingleInvocation as asSingleInvocationInternal,
  MAX_PACKED_ARGV_BYTES as MAX_PACKED_ARGV_BYTES_INTERNAL,
} from "./_internal/transport/group.js";
import type { AbortLike } from "./types.js";

/**
 * Making a command refuse to run on a daemon that is not the one it was read
 * from.
 *
 * A tmux id is unique within one daemon and reissued by the next: `kill-server`
 * and a restart give a new daemon the same socket, and it numbers its panes from
 * `%0` again. A handle captured before the restart therefore names something
 * that exists, belongs to somebody else, and answers to the same command.
 *
 * Checking first and sending second does not close that: the daemon can change
 * between the two. `if-shell -F` does, because it is not a shell — tmux expands
 * the format inside its command queue and `cmdq_insert_after`s the guarded
 * command into the same queue, so nothing runs in between. The condition is
 * `pid` and `start_time` together, since pids are reused.
 *
 * The refusal has to be visible. tmux answers a false condition with no output
 * and status 0, which is indistinguishable from a command that printed nothing,
 * so the else branch is a freshly named unknown command. A 128-bit suffix makes
 * matching a pre-existing command alias a guess, and the exact diagnostic
 * distinguishes the refusal from the guarded command failing. The guarded
 * command keeps its own stdout and stderr either way.
 */
export type DaemonGuard = {
  readonly pid: string;
  readonly startTime: string;
};

export type TmuxCommandRequest = {
  readonly args: readonly string[];
  /**
   * Refuse this command unless tmux is still the daemon named here.
   *
   * Set when the argv carries a raw tmux id, which a restarted daemon reissues
   * to something else. A spawning transport honours it by wrapping the command
   * in `if-shell -F`; a control connection ignores it, because it is bound to
   * one daemon for its lifetime and a restart drops it — and because
   * `if-shell` emits one `%begin`/`%end` block when its condition is false and
   * two when it is true, which a response queue correlating by order cannot
   * survive.
   */
  readonly daemonGuard?: DaemonGuard;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  /**
   * Require the engine to return stdout without a text protocol changing it.
   *
   * A control connection falls back to a spawned command for this: control
   * responses cannot represent every paste-buffer byte.
   */
  readonly rawOutput?: true;
  readonly signal?: AbortLike;
  /**
   * Bytes to write to the command's standard input.
   *
   * Caller-facing `CommandOptions` accepts text or bytes. The library
   * encodes text before it reaches the engine seam, so an engine receives only
   * the normalized `Uint8Array` form.
   */
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
};

/** A daemon-guarded request paired with its exact refusal detector. */
export type GuardedTmuxRequest = {
  readonly request: TmuxCommandRequest;
  readonly refusedBy: (returncode: number, stderr: Uint8Array) => boolean;
};

export type TmuxCommandResult = {
  readonly cmd: readonly string[];
  readonly returncode: number;
  /**
   * The signal that ended the process, as a plain string.
   *
   * Not `NodeJS.Signals`: these declarations are gated to compile with no
   * ambient Node types, and this one is reachable from the package root.
   */
  readonly signal: string | null;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
};

/**
 * What runs a tmux command for a server.
 *
 * Two obligations beyond returning bytes, and both are what the layers above
 * assume rather than check:
 *
 * `executeGroup` must run its requests as **one** tmux command list. Running
 * them separately returns the same data and quietly stops a snapshot being one:
 * tmux serializes a client's command queue and nothing else, so separate
 * invocations can observe different topologies. {@link asSingleInvocation}
 * assembles and splits that list, and the built-in engine uses it.
 *
 * `daemonGuard`, when a request carries one, must reach tmux — or the engine
 * must be bound to one daemon for its lifetime, the way a control connection
 * is. Ignoring it on a reconnecting engine means a handle read before a restart
 * addressing whatever now holds its id. `guardRequest` is what the built-in
 * engine calls to honour it, published so an implementer does not reproduce
 * the wrapper, its else branch, and the stderr that tells refusal from failure.
 */
export type TmuxEngine = {
  /**
   * Where this engine reaches tmux, as one comparable string.
   *
   * The socket is not the address when an engine is in play: `/tmp/tmux-1000/x`
   * on two machines is two daemons, and comparing servers by socket alone
   * reports them as one. Anything stable and distinct will do — `ssh://host`,
   * a container id, a URL.
   *
   * Optional because only comparison needs it. An engine that leaves it unset
   * is never reported equal to another engine, which is the answer that cannot
   * be wrong when the reach is unknown.
   */
  readonly endpoint?: string;
  execute(request: TmuxCommandRequest): Promise<TmuxCommandResult>;
  /**
   * Run these commands as one tmux command list.
   *
   * tmux drains one client's command queue without returning to its event loop,
   * so a list submitted together is serialized against every other client and
   * the results describe one instant. That is what makes a multi-listing
   * acquisition a snapshot rather than four readings taken near each other.
   *
   * A failing command removes the rest of the list, so this resolves with the
   * results of the commands tmux actually ran: a shorter array than `requests`
   * means an earlier one failed, and the last entry is that failure. Only the
   * first request's server-selecting flags are used; the rest contribute their
   * subcommands.
   */
  executeGroup(requests: readonly TmuxCommandRequest[]): Promise<readonly TmuxCommandResult[]>;
};

/**
 * How much of one command a tmux client may hand the server.
 *
 * `client.c` packs the whole argv into a single imsg and refuses anything over
 * `MAX_IMSGSIZE`, which OpenBSD's imsg — and tmux's bundled copy — fix at 16KB.
 * It bounds the *spawning* engine only: control mode sends a command as text on
 * an established socket and never packs an argv.
 */
export const MAX_PACKED_ARGV_BYTES: 16384 = MAX_PACKED_ARGV_BYTES_INTERNAL;

/**
 * One tmux invocation that runs a whole group, and the way back out of it.
 *
 * Exported because an engine that runs tmux somewhere else — over ssh, in a
 * container, through a daemon — has to get this exactly right or its snapshots
 * tear, and the way to get it right is not to write it again. The built-in
 * spawning engine calls this, so what ships is what is under test.
 */
export const asSingleInvocation: (requests: readonly { readonly args: readonly string[] }[]) => {
  readonly args: readonly string[];
  sections(stdout: Uint8Array): readonly Uint8Array[];
} = asSingleInvocationInternal;

/**
 * Prepare a request so tmux itself refuses it on the wrong daemon.
 *
 * The returned detector is bound to the random command in the transformed
 * request. Keep the pair together until the command completes. A guarded
 * request with stdin is rejected because an `if-shell` branch cannot read the
 * spawning client's stdin.
 */
export const guardRequest: (request: TmuxCommandRequest) => GuardedTmuxRequest =
  guardRequestInternal;
