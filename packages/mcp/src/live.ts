/**
 * One control-mode connection per observed session, shared by everything.
 *
 * A control client is told about pane output only for panes in the session it
 * attached to — `control_write_output` returns early unless the pane's window is
 * linked into that client's session — so one connection cannot tail a server.
 * The unit that can is a session, which is why these are keyed by session and
 * opened only for sessions somebody is actually watching.
 *
 * Attaching does not resize anything. tmux ignores a control client's size
 * unless that client has asked for one with `refresh-client -C`, which nothing
 * here sends; without it the connection is invisible to window sizing.
 */

import { randomUUID } from "node:crypto";

import type { ConnectedServer, TmuxEvent } from "libtmux";
import type { Server } from "libtmux/server";

import { TextFilter } from "./text.js";

/** How long an idle connection is kept before it is closed. */
const LINGER_MS = 30_000;

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
  readonly #filter = new TextFilter();
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

interface SessionLink {
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly connected: ConnectedServer;
  readonly ended: Promise<PaneTailEndReason>;
  endReason: PaneTailEndReason | undefined;
  readonly finish: (reason: PaneTailEndReason) => void;
  /** Set when the connection died; a later acquire opens a fresh one. */
  failed: boolean;
  readonly listeners: Set<(event: TmuxEvent) => void>;
  readonly tails: Map<string, PaneTail>;
}

const TAIL_INVALIDATING_EVENTS = new Set<TmuxEvent["kind"]>([
  "layout-change",
  "sessions-changed",
  "unlinked-window-add",
  "unlinked-window-close",
  "window-add",
  "window-close",
  "window-pane-changed",
]);

/** Stop a notification listener and observe why its connection ended. */
export type LiveListener = (() => void) & { readonly ended: Promise<PaneTailEndReason> };

/**
 * The connections this process holds, and the tails reading them.
 *
 * Shared deliberately: an agent captures a pane, waits on it, then captures it
 * again, and reconnecting between those costs a tmux client attach each time.
 */
export class LiveHub {
  readonly #links = new Map<string, SessionLink>();
  readonly #opening = new Map<string, Promise<SessionLink>>();
  readonly #tmux: Server;

  /** Whether this hub has begun its terminal close. */
  get closed(): boolean {
    return this.#closed;
  }
  readonly #abort = new AbortController();
  /** How long a tail may go unread, and a link unused, before both are let go. */
  readonly #lingerMs: number;
  #closed = false;

  constructor(tmux: Server, options: { readonly lingerMs?: number } = {}) {
    this.#tmux = tmux;
    this.#lingerMs = options.lingerMs ?? LINGER_MS;
  }

  /**
   * The link for a session, opened if this is the first interest in it.
   *
   * Concurrent callers share one attach: two tools asking about the same
   * session at once would otherwise each spawn a client, and tmux would count
   * both.
   */
  async #link(sessionId: string): Promise<SessionLink> {
    if (this.#closed) throw new Error("live connections are closed");
    const existing = this.#links.get(sessionId);
    if (existing !== undefined && !existing.failed) {
      if (existing.closeTimer !== undefined) {
        clearTimeout(existing.closeTimer);
        existing.closeTimer = undefined;
      }
      return existing;
    }
    const pending = this.#opening.get(sessionId);
    if (pending !== undefined) return pending;

    const opening = this.#open(sessionId);
    this.#opening.set(sessionId, opening);
    try {
      return await opening;
    } finally {
      this.#opening.delete(sessionId);
    }
  }

