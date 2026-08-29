import { spawn } from "node:child_process";

import type { PaneId } from "../../common.js";
import type {
  AbortLike,
  ConnectionOptions,
  TmuxEventStream,
  TmuxPaneFlowEvent,
  WatchOptions,
} from "../../types.js";
import { connectionArguments } from "../operations/request.js";
import type { TmuxConnection } from "../runtime/connection.js";
import { NodeSpawnTransport } from "../transport/node_spawn_transport.js";
import type { CommandTransport } from "../transport/types.js";
import { TmuxTransportError } from "../transport/types.js";
import { BlockTracker } from "./blocks.js";
import { ControlChildLifecycle, type ControlChild } from "./child.js";
import { completeUtf8Length, parseControlLine } from "./events.js";
import { LineFramer, MAX_CARRY_BYTES } from "./framing.js";
import { createEventStream, DEFAULT_BUFFER_SIZE, type EventSink } from "./stream.js";
import { MAX_TIMER_DELAY_MS, timerDelay } from "../timing.js";

/**
 * Bounds on what one connection may hold in memory.
 *
 * A control line has to be whole before it can be classified. This ceiling
 * keeps a peer that never sends LF from growing the carry without bound.
 */
const MAX_CONTROL_LINE_BYTES = 64 * 1024 * 1024;
/** Kept only to explain an exit, so the tail is what matters. */
const MAX_STDERR_BYTES = 64 * 1024;
/** How long a closing process is given to leave before it is killed outright. */
const TERMINATION_GRACE_MS = 2_000;

/**
 * Say a broken pipe in this package's terms.
 *
 * Node reports stream failures as its own `Error`, outside this package's
 * exception hierarchy. Translate them before they reach subscribers.
 */
export function transportFailure(failure: Error): TmuxTransportError {
  if (failure instanceof TmuxTransportError) return failure;
  const code = (failure as { readonly code?: string }).code;
  return new TmuxTransportError(
    `tmux control connection broke${code === undefined ? "" : ` (${code})`}`,
    { cause: failure, delivery: "indeterminate", kind: "pipe" },
  );
}

interface ControlConnectionOptions extends ConnectionOptions {
  readonly pauseAfterSeconds?: number;
}

type ControlChildSpawner = () => ControlChild;

/**
 * One `tmux -C` process carrying notifications and daemon-lifetime evidence.
 * Commands use process boundaries because control mode cannot frame arbitrary
 * alias-expanded or waiting command output truthfully.
 */
export class ControlConnection {
  readonly #children: ControlChildLifecycle;
  readonly #argv: readonly string[];
  readonly #commandPrefix: readonly string[];
  readonly #executable: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #reconnect: { readonly attempts: number; readonly delayMs?: number } | undefined;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Whether the process is gone and a replacement is on its way.
   *
   * Writing to the old process during this window goes nowhere: the pipe
   * accepts the bytes and no reply ever comes, so the command waits out its
   * deadline, or forever if it has none.
   */
  #reopening = false;
  readonly #streamEndsConnection: boolean;
  readonly #sinks = new Set<EventSink>();
  readonly #bufferSize: number;
  readonly #framer: LineFramer;
  /**
   * The tail of a character split across two `%output` notifications, per pane.
   *
   * An entry only exists between the halves of one character, so the map holds
   * at most one short remainder per pane that is mid-sequence, and the entry is
   * dropped as soon as the continuation arrives.
   */
  readonly #partial = new Map<string, Uint8Array>();
  readonly #blocks = new BlockTracker();
  #diagnostic: string[] = [];
  #reason: string | undefined;
  #attached: { resolve: () => void; reject: (error: Error) => void } | undefined;
  #attachment: Promise<void> | undefined;
  /**
   * How the attach turned out, once it has.
   *
   * Kept rather than only signalled. `ready()` builds its promise when it is
   * first called, so an attach settling before anyone asks has nothing to
   * settle, and every later caller would then wait on an event that already
   * happened. Recording the outcome makes the question answerable whenever it
   * is asked instead of only while it is still open.
   */
  #attachOutcome: { kind: "attached" } | { kind: "failed"; error: Error } | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #onAbort: (() => void) | undefined;
  readonly #signal: AbortLike | undefined;
  readonly #stderr: Buffer[] = [];
  #stderrBytes = 0;
  /**
   * Seconds tmux may hold a pane's output before pausing it.
   *
   * Undefined leaves tmux's own remedy: at five minutes behind it kills the
   * client with "too far behind".
   */
  readonly #pauseAfterSeconds: number | undefined;
  /** Panes tmux has paused and this connection has not yet asked back. */
  readonly #paused = new Set<PaneId>();
  /** Which reconnect attempt is in flight, so `reconnected` can name it once tmux answers. */
  #reconnectingAttempt: number | undefined;

