import { describe, expect, test } from "bun:test";

import { BoundedTransport } from "../../src/_internal/transport/bounded_transport.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";
import { TmuxTransportError } from "../../src/exc.js";

/**
 * The ceiling on tmux invocations in flight.
 *
 * What matters is not that a wait happens but what it costs: a request that
 * queues must still honour its own deadline and its own signal, and one that
 * never gets a slot must be reportable as never sent.
 */

interface Gate extends CommandTransport {
  /** The deadline each invocation reached the inner engine with. */
  readonly budgets: () => (number | undefined)[];
  /** How many executions were running at once, at the busiest moment. */
  readonly peak: () => number;
  /** Let one waiting execution finish. */
  readonly release: () => void;
  readonly started: () => number;
}

function gate(failWith?: Error, blockMs = 0): Gate {
  const pending: (() => void)[] = [];
  const budgets: (number | undefined)[] = [];
  let active = 0;
  let peak = 0;
  let started = 0;
  return {
    budgets: () => budgets,
    endpoint: "test://gate",
    peak: () => peak,
    release: () => pending.shift()?.(),
    started: () => started,
    async execute(request: CommandRequest): Promise<RawCommandResult> {
      budgets.push(request.timeoutMs);
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      // Blocking here rather than in the test body is what makes the late
      // timer deterministic: the release resolves this, microtasks drain
      // before any timer task, so the waiter is granted its permit with the
      // clock already past its deadline.
      if (blockMs > 0) {
        const until = Date.now() + blockMs;
        while (Date.now() < until) {
          /* hold the loop */
        }
      }
      active -= 1;
      if (failWith !== undefined) throw failWith;
      return {
        cmd: ["tmux"],
        returncode: 0,
        signal: null,
        stderr: new Uint8Array(),
        stdout: new Uint8Array(),
      };
    },
  };
}

/** Yield until every already-scheduled continuation has run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Let executions finish until `settled` reports them all done.
 *
 * A fixed number of releases races the microtask queue: a release arriving
 * before the next waiter reaches the inner engine is dropped, and the run
 * hangs. Bounded so a genuine deadlock fails instead of hanging.
 */
async function drain(inner: Gate, settled: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !settled(); turn += 1) {
    inner.release();
    // eslint-disable-next-line no-await-in-loop -- each release has to land before the next.
    await flush();
  }
}

function requestFor(options: Partial<CommandRequest> = {}): CommandRequest {
  return {
    commands: [["list-panes"]],
    executable: "tmux",
    globalArguments: [],
    ...options,
  } as CommandRequest;
}

