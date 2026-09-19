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
about 32 times a 1-pane server for 88 times the rows — 264 against 3, counting
every session, window and pane the four listings emit, not the panes alone.

## Creating things

```console
$ bun packages/libtmux/scripts/bench-modes.ts
```

Twelve windows created, then queried. tmux 3.7c on an idle machine, three
invocations of the script; each wall-clock below is one invocation's median of
three, and the order column gives, across those invocations, how many of an
invocation's own three repeats came back out of order. The two columns do not
span the same work: the clock stops when the creations do, while the process
column also counts the query that reads the result back.

| batching      | concurrency | wall-clock       | processes | order                    |
| ------------- | ----------- | ---------------- | --------- | ------------------------ |
| one-at-a-time | sequential  | 463, 649, 676 ms | 25        | as requested             |
| one-at-a-time | concurrent  | 471, 537, 642 ms | 25        | out of order in 2-3 of 3 |
| pipeline      | sequential  | 88, 109, 114 ms  | 13        | as requested             |
| planned       | sequential  | 149, 161, 259 ms | 14        | as requested             |

The process counts are the deterministic part. Creating one at a time costs two
invocations per window — one to run the command, one to take the snapshot that
resolves the printed id into a handle — plus a final query: 25. `pipeline` sends
the twelve commands as twelve invocations and returns their printed output
directly: 13. `batch` does the same and adds one snapshot that resolves all
twelve handles at once: 14.

Concurrency is the row worth reading twice. `Promise.all` over the same twelve
creations saves no processes — 25 either way — and does not preserve order: the
batch arrived out of order in two or three of every three runs, so treat
reordering as what happens rather than as a risk. What it does _not_ do is run
slower: every wall-clock figure in the first two rows overlaps, and concurrent
was the faster of the pair in two of the three medians. A single run can look
otherwise; only the median across several says so.

So the case for `pipeline` or `batch` is not that fanning out is slow. It is
that fanning out costs the same twenty-five processes, gives up ordering, and
buys nothing — while `pipeline` does the same work in thirteen, and creates in a
sixth of the time (median 109 ms against 649 ms, both for the creations alone).
Read the order column as whole runs, not windows: a run either arrived in the
order it was asked for or it did not. That is why the README tells you to use
`pipeline` or `batch` when order matters. It is not where the default
`maxInFlight` of 16 comes from: this run never has more than twelve creations
outstanding, so it stays under that ceiling and cannot say anything about where
the ceiling belongs — only that bounding a fan-out costs nothing.

### On a bigger server

```console
$ bun packages/libtmux/scripts/bench-snapshot.ts
```

The same script as the snapshot table creates one window in the first session
of each server it builds: once as `session.newWindow()`, which resolves a
handle, and once as that plan's argv through `pipeline`, which returns the
printed id and nothing else. Only the columns that do not depend on the machine
are given here — this run shared its machine with other suites, which makes
wall-clock worthless and leaves a count unchanged.

| sessions × windows × panes | panes | handle calls | handle bytes | id calls | id bytes |
| -------------------------- | ----- | ------------ | ------------ | -------- | -------- |
| 1×1×1                      | 1     | 2            | 4 KiB        | 1        | 3 B      |
| 2×3×2                      | 12    | 2            | 18 KiB       | 1        | 4 B      |
| 4×6×2                      | 48    | 2            | 66 KiB       | 1        | 4 B      |
| 8×8×3                      | 192   | 2            | 233 KiB      | 1        | 4 B      |

The handle costs one invocation more than the id at every size, and that
invocation is a snapshot: its bytes track the snapshot table above, and so does
its time — the acquire wall there, 10 ms on a one-pane server and 319 ms on a
192-pane one. The id costs the create alone and reads four bytes. The snapshot
cannot be narrowed to the session the window was made in: a window made in a
grouped session is linked into every member, and the handle reports those
links. A test holds that.

## Observing a server

```console
$ bun packages/libtmux/scripts/bench-control.ts
```

Run: tmux 3.7c, Linux, 10 cores. The script medians the daemon-replacement row
internally and reports the others from one pass. Only the asserted column is
reproduced here; the script also prints a worst attempt count and a worst
replacement time, which move run to run like any other timing.

| workload              | size                     | wall-clock    | asserted outcome             |
| --------------------- | ------------------------ | ------------- | ---------------------------- |
| sustained pane output | 1024 KiB                 | 188 ms        | 1048576 B payload, 0 dropped |
| slow subscriber       | 100000 events / 64 slots | 13 ms         | 64 retained, 99936 dropped   |
| same-daemon reconnect | 5 detachments            | 185 ms        | 5 recovered                  |
| daemon replacement    | 3 daemons                | 150 ms median | 3 stale handles refused      |

This one is a correctness workload that reports timings, not a benchmark that
checks a number: it throws if any value in the right-hand column is wrong, so
that column is the result and the wall-clock is context. The attempt counts the
script also prints are not in it, because nothing throws on them — they are
observations of how many tries recovery happened to need, and that count can
vary between runs. **0 dropped**
on sustained output says a fast producer loses nothing, and **64 retained, 99936
dropped** says a consumer that stops reading costs a bounded 64 slots rather
than unbounded memory — the two halves of the backpressure claim. The last two
rows are the recovery path: a connection that survives its client detaching, and
handles that refuse rather than address a daemon that has been replaced.
