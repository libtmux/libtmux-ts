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

import { requireActive, waitForAbort } from "./abort.js";
import { PaneTail, type PaneTailEndReason } from "./pane_tail.js";

/** How long an idle connection is kept before it is closed. */
const LINGER_MS = 30_000;
/** How long a control client may take to reach its first ready block. */
const CONNECT_TIMEOUT_MS = 30_000;

interface SessionLink {
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly connected: ConnectedServer;
  endReason: PaneTailEndReason | undefined;
  /** Set when the connection died; a later acquire opens a fresh one. */
  failed: boolean;
  readonly listeners: Set<LiveListenerEntry>;
  readonly tails: Map<string, PaneTail>;
}

interface LiveListenerEntry {
  active: boolean;
  readonly finish: (reason: LiveListenerEndReason) => void;
  readonly notify: (event: TmuxEvent) => void;
}

interface OpeningLink {
  readonly abort: AbortController;
  readonly promise: Promise<SessionLink>;
  waiters: number;
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
export type LiveListenerEndReason = PaneTailEndReason | "listener_stopped";
export type LiveListener = (() => void) & {
  readonly active: boolean;
  readonly ended: Promise<LiveListenerEndReason>;
};

/**
 * The connections this process holds, and the tails reading them.
 *
 * Shared deliberately: an agent captures a pane, waits on it, then captures it
 * again, and reconnecting between those costs a tmux client attach each time.
 */
export class LiveHub {
  readonly #connecting = new Set<Promise<void>>();
  readonly #finalizing = new Set<Promise<void>>();
  readonly #links = new Map<string, SessionLink>();
  readonly #opening = new Map<string, OpeningLink>();
  readonly #tmux: Server;

  /** Whether this hub has begun its terminal close. */
  get closed(): boolean {
    return this.#closed;
  }
  readonly #abort = new AbortController();
  /** Maximum time allowed for one control connection to become ready. */
  readonly #connectTimeoutMs: number;
  #closePromise: Promise<void> | undefined;
  /** How long a tail may go unread, and a link unused, before both are let go. */
  readonly #lingerMs: number;
  #closed = false;

  constructor(
    tmux: Server,
    options: { readonly connectTimeoutMs?: number; readonly lingerMs?: number } = {},
  ) {
    this.#tmux = tmux;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.#lingerMs = options.lingerMs ?? LINGER_MS;
  }

  /**
   * The link for a session, opened if this is the first interest in it.
   *
   * Concurrent callers share one attach: two tools asking about the same
   * session at once would otherwise each spawn a client, and tmux would count
   * both.
   */
  async #link(sessionId: string, signal?: AbortSignal): Promise<SessionLink> {
    if (this.#closed) throw new Error("live connections are closed");
    requireActive(signal);
    const existing = this.#links.get(sessionId);
    if (existing !== undefined && !existing.failed) {
      if (existing.closeTimer !== undefined) {
        clearTimeout(existing.closeTimer);
        existing.closeTimer = undefined;
      }
      return existing;
    }
    let opening = this.#opening.get(sessionId);
    if (opening?.abort.signal.aborted === true) opening = undefined;
    if (opening === undefined) {
      const abort = new AbortController();
      let tracked!: OpeningLink;
      const promise = this.#open(sessionId, abort).finally(() => {
        if (this.#opening.get(sessionId) === tracked) this.#opening.delete(sessionId);
      });
      tracked = { abort, promise, waiters: 0 };
      opening = tracked;
      this.#opening.set(sessionId, opening);
    }
    opening.waiters += 1;
    try {
      return await waitForAbort(opening.promise, signal);
    } finally {
      opening.waiters -= 1;
      if (signal?.aborted === true && opening.waiters === 0) {
        if (this.#opening.get(sessionId) === opening) {
          this.#opening.delete(sessionId);
          opening.abort.abort();
        }
        void opening.promise.then(
          (link) => {
            this.#scheduleClose(sessionId, link, 0);
          },
          () => undefined,
        );
      }
    }
  }

