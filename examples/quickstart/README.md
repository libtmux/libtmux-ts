# Quickstart

A tour of the API in one pass: acquire a server, build a session, query it
back, drive a pane, and handle a failed command.

Reach for this first — before `watch/` or `agent/` — to see what a snapshot,
a query, and a pane action look like end to end, before committing to any one
of them.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/quickstart
```

The test drives `quickstart()` against a real tmux server the suite starts on
a socket of its own, asserts on what it built, and tears the server down
afterwards. Requires tmux 3.2a or newer.

## What it shows

<!-- runs: examples/quickstart/quickstart.ts -->

```ts
const session = await server.newSession({ name: "quickstart" });
const editor = await session.newWindow({ name: "editor" });
await editor.split();

const snapshot = await server.snapshot();

const found = snapshot.windows.where({ name: "editor" }).one();

const paneCount = found.panes.length;
```

`.snapshot()` is the only call here that talks to tmux — everything reachable
from it, including `.where()` and `.panes`, resolves against the snapshot
already in memory. `quickstart.ts` also shows a criterion object, a relation
walked with no `await`, a literal `sendKeys`, and a failed command caught as a
typed `TmuxCommandError`.

This is a literal excerpt of [`quickstart.ts`](quickstart.ts), which
`quickstart.test.ts` runs against a real tmux server, and which the root
[README](../../README.md#quickstart) quotes the same way.

## Where to go next

[`../workspace/`](../workspace/README.md) builds more than one window at once;
[`../agent/`](../agent/README.md) acts on a pane and waits for the result on one
connection.
