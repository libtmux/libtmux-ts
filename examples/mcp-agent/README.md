# MCP agent

Drive tmux through the Model Context Protocol, from an in-process client.

Reach for this when the thing driving tmux is a model rather than your own
code, and you want to see what the MCP server actually exposes to it.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/mcp-agent
```

The test connects a real MCP client to `@libtmux/mcp` over an in-memory
transport, against a real tmux server the suite starts on a socket of its own.
Requires tmux 3.2a or newer.

## What it shows

The same act-then-wait shape as [`../agent/`](../agent/README.md), expressed as
tool calls. `run_command` frames a command so its own echo cannot be mistaken
for its output, and reports the exit status — which is the difference between
"the text appeared" and "the command succeeded".

No subprocess and no socket of its own: the client and server share memory, so
this is the cheapest way to see the tool surface end to end.

## Where to go next

[`../agent/`](../agent/README.md) does the same work through the library
directly, which is what the MCP server is built on.
