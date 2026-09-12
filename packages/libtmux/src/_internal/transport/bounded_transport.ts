import { TmuxTransportError } from "../../exc.js";
import type { CommandRequest, CommandTransport, RawCommandResult } from "./types.js";

/** How many invocations one server runs at once when nothing says otherwise. */
export const DEFAULT_MAX_IN_FLIGHT = 16;

/**
 * Commands that block until something outside this invocation releases them.
 *
 * Each returns `CMD_RETURN_WAIT` and then waits on a second command or on a
 * person: `wait-for <channel>` on `wait-for -S <channel>`, a popup or menu on
 * its dismissal, a prompt on an answer. Counting one against the ceiling lets
 * it hold the permit its own release needs — a single wait deadlocks the pair
 * at a ceiling of one, and sixteen popups deadlock it at the default. They
 * occupy a tmux client and no throughput, which is the opposite of what the
 * ceiling exists to bound. Naming the command rather than the flag is what
 * lets the release through too, since `wait-for -S` and `display-popup -C`
 * are the same command as the thing they end.
 *
 * Each command's built-in short name is here too, because tmux resolves
 * `wait` to `wait-for` and `popup` to `display-popup` after this sees the
 * argument list. What this cannot see through is a blocking command wrapped
 * in another one — `if-shell 'wait-for x'` reads as `if-shell` — so a caller
 * who buries a wait inside a command owns the bound on it.
 *
 * Commands that wait on tmux doing work — `run-shell`, `source-file`,
 * `load-buffer` — are not here. They finish on their own, and bounding them
 * is the point.
 */
const UNBOUNDED_COMMANDS: ReadonlySet<string> = new Set([
  "command-prompt",
  "confirm",
  "confirm-before",
  "display-menu",
  "display-panes",
  "display-popup",
  "displayp",
  "menu",
  "popup",
  "wait",
  "wait-for",
]);

/**
 * Whether `name` reaches one of those commands, abbreviations included.
 *
 * tmux resolves any unambiguous prefix, so `wait-f` runs `wait-for` and would
 * otherwise be counted while its release was not. Ambiguity is judged within
 * this set: a prefix that reaches two of them is one tmux rejects as ambiguous
 * too, and the worst this can do is exempt a command that blocks anyway.
 */
function reachesUnboundedCommand(name: string): boolean {
  if (UNBOUNDED_COMMANDS.has(name)) return true;
  let found: string | undefined;
  for (const candidate of UNBOUNDED_COMMANDS) {
    if (!candidate.startsWith(name)) continue;
    if (found !== undefined) return false;
    found = candidate;
  }
  return found !== undefined;
}

function waitsOnSomethingElse(request: CommandRequest): boolean {
  return request.commands.every((command) => reachesUnboundedCommand(command[0]));
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

  execute(request: CommandRequest): Promise<RawCommandResult> {
    if (waitsOnSomethingElse(request)) return this.#inner.execute(request);
    // Dispatched without suspending when a slot is free, so an uncontended
    // command reaches tmux exactly as it did before there was a ceiling: an
    // await here would put the caller's own synchronous work between the
    // request and the engine, and spend a deadline on it.
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#dispatch(request, 0);
    }
    return this.#waitThenDispatch(request);
  }

  async #waitThenDispatch(request: CommandRequest): Promise<RawCommandResult> {
    const queuedAt = await this.#acquire(request);
    return this.#dispatch(request, queuedAt);
  }

  async #dispatch(request: CommandRequest, queuedAt: number): Promise<RawCommandResult> {
    try {
      return await this.#inner.execute(afterWaiting(request, queuedAt));
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

  /**
   * Answers when the caller started waiting, or zero if it never did.
   *
   * A timestamp rather than a duration: the continuation that resumes after
   * this can itself be delayed, and only the moment of dispatch knows how much
   * of the deadline is left by then.
   */
  #acquire(request: CommandRequest): Promise<number> {
    // Monotonic: a system clock that moves while a request is queued would
    // otherwise turn a twenty millisecond wait into a second of credit or a
    // premature expiry. `observer_transport` measures its budgets the same way.
    const queuedAt = performance.now();
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
          if (deadline !== undefined && performance.now() >= deadline) {
            refuse("timeout", "timed out waiting for a tmux invocation slot");
            return false;
          }
          this.#active += 1;
          resolve(queuedAt);
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
 *
 * Measured here rather than at the grant, because the continuation between
 * the two is an ordinary task and a busy loop delays it: a request granted
 * inside its deadline can still reach this line outside it, and starting a
 * mutation whose caller has already given up is the thing worth refusing.
 */
function afterWaiting(request: CommandRequest, queuedAt: number): CommandRequest {
  if (queuedAt === 0 || request.timeoutMs === undefined) return request;
  const remaining = Math.ceil(request.timeoutMs - (performance.now() - queuedAt));
  if (remaining <= 0) {
    throw new TmuxTransportError("timed out waiting for a tmux invocation slot", {
      delivery: "not_started",
      kind: "timeout",
      subcommand: request.commands[0][0],
    });
  }
  return { ...request, timeoutMs: remaining };
}
