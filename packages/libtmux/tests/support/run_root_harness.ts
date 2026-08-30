import {
  deadlineMs,
  fixtureReservationPrefix,
  RESERVATION_RELEASE_DEADLINE_MS,
  prepareRunRoot,
  reapOwnedRunRoot,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export async function createIsolatedRunRoot(
  name: string,
): Promise<{ parent: string; root: string }> {
  const parent = await makeTestDirectory("ltx4-supervisor-");
  const root = join(parent, name);
  await prepareRunRoot(root);
  return { parent, root };
}

export async function removeIsolatedRunRoot(parent: string, root: string): Promise<void> {
  await reapOwnedRunRoot(root);
  await rm(parent, { force: true, recursive: true });
}

async function withTemporaryRunRoot<T>(
  name: string,
  body: (runRoot: string) => Promise<T>,
): Promise<T> {
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  if (published !== undefined) return body(published);
  const parent = await makeTestDirectory("ltx4-it-");
  const runRoot = join(parent, name);
  await prepareRunRoot(runRoot);
  try {
    return await body(runRoot);
  } finally {
    await reapOwnedRunRoot(runRoot);
    await rm(parent, { force: true, recursive: true });
  }
}

/** Everything in a run root except the record naming its owner. */
async function reservationsIn(runRoot: string): Promise<readonly string[]> {
  return (await readdir(runRoot)).filter((entry) => entry !== ".owner.json");
}

/**
 * Wait until every reservation this process made has been released.
 *
 * A run root is shared: the supervisor publishes one and each test file the
 * suite runs at once reserves in it. Only this process's own reservations say
 * anything about its cleanup, and the name carries the process id that decides
 * that — so the question is asked by owner rather than by comparing against a
 * reading taken earlier, which counts a sibling's later reservation as this
 * one's leak and waits out the deadline on a fixture that is still in use.
 *
 * Removing a reservation is the tail of a cleanup the failing call has already
 * returned from, hence the wait rather than a single read.
 */
async function waitForOwnReservations(runRoot: string): Promise<void> {
  const prefix = fixtureReservationPrefix();
  let held: string[] = [];
  const deadline = performance.now() + deadlineMs(RESERVATION_RELEASE_DEADLINE_MS);
  while (performance.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- absence is observed within one monotonic bound.
    held = (await reservationsIn(runRoot)).filter((entry) => entry.startsWith(prefix));
    if (held.length === 0) return;
    // eslint-disable-next-line no-await-in-loop -- absence observation is bounded and sequential.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fixture reservations were not released: ${held.join(", ")}`);
}

export { waitForOwnReservations, withTemporaryRunRoot };
