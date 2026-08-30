import { describe, expect, test } from "bun:test";

import type { ConnectedServer, TmuxEvent, TmuxEventStream } from "libtmux";
import { Server } from "libtmux/server";

import { LiveHub } from "../src/live.js";

class FakeEventStream {
  readonly #events: TmuxEvent[] = [];
  #ended = false;
  #wake: (() => void) | undefined;
  dropped = 0;

  emit(event: TmuxEvent): void {
    this.#events.push(event);
    this.#wake?.();
  }

  finish(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *events(): AsyncGenerator<TmuxEvent> {
    for (;;) {
      const event = this.#events.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (this.#ended) return;
      // eslint-disable-next-line no-await-in-loop -- one wake per drained fake queue.
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }

  stream(): TmuxEventStream {
    return {
      [Symbol.asyncDispose]: async () => undefined,
      [Symbol.asyncIterator]: () => this.events(),
      close: async () => {
        this.finish();
      },
      dropped: this.dropped,
      find: async () => undefined,
      ready: async () => undefined,
    } as TmuxEventStream;
  }
}

function fakeConnection(events: FakeEventStream, closed: { count: number }): ConnectedServer {
  const stream = events.stream();
  Object.defineProperty(stream, "dropped", { get: () => events.dropped });
  return {
    close: async () => {
      closed.count += 1;
      events.finish();
    },
    subscribe: () => stream,
  } as ConnectedServer;
}

describe("live hub", () => {
  test("bounds a control connection that never opens", async () => {
    let aborted = false;
    const hub = new LiveHub(
      {
        connect: ({ signal }: { signal: AbortSignal }) =>
          new Promise<ConnectedServer>((_resolve, reject) => {
            const stop = (): void => {
              aborted = true;
              reject(new Error("connection aborted"));
            };
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
          }),
      } as unknown as Server,
      { connectTimeoutMs: 10 },
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        hub.listen("$1", () => undefined).then(() => "settled" as const),
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), 250);
        }),
      ]);

