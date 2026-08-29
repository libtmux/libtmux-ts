# Watch

Follow tmux as it changes, instead of polling to find out what changed.

Reach for this when something else is driving tmux — a build, a person, another
agent — and you need to react to it: a window opening, a pane printing, a
session going away.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/watch
```

Each function is driven against a real tmux server the suite starts on a socket
of its own. Requires tmux 3.2a or newer.

## What it shows

`watch()` holds one control-mode connection open and yields tmux's own
notifications. The stream is an async disposable, so `await using` closes it on
the way out of the scope — including when the loop throws.

Four situations, because they fail differently:

- **Waiting for one event** — `find()` with a deadline, so a missed event is a
  timeout rather than a hang.
- **Reading a pane's output** — subscribe first, then act, or a line printed
  while you were still connecting is lost.
- **Falling behind** — a slow consumer is told it fell behind rather than
  silently losing events, and `pauseAfterSeconds` reports the pause and its
  resume.
- **Giving up** — a deadline and a caller who stopped waiting are different
  answers, and only one of them says anything about the workload.

## Where to go next

[`../agent/`](../agent/README.md) combines this observer with commands from the
same server — act, then wait for the result.
