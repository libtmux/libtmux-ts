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

Pane readiness waits apply before sending commands. Empty panes skip the wait,
including with `workspace_builder_options.pane_readiness: always`.

## Output

Every command accepts `--json` and `--ndjson` before or after the command name.
NDJSON takes precedence when both are present. Machine load requires `-d` or
`--append`. Machine commands never prompt. Human output honors `--color` and
`NO_COLOR`; machine output contains encoded data without terminal styling.

`convert`, import commands, and machine `freeze` return a document when no
destination is given. `--save-to` writes a file; `--force` permits replacement.
The file format is separate from the JSON/NDJSON output mode.

`--log-level` filters diagnostics on stderr: `debug`, `info`, `warning` (default),
`error`, or `critical`. Machine diagnostics are NDJSON. `load --log-file` appends
the selected diagnostics as NDJSON, including script output at `info` level.
New log files use owner-only permissions. Nonregular destinations are rejected
before session creation; existing log contents are preserved.
If logging fails during execution, stderr reports `log_error` and the command
keeps its result and exit status. Cancellation closes the owned log handle.

Bootstrap and editor commands use quoted argv directly. Child output is UTF-8
with replacement for invalid bytes. Captured results retain at most 64 KiB of
source bytes per stream and report truncation; NDJSON forwards output as it
arrives. A nonzero editor status becomes the CLI exit status.

## Python compatibility

Search uses native JavaScript regular expressions. `-F` treats patterns as
literal text; `-w` applies whole-word matching to the complete expression.
Python-specific regex syntax is outside the native search contract.

`shell` uses an interpreter with tmuxp 1.74.0 installed. Set
`TMUX_WORKSPACE_PYTHON` to choose its executable; otherwise it uses `python3`.
Code passed with `-c` runs in tmuxp's Python context. An interactive shell needs
a controlling terminal.

## Development status

Native discovery, conversion, imports, common searches, detached load, append,
capture, editor invocation, diagnostics, and the Python shell have executable
tests. The Linux installed-package check packs the CLI and core, installs both
offline into an empty project, and exercises every command in JSON and NDJSON
on Node 22 and Bun. It needs the optional Python runtime described above:

```console
$ bun run --cwd packages/workspace-cli test:install
```

Plugin/custom-builder loading, interactive prompts, progress presets,
generated references/completions, and benchmarks remain unfinished.

The core library keeps its zero-runtime-dependency contract. Commander and YAML
are bundled into this CLI; `libtmux` remains a separate package.
