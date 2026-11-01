import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlanError, parseCiMatrix } from "../../../../scripts/ci_matrix.js";
import { planCi, unpassedJobs, type PlanInput } from "../../../../scripts/ci_plan.js";

const repositoryRoot = new URL("../../../../", import.meta.url).pathname;

/** A small table with a middle release, a preview and a development lane. */
const table = `
# a comment
supported 3.3a
supported 3.4
supported 3.7  # trailing comment
supported 3.8

preview release_3.8a
development master

bun 1.3.14
bun 1.4.0
bun 1.4.2
lane-bun 1.4.0
`;
const matrix = parseCiMatrix(table);

const push: PlanInput = { event: "push", ref: "refs/heads/master" };
const dispatch = (inputs: Omit<PlanInput, "event">): PlanInput => ({
  event: "workflow_dispatch",
  ...inputs,
});
const versions = (input: PlanInput): readonly string[] =>
  planCi(matrix, input).lanes.map((lane) => lane["tmux-version"]);
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof PlanError) return error.message;
    throw error;
  }
  throw new Error("expected the plan to be refused");
};

describe("the events", () => {
  test("a push to a branch and a pull request run only the first and last release", () => {
    for (const input of [push, { event: "pull_request", ref: "refs/pull/7/merge" }]) {
      const plan = planCi(matrix, input);
      expect(plan.lanes.map((lane) => lane["tmux-version"])).toEqual(["3.3a", "3.8"]);
      expect(plan.scope).toBe("edges");
      expect(plan.skip).toEqual([]);
      expect(plan.bun).toEqual(["1.3.14", "1.4.0", "1.4.2"]);
      expect(plan.os).toBe("ubuntu-latest");
    }
  });

  test("a tag push and scope full run the whole table, the preview and master", () => {
    for (const input of [
      { event: "push", ref: "refs/tags/v0.1.1" },
      dispatch({ scope: "full" }),
      // The publish workflow calls this one on a tag push with scope full.
      { ...push, scope: "full" },
      { event: "pull_request", scope: "full" },
    ]) {
      const plan = planCi(matrix, input);
      expect(plan.lanes.map((lane) => lane["tmux-version"])).toEqual([
        "3.3a",
        "3.4",
        "3.7",
        "3.8",
        "release_3.8a",
        "master",
      ]);
      expect(plan.skip).toEqual([]);
    }
  });

  test("only master is advisory, and each lane expects the version its ref builds", () => {
    const lanes = planCi(matrix, dispatch({ scope: "full" })).lanes;
    expect(lanes.filter((lane) => lane.advisory).map((lane) => lane["tmux-version"])).toEqual([
      "master",
    ]);
    const expected = Object.fromEntries(lanes.map((lane) => [lane["tmux-version"], lane.expect]));
    expect(expected).toEqual({
      "3.3a": "tmux 3.3a",
      "3.4": "tmux 3.4",
      "3.7": "tmux 3.7",
      "3.8": "tmux 3.8",
      "release_3.8a": "tmux 3.8a",
      master: "tmux next-*",
    });
  });

  test("a push or pull request ignores every dispatch input", () => {
    const plan = planCi(matrix, {
      ...push,
      bun: "9.9.9",
      os: "ubuntu-22.04",
      tmate: "before-tests",
      tmuxRef: "3.4",
    });
    expect(plan.lanes.map((lane) => lane["tmux-version"])).toEqual(["3.3a", "3.8"]);
    expect(
      plan.lanes.every((lane) => lane.tmate === "off" && lane["bun-version"] === "1.4.0"),
    ).toBe(true);
    expect(plan.bun).toEqual(["1.3.14", "1.4.0", "1.4.2"]);
    expect(plan.os).toBe("ubuntu-latest");
  });

  test("a caller may widen a run but not choose custom", () => {
    expect(refusal(() => planCi(matrix, { ...push, scope: "custom" }))).toContain("scope must be");
  });

  test("an event it has no plan for is refused", () => {
    expect(refusal(() => planCi(matrix, { event: "schedule" }))).toContain(
      "no plan for the schedule event",
    );
  });

  test("one supported release is its own first and last", () => {
    const single = parseCiMatrix("supported 3.8\nbun 1.4.0\nlane-bun 1.4.0\n");
    expect(planCi(single, push).lanes.map((lane) => lane["tmux-version"])).toEqual(["3.8"]);
  });

  test("every event plans at least one tmux job", () => {
    for (const input of [
      push,
      { event: "push", ref: "refs/tags/v1" },
      { event: "pull_request" },
      dispatch({}),
      dispatch({ scope: "edges" }),
      dispatch({ scope: "full" }),
      dispatch({ scope: "custom", tmuxRef: "3.4" }),
    ]) {
      const plan = planCi(matrix, input);
      expect(plan.lanes.length).toBeGreaterThan(0);
    }
  });
});

