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

One control observer carries notifications while commands use the server's
engine. Keeping that observer open makes event-driven waits persistent without
turning command output into a control-mode protocol.

Waiting for a marker is the part worth copying. A pane echoes what is typed
into it, so waiting for text that also appears in the command you sent matches
your own keystrokes rather than the output.

## Where to go next

[`../watch/`](../watch/README.md) covers the streaming half on its own;
[`../mcp-agent/`](../mcp-agent/README.md) drives the same tmux through the MCP
server instead of the library.
