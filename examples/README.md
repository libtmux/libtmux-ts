# Examples

Runnable programs, each executed by the integration suite against a real,
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
Point the suite anywhere else and every one of them fails instead of quietly
driving your session.

## What each one shows

| File                             | What it demonstrates                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`quickstart.ts`](quickstart.ts) | Acquisition, filtering, relations, pane input, and error handling in one pass                                                   |
| [`watch.ts`](watch.ts)           | Reacting over control mode: waiting for a window to open, following a pane, reading it under backpressure, and ending a wait    |
| [`agent.ts`](agent.ts)           | Act and wait on one connection: run a command until its output arrives, then wait for the server to reach a shape               |
| [`workspace.ts`](workspace.ts)   | Building a session from a declared layout, with an inherited environment and a teardown that treats "already gone" as an answer |
| [`fields.ts`](fields.ts)         | Reading decoded values: geometry as arithmetic, flags as booleans, timestamps as `Date`, and the raw row beside them            |
| [`mcp-agent.ts`](mcp-agent.ts)   | Driving tmux over the Model Context Protocol rather than the API, on linked in-memory transports                                |
| [`engine.ts`](engine.ts)         | Reaching tmux through a transport you supply, honouring the two obligations the seam documents                                  |

## Quoting an example in a README

A recipe in a README can be tied to the example that runs it. Name the file it
comes from, immediately above the block:

```
<!-- runs: examples/agent.ts -->
```

[`check-doc-runnable.ts`](../scripts/check-doc-runnable.ts) then requires every
line the block shows to appear in that file, in order. The path has to start
with `examples/` and has to exist, because the whole claim of the marker is
that the integration suite executes what it names.

What a block may leave out is generous: blank lines, `//` comments, and the
continuation lines of a doc comment are never compared, so a recipe can drop
the error handling and the commentary and still match. What it may not do is
reorder, reword, or invent. A line matches on its exact text once trimmed, and
the search only moves forward — so renaming a variable in the example turns
every line after it into a miss, and the failure names the first line it could
not place.

The loop runs one way. Edit the example, run it, then bring the excerpt across;
never edit the block and expect the example to follow, because only the example
is executed.

Compiling a snippet proves it typechecks. Only this marker proves it works.

## Where to go next

The [library README](../packages/libtmux/README.md) explains the pieces these
examples use, in the order they stack; the
[API reference](../packages/libtmux/docs/api.md) is for looking one thing up.