describe("a custom scope", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";

  test("runs the refs it names, once each", () => {
    const plan = planCi(
      matrix,
      dispatch({ scope: "custom", tmuxRef: ` 3.7 , master,feature/x,${commit},3.7,3.9` }),
    );
    expect(plan.lanes.map((lane) => lane["tmux-version"])).toEqual([
      "3.7",
      "master",
      "feature/x",
      commit,
      "3.9",
    ]);
    const byRef = Object.fromEntries(plan.lanes.map((lane) => [lane["tmux-version"], lane]));
    expect(byRef["3.7"]?.expect).toBe("tmux 3.7");
    expect(byRef.master?.expect).toBe("tmux next-*");
    expect(byRef["feature/x"]?.expect).toBe("tmux *");
    expect(byRef[commit]?.expect).toBe("tmux *");
    expect(byRef[commit]?.name).toBe(commit.slice(0, 12));
    expect(byRef["3.9"]?.expect).toBe("tmux 3.9");
  });

  test("a release below the floor is a lane like any other", () => {
    const plan = planCi(matrix, dispatch({ scope: "custom", tmuxRef: "3.2a" }));
    expect(plan.lanes.map((lane) => [lane["tmux-version"], lane.expect])).toEqual([
      ["3.2a", "tmux 3.2a"],
    ]);
    expect(plan.skip).toEqual([]);
  });

  test("carries the Bun and runner inputs to every lane", () => {
    const plan = planCi(
      matrix,
      dispatch({ bun: "1.3.14, 1.4.2", os: "ubuntu-24.04", scope: "custom", tmuxRef: "3.4,3.8" }),
    );
    expect(plan.bun).toEqual(["1.3.14", "1.4.2"]);
    expect(plan.os).toBe("ubuntu-24.04");
    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "3.4, Bun 1.3.14",
      "3.4, Bun 1.4.2",
      "3.8, Bun 1.3.14",
      "3.8, Bun 1.4.2",
    ]);
  });

  test("accepts the longest ref", () => {
    expect(versions(dispatch({ scope: "custom", tmuxRef: "a".repeat(64) }))).toEqual([
      "a".repeat(64),
    ]);
  });
});

describe("what it refuses", () => {
  const custom = (tmuxRef: string): PlanInput => dispatch({ scope: "custom", tmuxRef });

  test.each([
    ["an unknown scope", dispatch({ scope: "everything" }), "scope must be"],
    ["no refs", dispatch({ scope: "custom" }), "tmux-ref is empty"],
    ["blank refs", custom("  "), "tmux-ref is empty"],
    ["an empty item", custom("3.8,,3.7"), "empty item"],
    ["a trailing comma", custom("3.8,"), "empty item"],
    ["a shell metacharacter", custom("3.8;id"), "invalid item"],
    ["a command substitution", custom("$(id)"), "invalid item"],
    ["a space inside an item", custom("3.8 3.7"), "invalid item"],
    ["an item too long", custom("a".repeat(65)), "invalid item"],
    ["a leading dash", custom("-abc"), "invalid item"],
    ["an unknown runner", dispatch({ os: "macos-latest" }), "os must be"],
    ["an unknown tmate mode", dispatch({ tmate: "always" }), "tmate must be"],
    ["a bad Bun version", dispatch({ bun: "1.4.0;id" }), "invalid item"],
    ["an empty Bun item", dispatch({ bun: "1.4.0,,1.4.2" }), "empty item"],
    ["a Bun version with a dash", dispatch({ bun: "-1.4.0" }), "invalid item"],
  ] as const)("%s", (_name, input, message) => {
    expect(refusal(() => planCi(matrix, input))).toContain(message);
  });
});

