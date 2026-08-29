import { describe, expect, test } from "bun:test";

import { createEventStream } from "../../src/_internal/control/stream.js";
import { parsePaneId } from "../../src/_internal/runtime/ids.js";
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
const pane0 = parsePaneId("%0");

describe("event stream lifetime", () => {
  test("rejects invalid deadlines without consuming the stream", async () => {
    const sink = createEventStream(() => Promise.resolve(), 4);

    await Promise.all(
      [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648].map((timeoutMs) =>
        expect(sink.stream.find(() => false, { timeoutMs })).rejects.toThrow(/timeoutMs/u),
      ),
    );

    const armed = sink.stream.find((candidate) => candidate.kind === "sessions-changed", {
      timeoutMs: 1_000,
    });
    sink.push(event);
    expect(await armed).toEqual(event);
  });

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
    expect(closes).toBe(1);
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

    sink.push({ data: "1", kind: "output", paneId: pane0 });
    sink.push({ data: "2", kind: "output", paneId: pane0 });
    sink.push({ data: "3", kind: "output", paneId: pane0 });

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

  /**
   * Waiting out a deadline and losing the stream are different outcomes.
   *
   * Answering undefined for both is how a caller comes to report that its
   * command never printed a marker when what actually happened is that the
   * tmux server went away underneath it — a diagnosis that sends someone to
   * read their own workload for a transport failure.
   */
  test("answers undefined when the deadline passes", async () => {
    const sink = createEventStream(() => Promise.resolve(), 4);
    expect(await sink.stream.find(() => false, { timeoutMs: 10 })).toBeUndefined();
  });

  test("raises when the stream ends before a match", async () => {
    const sink = createEventStream(() => Promise.resolve(), 4);
    const armed = sink.stream.find(() => false, { timeoutMs: 30_000 });
    sink.finish(undefined);
    await expect(armed).rejects.toThrow(/ended before a match/u);
  });

  test("raises the stream's own failure rather than one of its own", async () => {
    const sink = createEventStream(() => Promise.resolve(), 4);
    const armed = sink.stream.find(() => false, { timeoutMs: 30_000 });
    sink.finish(new Error("tmux control connection broke (EPIPE)"));
    await expect(armed).rejects.toThrow(/EPIPE/u);
  });

  test("answers the match when one arrives before either", async () => {
    const sink = createEventStream(() => Promise.resolve(), 4);
    const armed = sink.stream.find((event) => event.kind === "output", { timeoutMs: 30_000 });
    sink.push({ data: "hello", kind: "output", paneId: pane0 });
    expect(await armed).toEqual({ data: "hello", kind: "output", paneId: pane0 });
  });

  test("answers undefined when a caller stops waiting", async () => {
    const sink = createEventStream(() => Promise.resolve(), 4);
    const armed = sink.stream.find(() => false, { timeoutMs: 30_000 });

    // Closing is a decision, the way the deadline is. Raising here would make
    // the loser of a `Promise.race` reject after nobody is holding it, which
    // is an unhandled rejection rather than a diagnosis.
    await sink.stream.close();

    expect(await armed).toBeUndefined();
  });

  test("keeps a deliberate close deliberate when the connection then ends", async () => {
    // Closing a stream is what makes the connection behind it let go, so the
    // teardown that follows arrives as `finish`. Read as the source going away,
    // it would turn the caller's own cancellation into a raised error.
    const sink = createEventStream(() => Promise.resolve(), 4);
    const armed = sink.stream.find(() => false, { timeoutMs: 30_000 });

    await sink.stream.close();
    sink.finish(undefined);

    expect(await armed).toBeUndefined();
  });

  test("answers undefined when the scope holding the stream ends", async () => {
    const sink = createEventStream(() => Promise.resolve(), 4);
    const armed = sink.stream.find(() => false, { timeoutMs: 30_000 });

    // `await using` disposes rather than closing, and the two must agree.
    await sink.stream[Symbol.asyncDispose]();

    expect(await armed).toBeUndefined();
  });
});
