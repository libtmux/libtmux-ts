/**
 * Which tmux lanes the typescript workflow runs.
 *
 * `.github/ci-matrix.txt` lists the releases and Bun versions once. A push or
 * pull request runs the first and last supported release. The whole table and
 * the preview and development lanes run for a release (the publish workflow
 * calls this one with `scope: full`) and for a dispatch with `scope: full`. A dispatch with `scope: custom` runs the tmux versions,
 * tags, branches or commits it names.
 *
 * Inputs arrive through the environment, never inline in a script. A push or
 * pull request ignores every input but a scope of `full`, which is how the
 * publish workflow asks for the whole table.
 */

import { TMUX_REF, fail, validRef, validToolchain, type CiMatrix } from "./ci_matrix.js";

const COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE = /^[0-9]+\.[0-9]+[a-z]?$/u;
const RUNNERS = ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"] as const;
const TMATE_MODES = ["off", "before-tests", "on-failure"] as const;
const SCOPES = ["edges", "full", "custom"] as const;

export type Scope = (typeof SCOPES)[number];

/** The inputs of one run, as the workflow passes them through its environment. */
export interface PlanInput {
  readonly bun?: string | undefined;
  readonly event: string;
  readonly os?: string | undefined;
  readonly ref?: string | undefined;
  readonly scope?: string | undefined;
  readonly tmate?: string | undefined;
  readonly tmuxRef?: string | undefined;
}

/** One leg of the `tmux` job. */
export interface Lane {
  readonly advisory: boolean;
  readonly "bun-version": string;
  /** A glob `tmux -V` has to match, so a lane cannot build the wrong ref. */
  readonly expect: string;
  readonly name: string;
  readonly tmate: string;
  readonly "tmux-version": string;
}

export interface CiPlan {
  readonly bun: readonly string[];
  /** The `tmux` legs. */
  readonly lanes: readonly Lane[];
  readonly os: string;
  readonly scope: Scope;
  /** Jobs the plan leaves out of scope, which may be skipped. */
  readonly skip: readonly string[];
}

/** Split a comma-separated input. An empty item is an error, not a typo to absorb. */
function splitList(text: string, label: string): readonly string[] {
  if (text.trim() === "") fail(`${label} is empty`);
  const items: string[] = [];
  for (const raw of text.split(",")) {
    const item = raw.trim();
    if (item === "") fail(`${label} has an empty item: ${text}`);
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

function oneOf<T extends string>(allowed: readonly T[], value: string, label: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) fail(`${label} must be ${allowed.join(", ")}, got: ${value}`);
  return match;
}

function expectation(ref: string, matrix: CiMatrix): string {
  if (matrix.development.includes(ref)) return "tmux next-*";
  const release = ref.replace(/^release_/u, "");
  return RELEASE.test(release) ? `tmux ${release}` : "tmux *";
}

/** Plan one run. */
export function planCi(matrix: CiMatrix, input: PlanInput): CiPlan {
  const dispatch = input.event === "workflow_dispatch";
  let scope: Scope = "edges";
  switch (input.event) {
    case "push":
      if (input.ref?.startsWith("refs/tags/") === true) scope = "full";
      break;
    case "pull_request":
      break;
    case "workflow_dispatch":
      scope = oneOf(
        SCOPES,
        input.scope === undefined || input.scope === "" ? "edges" : input.scope,
        "scope",
      );
      break;
    default:
      fail(`no plan for the ${input.event} event`);
  }
  // A caller may widen a run to the whole table and never narrow it.
  if (!dispatch && input.scope !== undefined && input.scope !== "") {
    if (oneOf(["edges", "full"], input.scope, "scope") === "full") scope = "full";
  }

  let os = "ubuntu-latest";
  let tmate = "off";
  let bun: readonly string[] = matrix.bun;
  let laneBun: readonly string[] = [matrix.laneBun];
  if (dispatch) {
    if (input.os !== undefined && input.os !== "") os = oneOf(RUNNERS, input.os, "os");
    if (input.tmate !== undefined && input.tmate !== "") {
      tmate = oneOf(TMATE_MODES, input.tmate, "tmate");
    }
    if (input.bun !== undefined && input.bun.trim() !== "") {
      bun = splitList(input.bun, "bun");
      for (const version of bun) {
        if (!validToolchain(version)) fail(`bun has an invalid item: ${version}`);
      }
      laneBun = bun;
    }
  }

  let refs: readonly string[] = [];
  switch (scope) {
    case "edges": {
      const first = matrix.supported[0];
      const last = matrix.supported.at(-1);
      refs =
        first === last || first === undefined || last === undefined ? [last ?? ""] : [first, last];
      break;
    }
    case "full":
      refs = [...matrix.supported, ...matrix.preview, ...matrix.development];
      break;
    case "custom": {
      const requested = splitList(input.tmuxRef ?? "", "tmux-ref");
      for (const ref of requested) {
        if (!validRef(ref)) {
          fail(`tmux-ref has an invalid item (want ${TMUX_REF.source}, no leading dash): ${ref}`);
        }
      }
      refs = requested;
      break;
    }
  }

  const lanes: Lane[] = [];
  for (const ref of refs) {
    const label = COMMIT.test(ref) ? ref.slice(0, 12) : ref;
    for (const version of laneBun) {
      lanes.push({
        advisory: matrix.development.includes(ref),
        "bun-version": version,
        expect: expectation(ref, matrix),
        name: version === matrix.laneBun ? label : `${label}, Bun ${version}`,
        tmate,
        "tmux-version": ref,
      });
    }
  }

  if (tmate !== "off" && lanes.length !== 1) {
    fail(
      `tmate needs exactly one tmux lane and the plan has ${String(lanes.length)}; name one tmux-ref and at most one bun`,
    );
  }

  const skip: string[] = [];
  if (lanes.length === 0) skip.push("tmux");
  return { bun, lanes, os, scope, skip };
}

interface NeedResult {
  readonly result?: unknown;
}

/**
 * The jobs that did not pass. A skipped job passes only when the plan left it
 * out of scope, and a run with nothing to verify is an error, not a pass.
 */
export function unpassedJobs(
  needs: Readonly<Record<string, NeedResult>>,
  allowSkipped: readonly string[],
): readonly string[] {
  const jobs = Object.entries(needs);
  if (jobs.length === 0) fail("NEEDS_JSON holds no jobs");
  return jobs
    .filter(([name, need]) => {
      if (need.result === "success") return false;
      return !(need.result === "skipped" && allowSkipped.includes(name));
    })
    .map(([name, need]) => `${name}: ${typeof need.result === "string" ? need.result : "null"}`);
}
