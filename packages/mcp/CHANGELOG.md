# Changelog

Notable changes to `@libtmux/mcp`.

Releases are numbered `0.1.N`, and each release increments `N`. The API is not
settled: any release may change or remove exported identifiers, and this
changelog marks each break. Pin an exact version to avoid one. The newest
release is always `latest`, so `npm i @libtmux/mcp` fetches it. Releases before
`0.1.0` were alphas, and their entries below keep that name.

The release packages share one version, so every release has a section here.
Changes that span packages, such as documentation, CI and release tooling,
are in the [`libtmux` changelog](../libtmux/CHANGELOG.md).

<!-- KEEP THIS PLACEHOLDER: new work lands under "Unreleased" until a release is cut. -->

<!-- toc -->

- [Unreleased](#unreleased)
- [0.1.2 (2026-10-31)](#012-2026-10-31)
- [0.1.1 (2026-10-31)](#011-2026-10-31)
- [0.1.0 (2026-10-25)](#010-2026-10-25)
- [0.1.0-alpha.15 (2026-10-24)](#010-alpha15-2026-10-24)
- [0.1.0-alpha.14 (2026-10-20)](#010-alpha14-2026-10-20)
- [0.1.0-alpha.13 (2026-10-18)](#010-alpha13-2026-10-18)
- [0.1.0-alpha.12 (2026-09-27)](#010-alpha12-2026-09-27)
- [0.1.0-alpha.11 (2026-09-26)](#010-alpha11-2026-09-26)
- [0.1.0-alpha.10 (2026-09-19)](#010-alpha10-2026-09-19)
- [0.1.0-alpha.9 (2026-09-12)](#010-alpha9-2026-09-12)
- [0.1.0-alpha.8 (2026-09-06)](#010-alpha8-2026-09-06)
- [0.1.0-alpha.7 (2026-08-30)](#010-alpha7-2026-08-30)
- [0.1.0-alpha.6](#010-alpha6)
- [0.1.0-alpha.5](#010-alpha5)
- [0.1.0-alpha.4](#010-alpha4)
- [0.1.0-alpha.3](#010-alpha3)
- [0.1.0-alpha.2](#010-alpha2)
- [0.1.0-alpha.1](#010-alpha1)
- [0.0.1-alpha.7](#001-alpha7)
- [0.0.1-alpha.6](#001-alpha6)
- [0.0.1-alpha.5](#001-alpha5)

<!-- /toc -->

## Unreleased

## 0.1.2 (2026-10-31)

### `@libtmux/mcp`

The server no longer starts a tmux server of its own on the socket
`libtmux-mcp` when neither `LIBTMUX_SOCKET` nor `LIBTMUX_SOCKET_PATH` is set.

Before: it started that server with a shipped minimal configuration, and an
agent launched inside tmux drove it instead of the server of its own window.

After: it passes tmux no socket, so tmux picks the server: the one `TMUX` names
when launched from a tmux pane, otherwise its default socket. To keep the old
server, set `LIBTMUX_SOCKET=libtmux-mcp`. (#164)

- `LIBTMUX_SOCKET_PATH` wins when both variables are set, where setting both
  stopped startup. A variable that is empty or only whitespace counts as unset,
  where an empty `LIBTMUX_SOCKET` stopped startup. (#164)
- `teardown` is no longer in the default toolsets of any launch, where the
  server the default launch had created got it. Name it in `LIBTMUX_TOOLSETS`.
  (#164)
- `tmux://capabilities` reports `socketProvenance` and `selectionProvenance` as
  `socket-path`, `socket-name` or `tmux-choice`, where it reported
  `default-dedicated` or `operator-current`, and the selector as `tmux-choice`
  when no socket was passed. `serverState` is no longer `created` and
  `configurationProvenance` is no longer `minimal`. (#164)
- The startup line says `serving` or `serving existing`, where it also said
  `serving new`. With no socket chosen it names the socket `TMUX` names,
  otherwise `default`. (#164)
- The startup line and the server instructions name the server of the pane the
  process was launched from: `from pane %0 on /path/to/socket`. (#164)

## 0.1.1 (2026-10-31)

### `@libtmux/mcp`

- Add `run_program`, which runs `argv` in a pane of its own, removed before it
  returns, and returns its `output`, `exitStatus` or `signal`, and `outcome`.
  `outputComplete` is false when a timeout, a lost start or end, or a limit cut
  the output. (#123)
- `run_program` takes `fromPaneId` with `placement`, `keep`, `input`,
  `separateStderr` and `inheritShell`, which carries the variables the pane's
  idle shell exported. (#123)
- `run_program` fails, with the reason, when its program cannot start:
  `argv[0]` not found or not executable, or a `startDirectory` it cannot enter.
  (#123)
- Add `start_program`, `read_program` and `stop_program` for a program longer
  than one wait. `read_program` returns its output after a cursor, with
  `ended`, `outcome`, `lostEnd`, `outputCut` and `outputComplete`. (#123)
- Once the program has ended, every `read_program` reports `outcome`,
  `exitStatus` and `signal`, and its status line says
  `more output after cursor N` until `ended`, so read until `ended`. (#129)
- `read_program` returns pages of up to about 24,000 characters, ending on a
  line break, so each result stays under the 50,000 characters Claude Code
  shows inline, and takes `maxLines` for a page of fewer lines. A carriage
  return on its own starts a new line. (#129, #140)
- `lifetimeMs` on `start_program` bounds how long this server lets the program
  run, and tmux ends it should the server die. (#123)
- `start_program` beside `fromPaneId` keeps its window or split on screen after
  the program ends, until `stop_program` or its lifetime; a program in a session
  of its own loses its pane at its end. (#123)
- Add `wait_for_exit`, which waits for the program in a pane this server did not
  start and returns its exit status or signal. (#123)
- `run_program`, `start_program` and `wait_for_exit` require tmux 3.8; an older
  server answers each with a refusal that names the remedy. (#123)
- `pane-program` is the process reach the capability rows of `run_program` and
  `start_program` declare: each runs a program of the caller's choosing in a
  pane. (#123)
- `run_shell_command` answers `pane_died` within about a second of its pane
  being killed, where it waited out its timeout, and returns what the command
  printed before the pane died, where `output` came back empty. (#129, #140)
- `run_shell_command` removes its script, which holds the command's text, when
  it returns `timed_out`, `cancelled` or `pane_died` after the shell opened the
  script, and once the pane is gone when it timed out before that. A pane that
  died left the script behind. (#129, #140)
- A `run_shell_command` cancelled while tmux is slow to answer returns without
  waiting out its pane check's own timeout. (#129)
- The server shuts down on SIGTERM, SIGINT and SIGHUP as on the end of stdin,
  ending the programs it started, and exits with 128 plus the signal's number.
  (#129)

## 0.1.0 (2026-10-25)

No entries for `@libtmux/mcp`.

## 0.1.0-alpha.15 (2026-10-24)

No entries for `@libtmux/mcp`.

## 0.1.0-alpha.14 (2026-10-20)

### `@libtmux/mcp`

`paste_text` needs tmux 3.4 and names that requirement when the server is older,
before staging anything. `run_shell_command` types its script on tmux before 3.4
instead of staging it in a buffer. (#73)

`wait_for_text` polls the pane with `capture-pane` below tmux 3.7, or when
`LIBTMUX_MCP_LIVE=0`, and attaches no control client there. The returned cursor
is `null`. A match across a wrapped row is found as on the stream. A pane that
dies mid-wait, or a server killed under it, ends the wait as `pane_died` with
the output so far, on the stream and on the poll alike; `stream_lost` now means
the stream ended while its pane lives. (#73)

## 0.1.0-alpha.13 (2026-10-18)

### `@libtmux/mcp`

A tmux below the minimum now returns a failure result that names the fix,
`get_server_info` reports `minimumVersion` beside `version`, and the server
instructions state the minimum. (#72)

## 0.1.0-alpha.12 (2026-09-27)

No entries for `@libtmux/mcp`.

## 0.1.0-alpha.11 (2026-09-26)

### `@libtmux/mcp`

The stdio server now closes pending waits and joins its control connections on
stdin EOF, preserving existing tmux sessions. Backend cleanup errors reach the
process exit status. (#24)

`select_layout` reports the observed window layout without falsely warning
that a valid abbreviation, mirrored name or adapted saved layout was not
applied. Descriptions now explain that tmux may resize or prune saved
cells. (#24)

## 0.1.0-alpha.10 (2026-09-19)

### `@libtmux/mcp`

#### Reaching the daemon

MCP pane input works in non-UTF-8 locales. (#26)

The startup message distinguishes a new daemon from an existing one, so an
operator can see which instance this process owns. (#26)

#### Pane input and shell commands

Blocked pane writes distinguish retryable conditions from startup context
that requires restarting the MCP server. (#26)

`run_shell_command` keeps its helper script out of the pane's visible input
when the shell can read its private file. Remote shells fall back to typed
delivery. (#26)

`wait_for_text` distinguishes existing text and this server's echoed input
from command output. Echo matching leaves longer words of output intact.
(#26)

#### Registration and results

Tool input schemas describe every parameter, including nested batch
arguments. (#26)

Tool registration rejects custom MCP annotations instead of silently
overwriting them. (#26)

Session results include `humanAttachedClients`, excluding this MCP server's
own control-mode observers from the human attachment count. (#26)

## 0.1.0-alpha.9 (2026-09-12)

### `@libtmux/mcp`

`resize_pane` treats `zoom` as a state: `true` makes the pane fill its window
and `false` restores the layout, and sending the same value twice is a no-op.
It previously passed tmux's toggle through, so two identical calls undid each
other. A call carrying both `zoom` and a size is now refused, because tmux
unzooms a window before applying any size.

## 0.1.0-alpha.8 (2026-09-06)

### `@libtmux/mcp`

#### Capability surface

**Breaking.** One registry of 45 tools, split across `inspect`, `manage`,
`execute`, and `teardown`, backs registration, dispatch, schemas,
descriptions, exact selection, and the static `tmux://capabilities` report.
Each `tools/list` entry carries its capability row under the namespaced
`com.git-pull.libtmux-mcp/capability` key. (#16)

Every tool definition classifies independent process reach, effects, output
classes, secret and untrusted-output flags, internal interpreter sinks,
annotations, nested authority, and future-input amplification. Public rows
expose one schema-keyed `inputLiteralization` map, and tmux-format-bearing
names and paths are literalized once. (#16)

**Breaking.** MCP prompts, dynamic resources, raw and generic mutation
families, background jobs, workspace tools, and buffer tools are removed.
`tmux://capabilities` is the only MCP resource. (#16)

**Breaking.** `enter_copy_mode` and `exit_copy_mode` are no longer MCP routes.
`Pane` keeps both in the library; MCP clients read a pane through bounded
capture, history, search, snapshots, and cursors without taking ownership of a
person's modal client state. (#16)

The MCP README maps every previous tool, resource, and prompt name to its
current route, composed workflow, or explicit lack of replacement. Renamed
routes include `get_pane` to `get_pane_info`, `server_info` to
`get_server_info`, `observe` to `snapshot_pane` plus `capture_since`,
`run_command` to `run_shell_command`, and the `new_*` and `split_pane`
topology routes to `create_*` and `split_window`. (#16)

#### Pane input

Key input resolves each pane's effective synchronized-input setting before
writing. It refuses a configured cohort holding a dead pane, a human-owned
mode, a protected caller or attended pane, or another active framed command,
and reports configured membership rather than observed delivery. (#16)

Literal paste stays target-only and removes its private buffer, including when
setup fails partway. (#16)

#### Shell commands

`run_shell_command` requires one live, mode-free pane at a supported POSIX
shell and checks it twice around setup, refusing on a state, identity, cohort,
or shell transition before command bytes are sent. Its framing bypasses
inherited `printf` aliases and functions while preserving the command's
inherited shell state. (#16)

#### Configuration

**Breaking.** `LIBTMUX_TOOLSETS`, `LIBTMUX_TOOLS`, and `LIBTMUX_EXCLUDE_TOOLS`
replace safety tiers and the legacy allowlist. `LIBTMUX_SOCKET` selects a
socket name, `LIBTMUX_SOCKET_PATH` an absolute path, and `LIBTMUX_TMUX_CONFIG`
configuration provenance.

`LIBTMUX_SAFETY`, `LIBTMUX_MCP_TOOLS`, and `LIBTMUX_SOCKET_NAME` now fail on
presence rather than silently narrowing or widening a stale configuration.

Before:

    LIBTMUX_MCP_TOOLS=capture_pane,list_panes

After:

    LIBTMUX_TOOLSETS=
    LIBTMUX_TOOLS=capture_pane,list_panes

An empty `LIBTMUX_TOOLSETS` selects no toolset, so `LIBTMUX_TOOLS` carries the
exact list; leave `LIBTMUX_TOOLS` unset when the old allowlist was empty.
Startup refuses rather than serving a tool surface the operator no longer
controls. (#16)

The default launch uses a dedicated `libtmux-mcp` socket and minimal
configuration. It grants teardown only when it creates the daemon itself and
authenticates that creation with a per-launch marker; a concurrent or later
process on the same socket treats the daemon's provenance as unknown. (#16)

The tmux executable and socket route are frozen for the server's lifetime.
ASCII control characters and DEL in those startup values fail before tmux is
contacted. (#16)

#### Limits

The read aggregate preserves each nested result envelope and its row-level
success accounting, caps the whole JSON-RPC response at 1,000,000 bytes, and
reports truncation and omitted bytes. Serialized request IDs over 512 KiB fail
before dispatch rather than consuming that budget. (#16)

Literal search and wait patterns carry bounded counts and UTF-8 sizes. Search
stops after 200 panes, 20,000 lines, 256 KiB of matching input, or five
seconds, and names the ceiling that truncated the scan. (#16)

## 0.1.0-alpha.7 (2026-08-30)

### `@libtmux/mcp`

#### Safety and policy

MCP starts read-only by default. `LIBTMUX_MCP_TOOLS` is an exact allowlist,
and an empty value grants no tools. (#11)

Read-only mode avoids shell execution, attended-pane mutations require caller
authority, and option writes enforce their declared scope. (#11)

**Breaking.** The experimental MCP task surface is removed; use resource
reads, live streams, and `run_command` for observable command execution.
(#11)

#### Commands, reads, and results

`run_command` reports explicit started, busy, completed, canceled, and marker
outcomes instead of inferring status from pane text. (#11)

MCP request, name, line, pane-output, and result limits are enforced
consistently, with typed errors when a value cannot be represented safely.
(#11)

Tool results preserve structured values while keeping diagnostic and retained
output within the advertised byte limits. (#11)

#### Live streams and resources

Live streams preserve split ANSI sequences, UTF-8, backspaces, and byte
cursors, and report gaps when retained output has been lost. (#11)

Subscriptions rebind after pane identity changes and cancel cleanly while a
stream is still opening. (#11)

Resource listing supports bounded cursors, invalidates stale catalogs, and
closes session listeners when their final consumer disconnects. (#11)

Topology resources preserve linked-window placement identity and deduplicate
descriptors without hiding distinct links. (#11)

Tool guidance and schemas describe only the operations allowed by the active
policy. (#11)

## 0.1.0-alpha.6

### `@libtmux/mcp`

`show_hooks` reports a hook under the name that sets it, with every command it
holds. `show_options` and `show_hooks` report values as they were set, rather
than carrying tmux's own escaping.

`load_buffer` refuses text with no bytes, naming the buffer it did not create.
tmux exits zero for `set-buffer -b name ""` and stores nothing, so a load
reported as done was followed by `paste_buffer` saying there is no such buffer.

`wait_for_text` reports `pane_died` when the pane dies under it, rather than
waiting out the rest of the deadline. Nothing more arrives from a dead pane, and
a wait run as a task can be holding an hour.

## 0.1.0-alpha.5

### `@libtmux/mcp`

#### Writing into a pane

`paste_text`, `paste_buffer` and `respawn_pane` refuse the pane the server runs
in, and take `force` to mean it anyway. Previously only `send_keys` and
`run_command` checked.

`respawn_pane` requires the `destructive` tier for `killFirst`, and refuses a
pane somebody is watching. It ended a running process at the `mutating` tier,
where `kill_pane` is hidden.

`split_pane`, `respawn_pane`, `resize_pane`, `select_pane`, `swap_pane` and
`set_pane_title` report `isAttended` and `isCallerPane` from the caller's
identity. All six returned `false` for both, including for the server's own
pane, while `get_pane` answered correctly about the same pane.

Every tool that runs a `shellCommand` declares `openWorldHint`. `new_session`,
`new_window`, `split_pane`, `respawn_pane` and `build_workspace` reported
`false` while `send_keys` reported `true` for the same thing.

#### `run_command`

A multiline command no longer reaches the history file of a shell set to
`HIST_IGNORE_SPACE` or `HISTCONTROL=ignorespace`. The leading space that
suppresses it was skipped whenever the command contained a newline.

Output no longer includes a second caller's echoed command or its output, and
`foreignOutputSuspected` reports what cannot be attributed. `false` means no
foreign marker was seen, not that the output is certainly this command's.

A command that prints more than the pane's buffer holds still reports its exit
status. The start marker is printed first and lost first, and requiring it meant
a finished command ran to its deadline and reported as still running.
`missedBytes` and `droppedLines` say when output is short of what was printed.

A dead pane is refused, naming `respawn_pane`. `pane_died` is decided by
liveness rather than by the pane still existing.

The timeout hint names `wait_for_text`. It read "call again to keep waiting",
which mints a fresh marker and is then refused by this tool's own shell guard.

#### Watching output

`observe` and `wait_for_text` refuse a cursor past the end of a pane's stream,
naming where the stream is and how to reseed. Past the end it read as empty with
nothing missed, so a pane that was printing looked quiet.

`observe` seeds on an absent cursor rather than an absent tail, and honours
`LIBTMUX_MCP_LIVE`.

`wait_for_text_task` holds to the blocking ceiling for a client that declares no
task capability. Such a client gets no handle and cannot cancel, and was charged
the task ceiling for a trade it never received.

#### Resources

Every per-object URI reads back. Ids were escaped on the way out and not
unescaped on the way in, so `tmux://sessions/%240` answered "No session %240"
while the unadvertised raw form resolved. Lookups route through the same
not-found errors the tools use.

`notifications/resources/list_changed` is sent when this server adds, removes or
renames anything, and when another client on the same tmux server does. It was
advertised and never sent. `subscribe` is advertised only when a control
connection is available.

A session's control connection is released once nothing reads it. The close path
refused to run while a link held any tail and nothing removed one, so the server
held one control-mode client per observed session for the life of the process.

#### Options

Six scopes rather than three: `global-session`, `global-window` and `window`
join `server`, `session` and `pane`. The global tables hold most of tmux's
options, `history-limit` and `default-shell` among them.

`unset_option` removes an option so it falls back to what it inherits.
`set_option` had no inverse.

`set_option` and `show_options` require a target for `session`, `window` and
`pane` scope. `""` is a legal tmux session name and was the absent-target
sentinel, so an untargeted call was a lookup that could succeed.

#### Reporting

`list_panes`, `list_windows` and `search_panes` resolve a session filter id
first and exclusively, as `requireSession` and tmux do. They matched the id or
the name, so a session named `$0` returned another session's panes. A filter
naming no session is an error rather than an empty list.

`server_info` reports the socket it is driving, resolved from tmux. It read a
constructor argument, so a server on the default socket reported null.

`display_message` names a field tmux does not know. tmux prints nothing for an
unknown name and exits 0, so a typo and an empty field were one answer. Only
`#{name}` forms are checked, and the table is consulted when nothing resolved or
when more than one name could have contributed.

`select_layout` says when a layout string was accepted and ignored. tmux exits 0
for a layout describing a different set of panes and changes nothing.

`show_hooks` lists the hooks that carry a command and counts the rest in
`unset`, rather than returning tmux's whole table.

A not-found error says when its list of alternatives is partial, and which tool
lists the rest.

`new_session`, `new_window` and `split_pane` say when a pane did not start in
the directory asked for. tmux chdirs in the forked child and falls back
silently. `split_pane` defaults to the directory of the pane being split.

Recovery guidance names `LIBTMUX_TMUX_BIN` when one was set. A missing
executable and an unreachable socket both arrive as "cannot reach tmux", and
only the socket was named; a version probe returning nothing carried no guidance
at all.

#### Tools added

`move_pane` joins a pane into another window, or breaks it out into one of its
own when no destination is named. `swap_window` exchanges two windows.

`resize_window` sets a window's size, and `new_session` takes `width` and
`height`. `resize_pane` only redistributes space inside a window.

`pipe_pane` sends a pane's output to a shell command, and `save_buffer` writes a
buffer to a file.

`unset_option` is listed under Options above.

## 0.1.0-alpha.4

No entries for `@libtmux/mcp`.

## 0.1.0-alpha.3

### Fixed

**`@libtmux/mcp` served nothing when installed.** `npm i -g` and `npx` both
install a `bin` as a symlink, and the guard deciding whether the file is the
program compared `process.argv[1]` against `import.meta.url` raw — through a
link those are the link and its target, never equal. The process exited with
status 0 having served no tools, which is what both documented installation
methods did in `0.1.0-alpha.2`. Running the built server through a symlink is
now a gate.

**`LIBTMUX_SAFETY` widened on a typo.** An unrecognised value fell back to the
default, and the default is `mutating` — so `read-only`, `read_only` or `ro`
produced a server offering `send_keys` and every creating tool on a socket
meant to be read-only, silently. It now narrows to `readonly` on a value it
cannot read, and says on stderr which tier it chose and why.

### Added

**`wait_for_text` reports `alreadyOnScreen`.** A wait that misses now says when
the pattern is on the pane already, because it printed before the wait began. A
wait still refuses to match what was there first — stale text satisfying a wait
is the bug that avoids — but "it printed before you asked" and "it never
printed" are different answers, and only one is worth waiting again for.

## 0.1.0-alpha.2

### Added

`@libtmux/mcp` takes `LIBTMUX_MCP_TOOLS`, a comma-separated allowlist for when a
safety tier is the wrong shape: read and type but never kill is not a degree of
typing. A tool left off is never registered, so an agent cannot spend a turn
discovering it. It also says what to do about a tmux server it cannot reach,
naming the variable that configured the socket — an agent given only "cannot
reach tmux" reports "unavailable" and stops.

## 0.1.0-alpha.1

No entries for `@libtmux/mcp`.

## 0.0.1-alpha.7

No entries for `@libtmux/mcp`.

## 0.0.1-alpha.6

No entries for `@libtmux/mcp`.

## 0.0.1-alpha.5

No entries for `@libtmux/mcp`.