      expect(result).toBe("settled");
      expect(aborted).toBe(true);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      await hub.close();
    }
  });

  test("keeps a shared connection opening when one listener cancels", async () => {
    const events = new FakeEventStream();
    const connected = fakeConnection(events, { count: 0 });
    const opening = Promise.withResolvers<ConnectedServer>();
    const entered = Promise.withResolvers<void>();
    let connectionSignal: AbortSignal | undefined;
    let connects = 0;
    const hub = new LiveHub({
      connect: ({ signal }: { signal: AbortSignal }) => {
        connects += 1;
        connectionSignal = signal;
        entered.resolve();
        return opening.promise;
      },
    } as unknown as Server);
    const controller = new AbortController();
    const first = hub.listen("$1", () => undefined, controller.signal);
    const second = hub.listen("$1", () => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      controller.abort();
      const outcome = await Promise.race([
        first.then(() => "settled" as const),
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), 250);
        }),
      ]);

      expect(outcome).toBe("settled");
      expect(await first).toBeUndefined();
      expect(connectionSignal?.aborted).toBe(false);
      opening.resolve(connected);
      const stop = await second;
      expect(stop).toBeDefined();
      expect(connects).toBe(1);
      stop?.();
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      opening.resolve(connected);
      await hub.close();
      await Promise.allSettled([first, second]);
    }
  });

  test("keeps a shared connection opening when one tail caller cancels", async () => {
    const events = new FakeEventStream();
    const connected = fakeConnection(events, { count: 0 });
    const opening = Promise.withResolvers<ConnectedServer>();
    const entered = Promise.withResolvers<void>();
    let connectionSignal: AbortSignal | undefined;
    let connects = 0;
    const hub = new LiveHub({
      connect: ({ signal }: { signal: AbortSignal }) => {
        connects += 1;
        connectionSignal = signal;
        entered.resolve();
        return opening.promise;
      },
    } as unknown as Server);
    const controller = new AbortController();
    const first = hub.tail("$1", "%1", controller.signal);
    const second = hub.tail("$1", "%1");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      controller.abort();
      const outcome = await Promise.race([
        first.then(() => "settled" as const),
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), 250);
        }),
      ]);

      expect(outcome).toBe("settled");
      expect(await first).toBeUndefined();
      expect(connectionSignal?.aborted).toBe(false);
      opening.resolve(connected);
      expect(await second).toBeDefined();
      expect(connects).toBe(1);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      opening.resolve(connected);
      await hub.close();
      await Promise.allSettled([first, second]);
    }
  });

  test("waits for a late connection after its last tail caller cancels", async () => {
    const entered = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<ConnectedServer>();
    const closed = Promise.withResolvers<void>();
    const events = new FakeEventStream();
    const late = {
      close: async () => {
        events.finish();
        closed.resolve();
      },
      subscribe: () => events.stream(),
    } as ConnectedServer;
    let connectionSignal: AbortSignal | undefined;
    const hub = new LiveHub({
      connect: ({ signal }: { signal: AbortSignal }) => {
        connectionSignal = signal;
        entered.resolve();
        return opening.promise;
      },
    } as unknown as Server);
    const controller = new AbortController();
    const tailing = hub.tail("$1", "%1", controller.signal);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      controller.abort();
      const outcome = await Promise.race([
        tailing.then(() => "settled" as const),
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), 250);
        }),
      ]);
      expect(outcome).toBe("settled");
      expect(await tailing).toBeUndefined();
      expect(connectionSignal?.aborted).toBe(true);

      let closeSettled = false;
      const closing = hub.close().then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      opening.resolve(late);

      await closing;
      await closed.promise;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      opening.resolve(late);
      await hub.close();
    }
  });

  test("waits for a late connection after its last listener cancelled", async () => {
    const entered = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<ConnectedServer>();
    const closed = Promise.withResolvers<void>();
    const events = new FakeEventStream();
    const late = {
      close: async () => {
        events.finish();
        closed.resolve();
      },
      subscribe: () => events.stream(),
    } as ConnectedServer;
    const hub = new LiveHub({
      connect: () => {
        entered.resolve();
        return opening.promise;
      },
    } as Server);
    const controller = new AbortController();
    const listening = hub.listen("$1", () => undefined, controller.signal);
    try {
      await entered.promise;
      controller.abort();
      expect(await listening).toBeUndefined();
      let closeSettled = false;
      const closing = hub.close().then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      opening.resolve(late);

      await closing;
      await closed.promise;
    } finally {
      opening.resolve(late);
      await hub.close();
    }
  });

  test("replaces an aborted opening for a fresh listener", async () => {
    const firstOpening = Promise.withResolvers<ConnectedServer>();
    const entered = Promise.withResolvers<void>();
    const secondEvents = new FakeEventStream();
    const secondConnection = fakeConnection(secondEvents, { count: 0 });
    let firstSignal: AbortSignal | undefined;
    let connects = 0;
    const hub = new LiveHub({
      connect: ({ signal }: { signal: AbortSignal }) => {
        connects += 1;
        if (connects === 1) {
          firstSignal = signal;
          entered.resolve();
        }
        return connects === 1 ? firstOpening.promise : Promise.resolve(secondConnection);
      },
    } as unknown as Server);
    const controller = new AbortController();
    const first = hub.listen("$1", () => undefined, controller.signal);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      controller.abort();
      const outcome = await Promise.race([
        first.then(() => "settled" as const),
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), 250);
        }),
      ]);

      expect(outcome).toBe("settled");
      expect(await first).toBeUndefined();
      expect(firstSignal?.aborted).toBe(true);

      const secondOpening = hub.listen("$1", () => undefined);
      await Promise.resolve();
      expect(connects).toBe(2);
      const second = await secondOpening;
      expect(second).toBeDefined();
      second?.();
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      firstOpening.resolve(fakeConnection(new FakeEventStream(), { count: 0 }));
      await hub.close();
      await Promise.allSettled([first]);
    }
  });

  test("keeps equal callbacks independently registered", async () => {
    const events = new FakeEventStream();
    const hub = new LiveHub({
      connect: async () => fakeConnection(events, { count: 0 }),
    } as Server);
    let received = 0;
    const listener = (): void => {
      received += 1;
    };
    const first = await hub.listen("$1", listener);
    const second = await hub.listen("$1", listener);
    try {
      first?.();
      expect(await first?.ended).toBe("listener_stopped");
      events.emit({ kind: "window-add" } as TmuxEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(received).toBe(1);

      second?.();
      events.emit({ kind: "window-add" } as TmuxEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(received).toBe(1);
    } finally {
      first?.();
      second?.();
      await hub.close();
    }
  });

  test("closes tails when the source drops an event", async () => {
    const events = new FakeEventStream();
    const closed = { count: 0 };
    const connected = fakeConnection(events, closed);
    const hub = new LiveHub({ connect: async () => connected } as Server);
    const tail = await hub.tail("$1", "%1");
    expect(tail).toBeDefined();
    const waiting = tail?.changed(30_000);

    events.dropped = 1;
    events.emit({ data: "after-gap", kind: "output", paneId: "%1" } as TmuxEvent);

    expect(await waiting).toBe("closed");
    expect(tail?.endReason).toBe("events_dropped");
    expect(tail?.read(undefined).text).toBe("");
    await hub.close();
  });

  test("closes and wakes tails when their connection ends", async () => {
    const events = new FakeEventStream();
    const hub = new LiveHub({
      connect: async () => fakeConnection(events, { count: 0 }),
    } as Server);
    const tail = await hub.tail("$1", "%1");
    const listener = await hub.listen("$1", () => undefined);
    const waiting = tail?.changed(30_000);

    events.finish();

    expect(await waiting).toBe("closed");
    expect(tail?.endReason).toBe("connection_lost");
    expect(await listener?.ended).toBe("connection_lost");
    expect(listener?.active).toBe(false);
    await hub.close();
  });

  test("joins concurrent terminal closes", async () => {
    const closingConnection = Promise.withResolvers<void>();
    const events = new FakeEventStream();
    const hub = new LiveHub({
      connect: async () =>
        ({
          close: async () => {
            await closingConnection.promise;
            events.finish();
          },
          subscribe: () => events.stream(),
        }) as ConnectedServer,
    } as Server);
    const listener = await hub.listen("$1", () => undefined);

    const first = hub.close();
    const second = hub.close();
    try {
      let settled = false;
      void second.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(await listener?.ended).toBe("hub_closed");
      expect(listener?.active).toBe(false);
    } finally {
      closingConnection.resolve();
    }
    await Promise.all([first, second]);
  });

  test("ends a rehomed link and joins its finalizer on close", async () => {
    const closeEntered = Promise.withResolvers<void>();
    const closingConnection = Promise.withResolvers<void>();
    const events = new FakeEventStream();
    const hub = new LiveHub({
      connect: async () =>
        ({
          close: async () => {
            closeEntered.resolve();
            await closingConnection.promise;
            events.finish();
          },
          subscribe: () => events.stream(),
        }) as ConnectedServer,
    } as Server);
    const listener = await hub.listen("$1", () => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let closing: Promise<void> | undefined;
    try {
      events.emit({ kind: "session-changed", name: "other", sessionId: "$2" } as TmuxEvent);
      const reason = await Promise.race([
        listener?.ended,
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), 250);
        }),
      ]);

      expect(reason).toBe("topology_changed");
      expect(listener?.active).toBe(false);
      if (deadline !== undefined) clearTimeout(deadline);
      deadline = undefined;
      await closeEntered.promise;
      closing = hub.close();
      const outcome = await Promise.race([
        closing.then(() => "settled" as const),
        new Promise<"pending">((resolve) => {
          deadline = setTimeout(() => resolve("pending"), 10);
        }),
      ]);
      expect(outcome).toBe("pending");
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      closingConnection.resolve();
      await (closing ?? hub.close());
    }
  });

  test("closes a connection that opens after the hub closed", async () => {
    const events = new FakeEventStream();
    const closed = { count: 0 };
    const connected = fakeConnection(events, closed);
    let resolve!: (value: ConnectedServer) => void;
    const opening = new Promise<ConnectedServer>((done) => {
      resolve = done;
    });
    const hub = new LiveHub({ connect: () => opening } as Server);
    const acquiring = hub.tail("$1", "%1");

    let closeSettled = false;
    const closing = hub.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    resolve(connected);

    await closing;
    expect(await acquiring).toBeUndefined();
    expect(closed.count).toBe(1);
  });

  test("does not re-arm listener expiry after the hub closed", async () => {
    const events = new FakeEventStream();
    const closed = { count: 0 };
    const hub = new LiveHub({ connect: async () => fakeConnection(events, closed) } as Server, {
      lingerMs: 5,
    });
    const stop = await hub.listen("$1", () => undefined);

    await hub.close();
    const closedAtShutdown = closed.count;
    stop?.();
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(closed.count).toBe(closedAtShutdown);
  });

  test("does not expire a tail while a reader is waiting", async () => {
    const events = new FakeEventStream();
    const hub = new LiveHub(
      { connect: async () => fakeConnection(events, { count: 0 }) } as Server,
      { lingerMs: 10 },
    );
    const tail = await hub.tail("$1", "%1");
    const waiting = tail?.changed(5_000);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tail?.endReason).toBeUndefined();
    events.emit({ data: "still-watched", kind: "output", paneId: "%1" } as TmuxEvent);

    expect(await waiting).toBe("changed");
    await hub.close();
  });

  test("re-arms expiry after acquiring an existing tail", async () => {
    const events = new FakeEventStream();
    const closed = { count: 0 };
    const hub = new LiveHub({ connect: async () => fakeConnection(events, closed) } as Server, {
      lingerMs: 15,
    });
    const tail = await hub.tail("$1", "%1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await hub.tail("$1", "%1")).toBe(tail);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(tail?.endReason).toBe("expired");
    expect(closed.count).toBeGreaterThan(0);
    await hub.close();
  });

  test("invalidates tails when pane placement may have changed", async () => {
    const events = new FakeEventStream();
    const hub = new LiveHub({
      connect: async () => fakeConnection(events, { count: 0 }),
    } as Server);
    const tail = await hub.tail("$1", "%1");
    const cursor = tail?.cursor;

    events.emit({ kind: "layout-change" } as TmuxEvent);

    expect(await tail?.changed(5_000)).toBe("closed");
    expect(tail?.endReason).toBe("topology_changed");
    const replacement = await hub.tail("$1", "%1");
    expect(replacement).not.toBe(tail);
    expect(replacement?.cursor).not.toBe(cursor);
    await hub.close();
  });
});
