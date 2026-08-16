/** Split a byte stream into the lines tmux's control protocol is written in. */

const NEWLINE = 0x0a;

/**
 * Bound on an unterminated line.
 *
 * Its longest legitimate form is one command's output line, so past this the
 * stream is no longer parseable and holding more of it only grows the heap.
 */
export const MAX_CARRY_BYTES: number = 16 * 1024 * 1024;

export class LineFramer {
  #carry = new Uint8Array(0);

  /**
   * The complete lines this chunk finished, in order.
   *
   * A partial tail is held for the next chunk. `undefined` means the carry
   * outgrew {@link MAX_CARRY_BYTES}; it is discarded rather than retained.
   */
  push(chunk: Uint8Array): readonly Uint8Array[] | undefined {
    const merged = new Uint8Array(this.#carry.length + chunk.length);
    merged.set(this.#carry);
    merged.set(chunk, this.#carry.length);

    const lines: Uint8Array[] = [];
    let start = 0;
    for (;;) {
      const newline = merged.indexOf(NEWLINE, start);
      if (newline === -1) break;
      lines.push(merged.subarray(start, newline));
      start = newline + 1;
    }

    this.#carry = merged.subarray(start);
    if (this.#carry.length > MAX_CARRY_BYTES) {
      this.#carry = new Uint8Array(0);
      return undefined;
    }
    return lines;
  }

  /** Bytes held back for the next chunk. Zero between lines. */
  get pending(): number {
    return this.#carry.length;
  }

  /** Forget a partial line. A reconnect is a different process mid-sentence. */
  reset(): void {
    this.#carry = new Uint8Array(0);
  }
}
