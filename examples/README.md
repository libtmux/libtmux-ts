# Examples

Runnable programs for [libtmux for Bun and TypeScript](../README.md).

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

Every example exports a function that takes a `Server`, so a program can hand
it a server of its own. This one starts a private server, reads it, and stops it:

```ts
import { Server } from "libtmux";

const server = new Server({ socketName: "libtmux-examples" });
try {
  await server.newSession({ name: "work" });
  const snapshot = await server.snapshot();

  console.log(snapshot.sessions.count());
  // 1
} finally {
  await server.kill();
}
```

Needs tmux 3.3a or newer.

### They cannot touch your tmux

Each example runs against a server the suite starts for it, on a socket of its
own, such as:

```
/tmp/ltx-examples-PE2i8W/run, root/t-6028-17d6a81a-1fc/s
```

The directory is new each run and removed afterwards. Every example asserts,
before it sends a key, that its socket carries this package's prefix and is not
the server this process is attached to.

## What each one shows

| Example                               | Reach for it when                                                     |
| ------------------------------------- | --------------------------------------------------------------------- |
| [`quickstart/`](quickstart/README.md) | You want the whole API in one pass before choosing a part of it       |
| [`fields/`](fields/README.md)         | You are asking tmux something rather than changing it                 |
| [`capture/`](capture/README.md)       | You are moving text out of a pane, or into one                        |
| [`watch/`](watch/README.md)           | Something else is driving tmux and you need to react to it            |
| [`agent/`](agent/README.md)           | You are running something in a pane and need to know when it finished |
| [`program/`](program/README.md)       | You want a program's output and exit status, with nothing typed       |
| [`workspace/`](workspace/README.md)   | You want a session built from a layout you declared                   |
| [`mcp-agent/`](mcp-agent/README.md)   | The thing driving tmux is a model, over the Model Context Protocol    |
| [`engine/`](engine/README.md)         | tmux is not where the library assumes — ssh, a container, a daemon    |
| [`observe/`](observe/README.md)       | You need to see what it sent, or bound how much runs at once          |

Each is a package of its own: a `README.md`, the code beside it, and a test
that runs the code against a real tmux server.

## Quoting an example in a README

A README block can be tied to the example that runs it. Name the file
immediately above the block:

```
<!-- runs: examples/agent/agent.ts -->
```

[`check-doc-runnable.ts`](../scripts/check-doc-runnable.ts) requires every line
the block shows to appear in that file, in order. The path must start with
`examples/` and exist.

- A block may leave out blank lines, `//` comments, and the continuation lines of
  a doc comment. It may not reorder, reword, or invent: a line matches on its
  exact trimmed text, and the search only moves forward.
- Edit the example, run it, then bring the excerpt across. Only the example is
  executed.

## Where to go next

The [library README](../packages/libtmux/README.md) explains the pieces these
examples use, in the order they stack; the
[API reference](../packages/libtmux/docs/api.md) is for looking one thing up.
