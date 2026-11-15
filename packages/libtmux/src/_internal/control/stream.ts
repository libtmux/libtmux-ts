import { LibTmuxError } from "../../errors.js";
import type { TmuxEvent, TmuxEventStream as PublicEventStream } from "../../types.js";
import { timerDuration } from "../timing.js";

export const DEFAULT_BUFFER_SIZE = 1024;
export const DEFAULT_OUTPUT_BYTES: number = 1024 * 1024;

function outputSize(event: TmuxEvent): number {
  return event.kind === "output" ? (event.bytes?.byteLength ?? 0) : 0;
}

/**
 * A bounded FIFO that overwrites its oldest entry rather than growing.
 *
 * `Array.shift` costs a move of every remaining entry, and a subscriber that
 * has fallen behind pays it on every notification — the case a bound exists
 * for. Slots hold `undefined` rather than being deleted, which keeps the
 * backing array packed, and are allocated as they are first needed so a
 * short-lived subscriber holds what it saw rather than what it was allowed.
 */
class EventRing {
  readonly #capacity: number;
  #slots: (TmuxEvent | undefined)[] = [];
  #head = 0;
  #count = 0;
  #dropped = 0;
  #bytes = 0;
  #droppedOutputBytes = 0;
  readonly #maxOutputBytes: number;

  constructor(capacity: number, maxOutputBytes: number) {
    this.#capacity = capacity;
    this.#maxOutputBytes = maxOutputBytes;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get size(): number {
    return this.#count;
  }

  get droppedOutputBytes(): number {
    return this.#droppedOutputBytes;
  }

