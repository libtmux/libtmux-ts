# Workspace CLI

Manage tmux workspaces from YAML and JSON with Node.js 22.12+ or Bun 1.3.14+.
This local implementation is in development.

## Build

Run from the repository root:

```console
$ bun run --cwd packages/libtmux build
```

```console
$ bun run --cwd packages/workspace-cli build
```

```console
$ node packages/workspace-cli/dist/main.js --help
```

## Load and capture

Save this document as `workspace.yaml`:

```yaml
session_name: dev
windows:
  - window_name: editor
    panes: [null, null]
```

Load on a separate tmux socket:

```console
$ node packages/workspace-cli/dist/main.js load ./workspace.yaml \
    -L workspace-cli-demo \
    -d \
    --json
```

Capture its live topology:

```console
$ node packages/workspace-cli/dist/main.js freeze dev \
    -L workspace-cli-demo \
    --json
```

All native input layouts are checked before scripts run or sessions change.
Names accept unique abbreviations supported by the running daemon. Only
version-sensitive names query it; a cold endpoint uses the selected client.
Saved layouts require a valid checksum, a nonempty tree and enough pane cells.
tmux still owns geometry correction and pruning, and may reject a layout when
it is applied.
The CLI limits custom layouts to 8192 characters and 256 nested groups;
these are application limits, separate from tmux's parser.

Loading reuses an existing session. Without `-d`, it attaches the final workspace
or switches the current tmux client. Attachment uses the controlling terminal,
including when standard streams are redirected; no terminal means failure
before creating sessions. Inside tmux, attached load stays on the current server;
use `-d` to load on another server. Explicit append adds windows
to the current pane's session. Bootstrap failure removes a session created by
that load; it preserves a session borrowed for append. Other partial failures
report the created objects and the failed stage.

When clients share a session, tmux selects its most recently active client before
loading. The CLI captures that client and targets the switch explicitly.

`load -2` forces 256-color terminal handling. Legacy `-8` is rejected before
calling tmux because supported tmux versions do not implement that legacy flag.

Pane readiness waits apply before sending commands. Empty panes skip the wait,
including with `workspace_builder_options.pane_readiness: always`.

Explicit `window_index` values reserve their slots before implicit windows are
allocated from the effective `base-index`; `null` leaves the index unspecified.
Append also reserves indexes from later input files. Removing the temporary bootstrap window preserves requested
indexes and restores the prior local or inherited `renumber-windows` setting.
A failed restoration appears as `renumber_restore_error` in the load result.

## Output

Every command accepts `--json` and `--ndjson` before or after the command name.
NDJSON takes precedence when both are present. Machine load requires `-d` or
`--append`. Machine commands never prompt. Human output honors `--color` and
`NO_COLOR`; machine output contains encoded data without terminal styling.

`convert`, import commands, and machine `freeze` return a document when no
destination is given. `--save-to` writes a file; `--force` permits replacement.
The file format is separate from the JSON/NDJSON output mode.
`freeze` infers JSON from a `.json` destination and otherwise saves YAML;
`-f` overrides the inferred format. `--quiet` suppresses its human save message
and preserves machine results.
Capture accepts an exact session name or ID. Without one, it uses the authenticated
current pane's session or the sole session on the selected server. Several sessions
outside tmux require an explicit target.
Capture reads honor cancellation. Saves check for cancellation before publishing;
publication already in progress may still complete.

Human `load` shows progress on terminal stderr. `--progress-format` accepts
`default`, `minimal`, `window`, `pane`, `verbose`, or a template with tokens such
as `{session}`, `{window}`, and `{session_pane_progress}`. Pane counts advance
after configured commands are sent; they do not wait for those commands to exit.
`--progress-lines` controls the recent script-output panel: default 3, 0 forwards
each stream directly, and -1 uses the available terminal height. Retention is
bounded to 64 KiB of characters for completed lines and each partial stream.
`TMUXP_PROGRESS_FORMAT` and `TMUXP_PROGRESS_LINES` set defaults; explicit flags
take precedence. `--no-progress`, `TMUXP_PROGRESS=0`, a dumb terminal, or redirected
stderr disables the display. Frames update from build events without timing
sleeps, clip to terminal width, and clear before results or attachment.

