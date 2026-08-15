import type { TmuxEvent, TmuxEventStream as PublicEventStream } from "../../types.js";

export const DEFAULT_BUFFER_SIZE = 1024;

/**
 * The consumer half of a control connection.
 *
 * The stream holds no process. It buffers what the connection routes to it and
 * hands that to one `for await`, so the process lifetime belongs to the
 * connection and closing either ends both.
 */
class BufferedEventStream implements PublicEventStream {
  readonly #buffer: TmuxEvent[] = [];
  readonly #bufferSize: number;
  readonly #onClose: () => Promise<void>;
  readonly #onReady: () => Promise<void>;
  #closed = false;
  #dropped = 0;
  #failure: Error | undefined;
  #iterated = false;
  #pending: (() => void) | undefined;

  constructor(bufferSize: number, onClose: () => Promise<void>, onReady: () => Promise<void>) {
    this.#bufferSize = bufferSize;
    this.#onClose = onClose;
    this.#onReady = onReady;
  }

  /** Resolve once the connection behind this stream has attached. */
  ready(): Promise<void> {
    return this.#onReady();
  }

  get dropped(): number {
    return this.#dropped;
  }

  push(event: TmuxEvent): void {
    if (this.#closed) return;
    if (this.#buffer.length >= this.#bufferSize) {
      this.#buffer.shift();
      this.#dropped += 1;
    }
    this.#buffer.push(event);
    this.#wake();
  }

  finish(failure: Error | undefined): void {
    this.#failure ??= failure;
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
        while (this.#buffer.length > 0) yield this.#buffer.shift()!;
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

  async find(
    matches: (event: TmuxEvent) => boolean,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<TmuxEvent | undefined> {
    const deadline = setTimeout(() => void this.close(), options.timeoutMs ?? 30_000);
    try {
      for await (const event of this) {
        if (matches(event)) return event;
      }
      return undefined;
    } finally {
      clearTimeout(deadline);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#wake();
    await this.#onClose();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** A stream, paired with the calls a control connection uses to feed it. */
export interface EventSink {
  finish: (failure: Error | undefined) => void;
  push: (event: TmuxEvent) => void;
  readonly stream: PublicEventStream;
}

export function createEventStream(
  onClose: () => Promise<void>,
  bufferSize: number = DEFAULT_BUFFER_SIZE,
  onReady: () => Promise<void> = () => Promise.resolve(),
): EventSink {
  if (!Number.isInteger(bufferSize) || bufferSize < 1) {
    throw new TypeError("bufferSize must be a positive integer");
  }
  const stream = new BufferedEventStream(bufferSize, onClose, onReady);
  return {
    finish: (failure) => {
      stream.finish(failure);
    },
    push: (event) => {
      stream.push(event);
    },
    stream,
  };
}
