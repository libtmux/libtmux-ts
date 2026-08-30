import { randomUUID } from "node:crypto";

import { TextFilter } from "./text.js";

/** How much of a pane's output one tail retains. */
const DEFAULT_TAIL_BYTES = 256 * 1024;

/** The wire shape of a cursor returned by {@link PaneTail}. */
export const PANE_CURSOR_PATTERN = /^ltxc1\.[0-9a-f]{32}\.(?:0|[1-9][0-9]*)$/u;

export type PaneTailChange = "cancelled" | "changed" | "closed" | "timed_out";

export type PaneTailEndReason =
  | "connection_lost"
  | "events_dropped"
  | "expired"
  | "hub_closed"
  | "topology_changed";

export type PaneCursorProblem =
  | { readonly kind: "ahead"; readonly bytes: number }
  | { readonly kind: "different_stream" }
  | { readonly kind: "malformed" };

interface ParsedCursor {
  readonly generation: string;
  readonly offset: number;
}

function parseCursor(cursor: string): ParsedCursor | undefined {
  if (!PANE_CURSOR_PATTERN.test(cursor)) return undefined;
  const [, generation, rawOffset] = cursor.split(".");
  const offset = Number(rawOffset);
  if (generation === undefined || !Number.isSafeInteger(offset)) return undefined;
  return { generation, offset };
}

/**
 * A pane's output as readable text with an absolute UTF-8 byte cursor.
 *
 * The cursor counts bytes seen since the tail opened, so a reader that
 * says where it got to is told exactly what arrived after that and nothing
 * else. Anchoring on a live stream rather than on a grid line is what makes
 * this survive `history-limit` trimming, which invalidates a grid anchor
 * silently.
 *
 * What is stored has already been through {@link TextFilter}: the raw form is
 * escape sequences a reader cannot use, and filtering on the way in is what
 * keeps the filter's state in step with the stream.
 */
export class PaneTail {
  #chunks: Buffer[] = [];
  #chunkHead = 0;
  #bufferedBytes = 0;
  /** When something last read this tail, for deciding whether it is still wanted. */
  #touched = Date.now();
  /** Absolute byte offset of the first character still held. */
  #base = 0;
  #end = 0;
  #endReason: PaneTailEndReason | undefined;
  readonly #filter: TextFilter;
  readonly #generation = randomUUID().replaceAll("-", "");
  readonly #limit: number;
  readonly #waiters = new Set<(change: PaneTailChange) => void>();
  readonly paneId: string;

