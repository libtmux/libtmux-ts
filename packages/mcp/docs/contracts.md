# @libtmux/mcp contracts

The rules that [the package README](../README.md) states in a line each, at full
length. Nothing here is needed to start the server; it is the reference for
anyone who needs the exact behavior.

## Socket and environment variables

An MCP client supplies an environment and a command line, and nothing else, so
the environment is the only place a socket can come from.

The library itself never reads these — a library that picks up ambient
configuration surprises its caller — so the reading happens here, at the edge
that has a process.

The executable and socket selector are validated and frozen before any tmux
connection. ASCII control characters and DEL are refused there; apostrophes and
non-ASCII characters pass through unchanged.

Snapshots, live tails, and framed commands all use that selected server route.

`LIBTMUX_SOCKET_NAME` is retired. Replace it with `LIBTMUX_SOCKET`; its presence
stops startup instead of selecting a socket.

Give the agent its own socket name. Sharing the one you are attached to means an
agent's cleanup can reap the session you are working in.

## Provenance and default toolsets

With no socket or config variables, the executable selects `libtmux-mcp` and
starts that daemon with the shipped minimal configuration. The launch records a
unique marker inside tmux, then reads it back before it exposes tools.

Only the process that actually created the daemon can claim minimal provenance;
a second process racing for the same socket sees an existing server and defaults
without `teardown`.

An explicit socket is different. The MCP process never assumes how an existing
daemon was configured.

A new daemon on that socket follows tmux's normal config behavior unless you
explicitly name a file, and it is never reported as having the shipped minimal
provenance.

`LIBTMUX_TMUX_CONFIG` is passed to tmux as written and must be a nonempty
absolute path.

Tools belong to four unordered sets: `inspect`, `manage`, `execute`, and
`teardown`. A new dedicated socket with the shipped minimal configuration gets
all four by default.

An existing, explicitly selected, or otherwise unknown server defaults to
`inspect,manage,execute`.

## Toolset selection and the startup line

`LIBTMUX_TOOLSETS` chooses sets, `LIBTMUX_TOOLS` adds individual tools, and
`LIBTMUX_EXCLUDE_TOOLS` removes tools last. An explicitly empty value selects
none.

Unknown names, empty list entries, and the retired `LIBTMUX_SAFETY` variable
stop startup before tmux is contacted.

The retired `LIBTMUX_MCP_TOOLS` allowlist fails there too.

Exclusions always win, including inside
[`call_read_tools_batch`][tool-call_read_tools_batch]. A tool removed there is
neither listed, directly callable, nor available as a nested batch operation.

The selection is resolved once before the protocol starts and does not change
with later environment or tmux state.

This shapes the MCP interface; it is not an authorization or confidentiality
boundary. Every advertised tool runs with the tmux user's authority.

Use a dedicated socket and read the [security boundary](../../../SECURITY.md)
before serving an untrusted client.

The startup line on stderr names the selected socket, effective toolsets, named
inclusions, and exclusions. Stdout remains exclusively MCP JSON-RPC, so that
diagnostic cannot corrupt the protocol stream.

The verb says whether this process started that tmux (`serving new`) or attached
to one already running (`serving existing`).

That is both why the toolsets differ between the two and the only notice that an
agent is sharing a daemon with whoever else is on that socket.

## Waits, timeouts, and live connections

With live connections disabled, [`wait_for_text`][tool-wait_for_text] stays in
the selected surface but returns a `no_stream` tool error;
[`capture_since`][tool-capture_since] returns a bounded capture with
`streaming: false`.

Cancelling a request stops its wait. An over-large tool timeout is never an
error: it is clamped, and every result reports the `effectiveTimeoutMs` it
actually used. The command timeout is capped at JavaScript's timer range.

