# Agent

Drive tmux the way an agent does: act, then wait for the result.

Reach for this when you are running something in a pane and need to know when
it finished — a build, a test run, a long command — without polling the screen.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/agent
```

The test drives both functions against a real tmux server the suite starts on a
socket of its own. Requires tmux 3.2a or newer.

## What it shows

`Pane.run` is the call. It opens a control client for the wait, sends the
command, and matches `until` only after the shell's echo of the keys.
Completing on that echo is refused. The client is disposed when the wait ends.

Waiting for a marker that also appears in the keys you sent is the case this
covers: the echo is not the result.

## Where to go next

[`../watch/`](../watch/README.md) covers the streaming half on its own;
[`../mcp-agent/`](../mcp-agent/README.md) drives the same tmux through the MCP
server instead of the library.
