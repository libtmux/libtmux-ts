# Observe

See what the library is sending to tmux, and bound how much of it runs at once.

Reach for this when you are answering "what did it actually do?" — in a log, a
trace, a metric, or a cost review.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/observe
```

The test drives `whatTheLibraryIsDoing()` against a real tmux server the suite
starts on a socket of its own. Requires tmux 3.2a or newer.

## What it shows

`onInvocation` is called once per tmux invocation, after it answers or fails,
with the commands tmux received, what the call cost, how long it waited for a
slot, and either an exit code or an error and a delivery status. Without it,
watching the library means supplying a whole engine just to see what it sent.

<!-- runs: examples/observe/observe.ts -->

```ts
const reports: TmuxInvocationReport[] = [];
const server = new Server({
  maxInFlight: 1,
  onInvocation: (report) => reports.push(report),
  socketPath,
  tmuxBin: reference.tmuxBin,
});
```

An observer cannot change what a command does. Anything it throws is
swallowed, and so is a rejection if it returns a promise, because a command
must not fail on account of the code watching it.

Counting those reports is also how the two cost claims in the README get
checked rather than believed. A snapshot is **one** invocation — an identity
read and four listings in a single command list — whatever the server holds,
and a hundred queries and relation reads against that snapshot are **none**.
The first call on a new server costs one extra: the version probe, which runs
once and decides which formats this tmux understands.

`maxInFlight` is the other half. tmux runs commands on one thread, so firing a
batch concurrently buys queueing rather than throughput; the ceiling keeps a
burst from becoming a pile of processes, and `queuedMs` says how long each call
waited for its slot. The example sets it to 1 and fires four snapshots at once,
so three of them wait — and the order they finish in is tmux's, not the order
they were asked for, which is why `pipeline` and `batch` exist for work whose
order matters.

## Where to go next

[`../engine/`](../engine/README.md) replaces the transport entirely, for when
watching what was sent is not enough and you need to decide where it goes.
