# ci_apt

Finds raw `apt-get` and `apt` calls in the CI configuration. The `apt-get`
action of `libtmux/.github` bounds apt with a timeout and moves to another mirror
when one hangs; that protects a job only while every call goes through it.

`rawAptFailures` takes a parsed workflow or composite action and returns one
message per step whose `run` script calls apt itself. `check-ci-config.ts` calls
it for every file under `.github`, and runs in CI as:

```console
$ bun run ci:config
```

It is a module with no command of its own. Its tests cover commands in a
separator, keyword and `sudo` position, and the paths and quoted strings that
are not commands:

```console
$ bun test scripts/ci_apt
```
