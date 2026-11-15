import { describe, expect, test } from "bun:test";

import { rawAptFailures } from "../../../../scripts/ci_apt.js";

const workflow = (run: string, name = "Install shells"): unknown => ({
  jobs: { tmux: { "runs-on": "ubuntu-24.04", steps: [{ name, run }] } },
});

describe("rawAptFailures", () => {
  test("names the file, job, step and fix for a raw sudo apt-get", () => {
    expect(rawAptFailures(".github/workflows/x.yml", workflow("sudo apt-get update"))).toEqual([
      '.github/workflows/x.yml: job tmux, step "Install shells" runs apt-get directly; use the libtmux/.github apt-get action',
    ]);
  });

  test("lets a script path that ends in apt-get pass", () => {
    expect(rawAptFailures("x.yml", workflow("./tools/apt-get.sh update"))).toEqual([]);
    expect(
      rawAptFailures("x.yml", workflow('"$GITHUB_WORKSPACE/tools/apt-get.sh" install -y fish')),
    ).toEqual([]);
  });

  test("lets a step that uses the shared action pass", () => {
    const document = {
      jobs: {
        tmux: {
          steps: [
            {
              name: "Install shells",
              uses: "libtmux/.github/actions/apt-get@0000000000000000000000000000000000000000",
              with: { args: "install -y fish" },
            },
          ],
        },
      },
    };

    expect(rawAptFailures("x.yml", document)).toEqual([]);
  });

  test("catches apt without sudo, behind an assignment, in a pipe and after a keyword", () => {
    for (const run of [
      "apt install -y fish",
      "sudo -E DEBIAN_FRONTEND=noninteractive apt-get install -y fish",
      "yes | sudo apt-get install fish",
      "if true; then sudo apt-get update; fi",
      "sudo \\\n  apt-get update",
    ]) {
      expect(rawAptFailures("x.yml", workflow(run))).toHaveLength(1);
    }
  });

  test("finds it in a composite action's steps", () => {
    const action = {
      runs: {
        using: "composite",
        steps: [{ shell: "bash", run: "sudo apt-get install --yes libevent-dev" }],
      },
    };

    expect(rawAptFailures(".github/actions/a/action.yml", action)).toEqual([
      ".github/actions/a/action.yml: runs, step 1 runs apt-get directly; use the libtmux/.github apt-get action",
    ]);
  });

  test("ignores comments and text that only mentions the command", () => {
    expect(rawAptFailures("x.yml", workflow("# sudo apt-get update"))).toEqual([]);
    expect(rawAptFailures("x.yml", workflow('echo "sudo apt-get update is wrapped"'))).toEqual([]);
  });

  test("ignores a document that is not a workflow", () => {
    expect(rawAptFailures("x.yml", null)).toEqual([]);
    expect(rawAptFailures("x.yml", "jobs")).toEqual([]);
  });
});
