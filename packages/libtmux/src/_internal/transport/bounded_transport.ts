import type { TmuxInvocationObserver } from "../../common.js";
import { TmuxTransportError } from "../../errors.js";
import type { CommandRequest, CommandTransport, RawCommandResult } from "./types.js";

/** How many invocations one server runs at once when nothing says otherwise. */
export const DEFAULT_MAX_IN_FLIGHT = 16;

/**
 * Commands that block until something outside this invocation releases them.
 *
 * Each returns `CMD_RETURN_WAIT` and then waits on a second command or on a
 * person: `wait-for <channel>` on `wait-for -S <channel>`, a popup or menu on
 * its dismissal, a prompt on an answer. Counting one against the ceiling
 * would make it hold the permit that its own release needs in order to run:
 * one wait deadlocks the pair at a ceiling of one, and sixteen popups deadlock
 * it at the default. So they are exempt. They occupy a tmux client and no
 * throughput, which is the opposite of what the ceiling exists to bound.
 *
 * The trade is real and deliberate: being exempt, they are not bounded by
 * anything, so a caller that opens very many at once pays in processes and
 * descriptors where a bounded command would have queued. Deadlocking the
 * release is the worse failure, and it is the certain one.
 *
 * The same list exempts them from the server's default deadline, for the
 * same reason read the other way: a wait the library cut short would be one
 * the person had not finished.
 *
 * Naming the command rather than the flag is what
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
  "confirm-before",
  "display-menu",
  "display-panes",
  "display-popup",
  "wait-for",
]);

/** Their built-in short names, which tmux matches whole rather than by prefix. */
const UNBOUNDED_ALIASES: ReadonlySet<string> = new Set([
  "confirm",
  "displayp",
  "menu",
  "popup",
  "wait",
]);

/**
 * Whether `name` reaches one of those commands, abbreviations included.
 *
 * tmux resolves any unambiguous prefix of a canonical name, so `wa` runs
 * `wait-for` and would otherwise be counted while its release was not. An
 * alias is not prefix-matched — tmux compares those whole — so treating one as
 * a candidate would make `wa` look ambiguous between `wait` and `wait-for`
 * when tmux sees only the second. Ambiguity is judged within this set, so the
 * worst a prefix can do is exempt a command that blocks anyway.
 */
