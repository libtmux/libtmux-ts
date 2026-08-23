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
$ bun test examples
```

Or one at a time, each being a package of its own:

```console
$ bun test examples/watch
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

| Example                               | Reach for it when                                                     |
| ------------------------------------- | --------------------------------------------------------------------- |
| [`quickstart/`](quickstart/README.md) | You want the whole API in one pass before choosing a part of it       |
| [`fields/`](fields/README.md)         | You are asking tmux something rather than changing it                 |
| [`capture/`](capture/README.md)       | You are moving text out of a pane, or into one                        |
| [`watch/`](watch/README.md)           | Something else is driving tmux and you need to react to it            |
| [`agent/`](agent/README.md)           | You are running something in a pane and need to know when it finished |
| [`workspace/`](workspace/README.md)   | You want a session built from a layout you declared                   |
| [`mcp-agent/`](mcp-agent/README.md)   | The thing driving tmux is a model, over the Model Context Protocol    |
| [`engine/`](engine/README.md)         | tmux is not where the library assumes — ssh, a container, a daemon    |

Each is a package of its own: a `README.md` saying what it shows and when to
reach for it, the code beside it, and a test that runs the code against a real
tmux server. Start with the README, read the code when the README has earned
it.

## Quoting an example in a README

A recipe in a README can be tied to the example that runs it. Name the file it
comes from, immediately above the block:

```
<!-- runs: examples/agent/agent.ts -->
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
