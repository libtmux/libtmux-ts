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

import type { ConnectedServer, TmuxEvent } from "libtmux";
import type { Server } from "libtmux/server";

import { TextFilter } from "./text.js";

/** How long an idle connection is kept before it is closed. */
const LINGER_MS = 30_000;

/** How much of a pane's output one tail retains. */
const DEFAULT_TAIL_BYTES = 256 * 1024;

/**
 * A pane's output as readable text with an absolute cursor.
 *
 * The cursor counts characters seen since the tail opened, so a reader that
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
  #buffer = "";
  /** Absolute offset of the first character still held. */
  #base = 0;
  #end = 0;
  readonly #filter = new TextFilter();
  readonly #limit: number;
  #waiters: (() => void)[] = [];
  readonly paneId: string;

  constructor(paneId: string, limit: number = DEFAULT_TAIL_BYTES) {
    this.paneId = paneId;
    this.#limit = limit;
  }

  /** The offset a reader should quote to be told only what comes next. */
  get cursor(): number {
    return this.#end;
  }

  append(raw: string): void {
    const data = this.#filter.push(raw);
    if (data === "") return;
    this.#buffer += data;
    this.#end += data.length;
    if (this.#buffer.length > this.#limit) {
      const excess = this.#buffer.length - this.#limit;
      this.#buffer = this.#buffer.slice(excess);
      this.#base += excess;
    }
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const wake of waiting) wake();
  }

  /**
   * Resolve when more output arrives, when `timeoutMs` passes, or when `signal`
   * aborts.
   *
   * Lets a reader wait on the stream itself rather than re-asking it, which is
   * what makes a wait cost nothing while nothing is happening. The signal is
   * what lets a caller that has gone away stop it early.
   */
  changed(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((entry) => entry !== wake);
        resolve();
      }, timeoutMs);
      const wake = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      signal?.addEventListener("abort", wake, { once: true });
      this.#waiters.push(wake);
    });
  }

  /**
   * What arrived after `from`.
   *
   * `missedBytes` is what fell out of the buffer before this read reached it —
   * the difference between "the pane printed nothing" and "it printed more than
   * was kept", which are the same empty answer otherwise.
   */
  read(from: number | undefined): {
    readonly cursor: number;
    readonly missedBytes: number;
    readonly text: string;
  } {
    const start = from ?? this.#base;
    const missed = Math.max(0, this.#base - start);
    const offset = Math.max(0, start - this.#base);
    return {
      cursor: this.#end,
      missedBytes: missed,
      text: this.#buffer.slice(offset),
    };
  }
}

interface SessionLink {
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly connected: ConnectedServer;
  /** Set when the connection died; a later acquire opens a fresh one. */
  failed: boolean;
  readonly listeners: Set<(event: TmuxEvent) => void>;
  readonly tails: Map<string, PaneTail>;
}

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
  #closed = false;

  constructor(tmux: Server) {
    this.#tmux = tmux;
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
    const connected = await this.#tmux.connect({ target: sessionId });
    const link: SessionLink = {
      closeTimer: undefined,
      connected,
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
    try {
      for await (const event of events) {
        if (event.kind === "output" || event.kind === "extended-output") {
          link.tails.get(event.paneId)?.append(event.data);
        }
        for (const listener of link.listeners) listener(event);
      }
    } catch {
      // A dead connection is a state, not an incident: the next acquire opens
      // a fresh one, and a tool that was reading gets an empty delta it can
      // tell apart by the cursor not moving.
    } finally {
      link.failed = true;
      if (this.#links.get(sessionId) === link) this.#links.delete(sessionId);
      await events.close().catch(() => undefined);
      await link.connected.close().catch(() => undefined);
    }
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
    const existing = link.tails.get(paneId);
    if (existing !== undefined) return existing;
    const tail = new PaneTail(paneId);
    link.tails.set(paneId, tail);
    return tail;
  }

  /** Whether a tail is already running, which decides if a read can be a delta. */
  hasTail(sessionId: string, paneId: string): boolean {
    return this.#links.get(sessionId)?.tails.has(paneId) ?? false;
  }

  /**
   * Call `listener` for every notification on a session until the returned
   * function is called.
   */
  async listen(
    sessionId: string,
    listener: (event: TmuxEvent) => void,
  ): Promise<(() => void) | undefined> {
    let link: SessionLink;
    try {
      link = await this.#link(sessionId);
    } catch {
      return undefined;
    }
    link.listeners.add(listener);
    return () => {
      link.listeners.delete(listener);
      this.#scheduleClose(sessionId, link);
    };
  }

  #scheduleClose(sessionId: string, link: SessionLink): void {
    if (link.tails.size > 0 || link.listeners.size > 0) return;
    if (link.closeTimer !== undefined) return;
    link.closeTimer = setTimeout(() => {
      if (link.tails.size > 0 || link.listeners.size > 0) return;
      if (this.#links.get(sessionId) === link) this.#links.delete(sessionId);
      void link.connected.close().catch(() => undefined);
    }, LINGER_MS);
    // A lingering connection must not be what keeps the process alive.
    link.closeTimer.unref?.();
  }

  async close(): Promise<void> {
    this.#closed = true;
    const links = [...this.#links.values()];
    this.#links.clear();
    await Promise.all(
      links.map(async (link) => {
        if (link.closeTimer !== undefined) clearTimeout(link.closeTimer);
        await link.connected.close().catch(() => undefined);
      }),
    );
  }
}