**A wait that fails is still an answer.** Every wait reports why it ended —
`matched`, `timed_out`, `pane_died`, `cancelled`, `output_lost`,
`stream_lost` — along with everything the pane printed, what it shows now, and
a cursor to carry on from. A wait that cannot start, because the server has no
live stream, is a tool error with a hint, not an outcome.

There is no result that leaves an agent with nothing but "no". Cancel the
request and the wait stops there and then, rather than holding its connection
for the rest of a deadline nobody is waiting on.

For `watch-until`, carry the returned cursor into the next capture after a
timeout. A `pane_died` outcome means retrying cannot produce more output; a
pane that exits mid-wait ends it that way on the stream and on the poll below
3.7 alike, and `stream_lost` means the stream ended while its pane lives.

## Tool route migration

These existing names are unchanged:

| Group   | Unchanged names                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read    | [`list_sessions`][tool-list_sessions], [`list_windows`][tool-list_windows], [`list_panes`][tool-list_panes], [`capture_pane`][tool-capture_pane], [`search_panes`][tool-search_panes], [`wait_for_text`][tool-wait_for_text], [`wait_for_exit`][tool-wait_for_exit], [`show_hooks`][tool-show_hooks], [`show_environment`][tool-show_environment]                                    |
| Input   | [`send_keys`][tool-send_keys], [`paste_text`][tool-paste_text], [`respawn_pane`][tool-respawn_pane]                                                                                                                                                                                                                                                                                  |
| Arrange | [`rename_session`][tool-rename_session], [`rename_window`][tool-rename_window], [`resize_pane`][tool-resize_pane], [`resize_window`][tool-resize_window], [`select_pane`][tool-select_pane], [`select_window`][tool-select_window], [`select_layout`][tool-select_layout], [`swap_pane`][tool-swap_pane], [`move_window`][tool-move_window], [`set_pane_title`][tool-set_pane_title] |
| End     | [`kill_pane`][tool-kill_pane], [`kill_window`][tool-kill_window], [`kill_session`][tool-kill_session]                                                                                                                                                                                                                                                                                |

Routes removed or renamed since the previous alpha migrate as follows:

| Previous route                                                                               | Current route or replacement                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_pane`                                                                                   | [`get_pane_info`][tool-get_pane_info]                                                                                                                                                |
| `whoami`                                                                                     | `list_panes` exposes caller and watched panes; inspect one with `get_pane_info`                                                                                                      |
| `server_info`                                                                                | [`get_server_info`][tool-get_server_info]                                                                                                                                            |
| `observe`                                                                                    | Use [`snapshot_pane`][tool-snapshot_pane] once, or seed [`capture_since`][tool-capture_since] without a cursor and reuse the cursor it returns                                       |
| `run_command`                                                                                | [`run_shell_command`][tool-run_shell_command]                                                                                                                                        |
| `build_workspace`                                                                            | Compose [`create_session`][tool-create_session], [`create_window`][tool-create_window], [`split_window`][tool-split_window], layout, title, and selection tools                      |
| `new_session`                                                                                | `create_session`                                                                                                                                                                     |
| `new_window`                                                                                 | `create_window`                                                                                                                                                                      |
| `split_pane`                                                                                 | `split_window`                                                                                                                                                                       |
| `show_options`                                                                               | [`show_option`][tool-show_option] with an explicit scope and option name                                                                                                             |
| `set_option`                                                                                 | Use [`set_mouse_enabled`][tool-set_mouse_enabled], [`set_history_limit`][tool-set_history_limit], or [`set_synchronize_panes`][tool-set_synchronize_panes] for the supported changes |
| `unset_option`                                                                               | No generic replacement; set the supported value explicitly outside MCP when inheritance is required                                                                                  |
| `display_message`                                                                            | No generic format evaluator; use [`get_tmux_variables`][tool-get_tmux_variables], `show_option`, or another typed inspector                                                          |
| `pipe_pane`                                                                                  | No durable host-command pipe; use `run_shell_command` for a bounded pane command                                                                                                     |
| `move_pane`                                                                                  | No direct replacement; `swap_pane` preserves pane identity in a window and `move_window` moves a whole window                                                                        |
| `swap_window`                                                                                | No direct replacement; use `move_window` when moving between sessions is sufficient                                                                                                  |
| `set_environment`                                                                            | No MCP environment writer; configure the dedicated daemon outside the MCP process                                                                                                    |
| `list_buffers`, `show_buffer`, `load_buffer`, `save_buffer`, `paste_buffer`, `delete_buffer` | No public buffer CRUD; use `paste_text` for literal input and capture tools for pane output                                                                                          |

## Pane protection

Pane rows identify the active pane, the MCP caller's pane when that identity can
be proven, and panes watched by attached clients.

That context matters before a write or teardown call: the server refuses its own
pane unless `force` confirms that exact caller, and always refuses panes watched
by an attached client.

[`clear_pane_scrollback`][tool-clear_pane_scrollback],
[`kill_pane`][tool-kill_pane], [`kill_window`][tool-kill_window], and
[`kill_session`][tool-kill_session] belong to the `teardown` toolset.

Those tools refuse to end the pane hosting the MCP process unless `force`
confirms that exact caller, and always refuse a pane an attached person is
watching. This protects direct teardown calls; it is not a sandbox.

A command typed into another pane still has the authority of the tmux user and
may perform an equivalent action.

## Reading panes and limits

**Reading twice costs less than reading once.**
[`capture_since`][tool-capture_since] hands back a cursor; pass it next time and
you are charged only for what arrived since.

Use [`search_panes`][tool-search_panes] to discover which pane contains a value
without capturing every pane. Once the pane is known,
[`capture_pane`][tool-capture_pane] reads its rendered screen; negative `start`
and `end` values reach into retained history.

[`snapshot_pane`][tool-snapshot_pane] returns bounded content plus mode, cursor
position, scroll position, and pane metadata in one MCP response. Its metadata
and content come from separate tmux requests, so do not treat them as an atomic
view.

For repeated observation, seed `capture_since` without a cursor and pass its
opaque cursor back on later calls.

A nonzero `missedBytes` means retained stream data was lost before the read; use
`capture_pane` to recover whatever remains in tmux's bounded history. The
capture tools read output without entering or changing a client mode.

A pane keeps `history-limit` lines and `capture_since` keeps a bounded buffer,
so output larger than either is gone before anything asks for it.

Search is one bounded operation even when it spans the whole socket: at most 200
panes, 20,000 captured lines, 256 KiB of matched input, and five seconds of
matching work.

The result states which aggregate limit stopped it, so a caller can narrow by
session, window, or pane instead of retrying the same broad scan.

[`call_read_tools_batch`][tool-call_read_tools_batch] accepts only its declared
16 read operations. Each row keeps its input index, success flag, error or
result, and row-truncation flag.

The outer result records `onError`, succeeded and failed counts, `stoppedAt`,
and whole-result truncation bytes.

The complete MCP result is capped at 1,000,000 bytes; an oversized row is
represented explicitly rather than silently omitted.

Inner operations receive no separate approval, so the batch capability metadata
is the union of every still-eligible nested tool.

A serialized request ID may use at most 512 KiB. A larger ID receives a bounded
invalid-request response before any tool runs.

## Input cohorts

[`paste_text`][tool-paste_text] loads the text and optional newline into one
uniquely named private buffer, then pastes directly to the named pane. Unlike
key input, that stays target-only when synchronized input is enabled.

It checks the target before buffer setup and checks it again immediately before
paste; cleanup is attempted on every path.

[`send_keys_batch`][tool-send_keys_batch] validates and bounds every child
operation before sending the first one, then takes a fresh snapshot for each
row.

When a source pane's effective `synchronize-panes` value is off, its configured
input cohort is only that source. When it is on, the cohort is the sorted,
deduplicated set of same-window panes whose own effective value is on.

Every member must be alive, input-enabled, and outside a human-owned mode.
Caller, attended-pane, and active input protections also apply to every member.

`force` can confirm only the exact MCP caller pane; it never overrides the other
checks.

Input results disclose that configured membership at the immediate preflight,
not observed recipients or a delivery receipt.

State can change after any snapshot; each `send_keys_batch` row takes its own
check so an earlier row cannot authorize a later one.

## [`run_program`][tool-run_program] program runs

`run_program` creates a detached session whose only pane starts with a
placeholder, then respawns that pane with an `sh` given `argv` as positional
parameters, which it does not parse, so `argv[0]` is always run as a program
name, `A=b` included, which `env` would read as an assignment. That `sh` runs
the program and lingers 50 ms after it, because tmux can remove a pane before
reading its last output, then exits with the status it saw, as `$?` reports it,
so a program a signal ended reads 128 plus the signal's number. The library's
[program runs contract](../../libtmux/docs/contracts.md#program-runs) has the
detail.

The session is an ordinary one named `libtmux-program-…`. `list_sessions` shows
it, and another client can type into it or kill it; a kill fails the call.

`fromPaneId` puts the program in a new background window of that pane's session
instead, or with `placement: "split"` in a split of that pane made without
moving focus. It starts in the pane's current directory with the session's tmux
environment, and only its own window or split is removed. It types nothing into
the pane, so the caller and attended-pane protections that guard pane input do
not apply.

`inheritShell` is the one route that types: it runs `env -0` into a file in a
fresh 0700 directory through `run_shell_command`'s framing, with every one of
its checks, then turns the dump into a file of `export NAME='value'` lines that
the program's own `sh` sources and deletes before it starts; the dump is
deleted once read. Values never pass through a tmux command or `argv`. A list
of names carries only those variables. Names a POSIX shell cannot export are
skipped, and so is `TMUX_PANE`, which names the shell's pane rather than the
program's. The typed command starts with a space, so a shell that ignores such
lines keeps it out of its history. A pane whose
shell runs on another host than this server, under `ssh` or in a container,
writes the dump where this server cannot read it, and the call refuses before
starting anything.

`input` goes to the program as its stdin from a private file the library
writes; it is never typed. `keep` leaves the dead pane for a person and hands
it to them: nothing removes it later. Neither is a default.

`startDirectory` is taken literally: the program's own `sh` enters it, so no `#`
is expanded, and one it cannot enter ends the run with exit status 126 before
the program starts. The tool has no environment parameter:
variables go in `argv` through `env`, where whatever inspects `argv` sees them,
`ps` and the pane's start command included, so a secret does not belong there.
It sets `PAGER` and `GIT_PAGER` to `cat` itself, because a pager waits for keys
nobody presses.