  push(event: TmuxEvent): void {
    const bytes = outputSize(event);
    if (bytes > this.#maxOutputBytes) {
      this.#dropped += 1;
      this.#droppedOutputBytes += bytes;
      return;
    }
    while (this.#count > 0 && this.#bytes + bytes > this.#maxOutputBytes) this.#discard();
    if (this.#count === this.#slots.length) {
      if (this.#slots.length < this.#capacity) this.#grow();
      else this.#discard();
    }
    this.#slots[(this.#head + this.#count) % this.#slots.length] = event;
    this.#count += 1;
    this.#bytes += bytes;
  }

  shift(): TmuxEvent | undefined {
    if (this.#count === 0) return undefined;
    const event = this.#slots[this.#head];
    // Released rather than left addressable: a drained subscriber should not
    // keep a pane's payload alive through a slot nothing will read again.
    this.#slots[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#slots.length;
    this.#count -= 1;
    this.#bytes -= event === undefined ? 0 : outputSize(event);
    return event;
  }

  #discard(): void {
    const event = this.shift();
    this.#dropped += 1;
    this.#droppedOutputBytes += event === undefined ? 0 : outputSize(event);
  }

  /** Relay into a larger contiguous run, oldest first, and reset the head. */
  #grow(): void {
    const size = Math.min(this.#capacity, Math.max(4, this.#slots.length * 2));
    const grown: (TmuxEvent | undefined)[] = Array.from({ length: size });
    for (let index = 0; index < this.#count; index += 1) {
      grown[index] = this.#slots[(this.#head + index) % this.#slots.length];
    }
    this.#slots = grown;
    this.#head = 0;
  }
}

/**
 * The consumer half of a control connection.
 *
 * The stream holds no process. It buffers what the connection routes to it and
 * hands that to one `for await`, so the process lifetime belongs to the
 * connection and closing either ends both.
 */
class BufferedEventStream implements PublicEventStream {
  readonly #buffer: EventRing;
  readonly #onClose: () => Promise<void>;
  readonly #onReady: () => Promise<void>;
  #closeOperation: Promise<void> | undefined;
  #closed = false;
  /**
   * Why iteration stopped, once it has.
   *
   * `closed` is a decision — a deadline, a caller cancelling, a scope ending —
   * and answers the wait. `finished` is the connection behind this going away,
   * which answers nothing about what was being waited for.
   */
  #ended: "closed" | "finished" | undefined;
  #failure: Error | undefined;
  #iterated = false;
  #pending: (() => void) | undefined;

  constructor(
    bufferSize: number,
    onClose: () => Promise<void>,
    onReady: () => Promise<void>,
    maxOutputBytes: number,
  ) {
    this.#buffer = new EventRing(bufferSize, maxOutputBytes);
    this.#onClose = onClose;
    this.#onReady = onReady;
  }

  /** Resolve once the connection behind this stream has attached. */
  ready(): Promise<void> {
    return this.#onReady();
  }

  get dropped(): number {
    return this.#buffer.dropped;
  }

  get droppedOutputBytes(): number {
    return this.#buffer.droppedOutputBytes;
  }

  push(event: TmuxEvent): void {
    if (this.#closed) return;
    this.#buffer.push(
      event.kind === "output" && event.bytes !== undefined
        ? { ...event, bytes: new Uint8Array(event.bytes) }
        : event,
    );
    this.#wake();
  }

  /**
   * End iteration the way a caller closing this would, and no further.
   *
   * The connection calls this on its subscribers when it is closed on purpose,
   * where `finish` would say the source went away and turn somebody's own
   * cancellation into a raised error. It runs no close hook: the connection is
   * already closing, and re-entering it here would be circular.
   */
  cancel(): void {
    this.#ended ??= "closed";
    this.#closed = true;
    this.#wake();
  }

  finish(failure: Error | undefined): void {
    this.#failure ??= failure;
    this.#ended ??= "finished";
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TmuxEvent> {
    if (this.#iterated) throw new Error("a tmux event stream can only be iterated once");
    this.#iterated = true;
    try {
      for (;;) {
        while (this.#buffer.size > 0) yield this.#buffer.shift()!;
        if (this.#closed) {
          if (this.#failure !== undefined) throw this.#failure;
          return;
        }
        // eslint-disable-next-line no-await-in-loop -- one wait per drained buffer.
        await new Promise<void>((resolve) => {
          this.#pending = resolve;
        });
      }
    } finally {
      await this.close();
    }
  }

  find<Match extends TmuxEvent>(
    matches: (event: TmuxEvent) => event is Match,
    options?: { readonly timeoutMs?: number },
  ): Promise<Match | undefined>;
  find(
    matches: (event: TmuxEvent) => unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<TmuxEvent | undefined>;
  async find(
    matches: (event: TmuxEvent) => unknown,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<TmuxEvent | undefined> {
    const timeoutMs = timerDuration("timeoutMs", options.timeoutMs ?? 30_000);
    const deadline = setTimeout(() => void this.close(), timeoutMs);
    try {
      for await (const event of this) {
        if (matches(event)) return event;
      }
      // Undefined is an answer about the wait: the deadline passed, or somebody
      // stopped waiting. The connection going away is not an answer about the
      // wait at all, and reported as one it sends a reader to their workload.
      if (this.#ended === "finished") {
        throw new LibTmuxError("the tmux event stream ended before a match");
      }
      return undefined;
    } finally {
      clearTimeout(deadline);
    }
  }

  close(): Promise<void> {
    if (this.#closeOperation !== undefined) return this.#closeOperation;
    this.#ended ??= "closed";
    this.#closed = true;
    this.#wake();
    this.#closeOperation = Promise.resolve().then(this.#onClose);
    return this.#closeOperation;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** A stream, paired with the calls a control connection uses to feed it. */
export interface EventSink {
  /** End it deliberately: a caller closed the connection, nothing went wrong. */
  cancel: () => void;
  /** End it because the source went away, with the reason when there was one. */
  finish: (failure: Error | undefined) => void;
  push: (event: TmuxEvent) => void;
  readonly stream: PublicEventStream;
}

export function createEventStream(
  onClose: () => Promise<void>,
  bufferSize: number = DEFAULT_BUFFER_SIZE,
  onReady: () => Promise<void> = () => Promise.resolve(),
  maxOutputBytes: number = Infinity,
): EventSink {
  if (!Number.isInteger(bufferSize) || bufferSize < 1) {
    throw new TypeError("bufferSize must be a positive integer");
  }
  const stream = new BufferedEventStream(bufferSize, onClose, onReady, maxOutputBytes);
  return {
    cancel: () => {
      stream.cancel();
    },
    finish: (failure) => {
      stream.finish(failure);
    },
    push: (event) => {
      stream.push(event);
    },
    stream,
  };
}
