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
 * What made this bound expensive was the rate, not the duration. The poll
 * used to run again as soon as the previous invocation returned, so the cost
 * of waiting was measured in processes rather than in time: a longer bound
 * bought proportionally more invocations, and each is another check-then-exec
 * a fixture watching for controller replacement can lose. Raising the bound to
 * ten seconds unpaced tripled the rate at which that fixture caught its own
 * decoy being run, 3/8 against 1/8 over paired parallel runs.
 *
 * Pacing separates the two. The wait can then be sized for how long a loaded
 * machine takes to start a shell, because its cost no longer scales with it.
 */
export const READINESS_POLL_INTERVAL_MS = 20;

/**
 * Wait for tmux to bring a new server's first pane to its readiness hold.
 *
 * Sized for liveness, like the rest: a pane that never reaches its hold still
 * fails, and one that was slow to get there no longer does.
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