  /**
   * @param streamEndsConnection
   *   Whether draining the event stream ends the process. A stream opened by
   *   `watch()` is the only holder, so it does; a stream reached through a
   *   connected server owns the process separately, so ending iteration there
   *   must not close its daemon-lifetime observer.
   */
  /**
   * Commands that target this observer, such as pause and resume requests.
   */
  readonly #observerCommands: CommandTransport | undefined;

  /**
   * Told when this connection stops being proof of one daemon.
   *
   * A control client is attached to a daemon for its lifetime, so it never needs
   * the inline guard a spawned command carries — but a reconnect attaches to
   * whatever is on the socket now, which may be a successor that reissued every
   * id. Announcing the drop is what lets the runtime retire the handles the old
   * daemon handed out.
   */
  #onDaemonLost: (() => void) | undefined;

  constructor(
    connection: TmuxConnection,
    options: ControlConnectionOptions = {},
    streamEndsConnection = true,
    observerCommands?: CommandTransport,
    spawnChild?: ControlChildSpawner,
  ) {
    this.#observerCommands = observerCommands;
    const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    // Validated before the spawn, so a rejected size cannot leak a process.
    if (!Number.isInteger(bufferSize) || bufferSize < 1) {
      throw new TypeError("bufferSize must be a positive integer");
    }
    const pauseAfterSeconds = options.pauseAfterSeconds;
    const reconnect = options.reconnect;
    if (
      pauseAfterSeconds !== undefined &&
      (!Number.isInteger(pauseAfterSeconds) || pauseAfterSeconds < 1)
    ) {
      throw new TypeError("pauseAfterSeconds must be a positive integer");
    }
    if (reconnect !== undefined) {
      if (!Number.isSafeInteger(reconnect.attempts) || reconnect.attempts < 1) {
        throw new TypeError("reconnect.attempts must be a positive safe integer");
      }
      const delayMs = reconnect.delayMs ?? 50;
      timerDelay("reconnect.delayMs", delayMs);
      if (delayMs > 0 && reconnect.attempts > Math.floor(MAX_TIMER_DELAY_MS / delayMs)) {
        throw new TypeError("reconnect.delayMs exceeds the timer range across its attempts");
      }
    }
    this.#framer = new LineFramer(Math.max(MAX_CARRY_BYTES, MAX_CONTROL_LINE_BYTES));
    this.#pauseAfterSeconds = pauseAfterSeconds;
    const globals = connectionArguments(connection);
    this.#commandPrefix = Object.freeze([...globals]);
    this.#signal = options.signal;

    // A bare `tmux -C` is a control client that never attached, and tmux sends
    // it no %output at all. Attaching is what makes the pane stream arrive.
    const argv = [
      ...globals,
      // Watching observes a server; it must never bring one into being. Without
      // this, attaching to a socket whose server has gone away creates a socket
      // at that path and starts a server behind it, only to report "no
      // sessions" — leaving a stray server and a path that no longer belongs to
      // whoever owned it.
      "-N",
      "-C",
      "attach-session",
      ...(options.target === undefined ? [] : ["-t", options.target]),
    ];
    this.#argv = Object.freeze(argv);
    this.#executable = connection.executable;
    this.#environment = connection.environment;
    this.#reconnect =
      reconnect === undefined
        ? undefined
        : Object.freeze({
            attempts: reconnect.attempts,
            ...(reconnect.delayMs === undefined ? {} : { delayMs: reconnect.delayMs }),
          });
    this.#children = new ControlChildLifecycle(spawnChild ?? (() => this.#spawn()));

    this.#bufferSize = bufferSize;
    this.#streamEndsConnection = streamEndsConnection;
    if (this.#signal !== undefined) {
      this.#onAbort = () => void this.close();
      if (this.#signal.aborted) this.#onAbort();
      else this.#signal.addEventListener("abort", this.#onAbort, { once: true });
    }
    if (!this.#closed) this.#openChild();
  }

  /**
   * Resolve once tmux has accepted the attach, or reject with its reason.
   *
   * tmux answers an attach with a block of its own: empty on success, and
   * carrying its explanation on failure — "no sessions" for an empty server,
   * "can't find session" for a target that is not there. Waiting for it here
   * means a caller learns why at the point they asked to connect, rather than
   * finding out through whichever command happens to run first.
   */
  ready(): Promise<void> {
    if (this.#attachOutcome !== undefined) {
      return this.#attachOutcome.kind === "attached"
        ? Promise.resolve()
        : Promise.reject(this.#attachOutcome.error);
    }
    this.#attachment ??= new Promise<void>((resolve, reject) => {
      if (this.#closed) {
        reject(new Error(this.#reason ?? "tmux control connection is closed"));
        return;
      }
      this.#attached = { reject, resolve };
    });
    return this.#attachment;
  }

  /**
   * Open an independent view of this connection's notifications.
   *
   * Each subscriber gets its own buffer, so one falling behind drops its own
   * events rather than everyone's, and a caller's `for await` can run beside a
   * `waitFor` without either stealing from the other. A stream consumes what it
   * is given, so sharing one would make the two silently take turns.
   */
  subscribe(): TmuxEventStream {
    const sink: EventSink = createEventStream(
      async () => {
        // Forget the subscriber before anything else: every notification is
        // pushed to every sink and buffered there, so one left behind keeps
        // filling. `waitFor` subscribes internally, so a long-lived connection
        // accumulates one per wait.
        this.#sinks.delete(sink);
        if (this.#streamEndsConnection) await this.close();
      },
      this.#bufferSize,
      () => this.ready(),
    );
    this.#sinks.add(sink);
    if (this.#closed) sink.finish(undefined);
    return sink.stream;
  }

  #spawn(): ControlChild {
    return spawn(this.#executable, [...this.#argv], {
      // Exactly the environment the connection was given, as the spawning
      // transport does. Overlaying it on `process.env` would make
      // `ServerOptions.environment` mean one thing per transport, and hand the
      // whole ambient environment to the tmux server.
      env: this.#environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  #openChild(): ControlChild {
    return this.#children.open({
      close: (code) => {
        const message = this.#reason ?? Buffer.concat(this.#stderr).toString("utf8").trim();
        this.#fail(
          code === 0 || code === null || this.#closed
            ? undefined
            : new TmuxTransportError(
                message === ""
                  ? `tmux control mode exited with ${String(code)}`
                  : `tmux control mode could not attach: ${message}`,
                { delivery: "indeterminate", kind: "pipe" },
              ),
        );
      },
      error: (error) => this.#fail(error),
      stderr: (chunk) => {
        // Only ever read to explain an exit, so keep the tail and drop the rest
        // rather than let a chatty tmux hold the heap.
        this.#stderr.push(chunk);
        this.#stderrBytes += chunk.length;
        while (this.#stderrBytes > MAX_STDERR_BYTES) {
          const first = this.#stderr[0];
          if (first === undefined) break;
          const excess = this.#stderrBytes - MAX_STDERR_BYTES;
          if (first.length <= excess) {
            this.#stderr.shift();
            this.#stderrBytes -= first.length;
          } else {
            this.#stderr[0] = Buffer.from(first.subarray(excess));
            this.#stderrBytes -= excess;
          }
        }
      },
      stdinDrain: () => undefined,
      // The child callback reports a broken process. This stream listener keeps
      // Node from throwing the pipe error first.
      stdinError: () => undefined,
      stdout: (chunk) => this.#consume(chunk),
    });
  }

  #consume(chunk: Buffer): void {
    const lines = this.#framer.push(chunk);
    if (lines === undefined) {
      this.#fail(
        new TmuxTransportError("tmux control mode sent an unterminated line", {
          delivery: "indeterminate",
          kind: "protocol",
        }),
      );
      return;
    }
    for (const line of lines) this.#route(line);
  }