describe("tmate", () => {
  test("goes to the one lane that runs", () => {
    const plan = planCi(matrix, dispatch({ scope: "custom", tmate: "on-failure", tmuxRef: "3.8" }));
    expect(plan.lanes.map((lane) => lane.tmate)).toEqual(["on-failure"]);
  });

  test.each([
    ["two refs", dispatch({ scope: "custom", tmate: "before-tests", tmuxRef: "3.7,3.8" })],
    [
      "two Bun versions",
      dispatch({ bun: "1.4.0,1.4.2", scope: "custom", tmate: "on-failure", tmuxRef: "3.8" }),
    ],
    ["the edges", dispatch({ scope: "edges", tmate: "on-failure" })],
    ["the whole table", dispatch({ scope: "full", tmate: "on-failure" })],
  ] as const)("is refused for %s", (_name, input) => {
    expect(refusal(() => planCi(matrix, input))).toContain("tmate needs exactly one tmux lane");
  });
});

describe("the real manifest", () => {
  test("a pull request runs its first and last supported release", () => {
    const real = parseCiMatrix(readFileSync(join(repositoryRoot, ".github/ci-matrix.txt"), "utf8"));
    const plan = planCi(real, { event: "pull_request" });
    const edges = real.supported.filter((_, index, all) => index === 0 || index === all.length - 1);
    expect(plan.lanes.map((lane) => lane["tmux-version"])).toEqual(edges);
  });
});

describe("verifying the jobs", () => {
  test.each([
    ["every job passed", { plan: { result: "success" }, tmux: { result: "success" } }, [], []],
    [
      "a job the plan left out was skipped",
      { plan: { result: "success" }, gates: { result: "skipped" } },
      ["gates"],
      [],
    ],
    [
      "a job failed",
      { plan: { result: "success" }, gates: { result: "failure" } },
      [],
      ["gates: failure"],
    ],
    [
      "a job was cancelled",
      { plan: { result: "success" }, gates: { result: "cancelled" } },
      [],
      ["gates: cancelled"],
    ],
    [
      "a job the plan kept in scope was skipped",
      { plan: { result: "success" }, tmux: { result: "skipped" } },
      ["gates"],
      ["tmux: skipped"],
    ],
    [
      "the plan failed and skipped the rest",
      { plan: { result: "failure" }, tmux: { result: "skipped" } },
      [],
      ["plan: failure", "tmux: skipped"],
    ],
    ["a job with no result", { plan: { result: "success" }, gates: {} }, [], ["gates: null"]],
  ] as const)("%s", (_name, needs, allowed, unpassed) => {
    expect(unpassedJobs(needs, allowed)).toEqual(unpassed);
  });

  test("a run with no jobs is an error", () => {
    expect(refusal(() => unpassedJobs({}, []))).toContain("no jobs");
  });
});

describe("the command", () => {
  const run = (environment: Record<string, string>, ...argv: string[]) => {
    const directory = mkdtempSync(join(tmpdir(), "ltx-ci-plan-"));
    try {
      const output = join(directory, "output");
      writeFileSync(output, "");
      const result = Bun.spawnSync({
        cmd: ["bun", join(repositoryRoot, "scripts/plan-ci.ts"), ...argv],
        env: { GITHUB_OUTPUT: output, PATH: process.env.PATH ?? "", ...environment },
        stderr: "pipe",
        stdout: "pipe",
      });
      return {
        code: result.exitCode,
        output: readFileSync(output, "utf8"),
        stderr: result.stderr.toString(),
      };
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  };

  test("writes the plan to GITHUB_OUTPUT", () => {
    const result = run({ GITHUB_EVENT_NAME: "pull_request" });
    expect(result.code).toBe(0);
    const outputs = Object.fromEntries(
      result.output
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(outputs.scope).toBe("edges");
    expect(outputs.skip).toBe("");
    expect(outputs.jobs).toBe("2");
    expect((JSON.parse(outputs.tmux ?? "[]") as unknown[]).length).toBe(2);
  });

  test("reads its inputs from the environment and refuses a bad one", () => {
    const result = run({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      INPUT_SCOPE: "custom",
      INPUT_TMUX_REF: "3.8;id",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid item");
    expect(result.output).toBe("");
  });

  test("verify fails on a failed job", () => {
    const failed = run({ NEEDS_JSON: JSON.stringify({ gates: { result: "failure" } }) }, "verify");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("gates: failure");
    const passed = run({ NEEDS_JSON: JSON.stringify({ gates: { result: "success" } }) }, "verify");
    expect(passed.code).toBe(0);
  });
});
