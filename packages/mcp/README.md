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
your own command back to you. `run_shell_command` frames what it sends so the
marker it waits for cannot appear in what it typed or in the command's inherited
shell state, and reports the real exit status.

**A wait that fails is still an answer.** Every wait reports why it ended —
`matched`, `timed_out`, `pane_died`, `cancelled` — along with everything the pane
printed, what it shows now, and a cursor to carry on from. There is no result
that leaves an agent with nothing but "no". Cancel the request and the wait
stops there and then, rather than holding its connection for the rest of a
deadline nobody is waiting on.

**Reading twice costs less than reading once.** `capture_since` hands back a
cursor; pass it next time and you are charged only for what arrived since, not
for the whole screen again.

## Install

```console
$ npx -y @libtmux/mcp@0.1.0-alpha.7
```

Nothing to install ahead of time: the server speaks MCP over stdio, so an MCP
client launches it as a subprocess. To pin it in a project instead:

```console
$ bun add --exact @libtmux/mcp@0.1.0-alpha.7
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
      "args": ["-y", "@libtmux/mcp@0.1.0-alpha.7"],
      "env": { "LIBTMUX_SOCKET": "agent" }
    }
  }
}
```

<details>
<summary>Claude Code</summary>

```console
$ claude mcp add tmux --env LIBTMUX_SOCKET=agent -- \
    npx -y @libtmux/mcp@0.1.0-alpha.7
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

| Variable              | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| `LIBTMUX_SOCKET`      | Socket name, resolved under tmux's own directory           |
| `LIBTMUX_SOCKET_PATH` | Absolute path to the tmux socket; mutually exclusive above |
| `LIBTMUX_TMUX_CONFIG` | Absolute path to the config used for a new server          |
| `LIBTMUX_TMUX_BIN`    | The `tmux` executable to use                               |

`LIBTMUX_SOCKET_NAME` is retired. Replace it with `LIBTMUX_SOCKET`; its
presence stops startup instead of selecting a socket.

Give the agent its own socket name. Sharing the one you are attached to means an
agent's cleanup can reap the session you are working in.

With no socket or config variables, the executable selects `libtmux-mcp` and
starts that daemon with the shipped minimal configuration. The launch records a
unique marker inside tmux, then reads it back before it exposes tools. Only the
process that actually created the daemon can claim minimal provenance; a second
process racing for the same socket sees an existing server and defaults without
`teardown`.

An explicit socket is different. The MCP process never assumes how an existing
daemon was configured. A new daemon on that socket follows tmux's normal config
behavior unless you explicitly name a file, and it is never reported as having
the shipped minimal provenance. `LIBTMUX_TMUX_CONFIG` is passed to tmux as
written and must be a nonempty absolute path.

### Tune what it will do

| Variable                         | Default               | Effect                                             |
| -------------------------------- | --------------------- | -------------------------------------------------- |
| `LIBTMUX_TOOLSETS`               | depends on the server | Comma-separated toolsets to include                |
| `LIBTMUX_TOOLS`                  | none                  | Comma-separated tools to add                       |
| `LIBTMUX_EXCLUDE_TOOLS`          | none                  | Comma-separated tools to remove last               |
| `LIBTMUX_MCP_WAIT_MAX_MS`        | 30000                 | Ceiling on a wait that blocks the caller           |
| `LIBTMUX_MCP_COMMAND_TIMEOUT_MS` | 30000                 | Deadline for each internal tmux request            |
| `LIBTMUX_MCP_MAX_RESULT_LINES`   | 200                   | Lines a result may carry before it trims and links |
| `LIBTMUX_MCP_LIVE`               | on                    | Set to `0` to forbid control-mode connections      |

With live connections disabled, `wait_for_text` stays in the selected surface
but returns a `no_stream` tool error; `capture_since` returns a bounded capture
with `streaming: false`.

Cancelling a request stops its wait. An over-large tool timeout is never an
error: it is clamped, and every result reports the `effectiveTimeoutMs` it
actually used. The command timeout is capped at JavaScript's timer range.

### Toolsets and trust

Tools belong to four unordered sets: `inspect`, `manage`, `execute`, and
`teardown`. A new dedicated socket with the shipped minimal configuration gets
all four by default. An existing, explicitly selected, or otherwise
unknown server defaults to `inspect,manage,execute`.

`LIBTMUX_TOOLSETS` chooses sets, `LIBTMUX_TOOLS` adds individual tools, and
`LIBTMUX_EXCLUDE_TOOLS` removes tools last. An explicitly empty value selects
none. Unknown names, empty list entries, and the retired `LIBTMUX_SAFETY`
variable stop startup before tmux is contacted.

The retired `LIBTMUX_MCP_TOOLS` allowlist fails there too.

Existing configurations migrate as follows:

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

For an agent that can inspect and run pane commands but cannot rearrange or end
topology:

```console
$ LIBTMUX_TOOLSETS=inspect,execute npx -y @libtmux/mcp@0.1.0-alpha.7
```

An empty toolset plus named inclusions makes a smaller purpose-built surface:

```console
$ LIBTMUX_TOOLSETS= LIBTMUX_TOOLS=list_sessions,capture_pane npx -y @libtmux/mcp@0.1.0-alpha.7
```

Exclusions always win, including inside `call_read_tools_batch`. A tool removed
there is neither listed, directly callable, nor available as a nested batch
operation. The selection is resolved once before the protocol starts and does
not change with later environment or tmux state.

This shapes the MCP interface; it is not an authorization or confidentiality
boundary. Every advertised tool runs with the tmux user's authority. Use a
dedicated socket and read the [security boundary](../../SECURITY.md) before
serving an untrusted client.

The startup line on stderr names the selected socket, effective toolsets, named
inclusions, and exclusions. Stdout remains exclusively MCP JSON-RPC, so that
diagnostic cannot corrupt the protocol stream.

On a fresh default socket, that diagnostic is:

```console
$ libtmux-mcp
libtmux-mcp 0.1.0-alpha.7 serving libtmux-mcp, toolsets execute,inspect,manage,teardown, 0 named inclusions, 0 exclusions
```

## Tools

Grouped by what you are trying to do. Every tool returns typed
`structuredContent` alongside its text, and carries MCP annotations so a host
can decide what to auto-approve.

These existing names are unchanged: `list_sessions`, `list_windows`,
`list_panes`, `capture_pane`, `search_panes`, `send_keys`, `paste_text`,
`wait_for_text`, `respawn_pane`, `rename_session`, `rename_window`,
`resize_pane`, `resize_window`, `select_pane`, `select_window`,
`select_layout`, `swap_pane`, `move_window`, `set_pane_title`, `show_hooks`,
`show_environment`, `kill_pane`, `kill_window`, and `kill_session`.

Routes removed or renamed since the previous alpha migrate as follows:

| Previous route                                                                               | Current route or replacement                                                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `get_pane`                                                                                   | `get_pane_info`                                                                                               |
| `whoami`                                                                                     | `list_panes` exposes caller and watched panes; inspect one with `get_pane_info`                               |
| `server_info`                                                                                | `get_server_info`                                                                                             |
| `observe`                                                                                    | Use `snapshot_pane` once, or seed `capture_since` without a cursor and reuse the cursor it returns            |
| `run_command`                                                                                | `run_shell_command`                                                                                           |
| `build_workspace`                                                                            | Compose `create_session`, `create_window`, `split_window`, layout, title, and selection tools                 |
| `new_session`                                                                                | `create_session`                                                                                              |
| `new_window`                                                                                 | `create_window`                                                                                               |
| `split_pane`                                                                                 | `split_window`                                                                                                |
| `show_options`                                                                               | `show_option` with an explicit scope and option name                                                          |
| `set_option`                                                                                 | Use `set_mouse_enabled`, `set_history_limit`, or `set_synchronize_panes` for the supported changes            |
| `unset_option`                                                                               | No generic replacement; set the supported value explicitly outside MCP when inheritance is required           |
| `display_message`                                                                            | No generic format evaluator; use `get_tmux_variables`, `show_option`, or another typed inspector              |
| `pipe_pane`                                                                                  | No durable host-command pipe; use `run_shell_command` for a bounded pane command                              |
| `move_pane`                                                                                  | No direct replacement; `swap_pane` preserves pane identity in a window and `move_window` moves a whole window |
| `swap_window`                                                                                | No direct replacement; use `move_window` when moving between sessions is sufficient                           |
| `set_environment`                                                                            | No MCP environment writer; configure the dedicated daemon outside the MCP process                             |
| `list_buffers`, `show_buffer`, `load_buffer`, `save_buffer`, `paste_buffer`, `delete_buffer` | No public buffer CRUD; use `paste_text` for literal input and capture tools for pane output                   |

### Find your way around

| Tool                    | Answers                                       |
| ----------------------- | --------------------------------------------- |
| `list_sessions`         | What sessions exist                           |
| `list_windows`          | What windows exist, optionally in one session |
| `list_panes`            | What panes exist and what each runs           |
| `get_server_info`       | Socket, tmux version, daemon pid, and totals  |
| `get_session_info`      | One session's metadata                        |
| `get_window_info`       | One window's metadata                         |
| `get_pane_info`         | One pane's metadata                           |
| `find_pane_by_position` | The pane at a window coordinate               |

Pane rows identify the active pane, the MCP caller's pane when that identity can
be proven, and panes watched by attached clients. That context matters before a
write or teardown call: the server refuses its own pane and attended panes by
default, while `force` records that the caller deliberately chose one.

### Read what panes show

| Tool                    | Answers                                             |
| ----------------------- | --------------------------------------------------- |
| `capture_pane`          | The rendered screen, or into the scrollback         |
| `capture_since`         | Only what is new since your cursor                  |
| `snapshot_pane`         | Bounded content, pane metadata, and cursor position |
| `search_panes`          | Which panes contain a bounded pattern               |
| `call_read_tools_batch` | Typed results from up to 16 eligible inspect calls  |

Use `search_panes` to discover which pane contains a value without capturing
every pane. Once the pane is known, `capture_pane` reads its rendered screen;
negative `start` and `end` values reach into retained history. `snapshot_pane`
returns bounded content plus mode, cursor position, scroll position, and pane
metadata in one MCP response. Its metadata and content come from separate tmux
requests, so do not treat them as an atomic view.

For repeated observation, seed `capture_since` without a cursor and pass its
opaque cursor back on later calls. A nonzero `missedBytes` means retained stream
data was lost before the read; use `capture_pane` to recover whatever remains in
tmux's bounded history. The capture tools read output without entering or
changing a client mode.

Search is one bounded operation even when it spans the whole socket: at most
200 panes, 20,000 captured lines, 256 KiB of matched input, and five seconds of
matching work. The result states which aggregate limit stopped it, so a caller
can narrow by session, window, or pane instead of retrying the same broad scan.

`call_read_tools_batch` accepts only its declared 16 read operations. Each row
keeps its input index, success flag, error or result, and row-truncation flag.
The outer result records `onError`, succeeded and failed counts, `stoppedAt`,
and whole-result truncation bytes. The complete MCP result is capped at
1,000,000 bytes;
an oversized row is represented explicitly rather than silently omitted. Inner
operations receive no separate approval, so the batch capability metadata is
the union of every still-eligible nested tool.

A serialized request ID may use at most 512 KiB. A larger ID receives a bounded
invalid-request response before any tool runs.

### Do things

| Tool                | Does                                                    |
| ------------------- | ------------------------------------------------------- |
| `run_shell_command` | Runs a shell command, waits for it, reports exit status |
| `send_keys`         | Sends keystrokes: TUIs, `C-c`, partial lines            |
| `send_keys_batch`   | Sends typed key operations in one bounded call          |
| `paste_text`        | Sends text with nothing read as a key name              |

A pane keeps `history-limit` lines and `capture_since` keeps a bounded buffer,
so output larger than either is gone before anything asks for it.

`paste_text` uses tmux's buffer transport so arbitrary text is not parsed as key
names. Its temporary buffer is removed whether delivery succeeds or fails.
`send_keys_batch` validates and bounds every child operation before sending the
first one.

When `set_synchronize_panes` is enabled, one input can reach every pane in a
window. Input results therefore disclose the actual resolved pane ids, not only
the pane originally named. That amplification is also recorded in the tool's
capability row.

### Wait

| Tool               | Does                                            |
| ------------------ | ----------------------------------------------- |
| `wait_for_text`    | Blocks until a pane prints something            |
| `wait_for_channel` | Blocks until a tmux channel is signalled        |
| `signal_channel`   | Signals a tmux channel for another waiting task |

### Build and arrange

`create_session`, `create_window`, `split_window`, `respawn_pane`,
`rename_session`, `rename_window`, `resize_pane`, `resize_window`,
`select_pane`, `select_window`, `select_layout`, `swap_pane`, `move_window`, and
`set_pane_title`.

Copy mode and other client modes are human-owned, modal state. A nonzero
`snapshot_pane.inMode` reports that state; input may be interpreted by the
active tmux key table instead of reaching the pane's program. Report the mode
and wait for its owner to leave it. The MCP server deliberately neither enters
nor cancels client modes.

`move_window` moves a complete window between sessions without restarting its
panes; pane and window identities remain stable. `swap_pane` exchanges pane
positions without changing the programs running inside them. Use those when
identity continuity matters instead of killing and recreating topology.

A detached session has no client to size it, so tmux gives it 80 columns and
every program in it formats to that. `create_session` takes `width` and `height`,
and `resize_window` changes one afterwards — `resize_pane` only redistributes
space inside a window. A program that formats to its terminal width truncates at
the source, where no capture option recovers the columns.

### Configure

`get_tmux_variables`, `show_option`, `show_environment`, and `show_hooks` inspect
configuration. `set_mouse_enabled`, `set_history_limit`, and
`set_synchronize_panes` expose the bounded changes MCP clients need without a
generic option or environment writer.

Options may contain tmux formats and commands. The read tools disclose those
configured-command outputs rather than executing caller-supplied host commands.

Options live at server, session, global-session, window, global-window, and pane
scope. `show_option` requires the scope explicitly so a value inherited from a
global table is not mistaken for one set on the target. `get_tmux_variables`
accepts validated variable names and resolves only those names; arbitrary tmux
formats are not accepted as an executable-shaped escape hatch.

Environment rows can contain credentials and hook or option rows can contain
configured shell commands. Their capability metadata declares
`process-environment` or `configured-command` output so an MCP host can route
the returned content appropriately.

### End things

`clear_pane_scrollback`, `kill_pane`, `kill_window`, and `kill_session` belong
to the `teardown` toolset.

Those tools refuse to end the pane hosting the MCP process or a pane an attached
person is watching unless `force` is true. This protects direct teardown calls;
it is not a sandbox. A command typed into another pane still has the authority
of the tmux user and may perform an equivalent action.

To opt into teardown on an explicitly selected server, name it deliberately:

```console
$ LIBTMUX_SOCKET=agent LIBTMUX_TOOLSETS=inspect,teardown npx -y @libtmux/mcp@0.1.0-alpha.7
```

## Choosing the right tool

The three mistakes that cost an agent a turn, and what to do instead.

**Do not poll.** A `send_keys` then `capture_pane` loop spends a call per read
and still cannot tell you when the command finished.

```console
$ run_shell_command  paneId=%1  command='cargo build'
```

That waits through tmux's notifications and comes back with `exitStatus`,
`outcome`, and the output — one call.

**Do not wait for text you sent.** The pane echoes it, so the wait matches your
own typing. `run_shell_command` is immune by construction; `wait_for_text` is for
output somebody else wrote.

**Do not re-read the screen.** Use `snapshot_pane` when one response needs
bounded content and pane metadata. For later deltas, call `capture_since`
without a cursor once, then pass back the opaque cursor it returns:

```console
$ snapshot_pane  paneId=%1
$ capture_since  paneId=%1
$ capture_since  paneId=%1  cursor=ltxc1.0123456789abcdef0123456789abcdef.4096  waitMs=10000
```

The second call is charged only for what arrived after the opaque cursor.

**Do not infer success from visible text.** A compiler can print an error and a
shell can still leave old success text on screen. Use `run_shell_command` when
the MCP call owns the command; its framed completion reports the exit status.
Use `wait_for_text` only when some other process owns the work and the text
itself is the condition.

## Resources

The server exposes one static resource: `tmux://capabilities`. It reports the
effective startup-frozen tool surface, each tool's capability row, the selected
socket and its provenance, and the trust boundary. It does not expose live tmux
topology or pane content as resources.

