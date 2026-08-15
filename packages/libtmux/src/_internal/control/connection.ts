import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AbortLike, TmuxEventStream, WatchOptions } from "../../types.js";
import { connectionArguments } from "../operations/request.js";
import type { TmuxConnection } from "../runtime/connection.js";
import type { CommandRequest, CommandTransport, RawCommandResult } from "../transport/types.js";
import { TransportError } from "../transport/types.js";
import { completeUtf8Length, parseControlLine } from "./events.js";
import { createEventStream, DEFAULT_BUFFER_SIZE, type EventSink } from "./stream.js";

const NEWLINE = 0x0a;
const encoder = new TextEncoder();

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
 * Drop the global flags that select a server.
 *
 * The connection is already established, so resending them makes tmux read the
 * first one as a command. Every tmux global flag is a leading `-` argument and
 * no subcommand starts with one, which is a more durable rule than counting
 * how many flags some particular caller happened to build.
 */
function subcommandOf(args: readonly string[]): readonly string[] {
  const start = args.findIndex((argument) => !argument.startsWith("-"));
  return start === -1 ? [] : args.slice(start);
}

interface PendingCommand {
  readonly argv: readonly string[];
  readonly lines: string[];
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
  #carry = new Uint8Array(0);
  /**
   * The tail of a character split across two `%output` notifications, per pane.
   *
   * An entry only exists between the halves of one character, so the map holds
   * at most one short remainder per pane that is mid-sequence, and the entry is
   * dropped as soon as the continuation arrives.
   */
  readonly #partial = new Map<string, Uint8Array>();
  #block: PendingCommand | undefined;
  #inBlock = false;
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

