# bench-control

Exercises the bounded and restartable parts of control-mode observation against a
real tmux server: a slow consumer's bounded queue, recovered connections, handles
retired when their daemon is replaced, and no attached client left behind. A
maintainer runs it by hand after changing the control transport, and
[the benchmarks page](../../docs/benchmarks.md#observing-a-server) reports a run.

```console
$ bun packages/libtmux/scripts/bench-control/bench-control.ts
```

Wall clock is reported, never gated. The workload does require its terminal
state. Live runtime support is Linux only, and the output names the tmux and
platform used. The test covers the output-marker tracker the workload reads
with, and starts no server:

```console
$ bun test packages/libtmux/scripts/bench-control
```

Run the test from the repository root.