The report includes `schemaVersion`, `frozen`, the selected toolsets and exact
effective tool names, and a socket record with selector, selection provenance,
server state, configuration provenance, and namespace boundary. Its boundary
record states that socket selection is process-wide, resources are static, and
host-command execution is absent. A client can read this once to explain the
surface it received without probing tmux or reconstructing launch arguments.

Former dynamic resource workflows have typed replacements:

| Previous resource                                                                   | Current workflow                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `tmux://sessions`, `tmux://windows`, `tmux://panes`                                 | `list_sessions`, `list_windows`, and `list_panes`                                |
| `tmux://clients`                                                                    | `list_panes` reports caller and watched-pane identity                            |
| `tmux://sessions/{sessionId}`, `tmux://windows/{windowId}`, `tmux://panes/{paneId}` | The corresponding `get_session_info`, `get_window_info`, or `get_pane_info` tool |
| `tmux://panes/{paneId}/content` and subscriptions                                   | `capture_pane`, `snapshot_pane`, `capture_since`, or `wait_for_text`             |

Resource-template `completion/complete` support has no direct replacement.
Discover ids with the list tools, then pass the exact id through the typed tool
schema.

The retired prompts remain available as explicit tool workflows:

| Previous prompt   | Current workflow                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `run-and-check`   | `run_shell_command`                                                                                                      |
| `watch-until`     | Seed `capture_since` without a cursor, then reuse its cursor with `capture_since` or `wait_for_text`                     |
| `diagnose-pane`   | `get_pane_info`, `capture_pane` or `snapshot_pane`, `show_option`, `show_hooks`, and `show_environment`                  |
| `build-workspace` | `create_session`, `create_window`, `split_window`, `select_layout`, `set_pane_title`, `select_window`, and `select_pane` |

