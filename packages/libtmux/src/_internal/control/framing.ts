/**
 * Turn a byte stream into the lines tmux's control protocol is written in.
 *
 * A socket hands over whatever arrived, which is not a line: one read can carry
 * half of one, six of them, or the tail of one and the head of the next. Every
 * layer above this deals in complete lines, so the split happens once, here.
 *
 * Separate from the connection because it is the one part of reading tmux that
 * is a pure function of the bytes. The connection owns a process, a command
 * queue, and a set of subscribers; none of that is needed to answer where the
 * newlines are, and keeping it out means this can be tested without a server.
 */

const NEWLINE = 0x0a;

/**
 * A line tmux has not terminated.
 *
 * Its longest legitimate form is one command's output line, so past this the
 * stream is no longer something the protocol can parse — and holding more of it
 * only postpones the same conclusion while the heap grows.
 */
export const MAX_CARRY_BYTES: number = 16 * 1024 * 1024;

export class LineFramer {
  #carry = new Uint8Array(0);

  /**
   * The complete lines this chunk finished, in order.
   *
   * A partial tail is held for the next chunk rather than returned, so a caller
   * never sees half a line. `undefined` says the carry outgrew its bound and
   * the framer has given up; it discards what it held, so a caller that keeps
   * going does not leak it.
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

  /**
   * Forget a partial line.
   *
   * A reconnect is a different tmux process, so whatever the last one had
   * started saying is not the beginning of what this one will say.
   */
  reset(): void {
    this.#carry = new Uint8Array(0);
  }
}