  /**
   * Decode a pane's output, carrying an incomplete character to its next line.
   *
   * tmux splits on whatever it read from the pty, not on character boundaries,
   * so decoding each notification alone turns a split character into
   * replacement bytes.
   */
  #decodeOutput = (paneId: string, payload: Uint8Array): string => {
    const held = this.#partial.get(paneId);
    let bytes = payload;
    if (held !== undefined) {
      const joined = new Uint8Array(held.length + payload.length);
      joined.set(held);
      joined.set(payload, held.length);
      bytes = joined;
      this.#partial.delete(paneId);
    }
    const complete = completeUtf8Length(bytes);
    if (complete < bytes.length) {
      // Copied out, so the remainder does not retain the whole read.
      this.#partial.set(paneId, new Uint8Array(bytes.subarray(complete)));
    }
    return new TextDecoder().decode(bytes.subarray(0, complete));
  };

  #route(line: Uint8Array): void {
    // A body can forge `%output`; do not let it mutate a pane's UTF-8 carry.
    const parsed = this.#blocks.inBlock
      ? parseControlLine(line)
      : parseControlLine(line, this.#decodeOutput);
    const position = this.#blocks.position(parsed);
    switch (position.kind) {
      case "begin":
        return;
      case "body":
        this.#routeBlockBody(line);
        return;
      case "end":
        this.#closeBlock(position.fromClient, position.failed);
        return;
      case "notification":
        if (position.event.kind === "pause" || position.event.kind === "continue") {
          this.#routeFlowControl(position.event);
          return;
        }
        for (const sink of this.#sinks) sink.push(position.event);
        return;
      default:
        return;
    }
  }

  /**
   * Take one line of a command's response.
   *
   * Inside a block every line is the command's output, whatever it starts with.
   * A pane id is `%1`, which is indistinguishable from a notification by its
   * first character, so position decides and not shape.
   */
  #routeBlockBody(line: Uint8Array): void {
    const text = new TextDecoder().decode(line);
    if (this.#diagnostic.length < 64) this.#diagnostic.push(text);
  }

  #closeBlock(fromClient: boolean, failed: boolean): void {
    if (!fromClient && !failed) {
      const child = this.#children.active();
      if (child !== undefined) void this.#finishAttach(child);
    }
    if (!fromClient && failed && this.#diagnostic.length > 0) {
      this.#reason = this.#diagnostic.join("; ");
    }
    this.#diagnostic = [];
  }

  async #finishAttach(child: ControlChild): Promise<void> {
    try {
      await this.#requestPauseAfter(child);
    } catch (error) {
      if (this.#children.active() === child) {
        this.#fail(error instanceof Error ? error : new Error("tmux refused pause-after"));
      }
      return;
    }
    if (this.#children.active() !== child || this.#closed) return;

    // A reconnect is usable only after tmux accepts the attach and restores
    // the observer's flow-control flag on the replacement client.
    this.#attachOutcome ??= { kind: "attached" };
    this.#attached?.resolve();
    this.#reopening = false;
    const recovered = this.#reconnectingAttempt;
    if (recovered !== undefined) {
      this.#reconnectingAttempt = undefined;
      for (const sink of this.#sinks) sink.push({ attempts: recovered, kind: "reconnected" });
    }
    // The budget is per outage. A connection that recovered yesterday may use
    // the same policy again after a new drop today.
    this.#attempt = 0;
  }

  /**
   * Reopen after an unexpected drop.
   *
   * Only the event connection is restored. Commands use separate tmux clients.
   */
  #tryReconnect(): boolean {
    const policy = this.#reconnect;
    if (policy === undefined || this.#closed || this.#reconnectTimer !== undefined) return false;
    if (this.#attempt >= policy.attempts) return false;
    this.#attempt += 1;
    const attempt = this.#attempt;
    this.#reconnectingAttempt = attempt;
    for (const sink of this.#sinks) sink.push({ attempts: attempt, kind: "reconnecting" });
    this.#reconnectTimer = setTimeout(
      () => {
        this.#reconnectTimer = undefined;
        if (this.#closed) return;
        this.#framer.reset();
        this.#partial.clear();
        this.#blocks.reset();
        this.#diagnostic = [];
        this.#reason = undefined;
        this.#stderr.length = 0;
        this.#stderrBytes = 0;
        this.#paused.clear();
        try {
          this.#openChild();
        } catch (error) {
          this.#fail(error instanceof Error ? error : new Error("tmux control mode did not start"));
        }
      },
      (policy.delayMs ?? 50) * attempt,
    );
    return true;
  }

  #fail(raw: Error | undefined): void {
    const failure = raw === undefined ? undefined : transportFailure(raw);
    // Before deciding whether to reconnect: either way this connection is no
    // longer evidence that the daemon its ids came from is the one answering.
    // A deliberate close is not that — the runtime is going away with it.
    if (!this.#closed && !this.#reopening) this.#onDaemonLost?.();
    this.#children.retire();
    if (this.#tryReconnect()) {
      this.#reopening = true;
      return;
    }
    this.#closed = true;
    this.#releaseAbort();
    const reason = failure ?? new Error("tmux control connection closed");
    this.#attachOutcome ??= { error: reason, kind: "failed" };
    this.#attached?.reject(reason);
    for (const sink of this.#sinks) sink.finish(failure);
  }

  /**
   * Ask tmux to pause a pane rather than kill this client when it falls behind.
   *
   * This travels on a spawned command targeted at the observer. Sharing the
   * observer's stream would make a literal `%pause` command result impossible
   * to distinguish from a notification.
   */
  async #requestPauseAfter(child: ControlChild): Promise<void> {
    const seconds = this.#pauseAfterSeconds;
    if (seconds === undefined) return;
    const fallback = this.#observerCommands;
    if (fallback === undefined || child.pid === undefined) {
      throw new Error("watch observer has no spawning transport");
    }
    const result = await fallback.execute({
      commands: [
        [
          "refresh-client",
          "-t",
          `client-${String(child.pid)}`,
          "-f",
          `pause-after=${String(seconds)}`,
        ],
      ],
      executable: this.#executable,
      environment: this.#environment,
      globalArgs: this.#commandPrefix,
      timeoutMs: 30_000,
    });
    if (result.returncode !== 0) {
      throw new TmuxTransportError("tmux refused pause-after", {
        delivery: "replied",
        kind: "protocol",
      });
    }
  }

  /** Publish a pause or resume, and ask a paused pane back. */
  #routeFlowControl(event: TmuxPaneFlowEvent): void {
    this.#partial.delete(event.paneId);
    if (event.kind === "pause") this.#paused.add(event.paneId);
    else this.#paused.delete(event.paneId);
    for (const sink of this.#sinks) sink.push(event);
    // tmux sends nothing more for a paused pane until told otherwise.
    if (event.kind === "pause") this.#resumePane(event.paneId);
  }

  /** Ask tmux to resume a pane it paused. tmux answers with `%continue`. */
  #resumePane(paneId: PaneId): void {
    const fallback = this.#observerCommands;
    const child = this.#children.active();
    if (fallback === undefined || child?.pid === undefined) return;
    const request = {
      commands: [
        ["refresh-client", "-t", `client-${String(child.pid)}`, "-A", `${paneId}:continue`],
      ] as const,
      executable: this.#executable,
      environment: this.#environment,
      globalArgs: this.#commandPrefix,
      timeoutMs: 30_000,
    };
    const isCurrent = (): boolean =>
      !this.#closed && this.#children.active() === child && this.#paused.has(paneId);
    void Promise.resolve()
      .then(() => fallback.execute(request))
      .then(
        (result) => {
          if (!isCurrent() || result.returncode === 0) return;
          this.#fail(
            new TmuxTransportError("tmux refused pane resume", {
              delivery: "replied",
              kind: "protocol",
              signal: result.signal,
              stderr: result.stderr,
              stdout: result.stdout,
            }),
          );
        },
        (error: unknown) => {
          if (!isCurrent()) return;
          this.#fail(error instanceof Error ? error : new Error("pane resume command failed"));
        },
      );
  }

  onDaemonLost(notify: () => void): void {
    this.#onDaemonLost = notify;
  }

  /** Refuse work while this observer cannot vouch for its connected server. */
  assertAvailable(): void {
    if (this.#closed) {
      throw new TmuxTransportError("tmux control connection is closed", {
        delivery: "not_started",
        kind: "pipe",
      });
    }
    if (this.#reopening) {
      throw new TmuxTransportError("tmux control connection is reconnecting", {
        delivery: "not_started",
        kind: "pipe",
      });
    }
  }

  #releaseAbort(): void {
    if (this.#signal === undefined || this.#onAbort === undefined) return;
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#onAbort = undefined;
  }

  #waitForRetirement(child: ControlChild): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      child.once("close", settled);
      child.once("error", settled);
      // The lifecycle escalates after one grace period. A second bounds close
      // even when descendants keep inherited pipes open after SIGKILL.
      timer = setTimeout(resolve, TERMINATION_GRACE_MS * 2);
      timer.unref?.();
    });
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#releaseAbort();
    if (this.#closed) return;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const child = this.#children.active();
    const retired = child === undefined ? Promise.resolve() : this.#waitForRetirement(child);
    this.#closed = true;
    for (const sink of this.#sinks) sink.cancel();
    // Said before #fail, which cannot tell this from the connection dropping:
    // a subscriber ending because its caller closed is an answer to a wait, not
    // a failure of one.
    this.#fail(undefined);
    await retired;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Open a control-mode event stream against a server. */
export function watchServer(connection: TmuxConnection, options?: WatchOptions): TmuxEventStream {
  return new ControlConnection(connection, options, true, new NodeSpawnTransport()).subscribe();
}
