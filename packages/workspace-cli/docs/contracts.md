# Workspace CLI contracts

The [README](../README.md) shows the commands. This page holds the rules behind
them, one heading per topic, and each heading is linked from the task that needs
it.

## Layout validation

All native input [layouts][wsconfig-layouts] are checked before scripts run or
sessions change. Names accept unique abbreviations supported by the running
daemon. Only version-sensitive names query it; a cold endpoint uses the selected
client.

Saved layouts require a valid checksum, a nonempty tree and enough pane cells.
tmux still owns geometry correction and pruning, and may reject a layout when it
is applied.

The CLI limits custom layouts to 8192 characters and 256 nested groups; these
are application limits, separate from tmux's parser.

## Differences from tmuxp

One default differs from tmuxp on purpose: a window that names no `layout` tiles
its panes, where tmuxp stacks them by halving the last one.

Explicit `layout` and `focus` agree with tmuxp, and so does the pane left active
when nothing sets `focus`: the last pane created in the focused window.

## Relation to @libtmux/workspace

[`@libtmux/workspace`](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace)
is a separate implementation that this command does not use: it converges a
session that already exists.

Its strict schema rejects `environment`, `before_script`, `window_index`,
`suppress_history`, `x-` keys and the other fields in the
[accepted-fields table](../README.md#write-a-workspace-file).

A document written here is not necessarily one that package accepts.

## Choosing the server

`-S` and `-L` name the socket, `-S` first. With neither, `LIBTMUX_SOCKET_PATH`
names it, else `LIBTMUX_SOCKET`; a variable that is empty or only whitespace
counts as unset. With none of the four, the command passes tmux no socket, and
tmux picks the server: the one `TMUX` names inside tmux, otherwise its default
socket.

`TMUX` is read as the current pane's server only where a command acts on that
pane: an attached `load` inside tmux, `load --append`, and `freeze` without a
session name. Each refuses a selected server that is not the one `TMUX` names.

tmuxp reads neither variable, so `shell` and Python extension loads hand it a
socket a variable chose. When none is chosen they leave the choice to tmuxp,
which follows `TMUX` as tmux does.

## Reusing, comparing and attaching

[`load`][cli-load] reuses an existing session, and compares it against the
document rather than rebuilding it: a window the document names that the session
does not hold is reported, exit 1, and nothing is changed.

Without `-d`, load attaches the final workspace or switches the current tmux
client. Attachment uses the controlling terminal, including when standard
streams are redirected; no terminal means failure before creating sessions.

Inside tmux, attached load stays on the current server; use `-d` to load on
another server. Explicit append adds windows to the current pane's session.

A load that cannot finish a session it created removes it, so a rerun starts
clean; an append keeps the windows it added and names them.

## Clients sharing a session

When clients share a session, tmux selects its most recently active client
before loading. The CLI captures that client and targets the switch explicitly.

## Concurrent loads

Two `load`s racing on the same session name are not coordinated: tmux offers no
lock on a session that does not exist yet, so the loser's create can fail after
the winner's session exists, or both can observe no session and each start one.

Run concurrent loads against distinct session names.

## Terminal color flags

`load -2` forces 256-color terminal handling. Legacy `-8` is rejected before
calling tmux because supported tmux versions do not implement that legacy flag.

## Pane readiness

Pane readiness waits apply before sending commands, whatever the pane's shell
is. Empty panes skip the wait, including with
`workspace_builder_options.pane_readiness: always`.

## Window index reservation

Explicit `window_index` values reserve their slots before implicit windows are
allocated from the effective `base-index`; `null` leaves the index unspecified.
Append also reserves indexes from later input files.

Removing the temporary bootstrap window preserves requested indexes and restores
the prior local or inherited `renumber-windows` setting. A failed restoration
appears as `renumber_restore_error` in the load result.

## Unsupported fields

Native `load` rejects unsupported fields before any input runs scripts or
changes tmux. The diagnostic includes the field path. For example,
`entter: false` in a command is an error; use `enter: false` to leave that
command unsubmitted.

A key starting with `x-`, at any scope, is the exception: it is accepted,
ignored at load, and left alone by `convert`. The refusal for any other unknown
key names that prefix as the way to keep it.

## Accepted fields

The README's [accepted-fields table](../README.md#write-a-workspace-file) lists
the fields, one row per scope.

`description` is neutral metadata at workspace, window, and pane scope. Option
and environment maps retain their native names. Conversion preserves arbitrary
fields without applying the native execution contract.

Documents delegated to Python plugins or custom builders retain their extension
fields; empty plugin lists and blank builder names still use native validation.

## Import validation

[`import tmuxinator`][cli-import-tmuxinator] and
[`import teamocil`][cli-import-teamocil] translate source documents and validate
native configuration fields before previewing or saving.

Unknown fields, conflicting non-null aliases and malformed command shapes fail
without replacing a destination. Generic `convert` preserves arbitrary fields.

## Tmuxinator conversion

Tmuxinator window command arrays stay in one pane (see
[`import tmuxinator`][cli-import-tmuxinator]). Explicit `panes` lists create
separate panes.

Project `pre_window` arrays form one `; `-joined command; window `pre` arrays
form one `&&`-joined command before each explicit pane. Window `pre` requires
nonempty explicit panes.

`synchronize: true` and `before` apply before sequential pane creation and
command delivery; `after` applies afterward.

## Teamocil conversion

Teamocil `commands` arrays form one `; `-joined command (see
[`import teamocil`][cli-import-teamocil]). Legacy `cmd` and `splits` are
accepted. Window options apply before pane commands.

The first requested window and pane focus wins; absent focus selects the first
item. Both formats retain window order, pane order and layouts.

## Import paths and tmux

Imports save an absolute project root relative to the invocation directory,
including when the source omits it. Window roots resolve relative to that root,
so moving the saved file preserves working directories.

Import requires neither tmux nor Python and does not check directory existence.
Layout compatibility is checked against the selected tmux during load.

Commands use native load's environment expansion from the invoking process
before shell delivery.

## Refused source features

Project lifecycle hooks, endpoint/runtime overrides, named pane titles, Teamocil
`clear`, filters and pane widths are refused. Use an explicit native workspace
or the source tool for those behaviors.

## ERB templates

Tmuxinator expands ERB through Ruby before parsing; unexpanded `<%` markup in a
Tmuxinator key or value fails before output or overwrite. Teamocil evaluates no
templates, so `<%` in a Teamocil source is ordinary text and is preserved.

## Output modes and saving

Every command accepts [`--json`][wsref-output] and `--ndjson` before or after
the command name. NDJSON takes precedence when both are present. Machine load
requires `-d` or `--append`. Machine commands never prompt.

Human output honors `--color` and `NO_COLOR`; machine output contains encoded
data without terminal styling.

`convert`, import commands, and machine `freeze` return a document when no
destination is given. `--save-to` writes a file; `--force` permits replacement.
The file format is separate from the JSON/NDJSON output mode.

`freeze` infers JSON from a `.json` destination and otherwise saves YAML; `-f`
overrides the inferred format. `--quiet` suppresses its human save message and
preserves machine results.

Capture accepts an exact session name or ID. Without one, it uses the
authenticated current pane's session or the sole session on the selected server.
Several sessions outside tmux require an explicit target.

Capture reads honor cancellation. Saves check for cancellation before
publishing; publication already in progress may still complete.

## Progress display

Human `load` shows progress on terminal stderr. `--progress-format` accepts
`default`, `minimal`, `window`, `pane`, `verbose`, or a template with tokens
such as `{session}`, `{window}`, and `{session_pane_progress}`.

Pane counts advance after configured commands are sent; they do not wait for
those commands to exit.

`--progress-lines` controls the recent script-output panel: default 3, 0
forwards each stream directly, and -1 uses the available terminal height.
Retention is bounded to 64 KiB of characters for completed lines and each
partial stream.

`TMUXP_PROGRESS_FORMAT` and `TMUXP_PROGRESS_LINES` set defaults; explicit flags
take precedence. `--no-progress`, `TMUXP_PROGRESS=0`, a dumb terminal, or
redirected stderr disables the display.

Frames update from build events without timing sleeps, clip to terminal width,
and clear before results or attachment.

## Logging and cancellation

`--log-level` filters diagnostics on stderr: `debug`, `info`, `warning`
(default), `error`, or `critical`. Machine diagnostics are NDJSON.

`load --log-file` appends the selected diagnostics as NDJSON, including script
output at `info` level.

New log files use owner-only permissions. Nonregular destinations are rejected
before session creation; existing log contents are preserved.

If logging fails during execution, stderr reports `log_error` and the command
keeps its result and exit status. Cancellation closes the owned log handle.

Interrupting a blocked output write still joins owned children and exits 130.

An interrupted load allows up to 100ms to emit its final machine result before
exiting; an unread pipe cannot hold the process open. Cancelled output may be
incomplete.

## Child process output

Bootstrap and editor commands use quoted argv directly. Child output is UTF-8
with replacement for invalid bytes.

Captured results retain at most 64 KiB of source bytes per stream and report
truncation; NDJSON forwards output as it arrives. A nonzero editor status
becomes the CLI exit status.

After a captured child exits, its streams have 100ms to drain before owned
descendants are stopped. Remaining capture streams close after group cleanup.

## Search patterns

[`search`][cli-search] uses native JavaScript regular expressions. `-F` treats
patterns as literal text; `-w` applies whole-word matching to the complete
expression. Python-specific regex syntax is outside the native search contract.

## Python shell

[`shell`][cli-shell] uses an interpreter with tmuxp 1.74.0 installed. Set
`TMUX_WORKSPACE_PYTHON` to choose its executable; otherwise it uses `python3`.

Code passed with `-c` runs in tmuxp's Python context. An interactive shell needs
a controlling terminal.

## Python plugins and custom builders

`load` uses the same optional interpreter when a workspace selects Python
`plugins` or a `workspace_builder`. Ordinary workspaces, empty plugin lists, and
blank builder names use the native builder without starting Python.

`workspace_builder_paths` adds existing import directories relative to the
workspace file. These directories contain executable extension code.

The adapter expands common configuration fields and supplies the tmuxp builder
protocol. Explicit custom builders may omit `windows` and consume their own
configuration.

Append retains the authenticated current session across input files. Python
extension append rejects `before_script`; run that script separately. Native
append retains its bootstrap support.

## Extension results and cancellation

Extension output uses the bounded child streams described under
[Child process output](#child-process-output). Human progress shows a workspace
label and script output without native pane counters.

Extension results report `effects_scope: "observed"`, `effects_unknown: true`,
and newly observed window and pane IDs.

These observations include concurrent changes and do not establish ownership;
failures do not roll back opaque extension effects.

Cancellation joins the owned Python process group, then allows up to one second
to observe surviving topology. A changed daemon or failed observation is
reported without comparing IDs across daemon lifetimes.

[cli-import-teamocil]: https://libtmux.org/en/ts/latest/workspace/cli/import-teamocil/
[cli-import-tmuxinator]: https://libtmux.org/en/ts/latest/workspace/cli/import-tmuxinator/
[cli-load]: https://libtmux.org/en/ts/latest/workspace/cli/load/
[cli-search]: https://libtmux.org/en/ts/latest/workspace/cli/search/
[cli-shell]: https://libtmux.org/en/ts/latest/workspace/cli/shell/
[wsconfig-layouts]: https://libtmux.org/en/ts/latest/workspace/configuration/layouts/
[wsref-output]: https://libtmux.org/en/ts/latest/workspace/reference/output/
