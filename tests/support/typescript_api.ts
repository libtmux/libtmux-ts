/**
 * Run a script against TypeScript's native API.
 *
 * The API is a Go program, and this machine occasionally cancels one that
 * starts while other tsc processes are running — the build and the declaration
 * fixtures spawn their own — which surfaces as a nonzero exit with "context
 * canceled" on stderr. One retry clears it more often than not.
 *
 * Serializing the two call sites with a lock was tried and rejected: the
 * contention is with every tsc process the suite starts, not just between
 * these two, and making them queue pushed a build past its deadline instead.
 */

import { resolveNode22 } from "../../src/_internal/test/node22.js";

const CANCELLED = "context canceled";
const ATTEMPTS = 3;

export interface TypeScriptApiRun {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export async function runTypeScriptApi(
  script: string,
  argv: readonly string[],
  cwd: string,
): Promise<TypeScriptApiRun> {
  // The interpreter the rest of the suite pins, rather than whatever `node`
  // happens to mean here: a lane silently running a different major would
  // report a pass about a runtime it never exercised.
  const node = await resolveNode22();
  let last: TypeScriptApiRun = { exitCode: -1, stderr: "", stdout: "" };
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const child = Bun.spawn([node, "--input-type=module", "--eval", script, ...argv], {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    });
    // eslint-disable-next-line no-await-in-loop -- one attempt at a time, by design.
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    last = { exitCode, stderr, stdout };
    if (exitCode === 0 || !stderr.includes(CANCELLED)) return last;
  }
  return last;
}
