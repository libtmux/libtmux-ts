# Scripts

This policy covers the support scripts in this repository: files under
`scripts/`, CI helpers, generators and checkers. It applies the libtmux
decision in [libtmux/docs#323](https://github.com/libtmux/docs/pull/323).

## Keep a script only for a current use

A script stays when this project runs it today: a CI job, a release step, a
code generator, a documentation check, or a maintainer task named in
[CONTRIBUTING.md](CONTRIBUTING.md).

- Parity with Python libtmux or tmuxp is not a use. Delete comparison
  harnesses, oracles, ledgers and generated fixtures, and the CI steps that
  install them.
- A shell step that creates, prepares or stops tmux for an example or test
  means the library lacks an operation. File an issue for the operation and
  remove the step when it lands.
- Delete scripts nothing calls.
- Tooling several ports share lives once, as a shared workflow or action, not
  as a vendored copy.

## Language

Scripts are TypeScript, run with Bun, the same interpreter CI uses for the
library. Do not add shell or Python script files.

## Layout and checks

- A script with tests lives in `scripts/<name>/`, with a `README.md` (what it
  does, who runs it, how) and `tests/`. The root `scripts/` holds the
  workspace's, and a package's own `scripts/` holds that package's.
  [`scripts/ci_plan/`](../scripts/ci_plan/README.md) is one to copy: a command,
  the module behind it, and the tests of both. A script with no tests of its
  own is one file with a usage header, such as `scripts/check-ci-config.ts`.
- A script that only the real-tmux suite can test stays beside the runner it
  belongs to, and that suite tests it: `test-node.ts`, `test_supervisor.ts` and
  `reap-test-run.ts` in `packages/libtmux/scripts`.
- Scripts pass the same formatter, linter, type checker and test runner as the
  library, in CI.
- Use current language and tool idioms; no shims below the project's floor.
- Before a new or rewritten script merges, a reviewer who did not write it
  checks it against [WRITING.md](WRITING.md) and
  [no-ai-slop](https://github.com/petergyang/no-ai-slop).

The checks, from the repository root:

```console
$ bun run format:check
```

```console
$ bun run lint
```

```console
$ bun run typecheck:tooling
```

```console
$ bun run test:scripts
```

The tests of a package's scripts run with its unit tests, from the package
directory:

```console
$ bun run test:unit
```

## What stays

- GitHub Actions `run:` lines that call one command.
- A capability TypeScript lacks comes from a test-only TypeScript dependency,
  not from a second language.
- Test data that is not a comparison, such as workspace files a loader reads.
- A test's stand-in for a program is TypeScript that Bun runs: `writeBunProgram`
  in `packages/libtmux/tests/support/bun_program.ts`, or `fake_tmux.ts` for
  tmux. Two kinds of shell and Python file are product contract, not scripts:
  the `before_script` files tmuxp runs, and the `.py` plugins a workspace file
  names. The fake `python` that answers `importlib.metadata` for the tmuxp
  bridge stays until
  [libtmux/docs#324](https://github.com/libtmux/docs/issues/324) decides
  whether the bridge does.
