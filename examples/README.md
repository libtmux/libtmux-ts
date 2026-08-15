# Examples

Four runnable programs, each executed by the integration suite against a real,
isolated tmux server — so the code here is the code that runs, and a README
recipe drawn from it is [checked against it](../scripts/check-doc-runnable.ts)
on every commit.

Part of [libtmux for Bun and TypeScript](../README.md).

## Run them

```console
$ bun install
```

```console
$ bun test examples/tests
```

Every example exports a function taking a `Server` rather than constructing
one, so the suite can hand it an isolated fixture — and you can hand it a
server of your own:

```ts
import { Server } from "libtmux";

const server = new Server();
const snapshot = await server.snapshot();

console.log(snapshot.sessions.count());
```

Requires tmux 3.2a or newer.

### They cannot touch your tmux

Each example runs against a server the suite starts for it, on a socket of its
own — something like:

```
/tmp/ltx-examples-PE2i8W/run, root/t-6028-17d6a81a-1fc/s
```

A fresh directory per run, a generated socket name per fixture, and the whole
thing removed afterwards. That is checked rather than assumed: every example
asserts, before it sends a single key, that the socket it was handed carries
this package's own prefix and is not the server this process is attached to.
Point the suite anywhere else and all six fail instead of quietly driving your
session.

## What each one shows

| File                             | What it demonstrates                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`quickstart.ts`](quickstart.ts) | Acquisition, filtering, relations, pane input, and error handling in one pass                                                   |
| [`watch.ts`](watch.ts)           | Reacting over control mode: waiting for a window to open, and following a pane until a marker arrives                           |
| [`agent.ts`](agent.ts)           | Act and wait on one connection: run a command until its output arrives, then wait for the server to reach a shape               |
| [`workspace.ts`](workspace.ts)   | Building a session from a declared layout, with an inherited environment and a teardown that treats "already gone" as an answer |

## Where to go next

The [library README](../packages/libtmux/README.md) explains the pieces these
examples use, in the order they stack; the
[API reference](../packages/libtmux/docs/api.md) is for looking one thing up.
