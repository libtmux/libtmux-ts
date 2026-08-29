/**
 * Run the real-tmux gates against every tmux the machine offers.
 *
 * The package claims a compatibility range, and a suite run against one binary
 * cannot support that claim however green it is. Version-gated code — the
 * registry withholds newer format fields from older servers — is only
 * exercised by an older server, and a behaviour difference between releases
 * only shows up when both are present. Running against 3.3a is what turned up
 * that tmux suppresses run-shell output for a clientless invocation.
 *
 * Point LIBTMUX_TMUX_BUILDS at a directory of prefixes (`3.2a/bin/tmux`,
 * `3.4/bin/tmux`, …). Without it, the tmux on PATH is the only one checked,
 * and this reports that rather than pretending to have covered a range.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { runBoundedCommand } from "../../../scripts/bounded_process.js";

const GATES = ["test:integration", "test:node", "test:differential"] as const;

interface Candidate {
  readonly executable: string;
  readonly label: string;
}

async function version(executable: string): Promise<string | undefined> {
  const result = await runBoundedCommand([executable, "-V"], {
    env: { ...process.env },
    maxOutputBytes: 4 * 1024,
    timeoutMilliseconds: 5_000,
  }).catch(() => undefined);
  return result?.termination === "exited" && result.exitCode === 0
    ? result.stdout.trim()
    : undefined;
}

async function candidates(): Promise<readonly Candidate[]> {
  const found: Candidate[] = [];
  const root = process.env.LIBTMUX_TMUX_BUILDS;
  if (root !== undefined) {
    for (const entry of await readdir(root)) {
      const executable = join(root, entry, "bin", "tmux");
      // eslint-disable-next-line no-await-in-loop -- a handful of directory probes.
      const usable = await stat(executable).then(
        () => true,
        () => false,
      );
      if (usable) found.push({ executable, label: entry });
    }
  }
  const onPath = Bun.which("tmux");
  if (onPath !== null && !found.some((entry) => entry.executable === onPath)) {
    found.push({ executable: onPath, label: "PATH" });
  }
  return found;
}

async function runGate(gate: string, executable: string): Promise<boolean> {
  const child = Bun.spawn(["bun", "run", gate], {
    env: {
      ...process.env,
      // The suite resolves tmux from PATH, so putting this build first is what
      // selects it for every process the gate spawns.
      PATH: `${executable.slice(0, executable.lastIndexOf("/"))}:${process.env.PATH ?? ""}`,
    },
    stderr: "inherit",
    stdout: "ignore",
  });
  return (await child.exited) === 0;
}

const builds = await candidates();
if (builds.length === 0) {
  process.stderr.write("no tmux found\n");
  process.exit(1);
}

// The gates import what the build emits, and none of them builds it in time:
// test:node does, but it runs after test:integration, which needs it already
// there. On a clean checkout that failed as a missing dist module rather than
// as anything about tmux. The build does not vary by tmux, so it happens once.
const emitted = Bun.spawn(["bun", "run", "build"], { stderr: "inherit", stdout: "ignore" });
if ((await emitted.exited) !== 0) {
  process.stderr.write("the library build failed, so no tmux was checked\n");
  process.exit(1);
}

let failed = false;
for (const build of builds) {
  // eslint-disable-next-line no-await-in-loop -- one build at a time.
  const reported = await version(build.executable);
  if (reported === undefined) {
    process.stderr.write(`${build.label}: not runnable\n`);
    failed = true;
    continue;
  }
  for (const gate of GATES) {
    // Gates run one at a time: two tmux suites at once contend for the same
    // machine and turn a real failure into a timing question.
    // eslint-disable-next-line no-await-in-loop -- gates contend for the machine.
    const ok = await runGate(gate, build.executable);
    process.stdout.write(`${reported.padEnd(12)} ${gate.padEnd(18)} ${ok ? "ok" : "FAILED"}\n`);
    if (!ok) failed = true;
  }
}

if (builds.length === 1) {
  process.stdout.write(
    "checked one tmux; set LIBTMUX_TMUX_BUILDS to a directory of prefixes to cover the range\n",
  );
}
process.exit(failed ? 1 : 0);