The respawn and a `wait-for -E pane-died` waiter go to tmux as one command list,
which tmux runs without handling any other event in between, so the exit cannot
be missed. The pane state is still read every second, because tmux fires no
event for a pane killed from outside.

The output is `capture-pane` of the program's own pane, scrollback included and
wrapped lines joined; stderr shares the terminal with stdout. Scrollback past
the session's history limit is dropped, and `outputComplete` reports it.

The pane is removed before the call returns, on every path, unless `keep` is
set. A program still running at the effective timeout gets SIGTERM and, two
seconds later, SIGKILL, sent to its process group on the tmux server's machine,
so one that ignores SIGHUP still ends; it is reported `timed_out`, and a retry
starts a new run. Should this server die mid-run, tmux finishes the job: the
run holds the library's default lease, which this server renews,
and once renewals stop, a tmux timer SIGKILLs the program and removes its pane.

It needs tmux 3.8 or newer: earlier releases have no `wait-for -E`, and
through 3.7c a remain-on-exit pane keeps its pipe open after the program exits.

## [`start_program`][tool-start_program], [`read_program`][tool-read_program] and [`stop_program`][tool-stop_program]

`start_program` starts `argv` the way `run_program` does, through the library's
`Server.spawn` with a stream copy, and returns at once. This server copies the
output into memory as it is written, through the same escape-sequence filter as
`capture_since`, and `read_program` hands out bytes after a cursor. A read waits
for new output or the end, up to the wait ceiling, so a program of any length
is read whole over several calls.

