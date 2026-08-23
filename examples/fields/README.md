# Fields

Read a server's state as typed values — numbers as numbers, flags as booleans
— without parsing anything out of a string.

Reach for this when you want to _ask_ tmux something rather than change it:
which pane is active, how big it is, what command it is running.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/fields
```

The test drives `reportPanes()` against a real tmux server the suite starts on
a socket of its own, and tears it down afterwards. Requires tmux 3.2a or newer.

## What it shows

One `snapshot()` reaches tmux; everything after it resolves in memory. Geometry
arrives as arithmetic rather than as text to parse, and a flag arrives as
`false` rather than as the string `"0"` — which is truthy, and is the bug this
decoding exists to prevent.

`fields.ts` is the source `packages/libtmux/README.md` quotes for its criteria
recipe, so what the reference shows is what this file runs.

## Where to go next

[`../quickstart/`](../quickstart/README.md) covers the same ground more
briefly; [`../watch/`](../watch/README.md) reacts to changes instead of
reading them once.