`--log-level` filters diagnostics on stderr: `debug`, `info`, `warning` (default),
`error`, or `critical`. Machine diagnostics are NDJSON. `load --log-file` appends
the selected diagnostics as NDJSON, including script output at `info` level.
New log files use owner-only permissions. Nonregular destinations are rejected
before session creation; existing log contents are preserved.
If logging fails during execution, stderr reports `log_error` and the command
keeps its result and exit status. Cancellation closes the owned log handle.
Interrupting a blocked output write still joins owned children and exits 130.
An interrupted load allows up to 100ms to emit its final machine result before
exiting; an unread pipe cannot hold the process open. Cancelled output may be
incomplete.

Bootstrap and editor commands use quoted argv directly. Child output is UTF-8
with replacement for invalid bytes. Captured results retain at most 64 KiB of
source bytes per stream and report truncation; NDJSON forwards output as it
arrives. A nonzero editor status becomes the CLI exit status.
After a captured child exits, its streams have 100ms to drain before owned
descendants are stopped. Remaining capture streams close after group cleanup.

## Python compatibility

Search uses native JavaScript regular expressions. `-F` treats patterns as
literal text; `-w` applies whole-word matching to the complete expression.
Python-specific regex syntax is outside the native search contract.

`shell` uses an interpreter with tmuxp 1.74.0 installed. Set
`TMUX_WORKSPACE_PYTHON` to choose its executable; otherwise it uses `python3`.
Code passed with `-c` runs in tmuxp's Python context. An interactive shell needs
a controlling terminal.

`load` uses the same optional interpreter when a workspace selects Python
`plugins` or a `workspace_builder`. Ordinary workspaces, empty plugin lists,
and blank builder names use the native builder without starting Python.
`workspace_builder_paths` adds existing import directories relative to the
workspace file. These directories contain executable extension code.

The adapter expands common configuration fields and supplies the tmuxp builder
protocol. Explicit custom builders may omit `windows` and consume their own
configuration. Append retains the authenticated current session across input
files. Python extension append rejects `before_script`; run that script
separately. Native append retains its bootstrap support.

Extension output uses the bounded child streams described above. Human progress
shows a workspace label and script output without native pane counters.
Extension results report `effects_scope: "observed"`, `effects_unknown: true`,
and newly observed window and pane IDs. These observations include concurrent
changes and do not establish ownership; failures do not roll back opaque
extension effects. Cancellation joins the owned Python process group, then
allows up to one second to observe surviving topology. A changed daemon or
failed observation is reported without comparing IDs across daemon lifetimes.

## Reference and completion

The [command reference](docs/command-reference.md) and
[command metadata](docs/commands.json) come from the native parser. Regenerate
them after changing command definitions:

```console
$ bun run --cwd packages/workspace-cli docs:generate
```

The build checks that the reference and packaged completion scripts are current.
The scripts complete commands, options, enum values, and file paths without
starting Node, Bun, or tmux. Saved workspace names and live sessions are outside
their completion scope.

Completion is tested on Linux with Bash 5.2, Zsh 5.9, and fish 4.8. Bash 3.2 is
a syntax target; older shells and filenames containing newlines remain unverified.

After installing the local package, load the script for your shell. Bash:

```console
$ source <(tmux-workspace completion bash)
```

Zsh, with its completion system initialized:

```console
$ autoload -Uz compinit && compinit && source <(tmux-workspace completion zsh)
```

fish:

```console
$ tmux-workspace completion fish | source
```

For automation, `--json` and `--ndjson` wrap the script in a structured result.

## Development status

Native discovery, conversion, imports, common searches, detached load, append,
capture, editor invocation, diagnostics, and the Python shell have executable
tests. The Linux installed-package check packs the CLI and core, installs both
offline into an empty project, and exercises every command in JSON and NDJSON
on Node 22 and Bun. It needs the optional Python runtime described above:

```console
$ bun run --cwd packages/workspace-cli test:install
```

Plugin/custom-builder loading, interactive prompts, and broader configuration
and platform coverage remain unfinished. Benchmark results cover isolated Linux
fixtures; they do not establish cross-port or interactive performance.

The core library keeps its zero-runtime-dependency contract. Commander, YAML,
and terminal text helpers are bundled into this CLI; `libtmux` remains a separate
package. Machine commands skip loading the progress renderer.
