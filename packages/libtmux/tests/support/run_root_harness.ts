import { deadlineMs, RESERVATION_RELEASE_DEADLINE_MS } from "../../src/_internal/test/deadlines.js";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { prepareRunRoot, reapOwnedRunRoot } from "../../src/_internal/test/testkit.js";
import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

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
 * Wait until this test's own reservations are gone from the run root.
 *
 * The run root is shared: the supervisor publishes one and every test file uses
 * it, so at any moment another file running in parallel has live reservations
 * here that are none of this test's business. Asserting the directory is empty
 * asserts that nothing else is running, which under `--parallel` is a statement
 * about scheduling rather than about cleanup.
 *
 * So the baseline is taken before the work and only new entries are waited on.
 * Removing a reservation is also the tail of a cleanup the failing call has
 * already returned from, hence the wait rather than a single read.
 */
async function waitForNoNewReservations(
  runRoot: string,
  before: ReadonlySet<string>,
): Promise<void> {
  let added: string[] = [];
  const deadline = performance.now() + deadlineMs(RESERVATION_RELEASE_DEADLINE_MS);
  while (performance.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- absence is observed within one monotonic bound.
    added = (await reservationsIn(runRoot)).filter((entry) => !before.has(entry));
    if (added.length === 0) return;
    // eslint-disable-next-line no-await-in-loop -- absence observation is bounded and sequential.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fixture reservations were not released: ${added.join(", ")}`);
}

export { reservationsIn, waitForNoNewReservations, withTemporaryRunRoot };
