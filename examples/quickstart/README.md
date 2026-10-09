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

## Ordinary default endpoint

Run `default-session.ts` to create, report, and clean up one session on your
normal endpoint. It includes its imports and needs no fixture arguments:

```console
$ bun examples/quickstart/default-session.ts
```

[`default-session.ts`](default-session.ts) uses the library's `ownSession()` with `await using`. The owner captures its daemon generation and session ID in the creation response, destroys that session at scope exit, and rolls it back if readback fails before handoff. Native scope exit preserves body and cleanup errors through `SuppressedError`; `withOwned()` offers a callback scope with `AggregateError` for runtimes consuming compiled TypeScript.

The [external harness](../../packages/libtmux/tests/integration/environment.test.ts)
sets `LIBTMUX_SOCKET_PATH` for a child process and executes this file unchanged.
It retains the fixture's original session, checks example-session cleanup, and
then verifies daemon exit and socket removal. Failure injection lives in the
harness. It covers body failure, cleanup failure, both together, timeout, SIGTERM, SIGKILL, and an explicit runner crash without test branches in the example. Node and Deno run the TypeScript-emitted program from `dist`; `build` emits it from the same source.

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
