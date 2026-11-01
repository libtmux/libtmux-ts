import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PlanError, parseCiMatrix } from "./ci_matrix.js";
import { planCi, unpassedJobs } from "./ci_plan.js";

/**
 * Plan the tmux lanes of the typescript workflow, or verify that its jobs
 * passed. The rules live in `ci_plan.ts`; this reads the environment and
 * writes `$GITHUB_OUTPUT`.
 *
 *   bun scripts/plan-ci.ts          plan, from .github/ci-matrix.txt
 *   bun scripts/plan-ci.ts verify   read NEEDS_JSON and ALLOW_SKIPPED
 */

function annotate(message: string): never {
  process.stderr.write(`::error::plan-ci: ${message}\n`);
  process.exit(1);
}

function verify(): void {
  const raw = process.env.NEEDS_JSON;
  if (raw === undefined || raw === "") annotate("verify needs NEEDS_JSON");
  let needs: unknown;
  try {
    needs = JSON.parse(raw);
  } catch {
    return annotate("NEEDS_JSON is not JSON");
  }
  if (typeof needs !== "object" || needs === null || Array.isArray(needs)) {
    annotate("NEEDS_JSON is not an object of jobs");
  }
  const allowed = (process.env.ALLOW_SKIPPED ?? "").split(/\s+/u).filter((name) => name !== "");
  const unpassed = unpassedJobs(needs as Record<string, { result?: unknown }>, allowed);
  if (unpassed.length > 0) annotate(`these jobs did not pass:\n${unpassed.join("\n")}`);
  process.stdout.write("required: every planned job passed\n");
}

function plan(): void {
  const manifest =
    process.env.CI_MATRIX ?? fileURLToPath(new URL("../.github/ci-matrix.txt", import.meta.url));
  const matrix = parseCiMatrix(readFileSync(manifest, "utf8"));
  const event = process.env.GITHUB_EVENT_NAME;
  if (event === undefined || event === "") annotate("GITHUB_EVENT_NAME is not set");
  const result = planCi(matrix, {
    bun: process.env.INPUT_BUN,
    event,
    os: process.env.INPUT_OS,
    ref: process.env.GITHUB_REF,
    scope: process.env.INPUT_SCOPE,
    tmate: process.env.INPUT_TMATE,
    tmuxRef: process.env.INPUT_TMUX_REF,
  });
  const lines = [
    `scope=${result.scope}`,
    `tmux=${JSON.stringify(result.lanes)}`,
    `bun-versions=${JSON.stringify(result.bun)}`,
    `os=${result.os}`,
    `skip=${result.skip.join(" ")}`,
    `jobs=${String(result.lanes.length)}`,
  ];
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined || output === "") process.stdout.write(`${lines.join("\n")}\n`);
  else appendFileSync(output, `${lines.join("\n")}\n`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") {
    appendFileSync(
      summary,
      [
        "### tmux plan",
        "",
        `- scope: \`${result.scope}\``,
        `- tmux lanes: \`${result.lanes.map((lane) => lane["tmux-version"]).join(" ")}\``,
        `- Bun: \`${result.bun.join(" ")}\``,
        `- planned tmux jobs: ${String(result.lanes.length)}`,
        "",
      ].join("\n"),
    );
  }
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || (command !== undefined && command !== "verify")) {
    annotate(`unknown argument: ${[command, ...rest].join(" ")}`);
  }
  if (command === "verify") verify();
  else plan();
} catch (error) {
  if (error instanceof PlanError) annotate(error.message);
  throw error;
}
