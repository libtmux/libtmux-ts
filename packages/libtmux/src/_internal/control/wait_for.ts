import { LibTmuxException, WaitTimeout } from "../../exc.js";
import type { TmuxEventStream, WaitForOptions } from "../../types.js";
import { timerDuration } from "../timing.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;

interface SnapshotWait<Snapshot> {
  readonly matches: (snapshot: Snapshot) => boolean;
  readonly options?: WaitForOptions;
  readonly snapshot: () => Promise<Snapshot>;
  readonly subscribe: () => TmuxEventStream;
}

interface WakeSignal {
  close(): void;
  next(): Promise<void>;
  signal(): void;
}

function createWakeSignal(pollIntervalMs: number): WakeSignal {
  let pending = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveWake: (() => void) | undefined;

  const signal = (): void => {
    pending = true;
    if (resolveWake === undefined) return;
    const resolve = resolveWake;
    resolveWake = undefined;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    resolve();
  };

  return {
    close: () => {
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      pollTimer = undefined;
    },
    next: async () => {
      if (!pending) {
        await new Promise<void>((resolve) => {
          resolveWake = resolve;
          pollTimer = setTimeout(signal, pollIntervalMs);
        });
      }
      pending = false;
    },
    signal,
  };
}

function timeout(): WaitTimeout {
  return new WaitTimeout("the awaited tmux state did not arrive before the deadline");
}

/** Wait for sampled state, using notifications as hints and polling as the fallback. */
export async function waitForSnapshot<Snapshot>(
  request: SnapshotWait<Snapshot>,
): Promise<Snapshot> {
  const timeoutMs = timerDuration("timeoutMs", request.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = timerDuration(
    "pollIntervalMs",
    request.options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const deadlineAt = performance.now() + timeoutMs;
  const events = request.subscribe();
  const wakes = createWakeSignal(pollIntervalMs);
  let deadlinePassed = false;
  let streamEnded = false;
  let streamFailure: unknown;
  let rejectDeadline!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = () => reject(timeout());
  });
  void deadline.catch(() => undefined);

  const expire = (): void => {
    if (deadlinePassed) return;
    deadlinePassed = true;
    wakes.signal();
    rejectDeadline();
  };
  const deadlineTimer = setTimeout(expire, Math.max(0, deadlineAt - performance.now()));
  const eventPump = (async (): Promise<void> => {
    try {
      for await (const _event of events) wakes.signal();
    } catch (error) {
      streamFailure = error;
    } finally {
      streamEnded = true;
      wakes.signal();
    }
  })();
  const expired = (): boolean => deadlinePassed || performance.now() >= deadlineAt;
  const inspect = async (): Promise<Snapshot | undefined> => {
    if (expired()) throw timeout();
    const snapshot = await Promise.race([request.snapshot(), deadline]);
    if (expired()) throw timeout();
    const matched = request.matches(snapshot);
    if (expired()) throw timeout();
    return matched ? snapshot : undefined;
  };

  try {
    let matched = await inspect();
    if (matched !== undefined) return matched;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- one wake drives one snapshot.
      await wakes.next();
      if (expired()) throw timeout();
      if (streamEnded) {
        if (streamFailure !== undefined) throw streamFailure;
        throw new LibTmuxException("the tmux event stream ended before the awaited state arrived");
      }
      // eslint-disable-next-line no-await-in-loop -- snapshots must not overlap.
      matched = await inspect();
      if (matched !== undefined) return matched;
    }
  } finally {
    clearTimeout(deadlineTimer);
    wakes.close();
    try {
      await events.close();
    } finally {
      await eventPump;
    }
  }
}
