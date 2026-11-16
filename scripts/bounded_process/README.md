# bounded_process

Runs a command with a deadline and an output ceiling, and ends its whole process
group when either passes. The install checks, the packing helper and the README
launch tests run commands that fetch or wait, and an unbounded child would hold
a CI job until the job's own timeout.

`runBoundedCommand(argv, options)` resolves with the exit code, the signal, the
captured output, and why it stopped: `exited`, `accepted` (an output line the
caller accepted), `timed_out`, `output_limit_exceeded` or `signaled`. It is a
module with no command of its own.

```console
$ bun test scripts/bounded_process
```
