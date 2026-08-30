/** Split a byte stream into the lines tmux's control protocol is written in. */

const NEWLINE = 0x0a;
const PAGE_BYTES = 64 * 1024;

/**
 * Bound on an unterminated line.
 *
 * Its longest legitimate form is one command's output line, so past this the
 * stream is no longer parseable and holding more of it only grows the heap.
 */
export const MAX_CARRY_BYTES: number = 16 * 1024 * 1024;

export class LineFramer {
  readonly #maxCarryBytes: number;
  readonly #pages: Uint8Array[] = [];
  #length = 0;

  constructor(maxCarryBytes: number = MAX_CARRY_BYTES) {
    if (!Number.isInteger(maxCarryBytes) || maxCarryBytes < 1) {
      throw new TypeError("maxCarryBytes must be a positive integer");
    }
    this.#maxCarryBytes = maxCarryBytes;
  }

  #append(bytes: Uint8Array): boolean {
    const length = this.#length + bytes.length;
    if (length > this.#maxCarryBytes) {
      this.reset();
      return false;
    }
    let source = 0;
    while (source < bytes.length) {
      const pageOffset = this.#length % PAGE_BYTES;
      if (pageOffset === 0) this.#pages.push(new Uint8Array(PAGE_BYTES));
      const page = this.#pages.at(-1)!;
      const copied = Math.min(page.length - pageOffset, bytes.length - source);
      page.set(bytes.subarray(source, source + copied), pageOffset);
      this.#length += copied;
      source += copied;
    }
    return true;
  }

  #finish(bytes: Uint8Array): Uint8Array {
    if (this.#length === 0) return bytes.slice();
    const line = new Uint8Array(this.#length + bytes.length);
    let offset = 0;
    for (const page of this.#pages) {
      const copied = Math.min(page.length, this.#length - offset);
      line.set(page.subarray(0, copied), offset);
      offset += copied;
    }
    line.set(bytes, offset);
    this.reset();
    return line;
  }

  /**
   * The complete lines this chunk finished, in order.
   *
   * A partial tail is held for the next chunk. `undefined` means the carry
   * outgrew {@link MAX_CARRY_BYTES}; it is discarded rather than retained.
   */
  push(chunk: Uint8Array): readonly Uint8Array[] | undefined {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start);
      if (newline === -1) break;
      lines.push(this.#finish(chunk.subarray(start, newline)));
      start = newline + 1;
    }
    return this.#append(chunk.subarray(start)) ? lines : undefined;
  }

  /** Bytes held back for the next chunk. Zero between lines. */
  get pending(): number {
    return this.#length;
  }

  /** Forget a partial line. A reconnect is a different process mid-sentence. */
  reset(): void {
    this.#pages.length = 0;
    this.#length = 0;
  }
}