  constructor(paneId: string, limit: number = DEFAULT_TAIL_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("pane tail limit must be a non-negative safe integer");
    }
    this.paneId = paneId;
    this.#limit = limit;
    this.#filter = new TextFilter(limit);
  }

  /** The offset a reader should quote to be told only what comes next. */
  get cursor(): string {
    return `ltxc1.${this.#generation}.${String(this.#end)}`;
  }

  /** Why this tail can no longer receive output, if it has ended. */
  get endReason(): PaneTailEndReason | undefined {
    return this.#endReason;
  }

  append(raw: string): void {
    if (this.#endReason !== undefined) return;
    const data = this.#filter.push(raw);
    if (data === "") return;
    const bytes = Buffer.from(data, "utf8");
    this.#chunks.push(bytes);
    this.#bufferedBytes += bytes.length;
    this.#end += bytes.length;
    this.#trim();
    const waiting = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiting) wake("changed");
  }

  /** End this stream and release every reader waiting on it. */
  close(reason: PaneTailEndReason): void {
    if (this.#endReason !== undefined) return;
    this.#endReason = reason;
    const waiting = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiting) wake("closed");
  }

  /** Keep a UTF-8 boundary at the start while holding no more than the limit. */
  #trim(): void {
    let excess = this.#bufferedBytes - this.#limit;
    while (excess > 0 && this.#chunkHead < this.#chunks.length) {
      const chunk = this.#chunks[this.#chunkHead];
      if (chunk === undefined) break;
      if (excess >= chunk.length) {
        this.#chunks[this.#chunkHead] = Buffer.alloc(0);
        this.#chunkHead += 1;
        this.#base += chunk.length;
        this.#bufferedBytes -= chunk.length;
        excess -= chunk.length;
        continue;
      }

      let cut = excess;
      while (cut < chunk.length && (chunk[cut]! & 0xc0) === 0x80) cut += 1;
      this.#chunks[this.#chunkHead] = Buffer.from(chunk.subarray(cut));
      this.#base += cut;
      this.#bufferedBytes -= cut;
      excess -= cut;
    }

    if (this.#chunkHead === this.#chunks.length) {
      this.#chunks = [];
      this.#chunkHead = 0;
    } else if (this.#chunkHead >= 64 && this.#chunkHead * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#chunkHead);
      this.#chunkHead = 0;
    }
  }

  /**
   * Resolve when more output arrives, when `timeoutMs` passes, or when `signal`
   * aborts.
   *
   * Lets a reader wait on the stream itself rather than re-asking it, which is
   * what makes a wait cost nothing while nothing is happening. The signal is
   * what lets a caller that has gone away stop it early.
   *
   * The result distinguishes output, timeout, cancellation, and a stream that
   * ended. A reader must not infer those states from an unchanged cursor.
   */
  changed(timeoutMs: number, signal?: AbortSignal): Promise<PaneTailChange> {
    this.#touched = Date.now();
    if (signal?.aborted === true) return Promise.resolve("cancelled");
    if (this.#endReason !== undefined) return Promise.resolve("closed");
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (change: PaneTailChange): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.#waiters.delete(wake);
        signal?.removeEventListener("abort", cancelled);
        resolve(change);
      };
      const wake = (change: PaneTailChange): void => {
        finish(change);
      };
      const cancelled = (): void => {
        finish("cancelled");
      };
      timer = setTimeout(() => finish("timed_out"), timeoutMs);
      signal?.addEventListener("abort", cancelled, { once: true });
      this.#waiters.add(wake);
    });
  }

  /**
   * How long since anything read this tail.
   *
   * Reading is what keeps a tail alive; a pane writing into one nobody is
   * watching is not a reason to hold a connection open for it.
   */
  idleMs(now: number): number {
    return this.#waiters.size > 0 ? 0 : now - this.#touched;
  }

  cursorProblem(from: string | undefined): PaneCursorProblem | undefined {
    if (from === undefined) return undefined;
    const parsed = parseCursor(from);
    if (parsed === undefined) return { kind: "malformed" };
    if (parsed.generation !== this.#generation) return { kind: "different_stream" };
    if (parsed.offset > this.#end) return { bytes: parsed.offset - this.#end, kind: "ahead" };
    return undefined;
  }

  /**
   * What arrived after `from`.
   *
   * `missedBytes` is what could not be returned before this read reached it —
   * normally because it fell out of the buffer. A caller-supplied cursor inside
   * a multibyte character also skips to the next boundary instead of returning
   * replacement text. Cursors returned by this class are always boundaries.
   */
  read(from: string | undefined): {
    readonly cursor: string;
    readonly missedBytes: number;
    readonly text: string;
  } {
    this.#touched = Date.now();
    const problem = this.cursorProblem(from);
    if (problem !== undefined) {
      const reason =
        problem.kind === "different_stream"
          ? "cursor belongs to a different pane tail"
          : problem.kind === "ahead"
            ? "cursor is past this pane tail"
            : "malformed pane-tail cursor";
      throw new RangeError(reason);
    }
    const start = from === undefined ? this.#base : (parseCursor(from)?.offset ?? this.#base);
    let missed = Math.max(0, this.#base - start);
    let skip = Math.max(0, start - this.#base);
    const parts: Buffer[] = [];
    let size = 0;
    for (let index = this.#chunkHead; index < this.#chunks.length; index += 1) {
      const chunk = this.#chunks[index];
      if (chunk === undefined || chunk.length === 0) continue;
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      let offset = skip;
      skip = 0;
      while (offset < chunk.length && (chunk[offset]! & 0xc0) === 0x80) {
        offset += 1;
        missed += 1;
      }
      if (offset >= chunk.length) continue;
      const part = chunk.subarray(offset);
      parts.push(part);
      size += part.length;
    }
    return {
      cursor: this.cursor,
      missedBytes: missed,
      text: Buffer.concat(parts, size).toString("utf8"),
    };
  }
}
