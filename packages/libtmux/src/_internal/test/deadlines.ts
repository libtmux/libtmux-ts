/**
 * How long the fixture waits for something to happen.
 *
 * These are liveness bounds, not correctness ones. Every site that uses them
 * polls and continues the moment the thing it waits for is true, so a generous
 * bound costs nothing when the machine is idle and only delays the report when
 * something is genuinely stuck. A tight one, by contrast, is decided by whatever
 * else the machine is running: a busy host turns "tmux took 2.5 seconds to
 * settle" into a failure that reads like a defect in the code under test.
 *
 * Timing invariants are a different thing and do not belong here. A bound that
 * exists to prove something happened *promptly* — that no leaked timer is
 * holding a process open — has to stay tight to mean anything, and stays at its
 * call site with the reasoning that picked it.
 *
 * `LIBTMUX_TEST_DEADLINE_SCALE` multiplies every bound, for a machine slower
 * than the ones this was tuned on.
 */

const DEFAULT_SCALE = 1;
const MAX_SCALE = 100;

function scale(): number {
  const raw = process.env.LIBTMUX_TEST_DEADLINE_SCALE;
  if (raw === undefined || raw === "") return DEFAULT_SCALE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_SCALE) {
    throw new Error(
      `LIBTMUX_TEST_DEADLINE_SCALE must be a positive number up to ${String(MAX_SCALE)}, received ${raw}`,
    );
  }
  return parsed;
}

/**
 * How long to leave between readiness polls.
 *
 * Pacing decouples the wait's duration from its cost. An unpaced poll runs
 * again as soon as the last invocation returns, so a longer bound buys
 * proportionally more invocations — and each is another check-then-exec a
 * fixture watching for controller replacement can lose.
 */
export const READINESS_POLL_INTERVAL_MS = 20;

/**
 * Wait for tmux to bring a new server's first pane to its readiness hold.
 *
 * Sized for liveness, like the rest: a pane that never reaches its hold still
 * fails, and one that is merely slow to get there does not.
 */
export const READINESS_DEADLINE_MS = 20_000;

/**
 * Give a tmux daemon a chance to exit on its own before cleanup reaps it.
 *
 * This one is a step in an escalation ladder, not a wait for something that
 * will certainly happen, so it is deliberately short: every millisecond spent
 * here is a millisecond the fixture holds its reservation while a later test
 * waits for that reservation to disappear. Lengthening it does not make a stuck
 * daemon exit — it makes the whole file slower to recover from one.
 */
export const DAEMON_EXIT_DEADLINE_MS = 750;

/**
 * Let the pidfd helper finish before cleanup gives up on it.
 *
 * The slowest child the fixture starts: an interpreter start plus a program,
 * spawned while the suite is running several files at once. A helper written to
 * hang still has to be stopped, so there is a bound — but this is a liveness
 * one, and a helper killed part-way leaves the daemon it was sent to reap. That
 * reads as a leak in whatever test ran next rather than as the busy machine it
 * was.
 */
export const PIDFD_HELPER_DEADLINE_MS = 5_000;

/** Confirm a daemon is gone once cleanup has already escalated to reaping it. */
export const DAEMON_REAPED_DEADLINE_MS = 2_000;

/**
 * Wait for a control-mode client to appear in `list-clients`.
 *
 * Kept the tightest of these on purpose: one fixture drives this deadline to
 * expiry deliberately, so every millisecond here is time that test spends
 * waiting to observe the failure it is about.
 */
export const CONTROL_REGISTRATION_DEADLINE_MS = 2_000;

/**
 * Wait for one tmux command the reaper or a launch probe runs to answer.
 *
 * Deliberately the shorter of the two: these sit on the cleanup path, where
 * every millisecond is one the fixture holds its reservation while a later test
 * waits for it to go. Scaled rather than lengthened — a busy machine needs
 * proportionally longer, and an idle one should not wait longer than it did.
 */
export const FIXTURE_PROBE_DEADLINE_MS = 1_000;

/**
 * Wait for one tmux command that brings a fixture server up.
 *
 * Bootstrapping starts a daemon and waits for its first pane, so it is the
 * slower of the two and is not on the path a later test is blocked behind.
 */
export const FIXTURE_BOOTSTRAP_DEADLINE_MS = 3_000;

/**
 * Wait for a fixture's reservation directory to disappear after cleanup.
 *
 * Cleanup runs after the call that failed has already returned, so this is
 * observing a tail rather than driving it: the daemon gets its chance to exit,
 * then reaping, then the directory goes. A reservation that genuinely leaks
 * never disappears, so a generous bound costs nothing and a tight one turns one
 * slow cleanup into a failure in every later test sharing the run root.
 */
export const RESERVATION_RELEASE_DEADLINE_MS = 15_000;

/** Apply the machine's scale to one of the bounds above. */
export function deadlineMs(base: number): number {
  return Math.ceil(base * scale());
}
