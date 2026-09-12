import { TmuxTransportError } from "../../exc.js";
import type { CommandRequest, CommandTransport, RawCommandResult } from "./types.js";

/** How many invocations one server runs at once when nothing says otherwise. */
export const DEFAULT_MAX_IN_FLIGHT = 16;

/**
 * Commands that wait on another command rather than on tmux doing work.
 *
 * `wait-for <channel>` blocks until `wait-for -S <channel>` runs, so counting
 * it against the ceiling lets a waiter hold the permit its own release needs:
 * one wait deadlocks the pair at a ceiling of one, and sixteen deadlock it at
 * the default. It occupies a tmux client and no throughput, which is the
 * opposite of what the ceiling exists to bound.
 */
const RENDEZVOUS_COMMANDS: ReadonlySet<string> = new Set(["wait-for"]);

function waitsOnAnotherCommand(request: CommandRequest): boolean {
  return request.commands.every((command) => RENDEZVOUS_COMMANDS.has(command[0]));
}

interface Waiter {
  /**
   * Offer this waiter the permit a finished invocation released.
   *
   * Answers whether it took it. A waiter whose deadline passed while it
   * queued refuses instead, and the permit has to reach the next one rather
   * than evaporate with it.
   */
  grant(): boolean;
}

/**
 * Bound how many tmux invocations one server has in flight.
 *
 * Every invocation is a tmux client process with its own pipes, so a caller
 * that fans out — an agent driving every pane, a reconciler sweeping a server
 * — turns its own concurrency into process and descriptor pressure. It buys
 * nothing for it: tmux runs commands on one thread, and measured against a
 * live server throughput stops rising at a handful of clients and stays flat
 * from there to sixty-four.
 *
 * Waiting for a permit spends the caller's deadline rather than extending it:
 * the inner engine gets what is left of `timeoutMs`, not a fresh copy of it,
 * so queueing cannot make a bounded command outlive its bound. A request that
 * never gets a slot fails `not_started`, the one status a mutation may retry
 * blindly.
 *
 * No `endpoint`: server equality reads the engine a caller supplied, not the
 * transport wrapped around it, so carrying one here would be a second answer
 * to a question nothing asks of this object.
 */
export class BoundedTransport implements CommandTransport {
  readonly #inner: CommandTransport;
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Waiter[] = [];

  constructor(inner: CommandTransport, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("maxInFlight must be a positive safe integer");
    }
    this.#inner = inner;
    this.#limit = limit;
  }

  async execute(request: CommandRequest): Promise<RawCommandResult> {
    if (waitsOnAnotherCommand(request)) return this.#inner.execute(request);
    const waited = await this.#acquire(request);
    try {
      return await this.#inner.execute(afterWaiting(request, waited));
    } finally {
      this.#active -= 1;
      this.#handOn();
    }
  }

  /** Give the freed permit to the first waiter that can still use it. */
  #handOn(): void {
    for (;;) {
      const next = this.#waiting.shift();
      if (next === undefined || next.grant()) return;
    }
  }

  /** Answers how long the caller waited, which is what its deadline owes. */
  #acquire(request: CommandRequest): Promise<number> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(0);
    }
    const queuedAt = Date.now();
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // Hoisted so `leave` can name the listener it removes and `abort` can
      // call `leave`; neither can be a const declared before the other.
      function leave(queue: Waiter[], waiter: Waiter, signal: CommandRequest["signal"]): boolean {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
        return true;
      }

      function refuse(kind: "cancelled" | "timeout", message: string): void {
        reject(
          new TmuxTransportError(message, {
            delivery: "not_started",
            kind,
            subcommand: request.commands[0][0],
          }),
        );
      }

      const queue = this.#waiting;
      const deadline = request.timeoutMs === undefined ? undefined : Date.now() + request.timeoutMs;
      const waiter: Waiter = {
        grant: () => {
          if (!leave(queue, waiter, request.signal)) return false;
          // The timer that would have refused this is an ordinary task, so a
          // busy loop can leave it pending past its own deadline. Deciding
          // here as well means one answer either way, and a mutation whose
          // caller has already given up never reaches tmux.
          if (deadline !== undefined && Date.now() >= deadline) {
            refuse("timeout", "timed out waiting for a tmux invocation slot");
            return false;
          }
          this.#active += 1;
          resolve(Date.now() - queuedAt);
          return true;
        },
      };

      function abort(): void {
        if (leave(queue, waiter, request.signal)) {
          refuse("cancelled", "cancelled while waiting for a tmux invocation slot");
        }
      }

      if (request.signal?.aborted === true) {
        abort();
        return;
      }
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (leave(queue, waiter, request.signal)) {
            refuse("timeout", "timed out waiting for a tmux invocation slot");
          }
        }, request.timeoutMs);
      }
      queue.push(waiter);
    });
  }
}

/**
 * Charge the wait to the caller's deadline before the engine starts timing.
 *
 * Without this a queued request starts a fresh timer on arrival, so waiting
 * behind another invocation extends the deadline instead of spending it and
 * `timeoutMs` silently becomes execution time rather than wall clock. A
 * request that never queued owes nothing and is handed on untouched, so the
 * uncontended path carries exactly the deadline it was given.
 */
function afterWaiting(request: CommandRequest, waited: number): CommandRequest {
  if (waited === 0 || request.timeoutMs === undefined) return request;
  // A granted waiter was inside its deadline a moment ago, so what is left is
  // positive; the floor covers only the tick between that check and this one.
  return { ...request, timeoutMs: Math.max(1, request.timeoutMs - waited) };
}