`ended` is true only once the program has ended and every byte it wrote has been
returned. tmux holds a dying pane until its pipe has drained, so what tmux read
reaches the copy. An end tmux never read, which the library's end mark detects,
sets `lostEnd`; the copy reaching its limit, while the program runs on, sets
`outputCut`; either makes `outputComplete` false, as does a stop or the lifetime
ending the program before its output was read to the end. `outcome` is decided
by how the program ended before its status is read: `expired` for one its
lifetime ended and `stopped` for one `stop_program` ended, whose SIGTERM can
also leave a status.

No later call owns cleanup:

- Each program has a lifetime, `lifetimeMs` on `start_program`, capped by the
  server and reported as `effectiveLifetimeMs`. When it runs out this server
  ends the program, SIGTERM and then SIGKILL, and removes its pane, regardless
  of other calls.
- The program holds a lease that this server renews. Should this server die,
  tmux ends the program and removes its pane once the lease runs out.
- Closing this server refuses new starts, waits for those in flight, and ends
  every program it started.
- The number running at once is capped. A program that exits, or that its
  lifetime ends, loses its pane at once; its text stays readable from this
  server's memory until `stop_program`, or until enough programs end after it.
- The end, the lifetime and the lease signal the program's process group. A
  process that leaves it, through `setsid` or by daemonizing, is not followed,
  as in the library.

`stop_program` ends one at once and forgets its id. The `paneId`
`start_program` returns is an ordinary pane, so `send_keys` reaches the program
with the usual pane-input checks.

## [`wait_for_exit`][tool-wait_for_exit]

`wait_for_exit` waits on a pane this server did not start through the library's
`Pane.waitForExit`: it registers tmux `wait-for -E` waiters for `pane-exited`
and `pane-died`, the two exclusive exit events, before it reads the pane, so an
exit is never missed and a pane already dead answers at once. A pane that
closes takes its status with it, and the event's payload carries that status.
`kill-pane` fires no event; the pane is read every second and a removed one
answers `gone`. It needs tmux 3.8 or newer.

### How each tool reports an end

| Tool            | `outcome`                                            | `exitStatus`                                            | `signal`                                         |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `run_program`   | `completed`, `timed_out`                             | As `$?` reports it, 128 plus a signal's number too      | Set when the signal ended the program's `sh` too |
| `read_program`  | `running`, `completed`, `expired`, `stopped`, `gone` | As in `run_program`, once `completed`                   | As in `run_program`                              |
| `wait_for_exit` | `completed`, `timed_out`, `gone`, `cancelled`        | tmux's reading of the pane's process, null for a signal | The signal that ended the pane's process         |

A cancelled `run_program` or `read_program` request ends with the request;
`wait_for_exit` answers `cancelled`. `run_program` and `read_program` wrap the
program in an `sh` of their own, which is why a signal shows there as `$?` does,
and `wait_for_exit` reads a process no wrapper stands in front of.

## [`run_shell_command`][tool-run_shell_command] framing and checks

**A command's output is never its echo.** A pane repeats what is typed into it,
so waiting for text that appears in the command matches immediately and reports
your own command back to you.

`run_shell_command` frames what it sends so the marker it waits for cannot
appear in what it typed or in the command's inherited shell state, and reports
the real exit status.

`run_shell_command` additionally requires a singular configured cohort and a
supported POSIX foreground shell.

It checks once before reservation and live tail setup, then takes one fresh
check after setup immediately before the first and only wrapper dispatch.

