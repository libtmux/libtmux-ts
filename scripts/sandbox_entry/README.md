# sandbox_entry

Finds scripts that start tmux without entering the test sandbox. A script that
starts a server outside it can leave one running or touch another libtmux port's
sockets, so a script that may start tmux has to call `enterSandbox`, or be listed
in `needsNoSandbox` in `check-testkit-boundary.ts` with the reason it needs none.

`sandboxEntryFailures(scripts, needsNoSandbox)` returns one message per script
that does neither, and per entry that is listed but needs no listing. The check
runs in CI as part of lint:

```console
$ bun run lint
```

It is a module with no command of its own. Its tests cover the patterns that
count as starting tmux, and the comments and strings that do not:

```console
$ bun test scripts/sandbox_entry
```
