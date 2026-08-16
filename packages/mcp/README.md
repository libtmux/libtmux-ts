# @libtmux/mcp

**A Model Context Protocol server that gives an AI agent a real tmux server.**

[![npm](https://img.shields.io/npm/v/@libtmux/mcp?color=cb3837)](https://www.npmjs.com/package/@libtmux/mcp)
[![downloads](https://img.shields.io/npm/dm/@libtmux/mcp?color=cb3837)](https://www.npmjs.com/package/@libtmux/mcp)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.2a%20%7C%203.4%20%7C%203.7%20%7C%203.7b-1bb91f)](../../.github/workflows/typescript.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Part of [libtmux for Bun and TypeScript](../../README.md). Built on
[`libtmux`](../libtmux).

> [!WARNING]
> **Alpha.** Prerelease software: tool names and arguments can change between
> alpha releases without a deprecation cycle. Pin an exact version.

## Why this exists

An agent that drives a terminal needs two things a shell tool does not give it:
somewhere durable to run commands, and a way to **wait for output** without
burning a call per poll. A tmux server is the first. `run_and_wait` is the
second — it streams tmux's own notifications rather than re-reading the pane.

Running and waiting are one tool rather than two on purpose. Split across two
calls, a command that finishes quickly prints before the second call has
attached, and tmux tells a control client nothing that happened before it
arrived — so the wait runs to its deadline against output that already
happened. One call subscribes, attaches, _then_ sends.

## Install

```console
$ npx -y @libtmux/mcp
```

Nothing to install ahead of time: the server speaks MCP over stdio, so an MCP
client launches it as a subprocess. To pin it in a project instead:

```console
$ bun add @libtmux/mcp
```

Requires Node 22+ or [Bun](https://bun.sh) 1.3.14+, and tmux 3.2a or newer.

## Configure your client

This is the whole configuration:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["-y", "@libtmux/mcp"],
      "env": { "LIBTMUX_SOCKET_NAME": "agent" }
    }
  }
}
```

<details>
<summary>Claude Code</summary>

```console
$ claude mcp add tmux --env LIBTMUX_SOCKET_NAME=agent -- npx -y @libtmux/mcp
```

</details>

<details>
<summary>Running it from a clone instead</summary>

```console
$ bun packages/mcp/src/server.ts
```

</details>

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

Give the agent its own socket name. Sharing the one you are attached to means
an agent's cleanup can reap the session you are working in.

## Tools

| Tool            | Arguments                                                     | Returns                                          |
| --------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `list_sessions` | —                                                             | Every session with its id, name and window count |
| `list_panes`    | `session?`                                                    | Panes, with command, session and window          |
| `capture_pane`  | `paneId`, `start?`                                            | Visible contents, or into the scrollback         |
| `send_keys`     | `paneId`, `keys`, `enter?`, `literal?`                        | Confirmation                                     |
| `new_session`   | `name?`                                                       | The created session                              |
| `run_and_wait`  | `paneId`, `keys`, `contains`, `timeoutMs?`, `maxOutputBytes?` | What the pane printed                            |

Every tool takes its own snapshot, so two concurrent requests observe their own
instant rather than sharing mutable state.

### One caveat worth knowing

A pane echoes what is typed into it. If you send `echo hello` and then wait for
`hello`, you match the echo immediately, not the output. Wait for something the
command _prints_ — its result, or a marker you echo after it.

## Embedding it

The server is a library too, so a host that already has a `Server` can mount
tmux tools on its own MCP surface:

```ts
import { createTmuxMcpServer, serverFromEnvironment } from "@libtmux/mcp";

const mcp = createTmuxMcpServer(serverFromEnvironment());
```

## License

[MIT](LICENSE)
