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
  /** How many executions were running at once, at the busiest moment. */
  readonly peak: () => number;
  /** Let one waiting execution finish. */
  readonly release: () => void;
  readonly started: () => number;
}

function gate(failWith?: Error): Gate {
  const pending: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  let started = 0;
  return {
    endpoint: "test://gate",
    peak: () => peak,
    release: () => pending.shift()?.(),
    started: () => started,
    async execute(): Promise<RawCommandResult> {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => pending.push(resolve));
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
});
