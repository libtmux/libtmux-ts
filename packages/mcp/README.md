<!-- libtmux-logo -->
<div align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/libtmux/libtmux-ts/HEAD/packages/mcp/assets/logo.svg" type="image/svg+xml">
    <img src="https://raw.githubusercontent.com/libtmux/libtmux-ts/HEAD/packages/mcp/assets/logo.png" width="128" height="128" alt="libtmux for TypeScript MCP">
  </picture>
</div>
<!-- /libtmux-logo -->

<div align="center">

# @libtmux/mcp

**A Model Context Protocol server that gives an AI agent a real tmux server.**

[API reference](https://libtmux.org/en/ts/latest/mcp/reference/) •
[Tools](https://libtmux.org/en/ts/latest/mcp/tools/) •
[Guides](https://libtmux.org/en/ts/latest/mcp/guides/) •
[npm](https://www.npmjs.com/package/@libtmux/mcp)

[![@libtmux/mcp](https://img.shields.io/npm/v/@libtmux/mcp?label=%40libtmux%2Fmcp)](https://www.npmjs.com/package/@libtmux/mcp)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.3a%E2%80%933.8-1bb91f)](../../.github/workflows/typescript.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![libtmux.org](https://img.shields.io/badge/docs-libtmux.org-0b7285)](https://libtmux.org/en/ts/latest/mcp/)

</div>

Part of
[libtmux for Bun and TypeScript](https://github.com/libtmux/libtmux-ts#readme).
Built on
[`libtmux`](https://github.com/libtmux/libtmux-ts/tree/master/packages/libtmux).

> [!WARNING]
> Releases are numbered `0.1.N`, and each release increments `N`. The API is not
> settled: any release may change or remove exported identifiers, and the
> changelog marks each break. Pin an exact version to avoid one.

Every launch line and printed startup line on this page is started and compared
by [`tests/readme_launch.test.ts`](tests/readme_launch.test.ts).

The `ts` blocks are compiled by `typecheck:readme`. The in-memory excerpt is
matched to
[`examples/mcp-agent/mcp-agent.ts`](../../examples/mcp-agent/mcp-agent.ts),
which the integration suite runs against real tmux.

## Quick start

You need Node 22+ or [Bun](https://bun.sh) 1.3.14+, and tmux 3.3a or newer. An
MCP client launches the server as a subprocess and speaks MCP over stdio, so
nothing needs installing ahead of time or keeping running.

### `npx`: start the server

```console
$ npx -y @libtmux/mcp@0.1.0
```

With no socket or config variable set, the server starts a tmux server of its
own on a socket named `libtmux-mcp`. To pin the package in a project instead:

```console
$ bun add --exact @libtmux/mcp@0.1.0
```

Closing the subprocess's stdin cancels pending waits and joins its control
connections before exit. Existing tmux sessions and panes keep running. Backend
cleanup failures produce a nonzero exit status.

### `claude mcp add`: tell Claude Code about it

```console
$ claude mcp add tmux --env LIBTMUX_SOCKET=agent -- \
    npx -y @libtmux/mcp@0.1.0
```

### `mcpServers`: tell any other client about it

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["-y", "@libtmux/mcp@0.1.0"],
      "env": { "LIBTMUX_SOCKET": "agent" }
    }
  }
}
```

Naming a socket is choosing one, and an explicitly chosen server gets
`inspect,manage,execute`. This configuration therefore ships without the
`teardown` tools: [`kill_pane`][tool-kill_pane],
[`kill_window`][tool-kill_window], [`kill_session`][tool-kill_session] and
[`clear_pane_scrollback`][tool-clear_pane_scrollback].

That is the intended default for a socket the server did not create.
[Toolsets and trust](#toolsets-and-trust) says how to opt in.

### [`list_sessions`][tool-list_sessions]: check that it connects

Ask the client to call `list_sessions`, then read
[`tmux://capabilities`][res-capabilities] to see which tools it was offered. The
[connection guide][guide-verify-and-expand-the-surface] shows the same check.

### `bun packages/mcp/src/server.ts`: run it from a clone

```console
$ bun packages/mcp/src/server.ts
```

Repository contributors can preview, apply, and exactly revert registrations
across supported clients with the
[native MCP swap helper](../../scripts/mcp_swap.md).

### [`createTmuxMcpServer`][mcpref-mcp-server-createtmuxmcpserver]: run it inside your own program

The server is a library too. To drive it in-process, as a test or a host that is
both ends, link a transport pair instead of spawning anything.

This is a literal excerpt of
[`examples/mcp-agent/mcp-agent.ts`](../../examples/mcp-agent/mcp-agent.ts),
which the integration suite runs against a real tmux server:

<!-- runs: examples/mcp-agent/mcp-agent.ts -->

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createTmuxMcpServer } from "@libtmux/mcp";

const client = new Client({ name: "example", version: "0.0.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([
  createTmuxMcpServer(server, {
    environment: { LIBTMUX_TOOLSETS: "inspect,execute" },
  }).connect(serverSide),
  client.connect(clientSide),
]);
```

[Embedding it](#embedding-it) covers the defaults and the settings an embedder
controls.

## Why this exists

An agent driving a terminal needs somewhere durable to run commands, a way to
wait for output without a call per poll, and an answer it can act on when the
wait fails.

tmux's control mode gives all three. One connection per watched session carries
both commands and notifications, so a wait costs nothing while nothing happens.

- **A command's output is never its echo.**
  [`run_shell_command`][tool-run_shell_command] frames what it sends so its
  marker cannot appear in what it typed, and it reports the real exit status.
- **A wait that fails is still an answer.** A wait such as
  [`wait_for_text`][tool-wait_for_text] reports why it ended (`matched`,
  `timed_out`, `pane_died`, `cancelled`, `output_lost`, `stream_lost`), what the
  pane printed, and a cursor to carry on from.
- **Reading twice costs less than reading once.**
  [`capture_since`][tool-capture_since] returns a cursor; pass it back and you
  pay only for what arrived since.

## Point it at a server

An MCP client gives the server an environment and a command line, and nothing
else. [`serverFromEnvironment`][mcpref-mcp-server-serverfromenvironment] reads
that environment; the library never does.

### [`LIBTMUX_SOCKET`][guide-start-the-stdio-server]: choose the tmux server

| Variable                                               | Effect                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| [`LIBTMUX_SOCKET`][guide-start-the-stdio-server]       | Socket name, resolved under tmux's own directory           |
| [`LIBTMUX_SOCKET_PATH`][guide-choose-another-endpoint] | Absolute path to the tmux socket; mutually exclusive above |
| [`LIBTMUX_TMUX_CONFIG`][guide-choose-another-endpoint] | Absolute path to the config used for a new server          |
| [`LIBTMUX_TMUX_BIN`][guide-choose-another-endpoint]    | The `tmux` executable to use                               |

Give the agent its own socket name. Sharing the one you are attached to means an
agent's cleanup can reap the session you are working in.

- The executable and socket selector are validated and frozen before any tmux
  connection; control characters are refused.
- `LIBTMUX_SOCKET_NAME` is retired. Replace it with `LIBTMUX_SOCKET`; its
  presence stops startup.
- `LIBTMUX_TMUX_CONFIG` is passed to tmux as written and must be a nonempty
  absolute path.
- [The full contract](docs/contracts.md#socket-and-environment-variables).

### Attach to a tmux server that is already running

Start it on a socket of its own:

```console
$ tmux -L agent new-session -d -s work
```

Naming the socket attaches to that server instead of starting one. The startup
line on stderr says `serving existing`, and the toolsets default to
`inspect,manage,execute`:

```console
$ LIBTMUX_SOCKET=agent npx -y @libtmux/mcp@0.1.0
libtmux-mcp 0.1.0 serving existing agent, toolsets execute,inspect,manage, 0 named inclusions, 0 exclusions
```

### Let it start a server of its own

With no socket or config variable, the executable selects `libtmux-mcp` and
starts that daemon with the shipped minimal configuration. Once the agent has
made a session, watch it with `tmux -L libtmux-mcp attach`.

- Only the process that created the daemon claims the minimal provenance. A
  second process racing for the socket attaches and defaults without `teardown`.
- An explicit socket is never reported as having the shipped minimal provenance.
- [The full contract](docs/contracts.md#provenance-and-default-toolsets) and the
  [provenance topic][topic-toolsets-and-startup-provenance].

### Tune waits, results, and tool selection

| Variable                         | Default               | Effect                                             | Policy field                                                      |
| -------------------------------- | --------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `LIBTMUX_TOOLSETS`               | depends on the server | Comma-separated toolsets to include                | [`toolsets`][mcpref-mcp-policy-policy-toolsets]                   |
| `LIBTMUX_TOOLS`                  | none                  | Comma-separated tools to add                       | [`tools`][mcpref-mcp-policy-policy-tools]                         |
| `LIBTMUX_EXCLUDE_TOOLS`          | none                  | Comma-separated tools to remove last               | [`excludeTools`][mcpref-mcp-policy-policy-excludetools]           |
| `LIBTMUX_MCP_WAIT_MAX_MS`        | 30000                 | Ceiling on a wait that blocks the caller           | [`blockingWaitMaxMs`][mcpref-mcp-policy-policy-blockingwaitmaxms] |
| `LIBTMUX_MCP_COMMAND_TIMEOUT_MS` | 30000                 | Deadline for each internal tmux request            | [`commandTimeoutMs`][mcpref-mcp-policy-policy-commandtimeoutms]   |
| `LIBTMUX_MCP_MAX_RESULT_LINES`   | 200                   | Lines a result may carry before it trims and links | [`maxResultLines`][mcpref-mcp-policy-policy-maxresultlines]       |
| `LIBTMUX_MCP_LIVE`               | on                    | Set to `0` to forbid control-mode connections      | [`liveEnabled`][mcpref-mcp-policy-policy-liveenabled]             |

- With `LIBTMUX_MCP_LIVE=0`, [`wait_for_text`][tool-wait_for_text] stays in the
  selected surface but returns a `no_stream` tool error;
  [`capture_since`][tool-capture_since] returns a bounded capture with
  `streaming: false`.
- An over-large tool timeout is clamped, never an error, and every result
  reports the `effectiveTimeoutMs` it used. Cancelling a request stops its wait.
- The command timeout is capped at JavaScript's timer range.
  [The full contract](docs/contracts.md#waits-timeouts-and-live-connections).

## Toolsets and trust

Tools belong to four unordered sets: `inspect`, `manage`, `execute`, and
`teardown`. The sets decide what a client is offered, and every offered tool
runs with the tmux user's authority.

| Toolset    | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inspect`  | [`call_read_tools_batch`][tool-call_read_tools_batch], [`capture_pane`][tool-capture_pane], [`capture_since`][tool-capture_since], [`find_pane_by_position`][tool-find_pane_by_position], [`get_pane_info`][tool-get_pane_info], [`get_server_info`][tool-get_server_info], [`get_session_info`][tool-get_session_info], [`get_tmux_variables`][tool-get_tmux_variables], [`get_window_info`][tool-get_window_info], [`list_panes`][tool-list_panes], [`list_sessions`][tool-list_sessions], [`list_windows`][tool-list_windows], [`read_program`][tool-read_program], [`search_panes`][tool-search_panes], [`show_environment`][tool-show_environment], [`show_hooks`][tool-show_hooks], [`show_option`][tool-show_option], [`snapshot_pane`][tool-snapshot_pane], [`wait_for_exit`][tool-wait_for_exit], [`wait_for_text`][tool-wait_for_text] |
| `manage`   | [`move_window`][tool-move_window], [`rename_session`][tool-rename_session], [`rename_window`][tool-rename_window], [`resize_pane`][tool-resize_pane], [`resize_window`][tool-resize_window], [`select_layout`][tool-select_layout], [`select_pane`][tool-select_pane], [`select_window`][tool-select_window], [`set_history_limit`][tool-set_history_limit], [`set_mouse_enabled`][tool-set_mouse_enabled], [`set_pane_title`][tool-set_pane_title], [`signal_channel`][tool-signal_channel], [`swap_pane`][tool-swap_pane], [`wait_for_channel`][tool-wait_for_channel]                                                                                                                                                                                                                                                                         |
| `execute`  | [`create_session`][tool-create_session], [`create_window`][tool-create_window], [`paste_text`][tool-paste_text], [`respawn_pane`][tool-respawn_pane], [`run_program`][tool-run_program], [`run_shell_command`][tool-run_shell_command], [`send_keys`][tool-send_keys], [`send_keys_batch`][tool-send_keys_batch], [`set_synchronize_panes`][tool-set_synchronize_panes], [`split_window`][tool-split_window], [`start_program`][tool-start_program], [`stop_program`][tool-stop_program]                                                                                                                                                                                                                                                                                                                                                         |
| `teardown` | [`clear_pane_scrollback`][tool-clear_pane_scrollback], [`kill_pane`][tool-kill_pane], [`kill_session`][tool-kill_session], [`kill_window`][tool-kill_window]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### [`LIBTMUX_TOOLSETS`][topic-toolsets-and-startup-provenance]: choose the toolsets

A new dedicated socket with the shipped minimal configuration gets all four
sets. An existing, explicitly selected, or otherwise unknown server gets
`inspect,manage,execute`.

`LIBTMUX_TOOLSETS` names the sets to grant, comma-separated. An explicitly empty
value selects none.

For an agent that can inspect and run pane commands but cannot rearrange or end
topology:

```console
$ LIBTMUX_TOOLSETS=inspect,execute npx -y @libtmux/mcp@0.1.0
```

- Unknown names, empty list entries, and the retired `LIBTMUX_SAFETY` variable
  stop startup before tmux is contacted. The retired `LIBTMUX_MCP_TOOLS` fails
  there too.
- [The full contract](docs/contracts.md#toolset-selection-and-the-startup-line).

### [`LIBTMUX_TOOLS`][mcpref-mcp-policy-policy-tools] and [`LIBTMUX_EXCLUDE_TOOLS`][mcpref-mcp-policy-policy-excludetools]: name exact tools

`LIBTMUX_TOOLS` adds tools after the sets are expanded, and
`LIBTMUX_EXCLUDE_TOOLS` removes tools last. An empty toolset plus named
inclusions makes a smaller purpose-built surface:

```console
$ LIBTMUX_TOOLSETS= LIBTMUX_TOOLS=list_sessions,capture_pane npx -y @libtmux/mcp@0.1.0
```

- Exclusions always win, including inside
  [`call_read_tools_batch`][tool-call_read_tools_batch]. A removed tool is
  neither listed, callable, nor a nested batch operation.
- The selection is resolved once, before the protocol starts, and does not
  change with later environment or tmux state.

### Migrate from `LIBTMUX_SAFETY` and `LIBTMUX_MCP_TOOLS`

| Previous setting             | Current setting                                    |
| ---------------------------- | -------------------------------------------------- |
| `LIBTMUX_SAFETY=readonly`    | `LIBTMUX_TOOLSETS=inspect`                         |
| `LIBTMUX_SAFETY=mutating`    | `LIBTMUX_TOOLSETS=inspect,manage,execute`          |
| `LIBTMUX_SAFETY=destructive` | `LIBTMUX_TOOLSETS=inspect,manage,execute,teardown` |
| `LIBTMUX_MCP_TOOLS=`         | `LIBTMUX_TOOLSETS=` with `LIBTMUX_TOOLS` omitted   |
| `LIBTMUX_MCP_TOOLS=a,b`      | `LIBTMUX_TOOLSETS=` plus `LIBTMUX_TOOLS=a,b`       |

The old safety variable and allowlist both fail on mere presence. An empty
`LIBTMUX_TOOLSETS` is important in the allowlist rows: `LIBTMUX_TOOLS` adds to
the selected sets, while the retired variable was an exact allowlist.

### What selection does not do

- Selection shapes the MCP interface. It is not an authorization or
  confidentiality boundary.
- Use a dedicated socket and read the [security boundary](../../SECURITY.md)
  before serving an untrusted client.

### [`libtmux-mcp`][mcpref-mcp-server-main]: read the startup line

The startup line on stderr names the selected socket, effective toolsets, named
inclusions, and exclusions. Stdout stays exclusively MCP JSON-RPC, so the
diagnostic cannot corrupt the protocol stream.

The verb says whether this process started that tmux (`serving new`) or attached
to one already running (`serving existing`). It is the only notice that an agent
is sharing a daemon with whoever else is on that socket.

On a fresh default socket, that diagnostic is:

```console
$ libtmux-mcp
libtmux-mcp 0.1.0 serving new libtmux-mcp, toolsets execute,inspect,manage,teardown, 0 named inclusions, 0 exclusions
```

## The tools

Every tool returns typed `structuredContent` alongside its text and carries the
same conservative MCP annotations, so a host that auto-approves on annotations
alone approves none of them.

What tells one tool from another is its capability row in
[`tmux://capabilities`][res-capabilities] and its toolset, in the table under
[Toolsets and trust](#toolsets-and-trust).

### [`list_panes`][tool-list_panes]: find your way around

| Tool                                                  | Answers                                       |
| ----------------------------------------------------- | --------------------------------------------- |
| [`list_sessions`][tool-list_sessions]                 | What sessions exist                           |
| [`list_windows`][tool-list_windows]                   | What windows exist, optionally in one session |
| [`list_panes`][tool-list_panes]                       | What panes exist and what each runs           |
| [`get_server_info`][tool-get_server_info]             | Socket, tmux version, daemon pid, and totals  |
| [`get_session_info`][tool-get_session_info]           | One session's metadata                        |
| [`get_window_info`][tool-get_window_info]             | One window's metadata                         |
| [`get_pane_info`][tool-get_pane_info]                 | One pane's metadata                           |
| [`find_pane_by_position`][tool-find_pane_by_position] | The pane at a window coordinate               |

- Pane rows identify the active pane, the MCP caller's pane when that identity
  can be proven, and panes watched by attached clients.
- A write or teardown call refuses the server's own pane unless `force` confirms
  that exact caller, and always refuses a pane an attached client watches.
- [Pane protection](docs/contracts.md#pane-protection) and the
  [pane input topic][topic-pane-input-and-human-activity].
- Names that changed since the previous alpha, and their replacements, are in
  [the route migration table](docs/contracts.md#tool-route-migration).

## Read what panes show

These tools read output without entering or changing a client mode.

| Tool                                                  | Answers                                             |
| ----------------------------------------------------- | --------------------------------------------------- |
| [`capture_pane`][tool-capture_pane]                   | The rendered screen, or into the scrollback         |
| [`capture_since`][tool-capture_since]                 | Only what is new since your cursor                  |
| [`snapshot_pane`][tool-snapshot_pane]                 | Bounded content, pane metadata, and cursor position |
| [`search_panes`][tool-search_panes]                   | Which panes contain a bounded pattern               |
| [`call_read_tools_batch`][tool-call_read_tools_batch] | Typed results from up to 16 eligible inspect calls  |

### [`search_panes`][tool-search_panes]: find which pane shows a value

`search_panes` discovers which pane contains a value without capturing every
pane. Narrow it with `session`, and reach into history with `scrollbackLines`.

```text
search_panes  pattern='Listening on'  scrollbackLines=200
```

- A search is bounded across the whole socket. The result names the aggregate
  limit that stopped it; narrow by session, window, or pane instead of retrying.
- [The limits](docs/contracts.md#reading-panes-and-limits).

### [`capture_pane`][tool-capture_pane]: read the rendered screen

`capture_pane` reads a pane's rendered screen. Negative `start` and `end` values
reach into retained history.

```text
capture_pane  paneId=%1  start=-100
```

### [`snapshot_pane`][tool-snapshot_pane]: content, metadata, and mode in one response

`snapshot_pane` returns bounded content plus mode, cursor position, scroll
position, and pane metadata in one response. The metadata and content come from
separate tmux requests, so do not treat them as an atomic view.

### [`capture_since`][tool-capture_since]: read only what is new

For repeated observation, seed `capture_since` without a cursor and pass its
opaque cursor back on later calls.

```text
capture_since  paneId=%1
```

- A nonzero `missedBytes` means retained stream data was lost before the read.
  Use `capture_pane` to recover what remains in tmux's bounded history.
- A pane keeps `history-limit` lines and `capture_since` keeps a bounded buffer,
  so output larger than either is gone before anything asks for it.
- The capture tools read output without entering or changing a client mode.

### [`call_read_tools_batch`][tool-call_read_tools_batch]: several reads in one call

`call_read_tools_batch` runs up to 16 eligible `inspect` calls and returns one
row per call: its input index, success flag, error or result, and a truncation
flag.

```text
call_read_tools_batch  operations=[{tool: 'list_sessions'}, {tool: 'list_panes'}]  onError='continue'
```

- Inner operations receive no separate approval, so the batch's capability
  metadata is the union of every still-eligible nested tool.
- The complete MCP result is capped at 1,000,000 bytes; an oversized row is
  represented explicitly, never omitted.
- [The limits](docs/contracts.md#reading-panes-and-limits).

## Run commands and wait

These tools run programs or put input into panes:

| Tool                                          | Does                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| [`run_program`][tool-run_program]             | Runs a program in a pane of its own, returns only its output |
| [`start_program`][tool-start_program]         | Starts a program that outlives one call; returns at once     |
| [`read_program`][tool-read_program]           | Reads a started program's new output and reports its exit    |
| [`stop_program`][tool-stop_program]           | Ends a started program and removes its pane                  |
| [`run_shell_command`][tool-run_shell_command] | Runs a shell command, waits for it, reports exit status      |
| [`send_keys`][tool-send_keys]                 | Sends keystrokes: TUIs, `C-c`, partial lines                 |
| [`send_keys_batch`][tool-send_keys_batch]     | Sends typed key operations in one bounded call               |
| [`paste_text`][tool-paste_text]               | Sends text with nothing read as a key name                   |

These tools wait:

| Tool                                        | Does                                            |
| ------------------------------------------- | ----------------------------------------------- |
| [`wait_for_exit`][tool-wait_for_exit]       | Blocks until a pane's program exits             |
| [`wait_for_text`][tool-wait_for_text]       | Blocks until a pane prints something            |
| [`wait_for_channel`][tool-wait_for_channel] | Blocks until a tmux channel is signalled        |
| [`signal_channel`][tool-signal_channel]     | Signals a tmux channel for another waiting task |

### [`run_program`][tool-run_program]: run a program and get only its output

`run_program` starts `argv` in a pane of its own, a fresh detached session by
default, waits for it, and returns `exitStatus`, `outcome`, and its output.
Nothing is typed, so the output holds no command line and no echo.

```text
run_program  argv=["git","status","--short"]  timeoutMs=20000
```

- `argv` runs as given: no shell parses it, so `$HOME` and `*` reach the program
  unexpanded. Pipes and redirections need `["sh", "-c", "…"]`; variables go
  first, `["env", "CI=1", "make"]`. Use `run_shell_command` when the command
  needs an existing pane's shell, its directory, environment, or activated
  tools.
- `fromPaneId` starts it in that pane's directory and session, with the
  session's tmux environment: in a background window, or with
  `placement: "split"` in a split beside the pane, where a person watching sees
  it run. Focus stays where it was.
- `inheritShell: true` adds the variables that pane's shell exported, and a
  list such as `["PATH", "VIRTUAL_ENV"]` adds only those. It types one framed
  `env` into the shell first, so the shell must be an idle POSIX one, as
  `run_shell_command` requires.
- `keep: true` leaves the pane, dead and showing the output, for a person to
  read and close. Set it only when a person asked to see the run.
- `input` is the program's stdin, written to a private file rather than typed.
  Without it the program has only the terminal, and one that prompts waits
  until the timeout.
- `separateStderr: true` returns what the program writes to stderr as
  `stderr`, so `output` is stdout alone; stderr is then no terminal. It needs
  the tmux server on this machine, as `input` does.
- The program finds commands on the tmux server's `PATH` and gets `PAGER=cat`
  and `GIT_PAGER=cat`.
- `timeoutMs` defaults to 30 seconds and is capped by `LIBTMUX_MCP_WAIT_MAX_MS`.
  Unlike `run_shell_command`'s, it ends the program: one still running gets
  SIGTERM, then SIGKILL, and is reported `timed_out`.
- The pane is removed before the call returns, unless `keep` is set. Should
  this server die mid-run, tmux ends the program and removes its pane within a
  minute: the server holds a lease on it that only a live server renews.
- The output is the terminal's rendering, stderr included, scrollback too.
  `outputComplete` is false when scrollback or `maxLines` cut it.
- Needs tmux 3.8 or newer; earlier servers answer with a refusal that points
  at `run_shell_command`.
- [Program runs](docs/contracts.md#run_program-program-runs).

### [`start_program`][tool-start_program], [`read_program`][tool-read_program] and [`stop_program`][tool-stop_program]: a program that outlives one call

`run_program` holds one call open until the program ends, which a wait ceiling
cuts short. A build or a server that runs longer is started, read as it
writes, and stopped.

This is a literal excerpt of
[`examples/mcp-agent/mcp-agent.ts`](../../examples/mcp-agent/mcp-agent.ts),
which the integration suite runs against a real tmux server; `callTool` there
returns a result's `structuredContent`:

<!-- runs: examples/mcp-agent/mcp-agent.ts -->

```ts
interface Read {
  readonly cursor: number;
  readonly exitStatus: number | null;
  readonly ended: boolean;
  readonly text: string;
}
const { programId } = await callTool<{ programId: string }>(client, "start_program", { argv });
let text = "";
let exitStatus: number | null = null;
try {
  let read = await callTool<Read>(client, "read_program", { programId });
  text = read.text;
  while (!read.ended) {
    read = await callTool<Read>(client, "read_program", { cursor: read.cursor, programId });
    text += read.text;
  }
  exitStatus = read.exitStatus;
} finally {
  await callTool(client, "stop_program", { programId });
}
```

- `start_program` returns a `programId` and the `paneId`, which `send_keys` and
  `capture_pane` reach while the program runs; its pane is removed once it
  exits. It takes `fromPaneId`, `placement`, `startDirectory`, `width` and
  `height` as `run_program` does, but not `input`, `keep`, `inheritShell` or
  `separateStderr`;
  `PAGER` and `GIT_PAGER` are `cat`. This server reads each running program's
  copy as the library's `stream()` does, by polling a file.
- Each `read_program` waits up to its `timeoutMs` for new output or the exit
  and returns a `cursor`. A read that times out returns no text; the next one
  with the same cursor carries on, past any wait ceiling.
- The text is the byte stream with escape sequences removed, as
  `capture_since` gives it. `ended` turns true once the program ended and
  every byte was read, and `outcome` says how: `completed` with `exitStatus`
  or `signal`, `stopped`, or `gone`. As in `run_program`, a status above 128
  may be a signal's, and `signal` is set only when the signal ended the
  program's `sh` too.
- `outputCut` turns true once the copy reaches its limit, while the program
  runs on, and `lostEnd` when tmux closed the pane before reading the end.
- A program's lifetime is `lifetimeMs` on `start_program`, capped by the server
  and reported as `effectiveLifetimeMs`. When it runs out, this server ends the
  program and removes its pane, even if no later call arrives; should this
  server die or restart, tmux does within 30 seconds, through a lease only a
  live server renews.
- The number of programs running at once is capped, and a start past it is
  refused. Ended programs stay readable, the most recently ended kept, until
  `stop_program` forgets one. With each copy capped too, the output this
  server holds for programs is bounded.
- The program's process group is what ends; a process that daemonizes out of
  it is not followed.

### [`run_shell_command`][tool-run_shell_command]: run a command and get its exit status

`run_shell_command` sends a framed command to a pane, waits through tmux's
notifications, and returns `exitStatus`, `outcome`, and the output in one call.

```text
run_shell_command  paneId=%1  command='make test'  timeoutMs=60000
```

- It needs a singular input cohort and a supported POSIX foreground shell; fish,
  csh, and PowerShell are refused, even with `force`.
- The command runs in a subshell: its `cd`, `export`, functions, and traps do
  not reach the parent shell.
- A `timed_out` outcome means the command may still be running. Keep observing
  it; do not run it again.
- The pane is checked twice and the command dispatched once. That is not an
  atomic tmux transaction, so another process can still race the final check.
- [Framing and checks](docs/contracts.md#run_shell_command-framing-and-checks)
  and the [commands topic][topic-commands-waits-and-cursors].

### [`send_keys`][tool-send_keys] and [`send_keys_batch`][tool-send_keys_batch]: keystrokes, TUIs, and partial lines

`send_keys` sends keystrokes. `send_keys_batch` validates and bounds every
operation before it sends the first, then checks each row afresh.

```text
send_keys  paneId=%1  keys='C-c'
```

- With `synchronize-panes` on, tmux types into every pane of the window. Input
  results disclose that configured cohort, not observed recipients.
- Every cohort member must be alive, input-enabled, and outside a human-owned
  mode. `force` confirms only the exact MCP caller pane.
- Copy mode and other client modes are human-owned. A nonzero `inMode` in a
  [`snapshot_pane`][tool-snapshot_pane] result reports one: wait for its owner
  to leave it. The server never enters or cancels a mode.
- [Input cohorts](docs/contracts.md#input-cohorts) and
  [client modes](docs/contracts.md#copy-mode-and-client-modes).

### [`paste_text`][tool-paste_text]: literal text, nothing read as a key name

`paste_text` loads text into one uniquely named private buffer and pastes it
directly to the named pane. Unlike key input, it stays target-only when
synchronized input is on.

```text
paste_text  paneId=%1  text='C-c is not a key here'  enter=true
```

### [`wait_for_exit`][tool-wait_for_exit]: wait for a program you did not start

`wait_for_exit` blocks until the program in a pane exits, listening for tmux's
own exit events, and returns `exitStatus` or `signal`. It reads the pane once a
second only to notice a kill, which fires no event.

```text
wait_for_exit  paneId=%3  timeoutMs=20000
```

- Use it for a pane you did not start, such as a person's build. For a program
  you run, `run_program` already reports the exit.
- A pane that closes on exit still reports its status: tmux carries it in the
  event. A pane killed from outside has none and answers `pane_gone`.
- `timed_out` means the program still runs; call again to keep waiting.
- Needs tmux 3.8 or newer.

### [`wait_for_text`][tool-wait_for_text]: wait for output you did not send

`wait_for_text` blocks until a pane prints something, streaming tmux's
notifications instead of polling. Use it for output another process or a person
wrote.

```text
wait_for_text  paneId=%1  patterns=['Listening on']  timeoutMs=20000
```

- A wait reports why it ended (`matched`, `timed_out`, `pane_died`,
  `cancelled`, `output_lost`, `stream_lost`), with what the pane printed and a
  cursor to carry on from.
- After a timeout, carry the returned cursor into the next capture. A
  `pane_died` outcome means retrying cannot produce more output. A pane that
  exits mid-wait ends it as `pane_died` on the stream and on the poll below
  3.7 alike; `stream_lost` is for a stream that ended while its pane lives.
- It discounts your own typing only briefly; see
  [Choosing the right tool](#choosing-the-right-tool).

### [`wait_for_channel`][tool-wait_for_channel] and [`signal_channel`][tool-signal_channel]: coordinate through a tmux channel

`wait_for_channel` blocks until a tmux wait-for channel is signalled.
`signal_channel` signals one for another waiting task. Both belong to `manage`.

```text
wait_for_channel  channel=build-done  timeoutMs=60000
signal_channel  channel=build-done
```

## Build and arrange

| Tool                                    | Does                                                              |
| --------------------------------------- | ----------------------------------------------------------------- |
| [`create_session`][tool-create_session] | Creates a detached session with its first window and pane         |
| [`create_window`][tool-create_window]   | Adds a window to a session                                        |
| [`split_window`][tool-split_window]     | Splits a pane and returns the new one                             |
| [`respawn_pane`][tool-respawn_pane]     | Restarts a pane's command in place, keeping its id                |
| [`rename_session`][tool-rename_session] | Renames a session; its id does not change                         |
| [`rename_window`][tool-rename_window]   | Renames a window; its id does not change                          |
| [`resize_pane`][tool-resize_pane]       | Resizes a pane to a size, or by an amount in a direction          |
| [`resize_window`][tool-resize_window]   | Sets a window's size in cells                                     |
| [`select_pane`][tool-select_pane]       | Makes a pane the active one in its window                         |
| [`select_window`][tool-select_window]   | Makes a window the current one in its session                     |
| [`select_layout`][tool-select_layout]   | Rearranges a window's panes with a layout                         |
| [`swap_pane`][tool-swap_pane]           | Exchanges two panes' positions                                    |
| [`move_window`][tool-move_window]       | Moves a window to another index or session                        |
| [`set_pane_title`][tool-set_pane_title] | Titles a pane; the title shows in [`list_panes`][tool-list_panes] |

`create_session`, `create_window`, `split_window`, and `respawn_pane` belong to
`execute`; the rest belong to `manage`.

### [`select_layout`][tool-select_layout]: arrange the panes of a window

`select_layout` accepts tmux's named layouts, unique abbreviations for the
running daemon, and checksummed saved layouts. JSON layouts need tmux 3.8.

```text
select_layout  windowId=@1  layout=tiled
```

- tmux owns geometry and may resize or prune saved cells. The result's
  `window.layout` comes from a fresh snapshot.
- Check `metadataComplete` before reusing a layout as input.

### [`move_window`][tool-move_window] and [`swap_pane`][tool-swap_pane]: rearrange without restarting

`move_window` moves a complete window between sessions without restarting its
panes; pane and window identities remain stable.

`swap_pane` exchanges pane positions without changing the programs running
inside them. Use these when identity continuity matters.

```text
swap_pane  paneId=%1  otherPaneId=%2
```

### [`create_session`][tool-create_session] and [`resize_window`][tool-resize_window]: size a detached session

A detached session has no client to size it, so tmux gives it 80 columns and
every program in it formats to that. A program that formats to its terminal
width truncates at the source.

`create_session` takes `width` and `height`, and `resize_window` changes one
afterwards. `resize_pane` only redistributes space inside a window.

```text
create_session  name=build  width=200  height=50
```

## Read and change settings

Four tools read configuration and three change it in bounded ways.

| Tool                                                  | Does                                           |
| ----------------------------------------------------- | ---------------------------------------------- |
| [`get_tmux_variables`][tool-get_tmux_variables]       | Resolves validated tmux variable names         |
| [`show_option`][tool-show_option]                     | Reads one option at an explicit scope          |
| [`show_environment`][tool-show_environment]           | Reads the environment a new pane would inherit |
| [`show_hooks`][tool-show_hooks]                       | Reads the hooks a server or session runs       |
| [`set_mouse_enabled`][tool-set_mouse_enabled]         | Sets the global mouse option                   |
| [`set_history_limit`][tool-set_history_limit]         | Sets the default scrollback line limit         |
| [`set_synchronize_panes`][tool-set_synchronize_panes] | Sets a window's default synchronized input     |

### [`show_option`][tool-show_option]: read an option at an explicit scope

Options live at server, session, global-session, window, global-window, and pane
scope. `show_option` requires the scope explicitly, so a value inherited from a
global table is not mistaken for one set on the target.

```text
show_option  name=history-limit  scope=global-session
```

### [`get_tmux_variables`][tool-get_tmux_variables]: resolve named variables

`get_tmux_variables` accepts validated variable names and resolves only those
names. Arbitrary tmux formats are not accepted.

```text
get_tmux_variables  paneId=%1  names=['pane_current_command']
```

### [`set_mouse_enabled`][tool-set_mouse_enabled], [`set_history_limit`][tool-set_history_limit], and [`set_synchronize_panes`][tool-set_synchronize_panes]: the bounded changes

These expose the bounded changes MCP clients need, without a generic option or
environment writer. `set_history_limit` applies to panes created afterwards.

```text
set_history_limit  lines=10000
```

- `show_environment` rows can contain credentials, and `show_hooks` and
  `show_option` rows can contain configured shell commands.
- Their capability metadata declares `process-environment` or
  `configured-command` output so a host can route the content.
- [The full contract](docs/contracts.md#settings-and-environment-tools).

## End things

[`clear_pane_scrollback`][tool-clear_pane_scrollback],
[`kill_pane`][tool-kill_pane], [`kill_window`][tool-kill_window], and
[`kill_session`][tool-kill_session] belong to the `teardown` toolset, which an
explicitly selected server does not get by default. Name it to opt in:

```console
$ LIBTMUX_SOCKET=agent LIBTMUX_TOOLSETS=inspect,teardown npx -y @libtmux/mcp@0.1.0
```

- These tools refuse to end the pane hosting the MCP process unless `force`
  confirms that exact caller, and always refuse a pane an attached person is
  watching.
- That protects direct teardown calls; it is not a sandbox. A command typed into
  another pane still has the tmux user's authority.
- [Pane protection](docs/contracts.md#pane-protection).

## Choosing the right tool

The mistakes that cost an agent a turn, and what to do instead.

**Do not poll.** A [`send_keys`][tool-send_keys] then
[`capture_pane`][tool-capture_pane] loop spends a call per read and still cannot
tell you when the command finished.

```text
run_shell_command  paneId=%1  command='cargo build'
```

That waits through tmux's notifications and comes back with `exitStatus`,
`outcome`, and the output — one call.

**Do not type a command when only its output matters.** A typed command shares
its pane with the prompt, the echo, and anyone else typing there.
[`run_program`][tool-run_program] starts it in a pane of its own and returns
only what it printed; keep `run_shell_command` for a command that needs that
pane's shell. Its timeout ends the program and is capped by
`LIBTMUX_MCP_WAIT_MAX_MS`. A build longer than that goes to
[`start_program`][tool-start_program] and is read with
[`read_program`][tool-read_program] until it exits.

```text
run_program  argv=["git","diff","--stat"]
```

**Do not wait for text you sent.** The pane echoes it.
[`wait_for_text`][tool-wait_for_text] discounts your own typing only briefly, so
a longer command can still surface its own echo.

[`run_shell_command`][tool-run_shell_command] is immune by construction;
`wait_for_text` is for output somebody else wrote.

**Do not re-read the screen.** Use [`snapshot_pane`][tool-snapshot_pane] when
one response needs bounded content and pane metadata. For later deltas, call
[`capture_since`][tool-capture_since] without a cursor once, then pass back the
opaque cursor it returns:

```text
snapshot_pane  paneId=%1
capture_since  paneId=%1
capture_since  paneId=%1  cursor=ltxc1.0123456789abcdef0123456789abcdef.4096  waitMs=10000
```

The second call is charged only for what arrived after the opaque cursor.

**Do not infer success from visible text.** A compiler can print an error and a
shell can still leave old success text on screen.

- Use `run_shell_command` when the MCP call owns the command; its framed
  completion reports the exit status.
- Use `wait_for_text` only when some other process owns the work and the text
  itself is the condition.
- [The echo contract](docs/contracts.md#echo-and-waiting) has the details.

## Resources

### [`tmux://capabilities`][res-capabilities]: what the server offers

The server exposes one static resource: `tmux://capabilities`. It reports the
effective startup-frozen tool surface, each tool's capability row, the selected
socket and its provenance, and the trust boundary.

It does not expose live tmux topology or pane content as resources. A client can
read it once to explain the surface it received, without probing tmux.

- Former dynamic resources and the retired prompts have typed tool replacements;
  [the migration tables](docs/contracts.md#resource-and-prompt-migration) map
  each one.
- Discover ids with the list tools, then pass the exact id through the typed
  tool schema.

### `_meta`: what each tool says about itself

Each advertised tool carries `_meta["com.git-pull.libtmux-mcp/capability"]`. The
row declares its process reach, effects, possible outputs, input literalization,
and whether it can amplify future pane input.

- Process reach is one of `none`, `configured-process`, `pane-input`,
  `pane-command`, or `pane-program`. No public tool has `host-command` reach,
  meaning this server starts no process itself; `pane-command` and
  `pane-program` still run arbitrary programs on the tmux server's machine, with
  your user's authority.
- Effects are `observe`, `change`, and `delete`. Output classes distinguish tmux
  metadata, terminal content, process environment, and configured commands.
- [Capability disclosure](docs/contracts.md#capability-disclosure).

## Embedding it

### [`createTmuxMcpServer`][mcpref-mcp-server-createtmuxmcpserver]: mount tmux tools on your own surface

A host that already has a [`Server`][ref-server-server] mounts the tools on its
own MCP surface.
[`serverFromEnvironment`][mcpref-mcp-server-serverfromenvironment] reads the
environment the executable reads:

```ts
import { createTmuxMcpServer, serverFromEnvironment } from "@libtmux/mcp";

const mcp = createTmuxMcpServer(serverFromEnvironment());
```

- Embedded, the default is `inspect,manage,execute`: a host passing its own
  `Server` names a daemon this process did not create.
- To choose, pass `environment: { LIBTMUX_TOOLSETS: ... }` or a whole
  [`Policy`][mcpref-mcp-policy-policy]; there is no `toolsets` option.
- `environment` configures the MCP tool policy. Caller identity is read from
  `process.env` when the factory is constructed; `callerEnvironment` overrides
  it.
- Pass a complete policy environment: changing the object later cannot add a
  hidden tool or alter batch authority.
- For the executable's minimal-daemon provenance, launch the executable instead.
  [The full contract](docs/contracts.md#embedding-the-server).

## What it leaves out

- **Terminal emulation.** [`capture_since`][tool-capture_since] reports a pane's
  byte stream in write order, so a program that draws by moving the cursor reads
  jumbled there. [`capture_pane`][tool-capture_pane] reads tmux's rendered grid.
- **Client UX.** Copy mode, clock mode, choose-tree, command prompts, menus,
  popups, and mouse gestures depend on a person's key table, client, and timing.
  Read their result with `capture_pane`; check mode with
  [`snapshot_pane`][tool-snapshot_pane].
- **Dynamic resources.** There are no topology resources and no subscriptions;
  [`tmux://capabilities`][res-capabilities] is the only resource.
- **Prompts and background jobs.** The server advertises no prompts and keeps no
  background job handles; the former prompts are explicit tool workflows.
- **Generic mutation.** There is no generic option or environment writer;
  [`set_mouse_enabled`][tool-set_mouse_enabled],
  [`set_history_limit`][tool-set_history_limit], and
  [`set_synchronize_panes`][tool-set_synchronize_panes] are the bounded changes.
- **Buffer management.** There is no public buffer CRUD; use
  [`paste_text`][tool-paste_text] for literal input.
- **Host-command tools.** No public tool starts a process from this server;
  `run_shell_command` and `run_program` run programs inside tmux panes, with the
  tmux user's authority. See `_meta` under [Resources](#resources).
- **A sandbox.** Selecting tools shapes the interface; every tool runs with the
  tmux user's authority. See the [security boundary](../../SECURITY.md).

## Support and status

- **Requirements.** Node 22+ or [Bun](https://bun.sh) 1.3.14+, and tmux 3.3a or
  newer.
- **Older tmux.** A server older than 3.3a is refused with a result that names
  the fix: upgrade tmux and restart the server, or pin the previous release.
- **Features above the floor.** `run_program`, `start_program` and
  `wait_for_exit` need tmux 3.8, live streaming (`LIBTMUX_MCP_LIVE`) 3.7, and
  `paste_text` 3.4. On an older tmux, `run_program` and `start_program` refuse
  and point at `run_shell_command`, `wait_for_exit` and `paste_text` refuse with
  the version they need, `wait_for_text` and captures read the pane, and
  `run_shell_command` reads the pane and types its script instead of staging it.
- **Version check.** [`get_server_info`][tool-get_server_info] reports the
  running `version` and the `minimumVersion`.
- **Platforms.** Runs on Linux, including WSL. macOS is supported on a best-effort
  basis, and CI coverage for it is highly limited.
- **Releases.** Releases are numbered `0.1.N`, and each release increments `N`. The API is not
  settled: any release may change or remove exported identifiers, and the
  changelog marks each break. Pin an exact version to avoid one.

## See also

| Link                                       | What it is                                      |
| ------------------------------------------ | ----------------------------------------------- |
| [API reference][mcp-api-reference]         | Every exported identifier, one page each        |
| [Tools][tools-index]                       | One page per tool                               |
| [Connection guide][guide-connect-a-client] | Launch from a client on a named socket          |
| [Topics][mcp-topics]                       | Toolsets, pane input, cursors                   |
| [Examples][mcp-examples]                   | Calls and a complete in-memory program          |
| [`docs/contracts.md`](docs/contracts.md)   | The long contracts behind the short rules above |
| [`AGENTS.md`](AGENTS.md)                   | Rules for working on this package               |
| [`../libtmux/`](../libtmux/)               | The library this serves                         |

## License

[MIT](LICENSE)

[guide-choose-another-endpoint]: https://libtmux.org/en/ts/latest/mcp/guides/#choose-another-endpoint
[guide-connect-a-client]: https://libtmux.org/en/ts/latest/mcp/guides/
[guide-start-the-stdio-server]: https://libtmux.org/en/ts/latest/mcp/guides/#start-the-stdio-server
[guide-verify-and-expand-the-surface]: https://libtmux.org/en/ts/latest/mcp/guides/#verify-and-expand-the-surface
[mcp-api-reference]: https://libtmux.org/en/ts/latest/mcp/reference/
[mcp-examples]: https://libtmux.org/en/ts/latest/mcp/examples/
[mcp-topics]: https://libtmux.org/en/ts/latest/mcp/topics/
[mcpref-mcp-policy-policy]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy/
[mcpref-mcp-policy-policy-blockingwaitmaxms]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy-blockingwaitmaxms/
[mcpref-mcp-policy-policy-commandtimeoutms]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy-commandtimeoutms/
[mcpref-mcp-policy-policy-excludetools]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy-excludetools/
[mcpref-mcp-policy-policy-liveenabled]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy-liveenabled/
[mcpref-mcp-policy-policy-maxresultlines]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy-maxresultlines/
[mcpref-mcp-policy-policy-tools]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy-tools/
[mcpref-mcp-policy-policy-toolsets]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy-toolsets/
[mcpref-mcp-server-createtmuxmcpserver]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-server-createtmuxmcpserver/
[mcpref-mcp-server-main]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-server-main/
[mcpref-mcp-server-serverfromenvironment]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-server-serverfromenvironment/
[ref-server-server]: https://libtmux.org/en/ts/latest/reference/server-server/
[res-capabilities]: https://libtmux.org/en/ts/latest/mcp/resources/capabilities/
[tool-call_read_tools_batch]: https://libtmux.org/en/ts/latest/mcp/tools/call_read_tools_batch/
[tool-capture_pane]: https://libtmux.org/en/ts/latest/mcp/tools/capture_pane/
[tool-capture_since]: https://libtmux.org/en/ts/latest/mcp/tools/capture_since/
[tool-clear_pane_scrollback]: https://libtmux.org/en/ts/latest/mcp/tools/clear_pane_scrollback/
[tool-create_session]: https://libtmux.org/en/ts/latest/mcp/tools/create_session/
[tool-create_window]: https://libtmux.org/en/ts/latest/mcp/tools/create_window/
[tool-find_pane_by_position]: https://libtmux.org/en/ts/latest/mcp/tools/find_pane_by_position/
[tool-get_pane_info]: https://libtmux.org/en/ts/latest/mcp/tools/get_pane_info/
[tool-get_server_info]: https://libtmux.org/en/ts/latest/mcp/tools/get_server_info/
[tool-get_session_info]: https://libtmux.org/en/ts/latest/mcp/tools/get_session_info/
[tool-get_tmux_variables]: https://libtmux.org/en/ts/latest/mcp/tools/get_tmux_variables/
[tool-get_window_info]: https://libtmux.org/en/ts/latest/mcp/tools/get_window_info/
[tool-kill_pane]: https://libtmux.org/en/ts/latest/mcp/tools/kill_pane/
[tool-kill_session]: https://libtmux.org/en/ts/latest/mcp/tools/kill_session/
[tool-kill_window]: https://libtmux.org/en/ts/latest/mcp/tools/kill_window/
[tool-list_panes]: https://libtmux.org/en/ts/latest/mcp/tools/list_panes/
[tool-list_sessions]: https://libtmux.org/en/ts/latest/mcp/tools/list_sessions/
[tool-list_windows]: https://libtmux.org/en/ts/latest/mcp/tools/list_windows/
[tool-move_window]: https://libtmux.org/en/ts/latest/mcp/tools/move_window/
[tool-paste_text]: https://libtmux.org/en/ts/latest/mcp/tools/paste_text/
[tool-rename_session]: https://libtmux.org/en/ts/latest/mcp/tools/rename_session/
[tool-rename_window]: https://libtmux.org/en/ts/latest/mcp/tools/rename_window/
[tool-resize_pane]: https://libtmux.org/en/ts/latest/mcp/tools/resize_pane/
[tool-resize_window]: https://libtmux.org/en/ts/latest/mcp/tools/resize_window/
[tool-respawn_pane]: https://libtmux.org/en/ts/latest/mcp/tools/respawn_pane/
[tool-run_program]: https://libtmux.org/en/ts/latest/mcp/tools/run_program/
[tool-run_shell_command]: https://libtmux.org/en/ts/latest/mcp/tools/run_shell_command/
[tool-search_panes]: https://libtmux.org/en/ts/latest/mcp/tools/search_panes/
[tool-select_layout]: https://libtmux.org/en/ts/latest/mcp/tools/select_layout/
[tool-select_pane]: https://libtmux.org/en/ts/latest/mcp/tools/select_pane/
[tool-select_window]: https://libtmux.org/en/ts/latest/mcp/tools/select_window/
[tool-send_keys]: https://libtmux.org/en/ts/latest/mcp/tools/send_keys/
[tool-send_keys_batch]: https://libtmux.org/en/ts/latest/mcp/tools/send_keys_batch/
[tool-set_history_limit]: https://libtmux.org/en/ts/latest/mcp/tools/set_history_limit/
[tool-set_mouse_enabled]: https://libtmux.org/en/ts/latest/mcp/tools/set_mouse_enabled/
[tool-set_pane_title]: https://libtmux.org/en/ts/latest/mcp/tools/set_pane_title/
[tool-set_synchronize_panes]: https://libtmux.org/en/ts/latest/mcp/tools/set_synchronize_panes/
[tool-show_environment]: https://libtmux.org/en/ts/latest/mcp/tools/show_environment/
[tool-show_hooks]: https://libtmux.org/en/ts/latest/mcp/tools/show_hooks/
[tool-show_option]: https://libtmux.org/en/ts/latest/mcp/tools/show_option/
[tool-signal_channel]: https://libtmux.org/en/ts/latest/mcp/tools/signal_channel/
[tool-snapshot_pane]: https://libtmux.org/en/ts/latest/mcp/tools/snapshot_pane/
[tool-split_window]: https://libtmux.org/en/ts/latest/mcp/tools/split_window/
[tool-swap_pane]: https://libtmux.org/en/ts/latest/mcp/tools/swap_pane/
[tool-wait_for_channel]: https://libtmux.org/en/ts/latest/mcp/tools/wait_for_channel/
[tool-read_program]: https://libtmux.org/en/ts/latest/mcp/tools/read_program/
[tool-start_program]: https://libtmux.org/en/ts/latest/mcp/tools/start_program/
[tool-stop_program]: https://libtmux.org/en/ts/latest/mcp/tools/stop_program/
[tool-wait_for_exit]: https://libtmux.org/en/ts/latest/mcp/tools/wait_for_exit/
[tool-wait_for_text]: https://libtmux.org/en/ts/latest/mcp/tools/wait_for_text/
[tools-index]: https://libtmux.org/en/ts/latest/mcp/tools/
[topic-commands-waits-and-cursors]: https://libtmux.org/en/ts/latest/mcp/topics/#commands-waits-and-cursors
[topic-pane-input-and-human-activity]: https://libtmux.org/en/ts/latest/mcp/topics/#pane-input-and-human-activity
[topic-toolsets-and-startup-provenance]: https://libtmux.org/en/ts/latest/mcp/topics/#toolsets-and-startup-provenance