describe("bounded transport", () => {
  test("runs no more invocations at once than the limit allows", async () => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 2);
    let done = 0;
    const runs = Array.from({ length: 6 }, async () => {
      await bounded.execute(requestFor());
      done += 1;
    });

    await flush();
    expect(inner.peak()).toBe(2);

    await drain(inner, () => done === 6);
    await Promise.all(runs);
    // The ceiling held for the whole run, not only at the start.
    expect(inner.peak()).toBe(2);
    expect(inner.started()).toBe(6);
  });

  test("releases the slot when the invocation fails", async () => {
    const inner = gate(new Error("inner failed"));
    const bounded = new BoundedTransport(inner, 1);
    const first = bounded.execute(requestFor());
    const second = bounded.execute(requestFor());

    await flush();
    inner.release();
    await expect(first).rejects.toThrow("inner failed");
    await flush();
    inner.release();
    await expect(second).rejects.toThrow("inner failed");
    expect(inner.started()).toBe(2);
  });

  test("refuses a queued request on its own deadline, as never sent", async () => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 1);
    const holding = bounded.execute(requestFor());
    await flush();
    const queued = bounded.execute(requestFor({ timeoutMs: 10 }));

    // `not_started` is the one status a mutation may retry blindly, and a
    // request that never got a slot is exactly that.
    await expect(queued).rejects.toMatchObject({
      delivery: "not_started",
      kind: "timeout",
    });
    await expect(queued).rejects.toBeInstanceOf(TmuxTransportError);
    expect(inner.started()).toBe(1);

    inner.release();
    await holding;
  });

  test("refuses a queued request on its signal, without starting it", async () => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 1);
    const controller = new AbortController();
    const holding = bounded.execute(requestFor());
    await flush();
    const queued = bounded.execute(requestFor({ signal: controller.signal }));

    controller.abort();
    await expect(queued).rejects.toMatchObject({
      delivery: "not_started",
      kind: "cancelled",
    });
    expect(inner.started()).toBe(1);

    inner.release();
    await holding;
  });

  test("grants waiting requests in the order they arrived", async () => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 1);
    const order: number[] = [];
    const holding = bounded.execute(requestFor());
    await flush();
    const queued = [1, 2, 3].map(async (n) => {
      await bounded.execute(requestFor());
      order.push(n);
    });

    await flush();
    await drain(inner, () => order.length === 3);
    await Promise.all([holding, ...queued]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("refuses a limit that is not a positive whole number", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new BoundedTransport(gate(), limit)).toThrow(RangeError);
    }
  });

  test("spends the wait on the caller's deadline rather than restarting it", async () => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 1);
    const holding = bounded.execute(requestFor({ timeoutMs: 1_000 }));
    await flush();
    const queued = bounded.execute(requestFor({ timeoutMs: 1_000 }));

    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    inner.release();
    await flush();

    // A fresh timer here would let a queued command outlive its own bound:
    // the caller asked for a wall clock, not for execution time. The first
    // never queued, so it owes nothing and carries its deadline exactly.
    const [first, second] = inner.budgets();
    expect(first).toBe(1_000);
    expect(second).toBeLessThan(1_000 - 50);

    inner.release();
    await Promise.all([holding, queued]);
  });

  test("leaves a deadline alone when the caller set none", async () => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 1);
    const run = bounded.execute(requestFor());
    await flush();
    inner.release();
    await run;

    expect(inner.budgets()).toEqual([undefined]);
  });

  test.each([
    ["wait-for", ["wait-for", "channel"], ["wait-for", "-S", "channel"]],
    ["display-popup", ["display-popup", "-t", "%0", "less x"], ["display-popup", "-C"]],
    [
      "display-menu",
      ["display-menu", "-t", "%0", "Kill", "k", "kill-pane"],
      ["display-menu", "-C"],
    ],
  ])("lets %s and the command that ends it past the ceiling", async (_name, blocks, ends) => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 1);
    const waiting = bounded.execute(requestFor({ commands: [blocks] }));
    await flush();

    // Each blocks until something outside the invocation releases it, so
    // counting it would let it hold the permit its own release needs.
    const releasing = bounded.execute(requestFor({ commands: [ends] }));
    await flush();
    expect(inner.started()).toBe(2);

    inner.release();
    inner.release();
    await Promise.all([waiting, releasing]);
  });

  test("still bounds a command that waits on tmux doing work", async () => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 1);
    const holding = bounded.execute(requestFor({ commands: [["run-shell", "sleep 1"]] }));
    await flush();
    const queued = bounded.execute(requestFor({ commands: [["source-file", "/tmp/x"]] }));
    await flush();

    // These finish on their own, so bounding them is the point rather than a
    // deadlock waiting to happen.
    expect(inner.started()).toBe(1);

    inner.release();
    await flush();
    inner.release();
    await Promise.all([holding, queued]);
  });

  test("still counts an invocation that only partly waits", async () => {
    const inner = gate();
    const bounded = new BoundedTransport(inner, 1);
    const holding = bounded.execute(
      requestFor({ commands: [["wait-for", "channel"], ["kill-pane"]] }),
    );
    await flush();
    const queued = bounded.execute(requestFor());
    await flush();

    // The exemption is for an invocation that does nothing but wait. One
    // carrying real work alongside it is work, and is bounded.
    expect(inner.started()).toBe(1);

    inner.release();
    await flush();
    inner.release();
    await Promise.all([holding, queued]);
  });

  test("refuses a permit that arrives after the deadline", async () => {
    const inner = gate(undefined, 60);
    const bounded = new BoundedTransport(inner, 1);
    const holding = bounded.execute(requestFor());
    await flush();
    const queued = bounded.execute(requestFor({ timeoutMs: 30 }));
    const refused = expect(queued).rejects.toMatchObject({
      delivery: "not_started",
      kind: "timeout",
    });
    await flush();

    // The holder blocks past the queued request's deadline, then releases.
    // Granting clears the queue timer, so this can only be refused by the
    // check that runs before dispatch.
    inner.release();
    await refused;
    // `not_started` is only true if nothing was started.
    expect(inner.started()).toBe(1);

    await flush();
    await holding;
  });
});
