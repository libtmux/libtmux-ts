/**
 * Running a consumer's tests without a tmux server.
 *
 * Everything this package does above the engine — snapshots, queries,
 * handles, batches — is decided by what tmux answered, so a consumer testing
 * their own code either starts a real server or writes an engine by hand.
 * Starting one is slow, needs the binary, and makes a unit test depend on a
 * daemon; writing one by hand means reproducing the guarded format protocol,
 * which is the part most likely to be got wrong.
 *
 * So: record once against a real server, replay for free. A recording is
 * plain JSON, so it belongs in a fixture file and a reviewer can read it.
 *
 * `record` is the only thing here that needs tmux. `replay` needs nothing,
 * which is the point. It still refuses an already-cancelled command, because
 * a caller testing their own cancellation deserves an answer rather than a
 * recording that never looked.
 *
 * A recording holds what a run did, which includes what it failed to do: an
 * invocation that raised is written down and raises again at its own
 * position. That is what keeps the queue aligned — an omitted failure would
 * hand the next call someone else's answer.
 *
 * What a recording cannot cover: `Server.watch` and `Server.connect` refuse on
 * any server built with an engine, because both hold a local `tmux -C attach`
 * process open. A recording covers the command path — snapshots, mutations,
 * `cmd` — and never the event stream.
 */

import { NodeSpawnTransport } from "./_internal/transport/node_spawn_transport.js";
import type { TmuxCommandResult, TmuxEngine } from "./engine.js";
import { flattenInvocation } from "./engine.js";
import type { DeliveryStatus } from "./common.js";
import type { LibTmuxErrorCode, TmuxTransportErrorKind } from "./errors.js";
import { TmuxServerRestartedError, TmuxTransportError } from "./errors.js";

/** What every recorded entry carries, answered or not. */
interface RecordedCall {
  /**
   * The commands tmux ran, without the connection flags.
   *
   * The flags say which socket and which binary, which is what differs
   * between the machine that recorded and the one replaying; the commands are
   * what decided the answer. Keying on these lets a fixture recorded on one
   * socket replay on a `Server` built with no socket at all.
   */
  readonly commands: readonly (readonly string[])[];
  /**
   * Bytes written to the command's standard input, when it had any.
   *
   * Part of the key, not just the record: `load-buffer -` is the same command
   * whatever it is fed, so a recording keyed on the commands alone would
   * answer a test that wrote different bytes with the ones it first saw, and
   * a regression that corrupted a buffer would replay as a pass.
   */
  readonly stdin?: readonly number[];
}

/** One invocation and what tmux answered, as JSON. */
export interface RecordedAnswer extends RecordedCall {
  readonly exitCode: number;
  /** Bytes, as numbers: a recording is JSON and tmux output is not text. */
  readonly stderr: readonly number[];
  readonly stdout: readonly number[];
}

/**
 * One invocation that raised instead of answering.
 *
 * `cause` is absent by design — it does not survive JSON, and a recording is
 * a file a reviewer reads.
 */
export interface RecordedError {
  /**
   * Which error class raised, when it was one of this package's.
   *
   * `code` is the branch a consumer is told to write — it survives bundling
   * and a worker boundary where `instanceof` does not — so a replayed failure
   * that has lost it is one they cannot test against.
   */
  readonly code?: LibTmuxErrorCode;
  readonly delivery?: DeliveryStatus;
  readonly kind?: TmuxTransportErrorKind;
  readonly message: string;
  readonly signal?: string;
  readonly stderr?: readonly number[];
  readonly stdout?: readonly number[];
  readonly subcommand?: string;
}

/** One invocation that failed, and how. */
export interface RecordedFailure extends RecordedCall {
  readonly error: RecordedError;
}

/**
 * One entry: either an answer or a failure, never both.
 *
 * A failure is written down rather than dropped because the queue is
 * positional. An omitted failure does not merely lose itself — it hands the
 * next call the answer belonging to the one after it, so a recorded failure
 * replays as a pass and everything past it is off by one.
 */
export type RecordedInvocation = RecordedAnswer | RecordedFailure;

/** Every invocation one run made, in order. */
export interface TmuxRecording {
  readonly invocations: readonly RecordedInvocation[];
  readonly version: 1;
}