A change in pane identity, daemon, placement, liveness, input state, mode,
shell, or cohort refuses the command without sending the wrapper. The final
check also reapplies caller, attended-pane, and competing-input policy.

These are exactly two observational checks and one dispatch. They are not
atomic, so another process can still race the final check.

The frame uses the shell's `command printf` primitive so an inherited `printf`
alias or function cannot forge its bookkeeping.

The caller's command still sees inherited shell options and traps, and its
subshell keeps command-defined functions, traps, directory changes, and exports
out of the parent.

It is a correctness protocol for a trusted interactive shell and gives no
protection against a hostile one. It trusts the selected tmux executable, the daemon and
its loaded configuration, and the supported foreground shell.

For `run-and-check`, a `timed_out` outcome means the command may still be
running. Continue observing it; do not run the command again.

## Echo and waiting

[`wait_for_text`][tool-wait_for_text] discounts your own typing while it is
unsubmitted or was submitted within the last ten seconds, but a command that
runs longer than that, or the same value typed and waited for again later, can
still surface its own echo.

[`run_shell_command`][tool-run_shell_command] is immune by construction;
`wait_for_text` is for output somebody else wrote.

A compiler can print an error and a shell can still leave old success text on
screen. Use `run_shell_command` when the MCP call owns the command; its framed
completion reports the exit status.

Use `wait_for_text` only when some other process owns the work and the text
itself is the condition.

## Copy mode and client modes

Copy mode and other client modes are human-owned, modal state. A nonzero
`inMode` in a [`snapshot_pane`][tool-snapshot_pane] result reports that state;
input may be interpreted by the active tmux key table instead of reaching the
pane's program.

Report the mode and wait for its owner to leave it. The MCP server neither
enters nor cancels client modes.

The MCP surface does not drive attachment-bound client UX such as copy mode,
clock mode, choose-tree, command prompts, menus, popups, or mouse gestures.

Those interactions depend on a person's key table, client, clipboard, and
timing. Read their visible result with [`capture_pane`][tool-capture_pane],
inspect mode through `snapshot_pane`, and leave entry and cleanup to the
attached client.

## Layout, identity, and detached sizes

[`select_layout`][tool-select_layout] accepts tmux's named layouts, unique
abbreviations for the running daemon, and checksummed saved layouts. JSON
layouts need tmux 3.8.

The native core validates the input before dispatch; tmux owns geometry and may
resize or prune saved cells. The result's `window.layout` comes from a fresh
snapshot. Check `metadataComplete` before reusing it as input.

[`move_window`][tool-move_window] moves a complete window between sessions
without restarting its panes; pane and window identities remain stable.
[`swap_pane`][tool-swap_pane] exchanges pane positions without changing the
programs running inside them.

Use those when identity continuity matters instead of killing and recreating
topology.

A detached session has no client to size it, so tmux gives it 80 columns and
every program in it formats to that.

[`create_session`][tool-create_session] takes `width` and `height`, and
[`resize_window`][tool-resize_window] changes one afterwards —
[`resize_pane`][tool-resize_pane] only redistributes space inside a window.

A program that formats to its terminal width truncates at the source, where no
capture option recovers the columns.

## Settings and environment tools

[`get_tmux_variables`][tool-get_tmux_variables],
[`show_option`][tool-show_option], [`show_environment`][tool-show_environment],
and [`show_hooks`][tool-show_hooks] inspect configuration.

[`set_mouse_enabled`][tool-set_mouse_enabled],
[`set_history_limit`][tool-set_history_limit], and
[`set_synchronize_panes`][tool-set_synchronize_panes] expose the bounded changes
MCP clients need without a generic option or environment writer.

Options may contain tmux formats and commands. The read tools disclose those
configured-command outputs rather than executing caller-supplied host commands.

Options live at server, session, global-session, window, global-window, and pane
scope. `show_option` requires the scope explicitly so a value inherited from a
global table is not mistaken for one set on the target.

