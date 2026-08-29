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
 * Global flags and commands stay distinct in the request, so an engine never
 * has to infer their boundary. `guardRequest` keeps an invocation addressed by
 * id from running on a daemon that reissued it. `endpoint` says where the
 * engine reaches, which tells two servers apart when the socket path cannot.
 *
 * `Server.watch` and `Server.connect` are not available through an engine:
 * both hold a local `tmux -C attach` process, and an engine exists because
 * tmux is not somewhere this process can spawn one. They refuse rather than
 * attaching to whichever local daemon answers.
 */

import { guardRequest as guardRequestInternal } from "./_internal/transport/daemon_guard.js";
import {
  flattenInvocation as flattenInvocationInternal,
  MAX_PACKED_ARGV_BYTES as MAX_PACKED_ARGV_BYTES_INTERNAL,
} from "./_internal/transport/invocation.js";
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

/** One nonempty tmux command, before command-list separators are inserted. */
export type TmuxCommand = readonly [name: string, ...args: string[]];

export type TmuxInvocationRequest = {
  /** Nonempty commands tmux receives as one ordered command list. */
  readonly commands: readonly [TmuxCommand, ...TmuxCommand[]];
  /**
   * Refuse this invocation unless tmux is still the daemon named here.
   *
   * Set when the argv carries a raw tmux id, which a restarted daemon reissues
   * to something else. A spawning transport honours it by wrapping the whole
   * command list in `if-shell -F`.
   */
  readonly daemonGuard?: DaemonGuard;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  /** Flags interpreted by the tmux client before the first command. */
  readonly globalArgs: readonly string[];
  /** Require the engine to return stdout without a text protocol changing it. */
  readonly rawOutput?: true;
  /** Cancel the whole invocation, never one command within it. */
  readonly signal?: AbortLike;
  /**
   * Bytes to write to the command's standard input.
   *
   * Caller-facing `CommandOptions` accepts text or bytes. The library
   * encodes text before it reaches the engine seam, so an engine receives only
   * the normalized `Uint8Array` form. Only an unguarded, one-command
   * invocation may carry stdin.
   */
  readonly stdin?: Uint8Array;
  /** A positive timer-safe integer when the request has a deadline. */
  readonly timeoutMs?: number;
};

/** A daemon-guarded request paired with its exact refusal detector. */
export type GuardedTmuxRequest = {
  readonly request: TmuxInvocationRequest;
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
 * Every request is one tmux invocation and carries its ordered command list.
 * Keeping that structure at the seam prevents an engine from splitting a
 * snapshot into several clients or guessing where global flags end.
 * Environment, stdin, signal, and timeout apply once to the whole invocation.
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
  execute(request: TmuxInvocationRequest): Promise<TmuxCommandResult>;
};

/**
 * How much of one invocation a tmux client may hand the server.
 *
 * `client.c` packs the whole argv into a single imsg and refuses anything over
 * `MAX_IMSGSIZE`, which OpenBSD's imsg — and tmux's bundled copy — fix at 16KB.
 * It bounds the *spawning* engine only: control mode sends a command as text on
 * an established socket and never packs an argv.
 */
export const MAX_PACKED_ARGV_BYTES: 16384 = MAX_PACKED_ARGV_BYTES_INTERNAL;

/** Flatten a validated request into the argv accepted by tmux. */
export const flattenInvocation: (request: TmuxInvocationRequest) => readonly string[] =
  flattenInvocationInternal;

/**
 * Prepare a request so tmux itself refuses it on the wrong daemon.
 *
 * The returned detector is bound to the random command in the transformed
 * request. Keep the pair together until the command completes. A guarded
 * request with stdin is rejected because an `if-shell` branch cannot read the
 * spawning client's stdin.
 */
export const guardRequest: (request: TmuxInvocationRequest) => GuardedTmuxRequest =
  guardRequestInternal;
