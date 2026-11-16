# check_tmux_version

Fails a tmux lane that is running a different tmux from the one it asked for. The
`build-tmux` action can restore a cached build, and a lane that silently runs
another release proves nothing about the one it names.

The `tmux` job of the typescript workflow runs it after the build, with the
prefix the build action reports and the expectation the plan wrote:

```console
$ TMUX_PREFIX=/path/to/prefix TMUX_EXPECT='tmux 3.8' bun scripts/check_tmux_version/check_tmux_version.ts
```

It prints what `tmux -V` reports and exits 1, with a `::error::` annotation, when
that does not match. `TMUX_EXPECT` is a shell glob in which `*` is any run of
characters: `tmux 3.8` for a release, `tmux next-*` for an unreleased tmux that
reports `next-X.Y`. [`ci_plan`](../ci_plan/README.md) writes it. The tests cover
the glob, the refusal, and the command against a stand-in `tmux`:

```console
$ bun test scripts/check_tmux_version
```