`get_tmux_variables` accepts validated variable names and resolves only those
names; arbitrary tmux formats are not accepted as an executable-shaped escape
hatch.

Environment rows can contain credentials and hook or option rows can contain
configured shell commands.

Their capability metadata declares `process-environment` or `configured-command`
output so an MCP host can route the returned content appropriately.

## Resource and prompt migration

The server exposes one static resource:
[`tmux://capabilities`][res-capabilities]. It reports the effective
startup-frozen tool surface, each tool's capability row, the selected socket and
its provenance, and the trust boundary.

It does not expose live tmux topology or pane content as resources.

The report includes `schemaVersion`, `frozen`, the selected toolsets and exact
effective tool names, and a socket record with selector, selection provenance,
server state, configuration provenance, and namespace boundary.

Its boundary record states that socket selection is process-wide, resources are
static, and host-command execution is absent: this server starts no process
itself. `run_shell_command` and `run_program` still run arbitrary programs in
tmux panes, with the tmux user's authority.

A client can read this once to explain the surface it received without probing
tmux or reconstructing launch arguments.

Former dynamic resource workflows have typed replacements:

| Previous resource                                                                   | Current workflow                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmux://sessions`, `tmux://windows`, `tmux://panes`                                 | [`list_sessions`][tool-list_sessions], [`list_windows`][tool-list_windows], and [`list_panes`][tool-list_panes]                                             |
| `tmux://clients`                                                                    | `list_panes` reports caller and watched-pane identity                                                                                                       |
| `tmux://sessions/{sessionId}`, `tmux://windows/{windowId}`, `tmux://panes/{paneId}` | The corresponding [`get_session_info`][tool-get_session_info], [`get_window_info`][tool-get_window_info], or [`get_pane_info`][tool-get_pane_info] tool     |
| `tmux://panes/{paneId}/content` and subscriptions                                   | [`capture_pane`][tool-capture_pane], [`snapshot_pane`][tool-snapshot_pane], [`capture_since`][tool-capture_since], or [`wait_for_text`][tool-wait_for_text] |

Resource-template `completion/complete` support has no direct replacement.
Discover ids with the list tools, then pass the exact id through the typed tool
schema.

The retired prompts remain available as explicit tool workflows:

