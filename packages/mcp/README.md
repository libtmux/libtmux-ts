# @libtmux/mcp

**A Model Context Protocol server that gives an AI agent a real tmux server.**

Part of [libtmux for Bun and TypeScript](../../README.md). Built on
[`libtmux`](../libtmux).

> **Status: unreleased.** Not on npm yet; run it from this repository.

## Why this exists

An agent that drives a terminal needs two things a shell tool does not give it:
somewhere durable to run commands, and a way to **wait for output** without
burning a call per poll. A tmux server is the first. `wait_for_output` is the
second — it streams tmux's own notifications rather than re-reading the pane.

## Run it

```console
$ bun packages/mcp/src/server.ts
```

It speaks MCP over stdio, so an MCP client launches it as a subprocess.

### Point it at a server

An MCP client supplies an environment and a command line, and nothing else, so
the environment is the only place a socket can come from. The library itself
never reads these — a library that picks up ambient configuration surprises its
caller — so the reading happens here, at the edge that has a process.

| Variable              | Effect                                           |
| --------------------- | ------------------------------------------------ |
| `LIBTMUX_SOCKET_PATH` | Absolute path to the tmux socket                 |
| `LIBTMUX_SOCKET_NAME` | Socket name, resolved under tmux's own directory |
| `LIBTMUX_TMUX_BIN`    | The `tmux` executable to use                     |

```json
{
  "mcpServers": {
    "tmux": {
      "command": "bun",
      "args": ["packages/mcp/src/server.ts"],
      "env": { "LIBTMUX_SOCKET_NAME": "agent" }
    }
  }
}
```

## Tools

| Tool              | Arguments                              | Returns                                          |
| ----------------- | -------------------------------------- | ------------------------------------------------ |
| `list_sessions`   | —                                      | Every session with its id, name and window count |
| `list_panes`      | `session?`                             | Panes, with command, session and window          |
| `capture_pane`    | `paneId`, `start?`                     | Visible contents, or into the scrollback         |
| `send_keys`       | `paneId`, `keys`, `enter?`, `literal?` | Confirmation                                     |
| `new_session`     | `name?`                                | The created session                              |
| `wait_for_output` | `paneId`, `contains`, `timeoutMs?`     | What the pane printed                            |

Every tool takes its own snapshot, so two concurrent requests observe their own
instant rather than sharing mutable state.

### One caveat worth knowing

A pane echoes what is typed into it. If you send `echo hello` and then wait for
`hello`, you match the echo immediately, not the output. Wait for something the
command _prints_ — its result, or a marker you echo after it.

## Embedding it

```ts
import { createTmuxMcpServer, serverFromEnvironment } from "@libtmux/mcp";

const mcp = createTmuxMcpServer(serverFromEnvironment());
```

## License

MIT
