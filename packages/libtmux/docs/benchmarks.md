# Benchmarks

Measured, not estimated. Every number here came from one of the three benchmark
scripts below, run from the repository root against a real tmux, and each script
prints the machine and tmux it ran on so a rerun can be compared with this one
rather than guessed against it.

Wall-clock is machine-specific and will differ on yours. The invocation counts
are not: they follow from the design and are what the claims in the README rest
on.

## Reading a server

```console
$ bun packages/libtmux/scripts/bench-snapshot.ts
```

Run: tmux 3.7c, Linux, 10 cores, median of 3, after a warm-up snapshot. These
are steady-state figures: the version probe a server makes before its first
command is paid in the warm-up, so a consumer's very first snapshot costs one
invocation more than the acquire-calls column says.

| sessions × windows × panes | panes | acquire wall | acquire calls | bytes read | local queries | local wall | query calls |
| -------------------------- | ----- | ------------ | ------------- | ---------- | ------------- | ---------- | ----------- |
| 1×1×1                      | 1     | 10 ms        | 1             | 2 KiB      | 250           | 30 ms      | 0           |
| 2×3×2                      | 12    | 51 ms        | 1             | 17 KiB     | 250           | 57 ms      | 0           |
| 4×6×2                      | 48    | 106 ms       | 1             | 67 KiB     | 250           | 52 ms      | 0           |
| 8×8×3                      | 192   | 319 ms       | 1             | 242 KiB    | 250           | 120 ms     | 0           |

Two columns carry the design and neither moves with the server's size. **Acquire
calls stays 1**: a snapshot is one tmux invocation — an identity read and four
listings in a single command list — whatever the topology, which is what lets
relation traversal cost no tmux command. **Query calls stays 0**: 250 `.where()`
and relation reads against the acquired snapshot issue none at all. They are not
free of work — the local-wall column prices those same 250 against the graph
they walk, which is why it rises with the server while the two counts do not —
only free of round trips.

Wall-clock rises with panes, roughly 1.6 ms per pane across this range, because
tmux formats a row per object and this side decodes it. A 192-pane server costs
about 32 times a 1-pane server for 192 times the objects.

## Creating things

```console
$ bun packages/libtmux/scripts/bench-modes.ts
```

Twelve windows created, then queried.

| batching      | concurrency | wall-clock | processes | order           |
| ------------- | ----------- | ---------- | --------- | --------------- |
| one-at-a-time | sequential  | 353 ms     | 25        | as requested    |
| one-at-a-time | concurrent  | 404 ms     | 25        | reordered (1/3) |
| pipeline      | sequential  | 72 ms      | 13        | as requested    |
| planned       | sequential  | 139 ms     | 14        | as requested    |

The process counts are the deterministic part. Creating one at a time costs two
invocations per window — one to run the command, one to take the snapshot that
resolves the printed id into a handle — plus a final query: 25. `pipeline` sends
the twelve commands as twelve invocations and returns their printed output
directly: 13. `batch` does the same and adds one snapshot that resolves all
twelve handles at once: 14.

Concurrency is the row worth reading twice. `Promise.all` over the same twelve
creations reorders a third of them and saves no processes, and on this run
finished _slower_ than doing them in order — the ordering of those two
wall-clock figures is the one number here that a loaded machine can invert:
tmux runs commands on one thread, so fanning out buys queueing rather than
throughput, and nothing preserves the order the calls were made in. That is the
measurement behind `maxInFlight` defaulting to 16 rather than something larger,
and behind the README telling you to use `pipeline` or `batch` when order
matters.

## Observing a server

```console
$ bun packages/libtmux/scripts/bench-control.ts
```

Run: tmux 3.7c, Linux, 10 cores. The script medians the daemon-replacement row
internally and reports the others from one pass.

| workload              | size                     | wall-clock    | bounded outcome                                    |
| --------------------- | ------------------------ | ------------- | -------------------------------------------------- |
| sustained pane output | 1024 KiB                 | 294 ms        | 1048576 B payload, 0 dropped                       |
| slow subscriber       | 100000 events / 64 slots | 49 ms         | 64 retained, 99936 dropped                         |
| same-daemon reconnect | 5 detachments            | 308 ms        | 5 recovered, max attempt 1                         |
| daemon replacement    | 3 daemons                | 323 ms median | 3 stale handles refused, max attempt 3, max 561 ms |

This one is a correctness workload that reports timings, not a benchmark that
checks a number: it throws if the terminal state is wrong, so the right-hand
column is the result and the wall-clock is context. **0 dropped** on sustained
output says a fast producer loses nothing, and **64 retained, 99936 dropped**
says a consumer that stops reading costs a bounded 64 slots rather than
unbounded memory — the two halves of the backpressure claim. The last two rows
are the recovery path: a connection that survives its client detaching, and
handles that refuse rather than address a daemon that has been replaced.
