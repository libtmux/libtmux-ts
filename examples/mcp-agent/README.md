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

Needs tmux 3.3a or newer; the program and exit helpers need 3.8.

## What it shows

The same act-then-wait shape as [`../agent/`](../agent/README.md), expressed as
tool calls. `run_shell_command` frames a command so its own echo cannot be
mistaken for its output, and reports the exit status — which is the difference
between "the text appeared" and "the command succeeded".

The example selects the `inspect` and `execute` toolsets because it creates
topology, types commands, and waits for output.

Its exported helpers cover the full workflow: create a multi-window workspace,
run a framed command, wait for output produced elsewhere, and continue reading
from an opaque cursor without recapturing the screen.

`followProgram` starts a program longer than one wait and reads it to its end
through `read_program`'s cursor, stopping it however the read ends.
`runWithInput` hands `run_program` a stdin, and `waitForExit` waits for a
program somebody else started.

The client and server share memory, so there is no subprocess to start.

## Where to go next

[`../agent/`](../agent/README.md) does the same work through the library
directly, which is what the MCP server is built on.