| Previous prompt   | Current workflow                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-and-check`   | [`run_shell_command`][tool-run_shell_command]                                                                                                                                                                                                                                     |
| `watch-until`     | Seed `capture_since` without a cursor, then reuse its cursor with `capture_since` or `wait_for_text`                                                                                                                                                                              |
| `diagnose-pane`   | `get_pane_info`, `capture_pane` or `snapshot_pane`, [`show_option`][tool-show_option], [`show_hooks`][tool-show_hooks], and [`show_environment`][tool-show_environment]                                                                                                           |
| `build-workspace` | [`create_session`][tool-create_session], [`create_window`][tool-create_window], [`split_window`][tool-split_window], [`select_layout`][tool-select_layout], [`set_pane_title`][tool-set_pane_title], [`select_window`][tool-select_window], and [`select_pane`][tool-select_pane] |

For `diagnose-pane`, inspect `currentCommand`, `dead`, bounded scrollback and
its cursor, the last command, and the last non-empty output.

Give a root-cause hypothesis and propose the single cheapest confirming command,
but do not execute it.

For `build-workspace`, report every pane ID returned while creating the
topology.

## Capability disclosure

Each advertised tool carries `_meta["com.git-pull.libtmux-mcp/capability"]`. The
row declares its process reach, effects, possible outputs, input literalization,
and whether it can amplify future pane input.

Every tool also uses the same conservative MCP annotations: non-read-only,
potentially destructive, non-idempotent, and open-world.

Process reach is one of `none`, `configured-process`, `pane-input`,
`pane-command`, or `pane-program`; no public tool has `host-command` reach.
`pane-program` runs a client-supplied program with the tmux user's full
authority, the same authority `run_shell_command` has; what differs is that it
takes argv, which no shell parses, and creates the pane it runs in.

Output classes distinguish tmux metadata, terminal content, process environment,
and configured commands.

The internal manifest classifies where every caller-controlled value goes and
tests those sink claims against each schema.

Public capability rows expose the resulting controls: fields that tmux would
otherwise interpret as formats declare the `double-hash-once` literalization
strategy.

Validated variable names are called out separately because they control a format
lookup without accepting a free-form format expression.

## Embedding the server

`environment` configures the MCP tool policy. Caller identity is read separately
from `process.env` when the factory is constructed; an embedded test can
override that complete input with `callerEnvironment`.

Embedded, the default is the conservative one — `inspect`, `manage`, `execute` —
because a host passing its own [`Server`][ref-server-server] is naming a daemon
this process did not create.

That is a smaller surface than the CLI on a socket it started itself, which also
gets `teardown`. To choose, pass `environment: { LIBTMUX_TOOLSETS: ... }` or a
whole [`policy`][mcpref-mcp-policy-policy]; there is no `toolsets` option.

Embedding freezes the same surface as the executable. Pass a complete policy
environment when constructing the server; changing the object later cannot add a
hidden tool or alter batch authority.

If the host wants the executable's automatic minimal-daemon provenance decision,
launch the executable rather than claiming that provenance for an arbitrary
embedded `Server`.

## What the surface leaves out

[`capture_since`][tool-capture_since] reports a pane's byte stream in the order
it was written.

A program that draws by moving the cursor — a progress bar, a full-screen TUI —
reads jumbled there, because resolving cursor addressing would mean emulating a
terminal.

[`capture_pane`][tool-capture_pane] reads tmux's rendered grid and is the answer
when that matters.

There are no dynamic topology resources, subscriptions, prompts, background
jobs, generic option or environment mutation, public buffer management, or
host-command tools: programs run only inside tmux panes, through
`run_shell_command` and `run_program`.

The typed surface covers the bounded tmux operations an agent needs without
creating a second scripting language beside tmux itself.

[mcpref-mcp-policy-policy]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy/
[ref-server-server]: https://libtmux.org/en/ts/latest/reference/server-server/
[res-capabilities]: https://libtmux.org/en/ts/latest/mcp/resources/capabilities/
[tool-call_read_tools_batch]: https://libtmux.org/en/ts/latest/mcp/tools/call_read_tools_batch/
[tool-capture_pane]: https://libtmux.org/en/ts/latest/mcp/tools/capture_pane/
[tool-capture_since]: https://libtmux.org/en/ts/latest/mcp/tools/capture_since/
[tool-clear_pane_scrollback]: https://libtmux.org/en/ts/latest/mcp/tools/clear_pane_scrollback/
[tool-create_session]: https://libtmux.org/en/ts/latest/mcp/tools/create_session/
[tool-create_window]: https://libtmux.org/en/ts/latest/mcp/tools/create_window/
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
[tool-snapshot_pane]: https://libtmux.org/en/ts/latest/mcp/tools/snapshot_pane/
[tool-split_window]: https://libtmux.org/en/ts/latest/mcp/tools/split_window/
[tool-swap_pane]: https://libtmux.org/en/ts/latest/mcp/tools/swap_pane/
[tool-read_program]: https://libtmux.org/en/ts/latest/mcp/tools/read_program/
[tool-start_program]: https://libtmux.org/en/ts/latest/mcp/tools/start_program/
[tool-stop_program]: https://libtmux.org/en/ts/latest/mcp/tools/stop_program/
[tool-wait_for_exit]: https://libtmux.org/en/ts/latest/mcp/tools/wait_for_exit/
[tool-wait_for_text]: https://libtmux.org/en/ts/latest/mcp/tools/wait_for_text/
