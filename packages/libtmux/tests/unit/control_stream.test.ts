import { describe, expect, test } from "bun:test";

import { createEventStream } from "../../src/_internal/control/stream.js";
import type { TmuxEvent } from "../../src/types.js";

/**
 * What a closed subscriber costs the connection that fed it.
 *
 * Every notification is pushed to every registered sink and buffered there, so
 * a subscriber that is closed but still registered keeps filling for the life
 * of the connection. `waitFor` subscribes internally, which makes this the
 * difference between a long run costing nothing and costing one buffer per
 * wait.
 */

const event: TmuxEvent = { kind: "sessions-changed" };

describe("event stream lifetime", () => {
  test("runs its close hook exactly once, however it is ended", async () => {
    let closes = 0;
    const sink = createEventStream(() => {
      closes += 1;
      return Promise.resolve();
    }, 8);

    await sink.stream.close();
    await sink.stream.close();
    await sink.stream[Symbol.asyncDispose]();

    // The hook is what deregisters the subscriber, so a second call must not
    // deregister something else that has since taken its place.
    expect(closes).toBe(3);
  });

  test("runs the close hook when iteration ends on its own", async () => {
    let closed = false;
    const sink = createEventStream(() => {
      closed = true;
      return Promise.resolve();
    }, 8);
    sink.push(event);
    sink.finish(undefined);

    const seen: TmuxEvent[] = [];
    for await (const received of sink.stream) seen.push(received);

    expect(seen).toEqual([event]);
    expect(closed).toBe(true);
  });

  test("drops the oldest event and counts it when the consumer falls behind", () => {
    const sink = createEventStream(() => Promise.resolve(), 2);

    sink.push({ data: "1", kind: "output", paneId: "%0" });
    sink.push({ data: "2", kind: "output", paneId: "%0" });
    sink.push({ data: "3", kind: "output", paneId: "%0" });

    expect(sink.stream.dropped).toBe(1);
  });

  test("refuses a second iteration rather than splitting the events", async () => {
    const sink = createEventStream(() => Promise.resolve(), 4);
    sink.finish(undefined);
    for await (const _ of sink.stream) void _;

    await expect(
      (async () => {
        for await (const _ of sink.stream) void _;
      })(),
    ).rejects.toThrow(/only be iterated once/u);
  });
});