  /**
   * @param streamEndsConnection
   *   Whether draining the event stream ends the process. A stream opened by
   *   `watch()` is the only holder, so it does; a stream reached through a
   *   connected server shares the process with that server's commands, and
   *   ending iteration there must not close the command channel underneath it.
   */
  constructor(connection: TmuxConnection, options: WatchOptions = {}, streamEndsConnection = true) {
    const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    // Validated before the spawn, so a rejected size cannot leak a process.
    if (!Number.isInteger(bufferSize) || bufferSize < 1) {
      throw new TypeError("bufferSize must be a positive integer");
    }
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
      env: { ...process.env, ...this.#environment },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  }

  #listen(): void {
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#consume(chunk);
    });
    this.#child.stderr.on("data", (chunk: Buffer) => this.#stderr.push(chunk));
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
    const merged = new Uint8Array(this.#carry.length + chunk.length);
    merged.set(this.#carry);
    merged.set(chunk, this.#carry.length);
    let start = 0;
    for (;;) {
      const newline = merged.indexOf(NEWLINE, start);
      if (newline === -1) break;
      this.#route(merged.subarray(start, newline));
      start = newline + 1;
    }
    this.#carry = merged.subarray(start);
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
    if (parsed?.kind === "block-begin") {
      this.#inBlock = true;
      if (parsed.fromClient) this.#block = this.#pending.shift();
      return;
    }
    if (parsed?.kind !== "block-end") {
      // Inside a block every line is the command's output, whatever it starts
      // with. A pane id is `%1`, which is indistinguishable from a
      // notification by its first character, so position decides and not shape.
      if (this.#inBlock) {
        const text = new TextDecoder().decode(line);
        if (this.#block === undefined) this.#diagnostic.push(text);
        else this.#block.lines.push(text);
        return;
      }
      if (parsed === undefined) return;
      for (const sink of this.#sinks) sink.push(parsed);
      return;
    }
    {
      this.#inBlock = false;
      if (!parsed.fromClient) {
        if (!parsed.failed) {
          // A reconnect re-attaches, and the first outcome is the one callers
          // were told: once attached, this connection has been usable, and a
          // later outage is reported through the commands and the stream.
          this.#attachOutcome ??= { kind: "attached" };
          this.#attached?.resolve();
          this.#reopening = false;
          // tmux acknowledging the attach is what says the outage is over, so
          // the budget is per outage rather than a total for the connection's
          // life — otherwise a watcher that reconnects once a day simply stops
          // recovering after `attempts` days, and says nothing.
          this.#attempt = 0;
        }
        // tmux explains a refused attach in a block of its own — "no sessions"
        // on an empty server, "can't find session" for a bad target. Keeping
        // it turns the exit code into the reason.
        if (parsed.failed && this.#diagnostic.length > 0) {
          this.#reason = this.#diagnostic.join("; ");
        }
        this.#diagnostic = [];
        return;
      }
      const block = this.#block;
      this.#block = undefined;
      if (block === undefined) return;
      // Its caller was answered when it was cancelled; the block still had to
      // be consumed to keep the queue aligned, and its output is discarded.
      if (!settle(block)) return;
      const body = block.lines.length === 0 ? "" : `${block.lines.join("\n")}\n`;
      block.resolve({
        cmd: block.argv,
        returncode: parsed.failed ? 1 : 0,
        signal: null,
        stderr: parsed.failed ? encoder.encode(body) : new Uint8Array(),
        stdout: parsed.failed ? new Uint8Array() : encoder.encode(body),
      });
    }
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
    setTimeout(
      () => {
        if (this.#closed) return;
        this.#carry = new Uint8Array(0);
        this.#partial.clear();
        this.#block = undefined;
        this.#inBlock = false;
        this.#stderr.length = 0;
        this.#child = this.#spawn();
        this.#listen();
        for (const sink of this.#sinks) sink.push({ attempts: attempt, kind: "reconnected" });
      },
      (policy.delayMs ?? 50) * attempt,
    );
    return true;
  }

  #fail(failure: Error | undefined): void {
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
      new TransportError("tmux control connection closed", {
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

  execute(request: CommandRequest): Promise<RawCommandResult> {
    if (this.#closed) {
      return Promise.reject(
        new TransportError("tmux control connection is closed", {
          delivery: "not_started",
          kind: "pipe",
        }),
      );
    }
    if (this.#reopening) {
      // Nothing was written, so this is safe to say plainly — unlike a command
      // already in flight when the connection dropped, which tmux may have run.
      return Promise.reject(
        new TransportError("tmux control connection is reconnecting", {
          delivery: "not_started",
          kind: "pipe",
        }),
      );
    }
    if (request.stdin !== undefined) {
      // Control mode has no channel for a command's stdin; the caller must use
      // a spawning transport for load-buffer and friends.
      return Promise.reject(
        new TransportError("control mode cannot carry command stdin", {
          delivery: "not_started",
          kind: "protocol",
        }),
      );
    }

    const argv = subcommandOf(request.args);
    if (argv.length === 0) {
      return Promise.reject(
        new TransportError("control mode request carries no subcommand", {
          delivery: "not_started",
          kind: "protocol",
        }),
      );
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(
        new TransportError("command cancelled before it was written", {
          delivery: "not_started",
          kind: "cancelled",
        }),
      );
    }
    return new Promise<RawCommandResult>((resolve, reject) => {
      const abandon = (): void => {
        if (!settle(command)) return;
        reject(
          new TransportError("command cancelled", {
            delivery: "indeterminate",
            kind: "cancelled",
          }),
        );
      };
      const signal = request.signal;
      signal?.addEventListener("abort", abandon, { once: true });
      const command: PendingCommand = {
        argv: Object.freeze([request.executable, ...argv]),
        lines: [],
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
                  new TransportError("tmux control command timed out", {
                    delivery: "indeterminate",
                    kind: "timeout",
                  }),
                );
              }, request.timeoutMs),
      };
      this.#pending.push(command);
      this.#child.stdin.write(`${argv.map(quoteArgument).join(" ")}\n`, (error) => {
        if (error) this.#fail(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener("abort", this.#onAbort);
      this.#onAbort = undefined;
    }
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(undefined);
    await new Promise<void>((resolve) => {
      this.#child.once("close", () => resolve());
      this.#child.kill("SIGTERM");
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
