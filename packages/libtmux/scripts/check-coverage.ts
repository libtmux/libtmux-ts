import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NODE22, preflight } from "./preflight.js";

/**
 * Coverage over the suites together, because they cover different things.
 *
 * The unit suite alone reports single digits for `pane.ts`, and the honest
 * reading of that is not "write unit tests for panes" — it is that a pane's
 * methods are proven against a real tmux server, which is the project's whole
 * testing posture. A floor measured on the unit suite would push work towards
 * mocking a server, which is the one thing this suite is built not to do.
 *
 * Per file as well as overall: an average stays green while a new module
 * arrives with nothing exercising it, and catching that is what a coverage gate
 * is actually for.
 */

/** What the library ships. The harness is not published and is not the subject. */
const SUBJECT = /^src\//u;
const EXCLUDED = [/^src\/_internal\/test\//u, /^src\/_generated\//u];

/**
 * Floors, set just under what the suites reach today.
 *
 * Low enough that ordinary work does not trip them and high enough that
 * deleting a suite does. They are a ratchet: raise them when the number moves,
 * rather than leaving room nobody is using.
 */
const OVERALL_FLOOR = 90;
const PER_FILE_FLOOR = 60;

interface FileCoverage {
  readonly covered: number;
  readonly path: string;
  readonly total: number;
}

/** Read the line counters out of lcov, which is the only format that carries them per file. */
function parseLcov(text: string): readonly FileCoverage[] {
  const files: FileCoverage[] = [];
  let path: string | undefined;
  let total = 0;
  let covered = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      path = line.slice(3).trim();
      total = 0;
      covered = 0;
      continue;
    }
    if (line.startsWith("DA:")) {
      const [, hits] = line.slice(3).split(",");
      total += 1;
      if (hits !== undefined && Number(hits) > 0) covered += 1;
      continue;
    }
    if (line.startsWith("end_of_record") && path !== undefined) {
      files.push({ covered, path, total });
      path = undefined;
    }
  }
  return files;
}

function percentage(covered: number, total: number): number {
  return total === 0 ? 100 : (covered / total) * 100;
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

await preflight([NODE22]);

const coverageDirectory = join(packageRoot, "coverage");
await rm(coverageDirectory, { force: true, recursive: true });

const run = Bun.spawnSync({
  cmd: [
    "bun",
    "test",
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${coverageDirectory}`,
    "--timeout=60000",
    "--no-orphans",
    "tests/unit",
    "tests/integration",
  ],
  cwd: packageRoot,
  stderr: "inherit",
  stdout: "inherit",
});
if (run.exitCode !== 0) process.exit(run.exitCode);

const lcov = await readFile(join(coverageDirectory, "lcov.info"), "utf8").catch(() => "");
if (lcov === "") {
  process.stderr.write("no coverage was written; the run produced no lcov.info\n");
  process.exit(1);
}

const measured = parseLcov(lcov).filter(
  (file) => SUBJECT.test(file.path) && !EXCLUDED.some((pattern) => pattern.test(file.path)),
);
if (measured.length === 0) {
  process.stderr.write("coverage reported nothing under src/, which cannot be right\n");
  process.exit(1);
}

const covered = measured.reduce((sum, file) => sum + file.covered, 0);
const total = measured.reduce((sum, file) => sum + file.total, 0);
const overall = percentage(covered, total);
const thin = measured
  .filter((file) => percentage(file.covered, file.total) < PER_FILE_FLOOR)
  .toSorted(
    (left, right) => percentage(left.covered, left.total) - percentage(right.covered, right.total),
  );

for (const file of thin) {
  process.stderr.write(
    `${file.path}: ${percentage(file.covered, file.total).toFixed(1)}% of lines, floor is ${String(PER_FILE_FLOOR)}%\n`,
  );
}
if (overall < OVERALL_FLOOR) {
  process.stderr.write(
    `overall ${overall.toFixed(2)}% of lines, floor is ${String(OVERALL_FLOOR)}%\n`,
  );
}
if (thin.length > 0 || overall < OVERALL_FLOOR) process.exit(1);

process.stdout.write(
  `Coverage holds: ${overall.toFixed(2)}% of ${String(total)} lines across ${String(measured.length)} shipped modules, none under ${String(PER_FILE_FLOOR)}%\n`,
);
