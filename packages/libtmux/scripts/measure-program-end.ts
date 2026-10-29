/**
 * Measure how often tmux reaps a pane before reading a program's last output,
 * and whether the run's end mark catches every such run.
 *
 *     bun scripts/measure-program-end.ts <runs per probe> <rounds> <tmux>...
 *
 * Each round runs every shape as three probes at once, on sockets in a temporary
 * directory, so the host is loaded; the last lines give each shape's range over rounds.
 * The wrapper is the one program runs start, imported rather than copied.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MARK, RUN } from "../src/_internal/operations/program_start.js";

const LINGER = "sleep 0.05 2>/dev/null || sleep 1; ";
if (!RUN.includes(LINGER))
  throw new Error("the wrapper no longer lingers the way this script cuts it");
const SHAPES: Readonly<Record<string, string>> = {
  bare: 'exec "$0" "$@"',
  unlingered: MARK + RUN.replace(LINGER, ""),
  shipped: MARK + RUN,
};
const LINES = 3000;
const PATH_MARK = "ltx-measure-mark";

async function tmux(binary: string, socket: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn([binary, "-S", socket, "-f", "/dev/null", ...args], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text;
}

interface Tally {
  whole: number;
  marked: number;
  markedButCut: number;
}

/** Run one program in a fresh session and read back what the pane kept. */
async function runOnce(
  binary: string,
  socket: string,
  script: string,
  argv: readonly string[],
): Promise<{ whole: boolean; marked: boolean }> {
  await tmux(binary, socket, [
    "new-session",
    "-d",
    "-s",
    "run",
    "-x",
    "80",
    "-y",
    "24",
    "--",
    "true",
    ";",
    "set",
    "-t",
    "=run:",
    "history-limit",
    "5000",
    ";",
    "set",
    "-w",
    "-t",
    "=run:",
    "remain-on-exit",
    "on",
    ";",
    "set",
    "-w",
    "-t",
    "=run:",
    "remain-on-exit-format",
    "",
  ]);
  const pane = (await tmux(binary, socket, ["display", "-p", "-t", "=run:", "#{pane_id}"])).trim();
  await tmux(binary, socket, [
    "respawn-pane",
    "-k",
    "-t",
    pane,
    "--",
    "sh",
    "-c",
    script,
    ...argv,
    ";",
    "wait-for",
    "-E",
    "-F",
    `#{==:#{pane},${pane}}`,
    "pane-died",
  ]);
  const shown = await tmux(binary, socket, [
    "capture-pane",
    "-p",
    "-J",
    "-S",
    "-",
    "-E",
    "-",
    "-t",
    pane,
  ]);
  const path = (await tmux(binary, socket, ["display", "-p", "-t", pane, "#{pane_path}"])).trim();
  await tmux(binary, socket, ["kill-session", "-t", "=run"]);
  return {
    marked: path === PATH_MARK,
    whole: shown.split("\n").findLast((line) => line !== "") === String(LINES),
  };
}

async function probe(binary: string, shape: string, runs: number, socket: string): Promise<Tally> {
  const tally: Tally = { marked: 0, markedButCut: 0, whole: 0 };
  const script = SHAPES[shape] ?? "";
  const argv =
    shape === "bare" ? ["seq", "1", String(LINES)] : ["seq", PATH_MARK, "1", String(LINES)];
  await tmux(binary, socket, ["new-session", "-d", "-s", "keep"]);
  for (let run = 0; run < runs; run += 1) {
    // eslint-disable-next-line no-await-in-loop -- one run at a time per probe; probes run side by side.
    const { marked, whole } = await runOnce(binary, socket, script, argv);
    tally.whole += whole ? 1 : 0;
    tally.marked += marked ? 1 : 0;
    tally.markedButCut += marked && !whole ? 1 : 0;
  }
  await tmux(binary, socket, ["kill-server"]);
  return tally;
}

const [runsArgument, roundsArgument, ...binaries] = process.argv.slice(2);
const runs = Number(runsArgument);
const rounds = Number(roundsArgument);
if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(rounds) || rounds < 1) {
  throw new TypeError(
    "usage: bun scripts/measure-program-end.ts <runs per probe> <rounds> <tmux>...",
  );
}
if (binaries.length === 0) throw new TypeError("name at least one tmux binary");
const sockets = mkdtempSync(join(tmpdir(), "ltx-measure-"));
const range = (values: readonly number[]): string =>
  `${String(Math.min(...values))}-${String(Math.max(...values))}`;
try {
  for (const binary of binaries) {
    // eslint-disable-next-line no-await-in-loop -- one tmux at a time.
    const version = (await new Response(Bun.spawn([binary, "-V"]).stdout).text()).trim();
    const seen = new Map<string, Tally[]>(Object.keys(SHAPES).map((shape) => [shape, []]));
    for (let round = 1; round <= rounds; round += 1) {
      for (const shape of Object.keys(SHAPES)) {
        // eslint-disable-next-line no-await-in-loop -- one shape at a time, three probes at once.
        const tallies = await Promise.all(
          [1, 2, 3].map((probeNumber) =>
            probe(binary, shape, runs, join(sockets, String(probeNumber))),
          ),
        );
        const tally: Tally = { marked: 0, markedButCut: 0, whole: 0 };
        for (const one of tallies) {
          tally.whole += one.whole;
          tally.marked += one.marked;
          tally.markedButCut += one.markedButCut;
        }
        seen.get(shape)?.push(tally);
        console.log(
          `${version} round ${String(round)} ${shape}: whole ${String(tally.whole)} of ` +
            `${String(runs * 3)}, mark shown ${String(tally.marked)}, ` +
            `mark on a cut run ${String(tally.markedButCut)}`,
        );
      }
    }
    for (const [shape, tallies] of seen) {
      const lost = tallies.map((tally) => runs * 3 - tally.whole);
      const markedButCut = tallies.reduce((total, tally) => total + tally.markedButCut, 0);
      console.log(
        `${version} ${shape} over ${String(rounds)} rounds: lost ${range(lost)} of ` +
          `${String(runs * 3)} a round, ${String(lost.reduce((a, b) => a + b, 0))} in all; ` +
          `mark on a cut run ${String(markedButCut)}`,
      );
    }
  }
} finally {
  rmSync(sockets, { force: true, recursive: true });
}