For `run-and-check`, a `timed_out` outcome means the command may still be
running. Continue observing it; do not run the command again.

For `watch-until`, carry the returned cursor into the next capture after a
timeout. A `pane_died` outcome means retrying cannot produce more output.

For `diagnose-pane`, inspect `currentCommand`, `dead`, bounded scrollback and
its cursor, the last command, and the last non-empty output. Give a root-cause
hypothesis and propose the single cheapest confirming command, but do not
execute it.

For `build-workspace`, report every pane ID returned while creating the
topology.

## Capability disclosure

Each advertised tool carries
`_meta["com.git-pull.libtmux-mcp/capability"]`. The row declares its process
reach, effects, possible outputs, input literalization, and whether it
can amplify future pane input. Every tool also uses the same conservative MCP
annotations: non-read-only, potentially destructive, non-idempotent, and
open-world.

Process reach is one of `none`, `configured-process`, `pane-input`, or
`pane-command`; no public tool has `host-command` reach. Effects are drawn from
`observe`, `change`, and `delete`. Output classes distinguish tmux metadata,
terminal content, process environment, and configured commands.

The internal manifest classifies where every caller-controlled value goes and
tests those sink claims against each schema. Public capability rows expose the
resulting controls: fields that tmux would otherwise interpret as formats
declare the `double-hash-once` literalization strategy. Validated variable names
are called out separately because they control a format lookup without
accepting a free-form format expression.

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
    environment: { LIBTMUX_TOOLSETS: "inspect,execute" },
  }).connect(serverSide),
  client.connect(clientSide),
]);
```

`environment` configures the MCP tool policy. Caller identity is read separately
from `process.env` when the factory is constructed; an embedded test can override
that complete input with `callerEnvironment`.

Embedding freezes the same surface as the executable. Pass a complete policy
environment when constructing the server; changing the object later cannot add
a hidden tool or alter batch authority. If the host wants the executable's
automatic minimal-daemon provenance decision, launch the executable rather than
claiming that provenance for an arbitrary embedded `Server`.

## What this does not do

`capture_since` reports a pane's byte stream in the order it was written. A
program that draws by moving the cursor — a progress bar, a full-screen TUI —
reads jumbled there, because resolving cursor addressing would mean emulating a
terminal. `capture_pane` reads tmux's rendered grid and is the answer when that
matters.

The MCP surface does not drive attachment-bound client UX such as copy mode,
clock mode, choose-tree, command prompts, menus, popups, or mouse gestures.
Those interactions depend on a person's key table, client, clipboard, and
timing. Read their visible result with `capture_pane`, inspect mode through
`snapshot_pane`, and leave entry and cleanup to the attached client.

There are no dynamic topology resources, subscriptions, prompts, background
jobs, generic option or environment mutation, public buffer management, or
host-command tools. These omissions are deliberate: the typed surface covers
the bounded tmux operations an agent needs without creating a second scripting
language beside tmux itself.

## License

[MIT](LICENSE)
