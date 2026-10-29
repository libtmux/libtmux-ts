/**
 * Time `Server.run` of `true`: one run after another on a server with no session
 * of its own, then with one, then several side by side.
 *
 *     bun scripts/bench-program.ts [runs] [side by side]
 *
 * It starts its own tmux server on a socket in a temporary directory, from the
 * `tmux` on PATH. Numbers belong to the machine and the tmux that produced
 * them, both of which are reported.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";

import { Server } from "../src/index.js";

const [runsArgument = "10", wideArgument = "16"] = process.argv.slice(2);
const runs = Number(runsArgument);
const wide = Number(wideArgument);
if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(wide) || wide < 1) {
  throw new TypeError("usage: bun scripts/bench-program.ts [runs] [side by side]");
}
const directory = await mkdtemp(join(tmpdir(), "ltx-bench-"));
const server = new Server({ socketPath: join(directory, "socket") });
try {
  // With no session of its own, each run starts the server and stops it on removing its own.
  let started = performance.now();
  for (let run = 0; run < runs; run += 1) {
    // eslint-disable-next-line no-await-in-loop -- one after another is what this times.
    await server.run(["true"]);
  }
  const cold = (performance.now() - started) / runs;
  // A session of its own keeps the server up between runs, as a caller's would.
  await server.newSession();
  await server.run(["true"]);
  const version = (await server.version()).raw;
  started = performance.now();
  for (let run = 0; run < runs; run += 1) {
    // eslint-disable-next-line no-await-in-loop -- one after another is what this times.
    await server.run(["true"]);
  }
  const oneByOne = (performance.now() - started) / runs;
  started = performance.now();
  await Promise.all(Array.from({ length: wide }, () => server.run(["true"])));
  const sideBySide = performance.now() - started;
  console.log(
    `tmux ${version} on ${process.platform} ${release()}: ${oneByOne.toFixed(0)} ms a run ` +
      `over ${String(runs)} one after another, ${cold.toFixed(0)} ms with no session ` +
      `keeping the server up; ${String(wide)} side by side took ${sideBySide.toFixed(0)} ms in all`,
  );
} finally {
  await server.kill();
  await rm(directory, { force: true, recursive: true });
}