/**
 * The per-invocation record guards, which are random by design.
 *
 * `guard_codec` frames every listing between `ltxS<24 hex>` and `ltxE<24 hex>`
 * drawn fresh for each request, so that no pane's own output can forge a
 * record boundary. That is also what stops a recording keyed on the literal
 * command from ever matching again — so a key normalizes them away, and a
 * replayed answer has the recorded guards rewritten to the ones the caller
 * just asked for. Both are fixed width, so the rewrite preserves every offset.
 */
const GUARD = /ltx[SE][0-9a-f]{24}/gu;

const guardsIn = (commands: readonly (readonly string[])[]): string[] => [
  ...new Set(commands.flat().join("\u0000").match(GUARD) ?? []),
];

const keyOf = (
  commands: readonly (readonly string[])[],
  stdin: readonly number[] | undefined,
): string => {
  const seen = guardsIn(commands);
  const text = JSON.stringify([commands, stdin ?? null]);
  return text.replaceAll(GUARD, (token) => `\u0000g${seen.indexOf(token)}`);
};

const bytes = (values: readonly number[]): Uint8Array => Uint8Array.from(values);

/** Rewrite the recorded guards to the ones this request carries. */
function withRequestGuards(
  recorded: readonly number[],
  from: readonly string[],
  to: readonly string[],
): Uint8Array {
  if (from.length === 0 || from.length !== to.length) return bytes(recorded);
  let text = "";
  for (const value of recorded) text += String.fromCharCode(value);
  for (const [index, token] of from.entries()) text = text.replaceAll(token, to[index]!);
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

/** Flatten a thrown failure into the part of it that survives JSON. */
function recordedErrorOf(failure: unknown): RecordedError {
  // The built-in engine raises two errors, not one. This is the second: tmux
  // refusing a command whose ids came from a daemon that has since restarted.
  if (failure instanceof TmuxServerRestartedError) {
    return {
      code: "TmuxServerRestartedError",
      message: failure.message,
      ...(failure.subcommand === undefined ? {} : { subcommand: failure.subcommand }),
    };
  }
  if (!(failure instanceof TmuxTransportError)) {
    return { message: failure instanceof Error ? failure.message : String(failure) };
  }
  const stderr = [...failure.stderr];
  const stdout = [...failure.stdout];
  return {
    code: "TmuxTransportError",
    delivery: failure.delivery,
    kind: failure.kind,
    message: failure.message,
    ...(typeof failure.signal === "string" ? { signal: failure.signal } : {}),
    ...(stderr.length === 0 ? {} : { stderr }),
    ...(stdout.length === 0 ? {} : { stdout }),
    ...(failure.subcommand === undefined ? {} : { subcommand: failure.subcommand }),
  };
}

/**
 * Rebuild a recorded failure as the error the caller would have caught.
 *
 * Reconstructed from `code`, which is the whole point of `code` existing: a
 * consumer is told to branch on it because it survives bundling and a worker
 * boundary where `instanceof` does not. A failure they cannot branch on is no
 * cheaper to test against than no failure at all. Anything recorded from an
 * engine of the caller's own, which may raise whatever it likes, comes back as
 * a plain `Error` carrying its message.
 */
function failureOf(error: RecordedError, from: readonly string[], to: readonly string[]): Error {
  if (error.code === "TmuxServerRestartedError") {
    return error.subcommand === undefined
      ? new TmuxServerRestartedError(error.message)
      : new TmuxServerRestartedError(error.message, { subcommand: error.subcommand });
  }
  if (error.delivery === undefined || error.kind === undefined) return new Error(error.message);
  return new TmuxTransportError(error.message, {
    delivery: error.delivery,
    kind: error.kind,
    ...(error.signal === undefined ? {} : { signal: error.signal }),
    ...(error.stderr === undefined ? {} : { stderr: withRequestGuards(error.stderr, from, to) }),
    ...(error.stdout === undefined ? {} : { stdout: withRequestGuards(error.stdout, from, to) }),
    ...(error.subcommand === undefined ? {} : { subcommand: error.subcommand }),
  });
}

/**
 * Wrap an engine so every invocation it runs is written down.
 *
 * The wrapper is transparent: it answers exactly what the inner engine
 * answered, so a suite can record while it runs against real tmux and keep
 * asserting on the real results. Called with nothing it wraps the engine a
 * `Server` builds for itself, which is what recording against a local tmux
 * means and saves reaching for an internal class to say so.
 */
export function recordInvocations(inner: TmuxEngine = new NodeSpawnTransport()): {
  readonly engine: TmuxEngine;
  /** The recording so far, safe to serialize at any point. */
  readonly recording: () => TmuxRecording;
} {
  const invocations: RecordedInvocation[] = [];
  return {
    engine: {
      ...(inner.endpoint === undefined ? {} : { endpoint: inner.endpoint }),
      async execute(request) {
        const call: RecordedCall = {
          commands: request.commands.map((command) => [...command]),
          ...(request.stdin === undefined ? {} : { stdin: [...request.stdin] }),
        };
        let result: TmuxCommandResult;
        try {
          result = await inner.execute(request);
        } catch (failure) {
          // Every call leaves exactly one entry, whatever it threw and
          // whatever threw it — the engine underneath is the caller's and
          // raises what it likes. The original is rethrown rather than a
          // reconstruction, so the live run sees the wrapper as transparent.
          invocations.push({ ...call, error: recordedErrorOf(failure) });
          throw failure;
        }
        invocations.push({
          ...call,
          exitCode: result.exitCode,
          stderr: [...result.stderr],
          stdout: [...result.stdout],
        });
        return result;
      },
    },
    recording: () => ({ invocations: [...invocations], version: 1 }),
  };
}

/**
 * An engine that answers from a recording and never starts a process.
 *
 * Repeated identical commands answer in the order they were recorded, because
 * two snapshots of a changing server are the same argv and different answers.
 * An argv the recording does not hold raises rather than inventing a result:
 * a test whose code took a path the recording never saw should say so, not
 * quietly pass against an empty server.
 */
export function replayInvocations(recording: TmuxRecording): TmuxEngine {
  if (recording.version !== 1) {
    throw new TypeError(`unsupported recording version ${String(recording.version)}`);
  }
  const remaining = new Map<string, RecordedInvocation[]>();
  for (const invocation of recording.invocations) {
    const key = keyOf(invocation.commands, invocation.stdin);
    const queue = remaining.get(key);
    if (queue === undefined) remaining.set(key, [invocation]);
    else queue.push(invocation);
  }

  return {
    // Deliberately no `endpoint`. `Server.equals` compares two servers by the
    // address their engines reach, and a fixed string here would make every
    // replay of every recording report the same daemon — two servers playing
    // back different fixtures would compare equal. An engine that declares
    // none is never reported equal to another, which is the answer that cannot
    // be wrong when the reach is a file rather than a socket.
    // `async` is the contract, not a convenience: `TmuxEngine.execute`
    // promises a promise, and a caller who wrote only `.catch()` must not take
    // a synchronous exception past it. Every refusal below is a rejection.
    async execute(request) {
      // A replayed command answers from a file, which makes it easy to forget
      // it is still a command: a caller's own cancellation test would pass
      // against a recording that never checked, which is the same shape of
      // false pass as ignoring stdin. Refuse exactly as the spawning engine
      // refuses before it starts a process.
      if (request.signal?.aborted === true) {
        throw new TmuxTransportError("command cancelled before spawn", {
          delivery: "not_started",
          kind: "cancelled",
        });
      }
      const stdin = request.stdin === undefined ? undefined : [...request.stdin];
      const next = remaining.get(keyOf(request.commands, stdin))?.shift();
      if (next === undefined) {
        const shown = request.commands.map((command) => command.join(" ")).join("; ");
        const withInput = stdin === undefined ? "" : " with these bytes on stdin";
        throw new TypeError(
          `no recorded answer for ${shown}${withInput}; record this invocation or widen the fixture`,
        );
      }
      const from = guardsIn(next.commands);
      const to = guardsIn(request.commands);
      // A run that failed here fails here again. The caller's own signal does
      // not decide it: a recording is a run rather than a database, so a
      // cancellation recorded at this position replays at this position.
      if ("error" in next) throw failureOf(next.error, from, to);
      const result: TmuxCommandResult = {
        cmd: [request.executable, ...flattenInvocation(request)],
        exitCode: next.exitCode,
        signal: null,
        stderr: withRequestGuards(next.stderr, from, to),
        stdout: withRequestGuards(next.stdout, from, to),
      };
      return result;
    },
  };
}
