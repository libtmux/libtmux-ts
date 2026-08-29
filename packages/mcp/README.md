# @libtmux/mcp

**A Model Context Protocol server that gives an AI agent a real tmux server.**

[![npm](https://img.shields.io/npm/v/@libtmux/mcp?color=cb3837)](https://www.npmjs.com/package/@libtmux/mcp)
[![downloads](https://img.shields.io/npm/dm/@libtmux/mcp?color=cb3837)](https://www.npmjs.com/package/@libtmux/mcp)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.2a%E2%80%933.7c-1bb91f)](../../.github/workflows/typescript.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Part of [libtmux for Bun and TypeScript](../../README.md). Built on
[`libtmux`](../libtmux).

> [!WARNING]
> **Alpha.** Prerelease software: tool names and arguments can change between
> alpha releases without a deprecation cycle. Pin an exact version.

## Why this exists

An agent driving a terminal needs three things a shell tool does not give it:
somewhere durable to run commands, a way to **wait for output** without burning
a call per poll, and an answer it can act on when the wait does not go its way.

This gets all three from tmux's control mode. One connection per watched
session carries both the commands and the notifications that say what happened,
so waiting costs nothing while nothing is happening — no polling, no command per
read.

Three properties fall out of that, and they are the reason to prefer this over a
capture loop:

**A command's output is never its echo.** A pane repeats what is typed into it,
so waiting for text that appears in the command matches immediately and reports
your own command back to you. `run_command` frames what it sends so the marker
it waits for cannot appear in what it typed or in the command's inherited shell
state, and reports the real exit status.

**A wait that fails is still an answer.** Every wait reports why it ended —
`matched`, `timed_out`, `pane_died`, `cancelled` — along with everything the pane
printed, what it shows now, and a cursor to carry on from. There is no result
that leaves an agent with nothing but "no". Cancel the request and the wait
stops there and then, rather than holding its connection for the rest of a
deadline nobody is waiting on.

**Reading twice costs less than reading once.** `observe` hands back a cursor;
pass it next time and you are charged only for what arrived since, not for the
whole screen again.

## Install

```console
$ npx -y @libtmux/mcp@0.1.0-alpha.6
```

Nothing to install ahead of time: the server speaks MCP over stdio, so an MCP
client launches it as a subprocess. To pin it in a project instead:

```console
$ bun add --exact @libtmux/mcp@0.1.0-alpha.6
```

Requires Node 22+ or [Bun](https://bun.sh) 1.3.14+, and tmux 3.2a or newer.

Linux is the only supported host for real tmux control. The macOS CI lane
checks package artifacts without exercising tmux; macOS runtime behavior is
unproven. WSL is untested.

## Configure your client

This is the whole configuration:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["-y", "@libtmux/mcp@0.1.0-alpha.6"],
      "env": { "LIBTMUX_SOCKET_NAME": "agent" }
    }
  }
}
```

<details>
<summary>Claude Code</summary>

```console
$ claude mcp add tmux --env LIBTMUX_SOCKET_NAME=agent -- \
    npx -y @libtmux/mcp@0.1.0-alpha.6
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

Give the agent its own socket name. Sharing the one you are attached to means an
agent's cleanup can reap the session you are working in.

### Tune what it will do

| Variable                       | Default  | Effect                                                |
| ------------------------------ | -------- | ----------------------------------------------------- |
| `LIBTMUX_SAFETY`               | readonly | `readonly`, `mutating`, or `destructive`              |
| `LIBTMUX_MCP_WAIT_MAX_MS`      | 30000    | Ceiling on a wait that blocks the caller              |
| `LIBTMUX_MCP_MAX_RESULT_LINES` | 200      | Lines a result may carry before it trims and links    |
| `LIBTMUX_MCP_LIVE`             | on       | Set to `0` to forbid control-mode connections         |
| `LIBTMUX_MCP_TOOLS`            | all      | Comma-separated tool names, when a tier is too coarse |

Cancelling a request stops its wait. An over-large timeout is never an error:
it is clamped, and every result reports the `effectiveTimeoutMs` it actually
used.

### Safety tiers

`LIBTMUX_SAFETY` decides which tools are **listed**, not which are refused. A
tool an agent cannot see is one it cannot spend a turn being denied.

- `readonly` — reading, watching, and waiting. It sends no pane input and leaves
  no tmux state behind. `show_buffer` may stage a temporary file; it reads at
  most the result ceiling and removes the file before returning.
- `mutating` — the above, plus typing, splitting, creating, and renaming.
- `destructive` — the above, plus `kill_pane`, `kill_window`, `kill_session`.

These tiers control tool exposure; they are not a sandbox, an authorization
boundary, or a confidentiality boundary. A listed tool has the tmux socket and
Unix-user authority of this process. Use a dedicated socket and read the
[security boundary](../../SECURITY.md) before serving an untrusted client.

A name this list does not hold falls to `readonly`, not to the default —
`read-only` and `read_only` are how `readonly` is usually mistyped, and
answering a typo with a wider surface than the one asked for is the wrong
direction to be wrong in. The server writes one line to stderr as it starts,
naming the socket and the tier actually in force, which is where a typo shows
up:

```console
$ libtmux-mcp
libtmux-mcp 0.1.0-alpha.6 serving agents at the readonly tier
```

`LIBTMUX_MCP_TOOLS` narrows further when a tier is the wrong shape. A tier
answers how much an agent may change; a list answers which of it, and "read and
type, never kill" is not a degree of typing. A tool left off the list is never
registered, so an agent cannot spend a turn discovering it:

```console
$ LIBTMUX_MCP_TOOLS=list_panes,capture_pane,run_command libtmux-mcp
```

Independently of the tier, the server refuses to write to or kill **the pane it
is running in** and any pane **a person is currently watching**, unless the call
passes `force`. `whoami` reports both without a failed call in between.

## Tools

Grouped by what you are trying to do. Every tool returns typed
`structuredContent` alongside its text, and carries MCP annotations so a host
can decide what to auto-approve.

### Find your way around

| Tool            | Answers                                                 |
| --------------- | ------------------------------------------------------- |
| `list_sessions` | What sessions exist, and is anyone attached             |
| `list_windows`  | What windows exist, optionally in one session           |
| `list_panes`    | What panes exist, what each runs, which are yours       |
| `get_pane`      | One pane's metadata                                     |
| `whoami`        | Which pane this server runs in; which panes are watched |
| `server_info`   | Socket, tmux version, daemon pid, totals                |

### Read what panes show

| Tool           | Answers                                     |
| -------------- | ------------------------------------------- |
| `capture_pane` | The rendered screen, or into the scrollback |
| `observe`      | Only what is new since your cursor          |
| `search_panes` | Which panes are showing something           |

### Do things

| Tool              | Does                                                    |
| ----------------- | ------------------------------------------------------- |
| `run_command`     | Runs a shell command, waits for it, reports exit status |
| `send_keys`       | Sends keystrokes: TUIs, `C-c`, partial lines            |
| `paste_text`      | Sends text with nothing read as a key name              |
| `pipe_pane`       | Sends a pane's output to a host command, durably        |
| `display_message` | Resolves arbitrary tmux formats, including `#()` jobs   |

`display_message` is a mutating-tier tool because tmux formats may contain
`#()` jobs that run through the host shell. The tier follows the authority the
format accepts, even when a particular call only reads a field.

A pane keeps `history-limit` lines and `observe` keeps a bounded buffer, so
output larger than either is gone before anything asks for it. `pipe_pane` is
tmux's answer: the command runs for as long as the pipe is open, so a long build
is captured whole and costs nothing to leave running. It attaches to the pane
rather than to the process in it, so it survives `respawn_pane` and keeps
running until something stops it. Starting or stopping the pipe mutates tmux,
and its command has the tmux user's host authority.

### Wait

| Tool            | Does                                 |
| --------------- | ------------------------------------ |
| `wait_for_text` | Blocks until a pane prints something |

### Build and arrange

`build_workspace`, `new_session`, `new_window`, `split_pane`, `respawn_pane`,
`rename_session`, `rename_window`, `resize_pane`, `resize_window`,
`select_pane`, `select_window`, `select_layout`, `swap_pane`, `swap_window`,
`move_pane`, `move_window`, `set_pane_title`.

`move_pane` joins a pane into another window, or breaks it out into one of its
own when no destination is named; the pane keeps its id and whatever runs in it,
which killing and splitting again does not.

A detached session has no client to size it, so tmux gives it 80 columns and
every program in it formats to that. `new_session` takes `width` and `height`,
and `resize_window` changes one afterwards — `resize_pane` only redistributes
space inside a window. A program that formats to its terminal width truncates at
the source, where no capture option recovers the columns.

### Configure

`show_options`, `set_option`, `unset_option`, `show_hooks`, `show_environment`,
`set_environment`, `list_buffers`, `show_buffer`, `load_buffer`, `save_buffer`,
`paste_buffer`, `delete_buffer`.

Options live in six scopes: `server`, `session`, `global-session`, `window`,
`global-window` and `pane`. A handle reports only what was set on it, so a
session that has set nothing reports nothing while the values governing it are
the global tables — `history-limit`, which decides how far `capture_pane` reaches
back, and `default-shell`, which decides what a new pane runs, both live there.
`unset_option` puts an option back to what it inherits.

`show_buffer` may stage a temporary file to measure the buffer and cap what it
reads into the response; it removes that file before returning. `save_buffer`
requires the `mutating` tier and writes the buffer to a file on tmux's own
machine when the point is to store it rather than read it.

Hooks are readable but not writable. A hook outlives the process that sets it,
so an agent that sets one leaves behaviour behind in somebody's tmux that
nothing later will remove. Hooks a server should keep belong in its config file.

### End things

`kill_pane`, `kill_window`, `kill_session` — listed only at the `destructive`
tier.

## Choosing the right tool

The three mistakes that cost an agent a turn, and what to do instead.

**Do not poll.** A `send_keys` then `capture_pane` loop spends a call per read
and still cannot tell you when the command finished.

```console
$ run_command  paneId=%1  command='cargo build'
```

That waits through tmux's notifications and comes back with `exitStatus`,
`outcome`, and the output — one call.

**Do not wait for text you sent.** The pane echoes it, so the wait matches your
own typing. `run_command` is immune by construction; `wait_for_text` is for
output somebody else wrote.

**Do not re-read the screen.** Call `observe` once to start watching, then pass
back the `cursor` it returns:

```console
$ observe  paneId=%1
$ observe  paneId=%1  cursor=ltxc1.0123456789abcdef0123456789abcdef.4096  waitMs=10000
```

The second call is charged only for what arrived after the opaque cursor.

## Resources

The server is browsable, not only callable.

| URI                             | Holds                                      |
| ------------------------------- | ------------------------------------------ |
| `tmux://sessions`               | Every session                              |
| `tmux://windows`                | Every window                               |
| `tmux://panes`                  | Every pane                                 |
| `tmux://clients`                | Who is attached and what they are watching |
| `tmux://sessions/{sessionId}`   | One session with its windows               |
| `tmux://windows/{windowId}`     | One window with its panes                  |
| `tmux://panes/{paneId}`         | One pane's metadata                        |
| `tmux://panes/{paneId}/content` | What a pane is showing                     |

`tmux://panes/{paneId}/content` is **subscribable**. Updates are pushed from the
control connection when the pane prints, coalesced so a chatty pane cannot
flood a subscriber. No polling anywhere in that path.

The templates also carry completions, which is the only place MCP offers
them — `completion/complete` takes a prompt or a resource template and nothing
else, so a pane id you can complete has to be reachable through one.

## Prompts

| Prompt            | For                                              |
| ----------------- | ------------------------------------------------ |
| `run-and-check`   | Run a command and report whether it worked       |
| `watch-until`     | Watch a pane something else is writing to        |
| `diagnose-pane`   | Work out what went wrong in a pane               |
| `build-workspace` | Build a session with several windows in one call |

## Embedding it

The server is a library too, so a host that already has a `Server` can mount
tmux tools on its own MCP surface:

```ts
import { createTmuxMcpServer, serverFromEnvironment } from "@libtmux/mcp";

const mcp = createTmuxMcpServer(serverFromEnvironment());
```

To drive it in-process — a test, or a host that is both ends — link a transport
pair rather than spawning anything. This is a literal excerpt of
[`examples/mcp-agent/mcp-agent.ts`](../../examples/mcp-agent/mcp-agent.ts), which the integration
suite runs against a real tmux server:

<!-- runs: examples/mcp-agent/mcp-agent.ts -->

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createTmuxMcpServer } from "@libtmux/mcp";

const client = new Client({ name: "example", version: "0.0.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([
  createTmuxMcpServer(server, {
    environment: { LIBTMUX_SAFETY: "mutating" },
  }).connect(serverSide),
  client.connect(clientSide),
]);
```

## What this does not do

`observe` reports a pane's byte stream in the order it was written. A program
that draws by moving the cursor — a progress bar, a full-screen TUI — reads
jumbled there, because resolving cursor addressing would mean emulating a
terminal. `capture_pane` reads tmux's rendered grid and is the answer when that
matters.

## License

[MIT](LICENSE)
