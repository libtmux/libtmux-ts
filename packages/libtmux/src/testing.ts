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
 * which is the point.
 */

import { NodeSpawnTransport } from "./_internal/transport/node_spawn_transport.js";
import type { TmuxCommandResult, TmuxEngine } from "./engine.js";
import { flattenInvocation } from "./engine.js";

/** One invocation and what tmux answered, as JSON. */
export interface RecordedInvocation {
  /**
   * The commands tmux ran, without the connection flags.
   *
   * The flags say which socket and which binary, which is what differs
   * between the machine that recorded and the one replaying; the commands are
   * what decided the answer. Keying on these lets a fixture recorded on one
   * socket replay on a `Server` built with no socket at all.
   */
  readonly commands: readonly (readonly string[])[];
  readonly exitCode: number;
  /** Bytes, as numbers: a recording is JSON and tmux output is not text. */
  readonly stderr: readonly number[];
  readonly stdout: readonly number[];
}

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

const keyOf = (commands: readonly (readonly string[])[]): string => {
  const seen = guardsIn(commands);
  return JSON.stringify(commands).replaceAll(GUARD, (token) => `\u0000g${seen.indexOf(token)}`);
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
        const result = await inner.execute(request);
        invocations.push({
          commands: request.commands.map((command) => [...command]),
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
    const key = keyOf(invocation.commands);
    const queue = remaining.get(key);
    if (queue === undefined) remaining.set(key, [invocation]);
    else queue.push(invocation);
  }

  return {
    endpoint: "recording://replay",
    execute(request) {
      const next = remaining.get(keyOf(request.commands))?.shift();
      if (next === undefined) {
        const shown = request.commands.map((command) => command.join(" ")).join("; ");
        throw new TypeError(
          `no recorded answer for ${shown}; record this invocation or widen the fixture`,
        );
      }
      const from = guardsIn(next.commands);
      const to = guardsIn(request.commands);
      const result: TmuxCommandResult = {
        cmd: [request.executable, ...flattenInvocation(request)],
        exitCode: next.exitCode,
        signal: null,
        stderr: withRequestGuards(next.stderr, from, to),
        stdout: withRequestGuards(next.stdout, from, to),
      };
      return Promise.resolve(result);
    },
  };
}
