import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AbortLike, TmuxEventStream, WatchOptions } from "../../types.js";
import { connectionArguments } from "../operations/request.js";
import type { TmuxConnection } from "../runtime/connection.js";
import { subcommandOf } from "../transport/group.js";
import type { CommandRequest, CommandTransport, RawCommandResult } from "../transport/types.js";
import { TmuxTransportError } from "../transport/types.js";
import { BlockTracker } from "./blocks.js";
import { completeUtf8Length, parseControlLine } from "./events.js";
import { LineFramer } from "./framing.js";
import { createEventStream, DEFAULT_BUFFER_SIZE, type EventSink } from "./stream.js";

const encoder = new TextEncoder();

/** The exact shape of tmux's two flow-control notifications. */
const FLOW_CONTROL_LINE = /^%(?:pause|continue) %\d+$/u;

/**
 * Bounds on what one connection may hold in memory.
 *
 * Every one of these guards a queue that a caller, a pane, or tmux itself can
 * fill faster than this process drains it. They are generous — a normal
 * connection never approaches them — and their purpose is to turn "the process
 * dies" into "this command fails".
 */
const DEFAULT_MAX_PENDING_COMMANDS = 1024;
const DEFAULT_MAX_COMMAND_BYTES = 64 * 1024 * 1024;
/** Kept only to explain an exit, so the tail is what matters. */
const MAX_STDERR_BYTES = 64 * 1024;
/** How long a closing process is given to leave before it is killed outright. */
const TERMINATION_GRACE_MS = 2_000;

/**
 * Quote one argument for tmux's command lexer.
 *
 * tmux parses a control-mode command line itself, so an argument holding a
 * space — a socket path, a window name — has to arrive quoted or it lexes as
 * several. The lexer accepts POSIX single-quoting, including the `'\''` idiom
 * for an embedded quote.
 */
