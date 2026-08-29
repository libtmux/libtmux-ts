import { expect, test } from "bun:test";

import { createEventStream } from "../../src/_internal/control/stream.js";
import { waitForSnapshot } from "../../src/_internal/control/wait_for.js";
import { WaitTimeout } from "../../src/exc.js";
import type { WaitForOptions } from "../../src/types.js";

test("a hard deadline supervises one pending snapshot", async () => {
  let closed = false;
  const sink = createEventStream(() => {
    closed = true;
    return Promise.resolve();
  });
  let rejectSnapshot!: (reason: Error) => void;
  const pending = new Promise<number>((_resolve, reject) => {
    rejectSnapshot = reject;
  });
  const lateFailure = setTimeout(() => rejectSnapshot(new Error("late snapshot failure")), 75);
  let snapshots = 0;
  const started = performance.now();
  const failure = await waitForSnapshot({
    matches: () => false,
    options: { pollIntervalMs: 1, timeoutMs: 25 },
    snapshot: () => {
      snapshots += 1;
      return pending;
    },
    subscribe: () => sink.stream,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(WaitTimeout);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(snapshots).toBe(1);
  expect(closed).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 75));
  clearTimeout(lateFailure);
}, 2_000);

test("rejects timer values outside the platform range before subscribing", async () => {
  const tooLarge = 2_147_483_648;
  const invalid: readonly WaitForOptions[] = [
    { timeoutMs: 0 },
    { timeoutMs: tooLarge },
    { pollIntervalMs: 0 },
    { pollIntervalMs: tooLarge },
  ];
  let subscriptions = 0;

  const failures = await Promise.all(
    invalid.map((options) =>
      waitForSnapshot({
        matches: () => false,
        options,
        snapshot: () => Promise.resolve(0),
        subscribe: () => {
          subscriptions += 1;
          throw new Error("subscribed before validation");
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ),
  );

  expect(failures.every((failure) => failure instanceof TypeError)).toBe(true);
  expect(subscriptions).toBe(0);
});
