# Engine

Reach tmux through a transport you supply, rather than the built-in ones.

Reach for this when tmux is not where the library assumes: over ssh, inside a
container, behind a daemon of your own.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/engine
```

The test drives `throughACustomEngine()` against a real tmux server the suite
starts on a socket of its own. Requires tmux 3.2a or newer.

## What it shows

Everything above the transport — capabilities, snapshots, the graph, queries,
mutations — is built on one operation: bytes in, bytes out. Replace that
operation and the whole library follows your `run` to wherever it reaches tmux.

This example keeps `run` local, shelling to the same tmux the built-in server
drives, so the only thing on display is the seam: nothing above it knows the
difference.

## Where to go next

[`../fields/`](../fields/README.md) shows what the layers above the seam give
you once it is in place.
