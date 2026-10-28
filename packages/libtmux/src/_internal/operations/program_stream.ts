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
function markSequence(mark: string): string {
  return `\x1b\\\x1b]7;${mark}\x07`;
}

/** Each sequence the wrapper may end with: the mark, or the mark and why the program never ran. */
export function markSequences(mark: string): readonly string[] {
  return [mark, `${mark}:not-found`, `${mark}:not-executable`, `${mark}:start-directory`].map(
    markSequence,
  );
}

/** The UTF-8 length of `text`. */
function utf8Length(text: string): number {
  let length = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return length;
}

/** The longest start of `text`, in whole characters, that fits `room` bytes of UTF-8. */
function within(text: string, room: number): string {
  if (room === Infinity) return text;
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = utf8Length(character);
    if (used + size > room) break;
    used += size;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * Drops the first of `marks` from text that arrives in pieces, holding back
 * only a tail that could start one, so a prompt passes at once.
 */
export class MarkFilter {
  #held = "";
  #seen = false;
  readonly #marks: readonly string[];
  readonly #longest: number;

  constructor(marks: readonly string[]) {
    this.#marks = marks;
    this.#longest = Math.max(...marks.map((mark) => mark.length));
  }

  /** Whether the mark has gone by. */
  get seen(): boolean {
    return this.#seen;
  }

  push(text: string): string {
    let pending = this.#held + text;
    this.#held = "";
    if (!this.#seen) {
      for (const mark of this.#marks) {
        const at = pending.indexOf(mark);
        if (at !== -1) {
          this.#seen = true;
          return pending.slice(0, at) + pending.slice(at + mark.length);
        }
      }
      for (let length = Math.min(this.#longest - 1, pending.length); length > 0; length -= 1) {
        const tail = pending.slice(-length);
        if (this.#marks.some((mark) => mark.length > length && mark.startsWith(tail))) {
          this.#held = tail;
          return pending.slice(0, -length);
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
  const marks = new MarkFilter(markSequences(state.mark));
  // The limit counts the program's bytes, with the mark already taken out.
  let allowance = files.limit ?? Infinity;
  const limited = (): StreamLimitError =>
    new StreamLimitError(
      `the program wrote more than maxStreamBytes (${String(files.limit)}); the copy stopped there`,
    );
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
        offset += read;
        if (read > 0) {
          const text = marks.push(decoder.decode(buffer.subarray(0, read), { stream: true }));
          const kept = within(text, allowance);
          allowance -= utf8Length(kept);
          if (kept !== "") yield kept;
          if (kept.length < text.length) throw limited();
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
    const kept = within(tail, allowance);
    if (kept !== "") yield kept;
    if (kept.length < tail.length) throw limited();
    // A pane removed from outside ends the copy too; say so after what arrived.
    if (lost !== undefined) throw lost;
    if (!marks.seen && state.exit !== undefined) {
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