export function reachesUnboundedCommand(name: string): boolean {
  if (UNBOUNDED_ALIASES.has(name) || UNBOUNDED_COMMANDS.has(name)) return true;
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

function contractError(request: CommandRequest, message: string): TmuxTransportError {
  return new TmuxTransportError(message, {
    delivery: "indeterminate",
    kind: "contract",
    subcommand: request.commands[0][0],
  });
}

/**
 * Prove the engine resolved the shape every caller above assumes.
 *
 * A custom `TmuxEngine` is unchecked at this boundary: nothing stops a build
 * still targeting the pre-rename `returncode` field from resolving here with
 * `exitCode` missing, which every caller reads as `undefined !== 0` and
 * reports a live server as dead. Failing loudly here beats every caller
 * re-deriving the same check.
 */
function validateRawResult(raw: unknown, request: CommandRequest): RawCommandResult {
  if (raw === null || typeof raw !== "object") {
    throw contractError(
      request,
      `tmux engine resolved ${JSON.stringify(raw)} instead of a command result`,
    );
  }
  const candidate = raw as Partial<Record<keyof RawCommandResult, unknown>>;
  if (!Number.isInteger(candidate.exitCode)) {
    const hint =
      "returncode" in candidate
        ? ` — TmuxEngine.execute resolves "exitCode", not "returncode"`
        : "";
    throw contractError(
      request,
      `tmux engine resolved a non-numeric exitCode (${JSON.stringify(candidate.exitCode)})${hint}`,
    );
  }
  if (!(candidate.stdout instanceof Uint8Array) || !(candidate.stderr instanceof Uint8Array)) {
    throw contractError(request, "tmux engine did not resolve stdout and stderr as Uint8Array");
  }
  if (!Array.isArray(candidate.cmd)) {
    throw contractError(request, "tmux engine did not resolve cmd as an array");
  }
  return raw as RawCommandResult;
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
 * nothing for it: tmux runs commands on one thread, and `bench-modes.ts`
 * measures twelve concurrent creations costing the same twenty-five
 * invocations as twelve sequential ones — twenty-four either way, plus the
 * query that reads the result back — and arriving out of order.
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
  readonly #observe: TmuxInvocationObserver | undefined;
  #active = 0;
  readonly #waiting: Waiter[] = [];

  constructor(inner: CommandTransport, limit: number, observe?: TmuxInvocationObserver) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("maxInFlight must be a positive safe integer");
    }
    this.#inner = inner;
    this.#limit = limit;
    this.#observe = observe;
  }

  /**
   * Hand one finished invocation to the caller's observer.
   *
   * Every command reaches tmux through `#run`, a custom engine's included, so
   * this is the one place that sees all of them. It throws nothing: a command
   * must not fail on account of the code watching it, and an observer that
   * does throw has no way to say so that is not worse.
   */
  #report(
    request: CommandRequest,
    startedAt: number,
    queuedMs: number,
    outcome: { readonly error?: unknown; readonly exitCode?: number },
  ): void {
    const observe = this.#observe;
    if (observe === undefined) return;
    try {
      const watching: unknown = observe({
        commands: request.commands,
        // A `TmuxTransportError` knows how far it got. Anything else threw
        // without saying, and a command that did not finish must not read as
        // one that did — `replied` is for an answer, either way.
        delivery:
          outcome.error === undefined
            ? "replied"
            : outcome.error instanceof TmuxTransportError
              ? outcome.error.delivery
              : "indeterminate",
        durationMs: performance.now() - startedAt,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        queuedMs,
      });
      // A `void` return is bivariant, so an `async` observer type-checks here
      // and reports its failure as a rejected promise rather than a throw.
      // Left alone that is an unhandled rejection, which on the default Node
      // policy takes the host process down — the command failing on account of
      // the code watching it, by a longer route than the `catch` below covers.
      if (typeof (watching as PromiseLike<void> | undefined)?.then === "function") {
        (watching as PromiseLike<void>).then(undefined, () => undefined);
      }
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  execute(request: CommandRequest): Promise<RawCommandResult> {
    if (waitsOnSomethingElse(request)) return this.#run(request);
    // Dispatched without suspending when a slot is free, so an uncontended
    // command reaches tmux exactly as it did before there was a ceiling: an
    // await here would put the caller's own synchronous work between the
    // request and the engine, and spend a deadline on it.
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#dispatchWaited(request, 0);
    }
    return this.#waitThenDispatch(request);
  }

  async #run(request: CommandRequest, queuedMs = 0): Promise<RawCommandResult> {
    const startedAt = performance.now();
    try {
      const result = validateRawResult(await this.#inner.execute(request), request);
      this.#report(request, startedAt, queuedMs, { exitCode: result.exitCode });
      return result;
    } catch (error) {
      this.#report(request, startedAt, queuedMs, { error });
      throw error;
    }
  }

  async #waitThenDispatch(request: CommandRequest): Promise<RawCommandResult> {
    // A request refused while queued, or refused by `afterWaiting` for a
    // deadline that passed during the wait, never reaches `#run` — and so
    // never reached the observer, though `TmuxInvocationReport` models exactly
    // that case with `delivery: "not_started"` and the wait in `queuedMs`.
    const waitedFrom = performance.now();
    let queuedAt = 0;
    try {
      queuedAt = await this.#acquire(request);
    } catch (error) {
      // `durationMs` is time spent on the invocation, and this one never
      // became an invocation — the whole elapsed time was the wait, which
      // `queuedMs` already carries. Reporting it as both would make a
      // consumer summing the two count the wait twice.
      const refusedAt = performance.now();
      this.#report(request, refusedAt, refusedAt - waitedFrom, { error });
      throw error;
    }
    const queuedMs = performance.now() - waitedFrom;
    let waited: CommandRequest;
    try {
      waited = afterWaiting(request, queuedAt);
    } catch (error) {
      this.#active -= 1;
      this.#handOn();
      this.#report(request, performance.now(), queuedMs, { error });
      throw error;
    }
    return this.#dispatchWaited(waited, queuedMs);
  }

  async #dispatchWaited(request: CommandRequest, queuedMs: number): Promise<RawCommandResult> {
    try {
      return await this.#run(request, queuedMs);
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
      // `dequeued` says the caller already removed this waiter. Searching for
      // it anyway scans the whole queue and finds nothing, which turns
      // draining a large burst into quadratic work.
      function leave(
        queue: Waiter[],
        waiter: Waiter,
        signal: CommandRequest["signal"],
        dequeued = false,
      ): boolean {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (!dequeued) {
          const at = queue.indexOf(waiter);
          if (at !== -1) queue.splice(at, 1);
        }
        return true;
      }

      function refuse(kind: "cancelled" | "timeout", message: string): void {
        reject(
          new TmuxTransportError(message, {
            // A command abandoned while queued was abandoned for the caller's
            // own reason as much as one abandoned mid-flight; the spawning
            // engine carries it and so does this. Queueing is the documented
            // behaviour under `maxInFlight`, not an edge — losing the reason
            // here would make the contract hold only when nothing contends.
            ...(kind === "cancelled" && request.signal?.reason !== undefined
              ? { cause: request.signal.reason }
              : {}),
            delivery: "not_started",
            kind,
            subcommand: request.commands[0][0],
          }),
        );
      }

      const queue = this.#waiting;
      const deadline =
        request.timeoutMs === undefined ? undefined : performance.now() + request.timeoutMs;
      const waiter: Waiter = {
        grant: () => {
          // Reached only from `#handOn`, which has already shifted this off.
          if (!leave(queue, waiter, request.signal, true)) return false;
          // The timer that would have refused this is an ordinary task, so a
          // busy loop can leave it pending past its own deadline. Deciding
          // here as well means one answer either way, and a mutation whose
          // caller has already given up never reaches tmux.
          //
          // Both sides read `performance.now()`. Built from `Date.now()` this
          // compared an epoch against a process-relative monotonic clock, so
          // it was false for every realistic process lifetime and the check
          // never fired; `afterWaiting` caught the same case one async hop
          // later, which is why nothing looked wrong.
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
