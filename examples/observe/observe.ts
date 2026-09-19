import { Server } from "libtmux";
import type { TmuxInvocationReport } from "libtmux";

/** What one observed run measured, rather than assumed. */
export interface ObservedRun {
  /**
   * Invocations the first snapshot on a new server cost: two.
   *
   * One is the version probe, which runs once per server and decides which
   * formats this tmux understands; the other is the snapshot.
   */
  readonly firstCallCalls: number;
  /** Invocations every snapshot after that costs. One, whatever it describes. */
  readonly snapshotCalls: number;
  /** Invocations a hundred queries against that snapshot cost. None. */
  readonly queryCalls: number;
  /** Concurrent calls that had to wait for a slot under `maxInFlight`. */
  readonly queued: number;
  /** Every report the run collected, in the order the invocations finished. */
  readonly reports: readonly TmuxInvocationReport[];
}

/**
 * See what the library is doing, and bound how much of it runs at once.
 *
 * `onInvocation` is called once per tmux invocation, after it answers or
 * fails. It is the seam for logs, traces and metrics: without it, watching the
 * library means supplying a whole engine just to see what it sent. It cannot
 * change what a command does, and anything it throws — or rejects with — is
 * swallowed, because a command must not fail on account of the code watching
 * it.
 *
 * What it reports is also how the two claims this package makes about cost are
 * checked rather than believed. A snapshot is one invocation no matter how
 * many panes it describes, and every query and relation read against that
 * snapshot is none at all — so the counting here is the claim itself, run.
 *
 * `maxInFlight` is the other half. tmux runs commands on one thread, so firing
 * a batch concurrently buys queueing rather than throughput; the ceiling keeps
 * a burst from becoming a pile of processes, and `queuedMs` says how long each
 * call waited for its slot. Set to 1 below to make the wait visible in a
 * handful of calls rather than a hundred.
 */
export async function whatTheLibraryIsDoing(reference: Server): Promise<ObservedRun> {
  const socketPath = reference.socketPath;
  if (socketPath === undefined) throw new Error("this example needs a socket-path server");

  const reports: TmuxInvocationReport[] = [];
  const server = new Server({
    // One slot, so the concurrent burst below has to line up.
    maxInFlight: 1,
    onInvocation: (report) => reports.push(report),
    socketPath,
    tmuxBin: reference.tmuxBin,
  });

  // The first call on a new server also pays the version probe, once. Reported
  // separately rather than hidden: a consumer measuring cost should see the
  // one-off, not discover it later as an unexplained extra process.
  await server.snapshot();
  const firstCallCalls = reports.length;

  // From here the count is the steady state: one invocation, an identity read
  // and four listings in a single command list, whatever the server holds.
  const beforeSnapshot = reports.length;
  const snapshot = await server.snapshot();
  const snapshotCalls = reports.length - beforeSnapshot;

  // Relations and filters read the snapshot already in hand. Nothing here
  // reaches tmux, which is what makes traversal free once acquired.
  const beforeQueries = reports.length;
  for (let index = 0; index < 100; index += 1) {
    snapshot.panes.where({ active: true });
    snapshot.windows.toArray().map((window) => window.panes.length);
  }
  const queryCalls = reports.length - beforeQueries;

  // Four at once against a one-slot ceiling: the first runs, the rest wait,
  // and `queuedMs` is what they waited. The order they finish in is tmux's,
  // not the order they were asked for — which is why `pipeline` and `batch`
  // exist for work whose order matters.
  const beforeBurst = reports.length;
  await Promise.all(Array.from({ length: 4 }, () => server.snapshot()));
  const queued = reports.slice(beforeBurst).filter((report) => report.queuedMs > 0).length;

  return { firstCallCalls, queryCalls, queued, reports, snapshotCalls };
}
