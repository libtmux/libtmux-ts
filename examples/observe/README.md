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

Needs tmux 3.3a or newer.

## What it shows

`onInvocation` is called once per tmux invocation, after it answers or fails.
It reports the commands tmux received, the cost, how long the call waited for a
slot, and an exit code or an error with a delivery status.

<!-- runs: examples/observe/observe.ts -->

```ts
import { Server } from "libtmux";
import type { TmuxInvocationReport } from "libtmux";

export async function whatTheLibraryIsDoing(reference: Server): Promise<ObservedRun> {
  const reports: TmuxInvocationReport[] = [];
  const server = new Server({
    maxInFlight: 1,
    onInvocation: (report) => reports.push(report),
    socketPath,
    tmuxBin: reference.tmuxBin,
  });
}
```

An observer cannot change what a command does. Anything it throws is
swallowed, and so is a rejection if it returns a promise.

Counting the reports checks the README's two cost claims:

- A snapshot is one invocation, whatever the server holds.
- A hundred queries and relation reads against that snapshot are none.
- The first call on a new server costs one extra: the version probe.

`maxInFlight` bounds the processes. tmux runs commands on one thread, so firing
a batch concurrently buys queueing, not throughput, and `queuedMs` says how long
each call waited. The example sets it to 1 and fires four snapshots at once, so
three wait. They can finish out of order: use `pipeline` and `batch` for work
whose order matters.

## Where to go next

[`../engine/`](../engine/README.md) replaces the transport entirely, for when
watching what was sent is not enough and you need to decide where it goes.