  async #open(sessionId: string): Promise<SessionLink> {
    const connected = await this.#tmux.connect({ signal: this.#abort.signal, target: sessionId });
    if (this.#closed) {
      await connected.close().catch(() => undefined);
      throw new Error("live connections are closed");
    }
    let finish!: (reason: PaneTailEndReason) => void;
    const ended = new Promise<PaneTailEndReason>((resolve) => {
      finish = resolve;
    });
    const link: SessionLink = {
      closeTimer: undefined,
      connected,
      ended,
      endReason: undefined,
      finish,
      failed: false,
      listeners: new Set(),
      tails: new Map(),
    };
    this.#links.set(sessionId, link);
    void this.#pump(sessionId, link);
    return link;
  }

  /**
   * Fan one connection's notifications out to its tails and listeners.
   *
   * Runs until the connection ends. A connection that ends is marked failed
   * rather than reopened here: reopening on a session that was killed would
   * spin, and the next acquire is where a caller can be told instead.
   */
  async #pump(sessionId: string, link: SessionLink): Promise<void> {
    const events = link.connected.subscribe();
    let reason: PaneTailEndReason = "connection_lost";
    let dropped = events.dropped;
    try {
      for await (const event of events) {
        if (events.dropped !== dropped) {
          reason = "events_dropped";
          dropped = events.dropped;
          break;
        }
        if (event.kind === "output") {
          link.tails.get(event.paneId)?.append(event.data);
        } else if (TAIL_INVALIDATING_EVENTS.has(event.kind)) {
          for (const tail of link.tails.values()) tail.close("topology_changed");
          link.tails.clear();
        }
        for (const listener of link.listeners) listener(event);
      }
    } catch {
      // A dead connection is a state, not an incident. Ending the tails below
      // wakes readers so none can mistake it for a quiet pane.
    } finally {
      if (events.dropped !== dropped) reason = "events_dropped";
      this.#endLink(link, reason);
      if (this.#links.get(sessionId) === link) this.#links.delete(sessionId);
      await events.close().catch(() => undefined);
      await link.connected.close().catch(() => undefined);
    }
  }

  #endLink(link: SessionLink, reason: PaneTailEndReason): void {
    if (link.endReason !== undefined) return;
    link.endReason = reason;
    link.failed = true;
    for (const tail of link.tails.values()) tail.close(reason);
    link.finish(reason);
  }

  /**
   * A tail on a pane, started if this is the first interest in it.
   *
   * Returns undefined when no connection can be had — a server whose session is
   * gone, or one that refuses control mode — so a caller can fall back to
   * capturing rather than fail.
   */
  async tail(sessionId: string, paneId: string): Promise<PaneTail | undefined> {
    let link: SessionLink;
    try {
      link = await this.#link(sessionId);
    } catch {
      return undefined;
    }
    if (link.failed) return undefined;
    const existing = link.tails.get(paneId);
    if (existing !== undefined) {
      this.#scheduleClose(sessionId, link);
      return existing;
    }
    const tail = new PaneTail(paneId);
    link.tails.set(paneId, tail);
    // Starts the sweep. Without this a tail created and then abandoned would
    // hold its connection forever, since nothing else schedules a close.
    this.#scheduleClose(sessionId, link);
    return tail;
  }

  /** Whether a tail is already running, which decides if a read can be a delta. */
  hasTail(sessionId: string, paneId: string): boolean {
    return this.#links.get(sessionId)?.tails.has(paneId) ?? false;
  }

  /**
   * Hold one connection for the notifications that are not about a pane.
   *
   * tmux's structural notifications — a window added, closed or renamed, the
   * session list changing — are global rather than session-scoped, so one
   * connection hears about the whole server. What it is anchored to only
   * decides where it is attached, not what it is told.
   *
   * The anchor is told not to detach when that session is destroyed. Under
   * tmux's default the connection would simply drop, and this is the one
   * connection whose whole purpose is to still be there; with the flag set,
   * tmux re-anchors the client to another session and names it in a
   * `%session-changed`. `refresh-client -f` sets client flags and nothing
   * else — it is not `-C`, which is what makes a persistent connection start
   * resizing the panes of whoever is attached.
   *
   * With no session on the server there is nothing to anchor to and this
   * returns undefined: a control client cannot attach to nothing, and creating
   * a session to hold one would change the server as a side effect of reading
   * it.
   */
  async anchor(listener: (event: TmuxEvent) => void): Promise<LiveListener | undefined> {
    const snapshot = await this.#tmux.snapshot().catch(() => undefined);
    const session = snapshot?.sessions.toArray()[0];
    if (session === undefined) return undefined;
    const stop = await this.listen(session.id, listener);
    if (stop === undefined) return undefined;
    await this.#links
      .get(session.id)
      ?.connected.cmd("refresh-client", ["-f", "no-detach-on-destroy"], { target: null })
      .catch(() => undefined);
    return stop;
  }

  /**
   * Call `listener` for every notification on a session until the returned
   * function is called.
   */
  async listen(
    sessionId: string,
    listener: (event: TmuxEvent) => void,
  ): Promise<LiveListener | undefined> {
    let link: SessionLink;
    try {
      link = await this.#link(sessionId);
    } catch {
      return undefined;
    }
    if (link.failed) return undefined;
    link.listeners.add(listener);
    const stop = (): void => {
      link.listeners.delete(listener);
      this.#scheduleClose(sessionId, link);
    };
    Object.defineProperty(stop, "ended", { enumerable: true, value: link.ended });
    return stop as LiveListener;
  }

  /**
   * Let go of a session's connection once nothing is using it.
   *
   * This used to refuse to run while the link held any tail, and nothing ever
   * removed one — so for any session a tool had observed, `tails.size` stayed
   * above zero for the life of the process and the linger could never elapse.
   * The server accumulated one control-mode client per observed session and
   * released none of them; tmux counts every one.
   *
   * A tail nobody has read within the linger is not being watched, so it goes.
   * That invalidates its cursor, which is only safe because a cursor from a
   * replaced tail is now refused with an explanation rather than answered with
   * a silent "nothing new".
   */
  #scheduleClose(sessionId: string, link: SessionLink, delayMs = this.#lingerMs): void {
    if (link.listeners.size > 0) return;
    if (link.closeTimer !== undefined) return;
    link.closeTimer = setTimeout(() => {
      link.closeTimer = undefined;
      const now = Date.now();
      for (const [paneId, tail] of link.tails) {
        if (tail.idleMs(now) >= this.#lingerMs) {
          tail.close("expired");
          link.tails.delete(paneId);
        }
      }
      if (link.tails.size > 0 || link.listeners.size > 0) {
        // Come back when the tail used most recently becomes eligible, rather
        // than a whole linger from now. The timer is armed when a tail is
        // created and a tail is read just after that, so it is always a little
        // short of the threshold on the first sweep — and waiting another full
        // linger each time doubled how long a connection nobody was reading
        // stayed open.
        const remaining = [...link.tails.values()].map((tail) => this.#lingerMs - tail.idleMs(now));
        this.#scheduleClose(sessionId, link, Math.max(1, Math.max(...remaining)));
        return;
      }
      if (this.#links.get(sessionId) === link) this.#links.delete(sessionId);
      this.#endLink(link, "expired");
      void link.connected.close().catch(() => undefined);
    }, delayMs);
    // A lingering connection must not be what keeps the process alive.
    link.closeTimer.unref?.();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    const opening = [...this.#opening.values()];
    const links = [...this.#links.values()];
    this.#links.clear();
    await Promise.all(
      links.map(async (link) => {
        if (link.closeTimer !== undefined) clearTimeout(link.closeTimer);
        this.#endLink(link, "hub_closed");
        await link.connected.close().catch(() => undefined);
      }),
    );
    await Promise.allSettled(opening);
  }
}