  async #open(sessionId: string, opening: AbortController): Promise<SessionLink> {
    const lifecycle = Promise.withResolvers<void>();
    this.#connecting.add(lifecycle.promise);
    let lifecycleFinished = false;
    const finishLifecycle = (): void => {
      if (lifecycleFinished) return;
      lifecycleFinished = true;
      this.#connecting.delete(lifecycle.promise);
      lifecycle.resolve();
    };
    const abort = (): void => {
      opening.abort();
    };
    this.#abort.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, this.#connectTimeoutMs);
    deadline.unref?.();
    let connecting: Promise<ConnectedServer> | undefined;
    let connected: ConnectedServer;
    try {
      connecting = this.#tmux.connect({ signal: opening.signal, target: sessionId });
      connected = await waitForAbort(connecting, opening.signal);
    } catch (error) {
      if (connecting !== undefined) {
        void connecting.then(
          async (late) => {
            await late.close().catch(() => undefined);
            finishLifecycle();
          },
          () => {
            finishLifecycle();
          },
        );
      } else {
        finishLifecycle();
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      this.#abort.signal.removeEventListener("abort", abort);
    }
    const stillOwned = this.#opening.get(sessionId)?.abort === opening;
    if (this.#closed || opening.signal.aborted || !stillOwned) {
      await connected.close().catch(() => undefined);
      finishLifecycle();
      throw new Error(this.#closed ? "live connections are closed" : "live connection cancelled");
    }
    const link: SessionLink = {
      closeTimer: undefined,
      connected,
      endReason: undefined,
      failed: false,
      listeners: new Set(),
      tails: new Map(),
    };
    this.#links.set(sessionId, link);
    const finalizing = this.#pump(sessionId, link);
    this.#finalizing.add(finalizing);
    void finalizing.then(
      () => this.#finalizing.delete(finalizing),
      () => this.#finalizing.delete(finalizing),
    );
    finishLifecycle();
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
        // The map key is the attached session; rehoming makes this link stale.
        if (event.kind === "session-changed") {
          reason = "topology_changed";
          break;
        }
        if (event.kind === "output") {
          link.tails.get(event.paneId)?.append(event.data);
        } else if (TAIL_INVALIDATING_EVENTS.has(event.kind)) {
          for (const tail of link.tails.values()) tail.close("topology_changed");
          link.tails.clear();
        }
        for (const listener of link.listeners) listener.notify(event);
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
    for (const listener of link.listeners) {
      listener.active = false;
      listener.finish(reason);
    }
    link.listeners.clear();
  }

  /**
   * A tail on a pane, started if this is the first interest in it.
   *
   * Returns undefined when no connection can be had — a server whose session is
   * gone, or one that refuses control mode — so a caller can fall back to
   * capturing rather than fail.
   */
  async tail(
    sessionId: string,
    paneId: string,
    signal?: AbortSignal,
  ): Promise<PaneTail | undefined> {
    let link: SessionLink;
    try {
      link = await this.#link(sessionId, signal);
    } catch {
      return undefined;
    }
    if (link.failed || signal?.aborted === true) {
      this.#scheduleClose(sessionId, link, 0);
      return undefined;
    }
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
   * Call `listener` for every notification on a session until the returned
   * function is called.
   */
  async listen(
    sessionId: string,
    listener: (event: TmuxEvent) => void,
    signal?: AbortSignal,
  ): Promise<LiveListener | undefined> {
    let link: SessionLink;
    try {
      link = await this.#link(sessionId, signal);
    } catch {
      return undefined;
    }
    if (link.failed || signal?.aborted === true) {
      this.#scheduleClose(sessionId, link, 0);
      return undefined;
    }
    let finish!: (reason: LiveListenerEndReason) => void;
    const ended = new Promise<LiveListenerEndReason>((resolve) => {
      finish = resolve;
    });
    const entry: LiveListenerEntry = { active: true, finish, notify: listener };
    link.listeners.add(entry);
    const stop = (): void => {
      if (!entry.active) return;
      entry.active = false;
      link.listeners.delete(entry);
      finish("listener_stopped");
      this.#scheduleClose(sessionId, link);
    };
    Object.defineProperties(stop, {
      active: { enumerable: true, get: () => entry.active },
      ended: { enumerable: true, value: ended },
    });
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
    if (this.#closed) return;
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
      if (link.listeners.size > 0) return;
      if (link.tails.size > 0) {
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

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    const connecting = [...this.#connecting];
    const finalizing = [...this.#finalizing];
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
    await Promise.allSettled(opening.map(({ promise }) => promise));
    await Promise.allSettled(connecting);
    await Promise.allSettled(finalizing);
  }
}
