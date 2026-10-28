// A program's stream: the copy pipe-pane writes, read as text with the run's end mark taken out.
import { open } from "node:fs/promises";

import { LibTmuxError, OutputLostError, StreamLimitError } from "../../errors.js";
import type { Program } from "../../program.js";
import type { AbortLike } from "../../types.js";
import {
  cancelled,
  exists,
  isAborted,
  sleep,
  stateOf,
  waitProgram,
  type ProgramState,
  type StreamFiles,
} from "./program.js";

/** How long a stream waits, after the exit, for the copy to finish. */
const COPY_DRAIN_MS = 5000;
const STREAM_POLL_MS = 25;

/** The bytes the wrapper's printf writes for `mark`: ST, then OSC 7 ending in BEL. */
export function markSequence(mark: string): string {
  return `\x1b\\\x1b]7;${mark}\x07`;
}

/**
 * Drops one exact `mark` from text that arrives in pieces, holding back only a
 * tail that could start it, so a prompt passes at once.
 */
export class MarkFilter {
  #held = "";
  #seen = false;
  readonly #mark: string;

  constructor(mark: string) {
    this.#mark = mark;
  }

  /** Whether the mark has gone by. */
  get seen(): boolean {
    return this.#seen;
  }

  push(text: string): string {
    let pending = this.#held + text;
    this.#held = "";
    if (!this.#seen) {
      const at = pending.indexOf(this.#mark);
      if (at !== -1) {
        this.#seen = true;
        pending = pending.slice(0, at) + pending.slice(at + this.#mark.length);
      } else {
        for (
          let length = Math.min(this.#mark.length - 1, pending.length);
          length > 0;
          length -= 1
        ) {
          if (this.#mark.startsWith(pending.slice(-length))) {
            this.#held = pending.slice(-length);
            return pending.slice(0, -length);
          }
        }
      }
    }
    return pending;
  }

  /** What is still held once nothing more will arrive. */
  end(): string {
    const held = this.#held;
    this.#held = "";
    return held;
  }
}

/** The program's output as UTF-8 text, as it is written, until it exits; misuse throws at once. */
export function streamProgram(
  program: Program,
  signal?: AbortLike,
): AsyncGenerator<string, void, undefined> {
  const state = stateOf(program);
  const files = state.files?.stream;
  if (files === undefined) {
    throw new TypeError("spawn the program with { stream: true } to stream its output");
  }
  return readStream(program, state, files, signal);
}

async function* readStream(
  program: Program,
  state: ProgramState,
  files: StreamFiles,
  signal: AbortLike | undefined,
): AsyncGenerator<string, void, undefined> {
  if (state.killing !== undefined) {
    throw new LibTmuxError("the program was killed, and its copied output with it");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(files.out, "r");
  } catch (error) {
    // A kill that landed between the check above and this open removed the copy.
    if (state.killing !== undefined) {
      throw new LibTmuxError("the program was killed, and its copied output with it");
    }
    throw error;
  }
  // Stopped when the consumer leaves early or cancels, so no wait outlives the loop.
  const stop = new AbortController();
  const onAbort = (): void => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let ended = false;
  let lost: unknown;
  void waitProgram(program, { signal: stop.signal }).then(
    () => {
      ended = true;
    },
    (error: unknown) => {
      ended = true;
      lost = error;
    },
  );
  const decoder = new TextDecoder();
  const sequence = markSequence(state.mark);
  const marks = new MarkFilter(sequence);
  // Past the limit the copy may hold only the mark; any other byte there is the cut.
  const markBytes = new TextEncoder().encode(sequence);
  let past = 0;
  try {
    const buffer = new Uint8Array(64 * 1024);
    let offset = 0;
    let drainUntil = Infinity;
    for (;;) {
      if (isAborted(signal)) {
        throw cancelled(signal, "the stream was cancelled; the program runs on", "replied");
      }
      // The copy is complete once the pane is dead and the `cat` writing it has
      // exited; a copy that never finishes is given up on after COPY_DRAIN_MS.
      // eslint-disable-next-line no-await-in-loop -- decided before the read that may be the last.
      const complete = ended && ((await exists(files.done)) || performance.now() >= drainUntil);
      let read: number;
      do {
        // eslint-disable-next-line no-await-in-loop -- read what has arrived, in order.
        ({ bytesRead: read } = await handle.read(buffer, 0, buffer.length, offset));
        const kept =
          files.limit === undefined ? read : Math.max(0, Math.min(read, files.limit - offset));
        offset += read;
        if (kept > 0) {
          const text = marks.push(decoder.decode(buffer.subarray(0, kept), { stream: true }));
          if (text !== "") yield text;
        }
        const beyond = buffer.subarray(kept, read);
        const onlyMark =
          past + beyond.length <= markBytes.length &&
          beyond.every((byte, index) => byte === markBytes[past + index]);
        past += beyond.length;
        if (!onlyMark) {
          const tail = marks.push(decoder.decode()) + marks.end();
          if (tail !== "") yield tail;
          throw new StreamLimitError(
            `the program wrote more than maxStreamBytes (${String(files.limit)}); the copy stopped there`,
          );
        }
      } while (read > 0);
      if (state.killing !== undefined) {
        throw new LibTmuxError("the program was killed while its output streamed");
      }
      if (complete) break;
      if (ended && drainUntil === Infinity) drainUntil = performance.now() + COPY_DRAIN_MS;
      // Not raced with the exit wait, which would gain a reaction every poll.
      // eslint-disable-next-line no-await-in-loop -- wait for more output or the exit.
      await sleep(ended ? 5 : STREAM_POLL_MS, stop.signal);
    }
    const tail = marks.push(decoder.decode()) + marks.end();
    if (tail !== "") yield tail;
    // A pane removed from outside ends the copy too; say so after what arrived.
    if (lost !== undefined) throw lost;
    if (!marks.seen && past !== markBytes.length && state.exit !== undefined) {
      throw new OutputLostError(
        "the output ended without the run's end mark: tmux removed the pane before reading its end, or its process group was killed",
      );
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stop.abort();
    await handle.close();
  }
}