function quoteArgument(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/**
 * A command list submitted together, so a failure can retire its remainder.
 *
 * tmux removes the rest of a list when one of its commands fails, and says so
 * only by not sending those blocks. Without the group the queue would hand each
 * missing block's place to the next command in line, and every command after it
 * would answer with a predecessor's output.
 */
interface PendingGroup {
  aborted: boolean;
}

interface PendingCommand {
  readonly argv: readonly string[];
  readonly group?: PendingGroup;
  /** Bytes accumulated in {@link lines}, so the bound does not cost a re-measure per line. */
  bytes: number;
  readonly lines: string[];
  /** Set when the response outgrew its bound; the block is still consumed, and discarded. */
  overflowed: boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (result: RawCommandResult) => void;
  /**
   * Whether the caller already has an answer.
   *
   * A cancelled or timed-out command stays in the queue, because tmux still
   * owes it a block and the queue's order is what correlates a block to the
   * command that asked for it. Removing it would hand its block to the next
   * command in line, and every command after that would answer with its
   * predecessor's output.
   */
  settled: boolean;
  /** Drop the abort subscription this command took out, if any. */
  readonly release: () => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Answer a command once, from whichever path reaches it first.
 *
 * A command can be settled by its response, its deadline, its signal, or the
 * connection going away. Routing all four through here is what keeps a caller
 * from being answered twice, and what guarantees the abort subscription is
 * dropped — a long-lived signal shared across many commands would otherwise
 * accumulate one listener per command, each retaining that command's buffer.
 */
function settle(command: PendingCommand): boolean {
  if (command.settled) return false;
  command.settled = true;
  if (command.timer !== undefined) clearTimeout(command.timer);
  command.release();
  return true;
}

/**
 * One `tmux -C` process, carrying both notifications and commands.
 *
 * tmux multiplexes a control connection: asynchronous notifications arrive
 * whenever something changes, and each command's response is fenced by
 * `%begin`/`%end`. Demultiplexing them here is what lets a caller keep one
 * process open instead of paying a spawn per command.
 *
 * Commands are answered in the order tmux received them, so a queue correlates
 * a response to its request without reading the block's command number.
 */
export class ControlConnection implements CommandTransport {
  #child: ChildProcessWithoutNullStreams;
  readonly #argv: readonly string[];
  readonly #executable: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #reconnect: { readonly attempts: number; readonly delayMs?: number } | undefined;
  #attempt = 0;
  /**
   * Whether the process is gone and a replacement is on its way.
   *
   * Writing to the old process during this window goes nowhere: the pipe
   * accepts the bytes and no reply ever comes, so the command waits out its
   * deadline, or forever if it has none.
   */
  #reopening = false;
  readonly #streamEndsConnection: boolean;
  readonly #pending: PendingCommand[] = [];
  readonly #sinks = new Set<EventSink>();
  readonly #bufferSize: number;
  readonly #framer = new LineFramer();
  /**
   * The tail of a character split across two `%output` notifications, per pane.
   *
   * An entry only exists between the halves of one character, so the map holds
   * at most one short remainder per pane that is mid-sequence, and the entry is
   * dropped as soon as the continuation arrives.
   */
  readonly #partial = new Map<string, Uint8Array>();
  #block: PendingCommand | undefined;
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
  #onAbort: (() => void) | undefined;
  readonly #signal: AbortLike | undefined;
  readonly #stderr: Buffer[] = [];
  #stderrBytes = 0;
  readonly #maxPendingCommands: number;
  /**
   * Seconds tmux may hold a pane's output before pausing it.
   *
   * Undefined leaves tmux's own remedy: at five minutes behind it kills the
   * client with "too far behind".
   */
  readonly #pauseAfterSeconds: number | undefined;
  /** Panes tmux has paused and this connection has not yet asked back. */
  readonly #paused = new Set<string>();
  readonly #maxCommandBytes: number;
  /**
   * Writes that tmux's stdin was not ready to take.
   *
   * `write` returning false means Node is buffering for us, without bound.
   * Holding them here and resuming on `drain` is what makes a producer that
   * outruns tmux wait rather than grow the heap.
   */
  readonly #writeQueue: string[] = [];
  #draining = false;
  /** Which reconnect attempt is in flight, so `reconnected` can name it once tmux answers. */
  #reconnectingAttempt: number | undefined;

  /**
   * @param streamEndsConnection
   *   Whether draining the event stream ends the process. A stream opened by
   *   `watch()` is the only holder, so it does; a stream reached through a
   *   connected server shares the process with that server's commands, and
   *   ending iteration there must not close the command channel underneath it.
   */
  /**
   * A transport for the commands this connection cannot carry.
   *
   * tmux's control protocol has no channel for a command's stdin, so
   * `load-buffer` and friends have nowhere to put their payload. Handing them
   * to a spawning transport keeps the promise the two modes are built on —
   * that choosing one never edits the caller — instead of making a connected
   * server a server with a hole in it.
   */
  readonly #stdinFallback: CommandTransport | undefined;

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
    options: WatchOptions = {},
    streamEndsConnection = true,
    stdinFallback?: CommandTransport,
  ) {
    this.#stdinFallback = stdinFallback;
    const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    // Validated before the spawn, so a rejected size cannot leak a process.
    if (!Number.isInteger(bufferSize) || bufferSize < 1) {
      throw new TypeError("bufferSize must be a positive integer");
    }
    const maxPendingCommands = options.maxPendingCommands ?? DEFAULT_MAX_PENDING_COMMANDS;
    const maxCommandBytes = options.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES;
    const pauseAfterSeconds = options.pauseAfterSeconds;
    for (const [name, value] of [
      ["maxPendingCommands", maxPendingCommands],
      ["maxCommandBytes", maxCommandBytes],
      ...(pauseAfterSeconds === undefined
        ? []
        : ([["pauseAfterSeconds", pauseAfterSeconds]] as const)),
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
    this.#maxPendingCommands = maxPendingCommands;
    this.#maxCommandBytes = maxCommandBytes;
    this.#pauseAfterSeconds = pauseAfterSeconds;
    const globals = connectionArguments(connection);
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
    this.#reconnect = options.reconnect;
    this.#child = this.#spawn();

    this.#bufferSize = bufferSize;
    this.#streamEndsConnection = streamEndsConnection;
    this.#listen();
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

  #spawn(): ChildProcessWithoutNullStreams {
    return spawn(this.#executable, [...this.#argv], {
      // Exactly the environment the connection was given, as the spawning
      // transport does. Overlaying it on `process.env` would make
      // `ServerOptions.environment` mean one thing per transport, and hand the
      // whole ambient environment to the tmux server.
      env: this.#environment,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  }

  #listen(): void {
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#consume(chunk);
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      // Only ever read to explain an exit, so keep the tail and drop the rest
      // rather than let a chatty tmux hold the heap.
      this.#stderr.push(chunk);
      this.#stderrBytes += chunk.length;
      while (this.#stderrBytes > MAX_STDERR_BYTES && this.#stderr.length > 1) {
        this.#stderrBytes -= this.#stderr.shift()?.length ?? 0;
      }
    });
    this.#child.stdin.on("drain", () => {
      this.#flushWrites();
    });
    // A control connection writes to tmux and tmux alone; if that pipe breaks,
    // the `close` handler is what reports it, and an unhandled 'error' on the
    // stream would take the process down first.
    this.#child.stdin.on("error", () => undefined);
    this.#child.once("error", (error: Error) => {
      this.#fail(error);
    });
    this.#child.once("close", (code) => {
      const message = this.#reason ?? Buffer.concat(this.#stderr).toString("utf8").trim();
      this.#fail(
        code === 0 || code === null || this.#closed
          ? undefined
          : new Error(
              message === ""
                ? `tmux control mode exited with ${String(code)}`
                : `tmux control mode could not attach: ${message}`,
            ),
      );
    });

    if (this.#signal !== undefined) {
      this.#onAbort = () => void this.close();
      if (this.#signal.aborted) this.#onAbort();
      else this.#signal.addEventListener("abort", this.#onAbort, { once: true });
    }
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
   * Send a line to tmux, waiting for the pipe when it is full.
   *
   * `write` returning false means Node accepted the bytes into a buffer it will
   * grow as far as it has to. Queueing here instead, and resuming on `drain`,
   * is what bounds a producer that outruns tmux.
   */
  #write(line: string): void {
    if (this.#draining) {
      this.#writeQueue.push(line);
      return;
    }
    const accepted = this.#child.stdin.write(line, (error) => {
      if (error) this.#fail(error);
    });
    if (!accepted) this.#draining = true;
  }

  #flushWrites(): void {
    this.#draining = false;
    while (this.#writeQueue.length > 0) {
      const line = this.#writeQueue.shift();
      if (line === undefined) break;
      const accepted = this.#child.stdin.write(line, (error) => {
        if (error) this.#fail(error);
      });
      if (!accepted) {
        this.#draining = true;
        return;
      }
    }
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
    const parsed = parseControlLine(line, this.#decodeOutput);
    const position = this.#blocks.position(parsed);
    switch (position.kind) {
      case "begin":
        if (position.fromClient) this.#block = this.#pending.shift();
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
    // tmux appends notifications to whatever block is open, so a pane that
    // backs up during a command has its `%pause` land in that command's
    // output. Swallowed there, the pane is never asked back.
    //
    // Matched whole: a pane id is `%1`, indistinguishable from a
    // notification by its first character.
    if (FLOW_CONTROL_LINE.test(text)) {
      const flow = parseControlLine(line);
      if (flow?.kind === "pause" || flow?.kind === "continue") {
        this.#routeFlowControl(flow);
        return;
      }
    }
    const block = this.#block;
    if (block === undefined) {
      // Nobody is waiting for this: it is tmux explaining an attach. Keep
      // enough to report the reason and no more.
      if (this.#diagnostic.length < 64) this.#diagnostic.push(text);
      return;
    }
    // Past the bound the block is still consumed — the queue's alignment
    // depends on it — but its contents stop being kept.
    block.bytes += line.length + 1;
    if (block.bytes > this.#maxCommandBytes) {
      block.overflowed = true;
      block.lines.length = 0;
      return;
    }
    block.lines.push(text);
  }

  #closeBlock(fromClient: boolean, failed: boolean): void {
    if (!fromClient) {
      if (!failed) {
        // A reconnect re-attaches, and the first outcome is the one callers
        // were told: once attached, this connection has been usable, and a
        // later outage is reported through the commands and the stream.
        this.#attachOutcome ??= { kind: "attached" };
        this.#attached?.resolve();
        this.#reopening = false;
        // The flag lives on the tmux client, so a reconnect needs it again.
        this.#requestPauseAfter();
        // The outage ends here, not when the replacement process started:
        // until tmux accepts the attach, the new client is carrying nothing.
        const recovered = this.#reconnectingAttempt;
        if (recovered !== undefined) {
          this.#reconnectingAttempt = undefined;
          for (const sink of this.#sinks) sink.push({ attempts: recovered, kind: "reconnected" });
        }
        // tmux acknowledging the attach is what says the outage is over, so
        // the budget is per outage rather than a total for the connection's
        // life — otherwise a watcher that reconnects once a day simply stops
        // recovering after `attempts` days, and says nothing.
        this.#attempt = 0;
      }
      // tmux explains a refused attach in a block of its own — "no sessions"
      // on an empty server, "can't find session" for a bad target. Keeping
      // it turns the exit code into the reason.
      if (failed && this.#diagnostic.length > 0) {
        this.#reason = this.#diagnostic.join("; ");
      }
      this.#diagnostic = [];
      return;
    }
    const block = this.#block;
    this.#block = undefined;
    if (block === undefined) return;
    // tmux removes the rest of a command list at the first failure, so the
    // blocks those commands would have sent never arrive.
    if (failed && block.group !== undefined) this.#abandonGroup(block.group);
    // Its caller was answered when it was cancelled; the block still had to
    // be consumed to keep the queue aligned, and its output is discarded.
    if (!settle(block)) return;
    if (block.overflowed) {
      block.reject(
        new TmuxTransportError(
          `tmux control response exceeded ${String(this.#maxCommandBytes)} bytes`,
          // tmux ran it: the response is what could not be held.
          { delivery: "replied", kind: "protocol" },
        ),
      );
      return;
    }
    const body = block.lines.length === 0 ? "" : `${block.lines.join("\n")}\n`;
    block.resolve({
      cmd: block.argv,
      returncode: failed ? 1 : 0,
      signal: null,
      stderr: failed ? encoder.encode(body) : new Uint8Array(),
      stdout: failed ? new Uint8Array() : encoder.encode(body),
    });
  }

  /**
   * Reopen after an unexpected drop.
   *
   * Only the connection is restored. Commands that were in flight have already
   * been failed by #fail, and are not re-sent: tmux may have run one before the
   * pipe broke, and replaying a mutation would apply it twice.
   */
  #tryReconnect(): boolean {
    const policy = this.#reconnect;
    if (policy === undefined || this.#closed) return false;
    if (this.#attempt >= policy.attempts) return false;
    this.#attempt += 1;
    const attempt = this.#attempt;
    this.#reconnectingAttempt = attempt;
    for (const sink of this.#sinks) sink.push({ attempts: attempt, kind: "reconnecting" });
    setTimeout(
      () => {
        if (this.#closed) return;
        this.#framer.reset();
        this.#partial.clear();
        this.#block = undefined;
        this.#blocks.reset();
        this.#stderr.length = 0;
        this.#stderrBytes = 0;
        this.#writeQueue.length = 0;
        this.#draining = false;
        this.#child = this.#spawn();
        this.#listen();
      },
      (policy.delayMs ?? 50) * attempt,
    );
    return true;
  }

  #fail(failure: Error | undefined): void {
    // Before deciding whether to reconnect: either way this connection is no
    // longer evidence that the daemon its ids came from is the one answering.
    // A deliberate close is not that — the runtime is going away with it.
    if (!this.#closed) this.#onDaemonLost?.();
    if (this.#tryReconnect()) {
      this.#reopening = true;
      this.#failPending(failure);
      return;
    }
    this.#closed = true;
    const reason = failure ?? new Error("tmux control connection closed");
    this.#attachOutcome ??= { error: reason, kind: "failed" };
    this.#attached?.reject(reason);
    this.#failPending(failure);
    for (const sink of this.#sinks) sink.finish(failure);
  }

  #failPending(failure: Error | undefined): void {
    const reason =
      failure ??
      new TmuxTransportError("tmux control connection closed", {
        delivery: "indeterminate",
        kind: "pipe",
      });
    const outstanding = [...this.#pending];
    this.#pending.length = 0;
    if (this.#block !== undefined) outstanding.unshift(this.#block);
    this.#block = undefined;
    for (const command of outstanding) {
      if (settle(command)) command.reject(reason);
    }
  }

  /**
   * Ask tmux to pause a pane rather than kill this client when it falls behind.
   *
   * Sent rather than awaited: a tmux that refuses it leaves the connection
   * working as before.
   */
  #requestPauseAfter(): void {
    const seconds = this.#pauseAfterSeconds;
    if (seconds === undefined) return;
    void this.execute({
      args: ["refresh-client", "-f", `pause-after=${String(seconds)}`],
      executable: this.#executable,
    }).catch(() => undefined);
  }

  /** Publish a pause or resume, and ask a paused pane back. */
  #routeFlowControl(event: { kind: "continue" | "pause"; paneId: string }): void {
    if (event.kind === "pause") this.#paused.add(event.paneId);
    else this.#paused.delete(event.paneId);
    for (const sink of this.#sinks) sink.push(event);
    // tmux sends nothing more for a paused pane until told otherwise.
    if (event.kind === "pause") this.#resumePane(event.paneId);
  }

  /** Ask tmux to resume a pane it paused. tmux answers with `%continue`. */
  #resumePane(paneId: string): void {
    void this.execute({
      args: ["refresh-client", "-A", `${paneId}:continue`],
      executable: this.#executable,
    }).catch(() => undefined);
  }

  onDaemonLost(notify: () => void): void {
    this.#onDaemonLost = notify;
  }

  execute(request: CommandRequest): Promise<RawCommandResult> {
    if (this.#closed) {
      return Promise.reject(
        new TmuxTransportError("tmux control connection is closed", {
          delivery: "not_started",
          kind: "pipe",
        }),
      );
    }
    if (this.#reopening) {
      // Nothing was written, so this is safe to say plainly — unlike a command
      // already in flight when the connection dropped, which tmux may have run.
      return Promise.reject(
        new TmuxTransportError("tmux control connection is reconnecting", {
          delivery: "not_started",
          kind: "pipe",
        }),
      );
    }
    if (request.stdin !== undefined) {
      // The request still carries this connection's socket flags, so the
      // spawned command reaches the same server this one is attached to.
      const fallback = this.#stdinFallback;
      if (fallback !== undefined) return fallback.execute(request);
      return Promise.reject(
        new TmuxTransportError("control mode cannot carry command stdin", {
          delivery: "not_started",
          kind: "protocol",
        }),
      );
    }

    const argv = subcommandOf(request.args);
    if (argv.length === 0) {
      return Promise.reject(
        new TmuxTransportError("control mode request carries no subcommand", {
          delivery: "not_started",
          kind: "protocol",
        }),
      );
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(
        new TmuxTransportError("command cancelled before it was written", {
          delivery: "not_started",
          kind: "cancelled",
        }),
      );
    }
    if (this.#pending.length >= this.#maxPendingCommands) {
      // Refusing the newest is what keeps the queue a queue. `not_started` is
      // exact here — nothing was written — so a caller may retry it as-is.
      return Promise.reject(
        new TmuxTransportError(
          `tmux control connection already has ${String(this.#maxPendingCommands)} commands awaiting a response`,
          { delivery: "not_started", kind: "protocol" },
        ),
      );
    }
    const enqueued = this.#enqueue(request, argv);
    this.#write(`${argv.map(quoteArgument).join(" ")}\n`);
    return enqueued;
  }

  /**
   * Run these commands as one tmux command list, in one write.
   *
   * One line, `;`-separated: tmux parses it into one command list and queues it
   * whole, which is what makes the results describe one instant. Each command
   * still answers in its own `%begin`/`%end`, so the block count is fixed and
   * the queue keeps correlating by order — unlike `if-shell`, whose block count
   * depends on the condition.
   */
  executeGroup(requests: readonly CommandRequest[]): Promise<readonly RawCommandResult[]> {
    const [first] = requests;
    if (first === undefined) return Promise.resolve(Object.freeze([]));
    if (requests.length === 1) return this.execute(first).then((result) => Object.freeze([result]));
    if (this.#closed || this.#reopening) {
      return this.execute(first).then((result) => Object.freeze([result]));
    }
    if (requests.some((request) => request.stdin !== undefined)) {
      return Promise.reject(
        new TmuxTransportError("a command list cannot carry stdin", {
          delivery: "not_started",
          kind: "protocol",
        }),
      );
    }
    const argvs = requests.map((request) => subcommandOf(request.args));
    if (argvs.some((argv) => argv.length === 0)) {
      return Promise.reject(
        new TmuxTransportError("control mode request carries no subcommand", {
          delivery: "not_started",
          kind: "protocol",
        }),
      );
    }
    if (this.#pending.length + requests.length > this.#maxPendingCommands) {
      return Promise.reject(
        new TmuxTransportError(
          `tmux control connection cannot hold a further ${String(requests.length)} commands`,
          { delivery: "not_started", kind: "protocol" },
        ),
      );
    }

    // Enqueued and written without an await between, so nothing can slip a
    // command into the middle of the list or the middle of the queue.
    const group: PendingGroup = { aborted: false };
    const answers = requests.map((request, index) => this.#enqueue(request, argvs[index]!, group));
    this.#write(`${argvs.map((argv) => argv.map(quoteArgument).join(" ")).join(" ; ")}\n`);
    return Promise.all(answers).then((results) => Object.freeze(results));
  }

  #enqueue(
    request: CommandRequest,
    argv: readonly string[],
    group?: PendingGroup,
  ): Promise<RawCommandResult> {
    return new Promise<RawCommandResult>((resolve, reject) => {
      const abandon = (): void => {
        if (!settle(command)) return;
        reject(
          new TmuxTransportError("command cancelled", {
            delivery: "indeterminate",
            kind: "cancelled",
          }),
        );
      };
      const signal = request.signal;
      signal?.addEventListener("abort", abandon, { once: true });
      const command: PendingCommand = {
        argv: Object.freeze([request.executable, ...argv]),
        bytes: 0,
        ...(group === undefined ? {} : { group }),
        lines: [],
        overflowed: false,
        reject,
        release: () => signal?.removeEventListener("abort", abandon),
        resolve,
        settled: false,
        timer:
          request.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                if (!settle(command)) return;
                reject(
                  new TmuxTransportError("tmux control command timed out", {
                    delivery: "indeterminate",
                    kind: "timeout",
                  }),
                );
              }, request.timeoutMs),
      };
      this.#pending.push(command);
    });
  }

  /**
   * Retire the rest of a list tmux stopped running.
   *
   * Their blocks are never coming, so leaving them queued would misalign every
   * later command. They are failed rather than resolved: the group asked for one
   * instant, and a partial one is not it.
   */
  #abandonGroup(group: PendingGroup): void {
    if (group.aborted) return;
    group.aborted = true;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const queued = this.#pending[index]!;
      if (queued.group !== group) continue;
      this.#pending.splice(index, 1);
      if (!settle(queued)) continue;
      queued.reject(
        new TmuxTransportError("tmux stopped the command list at an earlier failure", {
          delivery: "not_started",
          kind: "protocol",
        }),
      );
    }
  }

  async close(): Promise<void> {
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener("abort", this.#onAbort);
      this.#onAbort = undefined;
    }
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(undefined);
    // Ask, then insist. Waiting on `close` alone leaves closing unbounded: a
    // tmux that never leaves, or one whose descendants hold the inherited pipes
    // open, hangs the caller.
    const child = this.#child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const settled = (): void => {
        if (escalation !== undefined) clearTimeout(escalation);
        resolve();
      };
      child.once("close", settled);
      // A process that has already gone emits nothing further, so the same
      // listener has to survive an `error` from the kill itself.
      child.once("error", settled);
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        child.kill("SIGKILL");
        // Even SIGKILL leaves `close` waiting on inherited pipes, so this is
        // the last word: the connection is unusable either way, and holding
        // the caller past here buys nothing.
        escalation = setTimeout(resolve, TERMINATION_GRACE_MS);
        escalation.unref?.();
      }, TERMINATION_GRACE_MS);
      escalation.unref?.();
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Open a control-mode event stream against a server. */
export function watchServer(connection: TmuxConnection, options?: WatchOptions): TmuxEventStream {
  return new ControlConnection(connection, options).subscribe();
}
