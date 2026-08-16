# @libtmux/mcp

**A Model Context Protocol server that gives an AI agent a real tmux server.**

[![npm](https://img.shields.io/npm/v/@libtmux/mcp?color=cb3837)](https://www.npmjs.com/package/@libtmux/mcp)
[![downloads](https://img.shields.io/npm/dm/@libtmux/mcp?color=cb3837)](https://www.npmjs.com/package/@libtmux/mcp)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.2a%E2%80%933.7b-1bb91f)](../../.github/workflows/typescript.yml)
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
it waits for cannot appear in what it typed, and reports the real exit status.

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

Give the agent its own socket name. Sharing the one you are attached to means an
agent's cleanup can reap the session you are working in.

### Tune what it will do

| Variable                       | Default  | Effect                                             |
| ------------------------------ | -------- | -------------------------------------------------- |
| `LIBTMUX_SAFETY`               | mutating | `readonly`, `mutating`, or `destructive`           |
| `LIBTMUX_MCP_WAIT_MAX_MS`      | 30000    | Ceiling on a wait that blocks the caller           |
| `LIBTMUX_MCP_TASK_WAIT_MAX_MS` | 600000   | Ceiling on a wait running as a task                |
| `LIBTMUX_MCP_MAX_RESULT_LINES` | 200      | Lines a result may carry before it trims and links |
| `LIBTMUX_MCP_LIVE`             | on       | Set to `0` to forbid control-mode connections      |

Two ceilings rather than one, because the two waits cost different things. A
blocking wait spends the agent's turn and cannot be called off mid-flight, so it
is held low. A task hands back a handle at once and can be cancelled, so it may
run for as long as the work does. An over-large timeout is never an error: it is
clamped, and every result reports the `effectiveTimeoutMs` it actually used.

### Safety tiers

`LIBTMUX_SAFETY` decides which tools are **listed**, not which are refused. A
tool an agent cannot see is one it cannot spend a turn being denied.

- `readonly` — reading, watching, and waiting. Nothing writes.
- `mutating` — the above, plus typing, splitting, creating, and renaming.
- `destructive` — the above, plus `kill_pane`, `kill_window`, `kill_session`.

Independently of the tier, the server refuses to write to or kill **the pane it
is running in** and any pane **a person is currently watching**, unless the call
passes `force`. `whoami` reports both without a failed call in between.

## Tools

Grouped by what you are trying to do. Every tool returns typed
`structuredContent` alongside its text, and carries MCP annotations so a host
can decide what to auto-approve.

### Find your way around

| Tool              | Answers                                                 |
| ----------------- | ------------------------------------------------------- |
| `list_sessions`   | What sessions exist, and is anyone attached             |
| `list_windows`    | What windows exist, optionally in one session           |
| `list_panes`      | What panes exist, what each runs, which are yours       |
| `get_pane`        | One pane's metadata                                     |
| `whoami`          | Which pane this server runs in; which panes are watched |
| `server_info`     | Socket, tmux version, daemon pid, totals                |
| `display_message` | Any tmux format these projections do not carry          |

### Read what panes show

| Tool           | Answers                                     |
| -------------- | ------------------------------------------- |
| `capture_pane` | The rendered screen, or into the scrollback |
| `observe`      | Only what is new since your cursor          |
| `search_panes` | Which panes are showing something           |

### Do things

| Tool          | Does                                                    |
| ------------- | ------------------------------------------------------- |
| `run_command` | Runs a shell command, waits for it, reports exit status |
| `send_keys`   | Sends keystrokes: TUIs, `C-c`, partial lines            |
| `paste_text`  | Sends text with nothing read as a key name              |

### Wait

| Tool                 | Does                                                    |
| -------------------- | ------------------------------------------------------- |
| `wait_for_text`      | Blocks until a pane prints something                    |
| `wait_for_text_task` | The same wait as a task: a handle now, the result later |

### Build and arrange

`build_workspace`, `new_session`, `new_window`, `split_pane`, `respawn_pane`,
`rename_session`, `rename_window`, `resize_pane`, `select_pane`, `select_window`,
`select_layout`, `swap_pane`, `move_window`, `set_pane_title`.

### Configure

`show_options`, `set_option`, `show_hooks`, `show_environment`,
`set_environment`, `list_buffers`, `show_buffer`, `load_buffer`, `paste_buffer`,
`delete_buffer`.

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
$ observe  paneId=%1  cursor=4096  waitMs=10000
```

The second call is charged only for what arrived after byte 4096.

## Long waits without blocking

`wait_for_text_task` is the same wait registered as an MCP task. A client that
speaks the task protocol gets a handle immediately, can do other work, and can
cancel. A client that does not gets exactly the blocking tool it expects —
`taskSupport` is `optional`, so the SDK polls on its behalf. Nothing has to be
upgraded for this to be safe.

That is why the two ceilings differ: as a task, a wait may run for
`LIBTMUX_MCP_TASK_WAIT_MAX_MS`, ten minutes by default, because sitting through
it costs the agent nothing.

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
[`examples/mcp-agent.ts`](../../examples/mcp-agent.ts), which the integration
suite runs against a real tmux server:

<!-- runs: examples/mcp-agent.ts -->

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createTmuxMcpServer } from "@libtmux/mcp";

const client = new Client({ name: "example", version: "0.0.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([
  createTmuxMcpServer(server, { environment: {} }).connect(serverSide),
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
