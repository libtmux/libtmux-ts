# ci_plan

Plans the tmux lanes of the typescript workflow, and verifies that its jobs
passed. `plan-ci.ts` is the command; `ci_plan.ts` holds the rules, which take
their inputs as arguments so a test can call them.

The `plan` job of `.github/workflows/typescript.yml` runs it:

```console
$ bun scripts/ci_plan/plan-ci.ts
```

Pushes, pull requests, and the publish workflow run the first and last supported
tmux release. A dispatch (or explicit workflow call) with `scope=full` runs the
whole table with the preview and development lanes; `scope=custom` runs the refs
a dispatch names. The plan reads `.github/ci-matrix.txt` through
[`ci_matrix`](../ci_matrix/README.md) and writes `$GITHUB_OUTPUT`. Inputs arrive
through the environment, never inline in a workflow script.

The `required` job runs the other mode, which reads `NEEDS_JSON` and
`ALLOW_SKIPPED` and fails when a lane the plan asked for did not pass:

```console
$ bun scripts/ci_plan/plan-ci.ts verify
```

Its tests cover each scope, the refusals, and `plan-ci.ts` run as a process:

```console
$ bun test scripts/ci_plan
```
