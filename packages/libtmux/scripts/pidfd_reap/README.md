# pidfd_reap

Ends one stale tmux daemon through a pidfd, and prints what it did as JSON. The
test fixture reaper in `src/_internal/test/reaper.ts` runs it, under Bun, for a
daemon whose record says it belongs to a test run that has gone. Nobody runs it
by hand.

```console
$ bun packages/libtmux/scripts/pidfd_reap/pidfd_reap.ts \
    <pid> <start identity> <comm> <executable> <argv JSON> \
    <generation name> <generation value>
```

It sends SIGTERM, then SIGKILL if the daemon lingers, only while `/proc` still
shows the daemon the record describes. The exit status is 0 for gone or reaped,
3 for an identity mismatch, 4 for a daemon still live after SIGKILL and 5 when
the platform has no pidfd.

Bun runs it because Node has no pidfd binding. This file holds the system calls,
through `bun:ffi`, and `src/_internal/test/pidfd_reap.ts` holds the decisions,
which `tests/unit/pidfd_reap.test.ts` checks against fake system calls. The
tests here run the command against real processes:

```console
$ bun test packages/libtmux/scripts/pidfd_reap
```
