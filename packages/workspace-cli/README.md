<!-- libtmux-logo -->
<div align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/libtmux/libtmux-ts/HEAD/packages/workspace-cli/assets/logo.svg" type="image/svg+xml">
    <img src="https://raw.githubusercontent.com/libtmux/libtmux-ts/HEAD/packages/workspace-cli/assets/logo.png" width="128" height="128" alt="libtmux for TypeScript workspace">
  </picture>
</div>
<!-- /libtmux-logo -->

<div align="center">

# Workspace CLI

Manage tmux workspaces from YAML and JSON with Node.js 22.12+ or Bun 1.3.14+.
[`tmux-workspace`](https://libtmux.org/en/ts/latest/workspace/cli/) loads, captures, converts and imports tmuxp workspace files.
This implementation is in development.

[Command reference](https://libtmux.org/en/ts/latest/workspace/cli/) •
[Guides](https://libtmux.org/en/ts/latest/workspace/guides/) •
[npm](https://www.npmjs.com/package/@libtmux/workspace-cli)

</div>

Part of [libtmux for Bun and TypeScript](https://github.com/libtmux/libtmux-ts#readme).
Built on [`libtmux`](https://github.com/libtmux/libtmux-ts/tree/master/packages/libtmux).

The [`tmux-workspace`][cli-index] and `npx` commands on this page are run by
this repository's README tests (`packages/workspace-cli/tests/readme.test.ts`),
each against a tmux directory of its own.

## Quick start

Install the command globally, which puts [`tmux-workspace`][cli-index] on
`PATH`. [Install](#install) lists the other runners:

```console
$ npm install --global @libtmux/workspace-cli@0.1.0-alpha.15
```

Save this document as `workspace.yaml`:

```yaml
session_name: dev
windows:
  - window_name: editor
    layout: main-vertical
    panes:
      - vim
      - top
```

[`load`][cli-load] builds it detached, on a tmux socket of its own so the demo
stays off the server you already use ([why sockets][topic-socket-and-servers]):

```console
$ tmux-workspace load ./workspace.yaml \
    -L workspace-cli-demo \
    -d \
    --json
```

It creates the `dev` session and prints one [JSON result][wsref-output] that
names the session and the windows and panes it made.

Join the session with `tmux -L workspace-cli-demo attach`. Remove it and the
demo server with `tmux -L workspace-cli-demo kill-server`.

## Install

Run the command without installing it. With Node:

```console
$ npx -y @libtmux/workspace-cli@0.1.0-alpha.15 --help
```

With Bun. The command names `node` in its shebang, so `bunx` runs it on Node
when Node is installed; `--bun` runs it on Bun:

```console
$ bunx --bun @libtmux/workspace-cli@0.1.0-alpha.15 --help
```

With pnpm:

```console
$ pnpm dlx @libtmux/workspace-cli@0.1.0-alpha.15 --help
```

With Yarn. Yarn refuses a release younger than its `npmMinimalAgeGate`, one
day by default:

```console
$ yarn dlx @libtmux/workspace-cli@0.1.0-alpha.15 --help
```

Or install it globally, which puts [`tmux-workspace`][cli-index] on `PATH`.
With npm:

```console
$ npm install --global @libtmux/workspace-cli@0.1.0-alpha.15
```

With pnpm:

```console
$ pnpm add --global @libtmux/workspace-cli@0.1.0-alpha.15
```

With Bun:

```console
$ bun add --global @libtmux/workspace-cli@0.1.0-alpha.15
```

The rest of this page runs the installed `tmux-workspace`. A runner passes the
same arguments to the command when they follow the package name.

The [installation walkthrough][guide-installation] builds a source revision and
loads a session on a private socket.

## Commands

Each [`tmux-workspace`][cli-index] command has a page in the command reference.

- [`load`][cli-load] creates or reuses a session from a workspace file.
- [`freeze`][cli-freeze] captures a live session as a workspace document.
- [`convert`][cli-convert] converts a workspace between YAML and JSON.
- [`import`][cli-import] translates a tmuxinator or Teamocil workspace:
  [`import tmuxinator`][cli-import-tmuxinator],
  [`import teamocil`][cli-import-teamocil].
- [`ls`][cli-ls] lists project and saved workspace files.
- [`search`][cli-search] searches workspace names, sessions, windows and pane
  commands.
- [`edit`][cli-edit] opens a workspace in your editor.
- [`shell`][cli-shell] opens the Python tmuxp shell with the selected tmux
  context.
- [`debug-info`][cli-debug-info] shows runtime, configuration and tmux
  diagnostics.
- [`completion`][cli-completion] prints a shell completion script.

## Load and capture

[`load`][cli-load] builds sessions from workspace files; [`freeze`][cli-freeze]
writes a running session back to a file. Both take `-L` for a socket name or
`-S` for a socket path.

### [`tmux-workspace load`][cli-load]: build a session from a file

`load` creates the session a file describes, reuses one of the same name, or
appends windows to the current one. [`ls`][cli-ls] finds files by name and
[`import`][cli-import] translates other tools' files for it.

The Quick start loaded `dev`. Load the same file under another name with `-s`:

```console
$ tmux-workspace load ./workspace.yaml \
    -L workspace-cli-demo \
    -d \
    -s dev-copy \
    --json
```

The result names `dev-copy` and sets `reused` to false. Run the Quick start
command again and `load` reuses `dev` instead of building a second session.

Without `-d`, `load` attaches your terminal to the session. [Reuse, append and
attach](#reuse-append-and-attach) has the rules.

### [`tmux-workspace freeze`][cli-freeze]: capture a running session

`freeze` reads a live session and prints or saves it as a workspace document
that `load` accepts. Print the `dev` session as JSON:

```console
$ tmux-workspace freeze dev \
    -L workspace-cli-demo \
    --json
```

It prints the document: `session_name`, `windows` and `options`. Save it to a
file instead with `--save-to`:

```console
$ tmux-workspace freeze dev \
    -L workspace-cli-demo \
    --save-to ./frozen.yaml
```

It writes `frozen.yaml` and prints `Saved` with the path. A `.json` destination
saves JSON, and `-f` overrides the format.

Without a session name, `freeze` takes the current pane's session or the only
session on the server
([full contract](docs/contracts.md#output-modes-and-saving)).
[Export and reload][guide-export-session] walks through capture and replay.

## Reuse, append and attach

What [`load`][cli-load] does when the session already exists, and when it
attaches:

- **[Reuse](docs/contracts.md#reusing-comparing-and-attaching).** A session
  with the document's name is compared with it, not rebuilt. A missing window
  is reported with [exit 1][wsref-exit-codes] and nothing changes.
- **[Attach](docs/contracts.md#reusing-comparing-and-attaching).** Without
  `-d`, `load` attaches your terminal, or switches the current client inside
  tmux. No terminal fails before any session exists.
- **[Append](docs/contracts.md#reusing-comparing-and-attaching).** `--append`
  adds windows to the current pane's session. Use `-d` to load on another
  server.
- **[Failure](docs/contracts.md#reusing-comparing-and-attaching).** A load that
  cannot finish a session it created removes it. An append keeps the windows it
  added and names them.
- **[Races](docs/contracts.md#concurrent-loads).** Two loads of one session
  name are not coordinated. Run concurrent loads against distinct names.

## Layouts, window order and pane readiness

How [`load`][cli-load] treats a window's [`layout`][wsconfig-layouts], its
[`window_index`][wsconfig-windows] and the first command in a
[pane][wsconfig-panes].

- **[Layout checks](docs/contracts.md#layout-validation).** Layouts are checked
  before any script runs: valid checksum, nonempty tree, enough pane cells.
  Custom layouts stop at 8192 characters and 256 nested groups.
- **[Default layout](docs/contracts.md#differences-from-tmuxp).** A window with
  no `layout` tiles its panes. tmuxp halves the last pane instead.
- **[Pane readiness](docs/contracts.md#pane-readiness).** `load` waits for the
  pane before sending its commands, whatever the shell. Empty panes skip it.
- **[Window index](docs/contracts.md#window-index-reservation).** Explicit
  `window_index` values take their slots first. `null` leaves the index free.
- **[Colors](docs/contracts.md#terminal-color-flags).** `load -2` forces
  256-color handling. `-8` is rejected before tmux is called.

## Write a workspace file

A workspace arranges windows and panes for a task
([concepts][concept-workspaces]). The files use tmuxp's fields, one page each:

- [Session][wsconfig-session] sets the name, shared options and environment.
- [Windows][wsconfig-windows] sets indexes, layouts and option timing.
- [Panes][wsconfig-panes] defines commands, launch shells and focus.
- [Commands][wsconfig-commands] controls ordering, Enter and delays.
- [Environment][wsconfig-environment] separates loader settings from pane
  variables.
- [Directories][wsconfig-directories] explains discovery and working
  directories.
- [Layouts][wsconfig-layouts] arranges the panes.
- [Hooks][wsconfig-hooks] runs checked bootstrap scripts.

The [gallery][examples-gallery] has starter documents. [`load`][cli-load]
accepts these fields:

| Scope                       | Accepted fields                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace                   | `session_name`, `windows`, `start_directory`, `environment`, `shell_command_before`, `suppress_history`, `options`, `global_options`, `before_script`, `workspace_builder_options`, `plugins`, `workspace_builder`, `workspace_builder_paths`, `description` |
| Window                      | `window_name`, `window_index`, `panes`, `start_directory`, `environment`, `shell_command_before`, `suppress_history`, `options`, `options_after`, `layout`, `window_shell`, `focus`, `description`                                                           |
| Pane                        | `shell_command`, `shell_command_before`, `start_directory`, `environment`, `suppress_history`, `shell`, `focus`, `enter`, `sleep_before`, `sleep_after`, `description`                                                                                       |
| Command object              | `cmd`, `enter`, `sleep_before`, `sleep_after`                                                                                                                                                                                                                |
| `workspace_builder_options` | `pane_readiness`                                                                                                                                                                                                                                             |

- **[Unknown fields fail](docs/contracts.md#unsupported-fields).** `load`
  rejects an unsupported field before any input runs a script, and names its
  path. `entter: false` is an error; `enter: false` leaves a command unsent.
- **[`x-` keys](docs/contracts.md#unsupported-fields).** A key starting with
  `x-`, at any scope, is accepted, ignored at load and left alone by
  [`convert`][cli-convert].
- **[`description`](docs/contracts.md#accepted-fields).** It is neutral
  metadata at workspace, window and pane scope.
- **[Not the library's schema](docs/contracts.md#relation-to-libtmuxworkspace).**
  [`@libtmux/workspace`](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace)
  has a stricter schema, so a document written here may not pass it.

## Convert between YAML and JSON

[`tmux-workspace convert`][cli-convert] rewrites a workspace in the other
format. [`freeze`][cli-freeze] and [`import`][cli-import] write the same two
formats. Convert the document saved in the Quick start to JSON:

```console
$ tmux-workspace convert ./workspace.yaml \
    --workspace-format json \
    --save-to ./workspace.json
```

It writes `workspace.json` and prints `Saved` with the path. Without
`--save-to`, [`--json`][wsref-output] prints the converted document instead.

Conversion keeps keys that native loading does not use and does not check that
the result loads. `--force` replaces an existing file.

## Import from tmuxinator or Teamocil

[`import tmuxinator`][cli-import-tmuxinator] and
[`import teamocil`][cli-import-teamocil] translate another tool's file into a
native workspace. They need neither tmux nor Python and run no pane commands.

### [`tmux-workspace import tmuxinator`][cli-import-tmuxinator]: translate a project

Save this tmuxinator project as `blog.yml`:

```yaml
name: blog
root: ~/code/blog
windows:
  - editor: vim
  - server: bun dev
```

Import it as a tmuxp workspace:

```console
$ tmux-workspace import tmuxinator ./blog.yml \
    --workspace-format yaml \
    --save-to ./blog-workspace.yaml
```

It writes `blog-workspace.yaml`. A window's command list stays in one pane; list
[`panes`][wsconfig-panes] explicitly for separate panes.

Unexpanded `<%` ERB markup in the source fails the import
([contract](docs/contracts.md#erb-templates)).

### [`tmux-workspace import teamocil`][cli-import-teamocil]: translate a layout

Save this Teamocil layout as `blog-teamocil.yml`:

```yaml
windows:
  - name: editor
    root: ~/code/blog
    layout: main-vertical
    panes:
      - commands:
          - vim
      - commands:
          - bun dev
```

Import it the same way:

```console
$ tmux-workspace import teamocil ./blog-teamocil.yml \
    --workspace-format yaml \
    --save-to ./blog-teamocil-workspace.yaml
```

It writes `blog-teamocil-workspace.yaml`. Window order, pane order and layouts
are kept, and a pane's `commands` array becomes one `; `-joined command.

Before you load the result:

- **[Refused, not dropped](docs/contracts.md#refused-source-features).**
  Lifecycle hooks, runtime overrides, named pane titles, Teamocil `clear`,
  filters and pane widths fail the import.
- **[Directories](docs/contracts.md#import-paths-and-tmux).** Roots are saved
  as absolute paths and are not checked for existence. Review them.
- **[Destination](docs/contracts.md#import-validation).** Unknown fields and
  conflicting aliases fail without replacing a file. `--force` replaces one.

## Find and search workspaces

Saved workspaces load by name. [`ls`][cli-ls] lists them,
[`search`][cli-search] looks inside them, and [`edit`][cli-edit] opens one.

### [`tmux-workspace ls`][cli-ls]: list workspace files

```console
$ tmux-workspace ls --tree
```

It lists project files from the current directory up to your home directory,
then the files in the first of `$TMUXP_CONFIGDIR`, `$XDG_CONFIG_HOME/tmuxp` and
`~/.tmuxp` that exists.

A file there loads by name, as [`tmux-workspace load project`][cli-load]. Use
[`--json`][wsref-output] in scripts; the tree is for people. The
[discovery guide][guide-discovery] lists every location.

### [`tmux-workspace search`][cli-search]: find a workspace by what it holds

```console
$ tmux-workspace search --field window logs
```

It prints the name, path and matching fields of each workspace with a window
matching `logs`. Without `--field`, a term matches every field.

Terms combine with AND, and `--any` selects OR. Patterns are JavaScript regular
expressions; `-F` matches literal text
([contract](docs/contracts.md#search-patterns)).

### [`tmux-workspace edit`][cli-edit]: open a workspace in your editor

`edit` resolves a file or saved name and opens it in `$EDITOR`, or `vi` when
that is unset. Run it as `EDITOR=vi tmux-workspace edit workspace.yaml`.

It waits for the editor and exits with the editor's status.

## Inspect a loaded workspace through MCP

The separate [MCP server](https://github.com/libtmux/libtmux-ts/tree/master/packages/mcp)
inspects loaded workspaces on the same tmux socket. After the Quick start's
detached load, add it to your MCP client with that socket and the `inspect`
[toolset][mcpref-policy-toolsets]:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["-y", "@libtmux/mcp@0.1.0-alpha.15"],
      "env": { "LIBTMUX_SOCKET": "workspace-cli-demo", "LIBTMUX_TOOLSETS": "inspect" }
    }
  }
}
```

The server picks its socket when it starts. For a workspace loaded with `-S`,
set `LIBTMUX_SOCKET_PATH` to the same absolute path instead of
`LIBTMUX_SOCKET`. If the CLI uses `TMUX_BIN`, set `LIBTMUX_TMUX_BIN` to match.

### [`list_sessions`][tool-list_sessions], [`list_windows`][tool-list_windows], [`list_panes`][tool-list_panes]: find what loaded

Discover tools with `tools/list`, then call `list_sessions` and `list_panes`.
Call `list_windows` with `session` set to `dev`, the configuration's session
name.

### [`capture_pane`][tool-capture_pane] and [`wait_for_text`][tool-wait_for_text]: read what panes show

Pass a returned pane ID as `paneId`. Bound output with `maxLines` and waits with
`timeoutMs`. A pending text wait allows other inspection requests on the same
connection. [`capture_since`][tool-capture_since] reads incrementally, with
cursors.

### [`tmux://capabilities`][res-capabilities]: check the selected socket

Read it through `resources/read` to verify the selected socket and the
advertised tools.

Closing the MCP subprocess's stdin cancels pending waits and joins its control
connections. The loaded workspace stays in tmux. The
[inspect guide][guide-inspect-with-mcp] walks through the whole path.

## Use it in scripts and CI

Every command accepts [`--json`][wsref-output] and `--ndjson`. What a script
must know:

- **[Machine output](docs/contracts.md#output-modes-and-saving).** The flags
  work before or after the command name. NDJSON wins when both are present.
- **[No prompts](docs/contracts.md#output-modes-and-saving).** Machine commands
  never prompt. Machine [`load`][cli-load] needs `-d` or `--append`.
- **[Results](docs/contracts.md#output-modes-and-saving).** Read stdout as
  results and stderr as diagnostics. Check the exit status as well.
- **[Saving](docs/contracts.md#output-modes-and-saving).**
  [`convert`][cli-convert], import and machine [`freeze`][cli-freeze] return the
  document without a destination. `--force` replaces a file.
- **[Progress](docs/contracts.md#progress-display).** Human `load` draws
  progress on stderr; `--no-progress` or a redirected stderr turns it off.
- **[Logs](docs/contracts.md#logging-and-cancellation).** `--log-level` filters
  stderr diagnostics (default `warning`). `load --log-file` appends them.
- **[Interrupts](docs/contracts.md#logging-and-cancellation).** An interrupted
  run exits 130 and its output can be incomplete. Handle EOF and parse errors.
- **[Child output](docs/contracts.md#child-process-output).** Captured results
  keep at most 64 KiB per stream and report truncation.

| Exit | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| 0    | Completed; a declined prompt can also finish without changes |
| 1    | Workspace validation or operation failure                    |
| 2    | Invalid arguments or execution context                       |
| 130  | Interrupted                                                  |

A failed `load` can leave completed tmux operations in place. [Exit
codes][wsref-exit-codes] lists the machine error codes, and the
[automation guide][guide-automation] shows a detached load with streamed
progress.

## Use Python plugins, builders and the shell

Most workspaces never start Python. [`shell`][cli-shell] and workspaces that
select `plugins` or a `workspace_builder` ([hooks][wsconfig-hooks]) need an
interpreter:

- **[Interpreter](docs/contracts.md#python-shell).** It needs tmuxp 1.74.0.
  `TMUX_WORKSPACE_PYTHON` picks the executable; otherwise `python3`.
- **[Shell](docs/contracts.md#python-shell).** `shell -c` code runs in tmuxp's
  Python context. An interactive shell needs a terminal.
- **[Native by default](docs/contracts.md#python-plugins-and-custom-builders).**
  Empty plugin lists and blank builder names use the native builder.
- **[Extension code](docs/contracts.md#python-plugins-and-custom-builders).**
  `workspace_builder_paths` adds import directories that hold executable code.
- **[Append](docs/contracts.md#python-plugins-and-custom-builders).** Python
  extension append rejects `before_script`; run that script separately.
- **[Results](docs/contracts.md#extension-results-and-cancellation).**
  Extension results report `effects_scope: "observed"`. Failures do not roll
  back opaque extension effects.

[Runtime and configuration support][wsref-compatibility] lists the requirements.

## Check your setup

[`tmux-workspace debug-info`][cli-debug-info] prints the CLI version, platform,
runtime, tmux version and the configured paths:

```console
$ tmux-workspace debug-info --json
```

Review the report before sharing it: paths and session names can describe your
environment. The [troubleshooting guide][guide-troubleshooting] lists common
failures.

## Shell completion

[`tmux-workspace completion`][cli-completion] prints a script for Bash, Zsh or
fish. With `tmux-workspace` on `PATH`, load the script for your shell. Bash:

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

- The scripts complete commands, options, enum values and file paths without
  starting Node, Bun or tmux.
- Saved workspace names and live sessions are outside their completion scope.
- Completion is tested on Linux with Bash 5.2, Zsh 5.9 and fish 4.8. Bash 3.2 is
  a syntax target; older shells and filenames containing newlines are
  unverified.

## What it leaves out

- **Convergence.** This command creates, reuses or appends.
  [`@libtmux/workspace`](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace)
  converges a session that already exists
  ([contract](docs/contracts.md#relation-to-libtmuxworkspace)).
- **Original commands.** [`freeze`][cli-freeze] reads live tmux state. It cannot
  recover command arguments, scripts, comments or application state.
- **Python.** Only plugins, custom builders and [`shell`][cli-shell] start it.
- **Pane inspection.** Reading what panes show belongs to the
  [MCP server](https://github.com/libtmux/libtmux-ts/tree/master/packages/mcp).

## See also

|                                                                                  |                                                                 |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [Command reference][cli-index]                                                   | One page per command                                            |
| [Guides][guide-index]                                                            | Installation, automation, discovery, export and troubleshooting |
| [Configuration][wsconfig-index]                                                  | Every workspace field, one page per topic                       |
| [Output formats][wsref-output]                                                   | What machine commands print                                     |
| [Exit codes][wsref-exit-codes]                                                   | Statuses and machine error codes                                |
| [Runtime and configuration support][wsref-compatibility]                         | Node, Bun, tmux and Python requirements                         |
| [`docs/contracts.md`](docs/contracts.md)                                         | The rules behind the sections above                             |
| [`docs/command-reference.md`](docs/command-reference.md)                         | Every option, generated from the parser                         |
| [`@libtmux/mcp`](https://github.com/libtmux/libtmux-ts/tree/master/packages/mcp) | Inspect a loaded workspace                                      |
| [`libtmux`](https://github.com/libtmux/libtmux-ts/tree/master/packages/libtmux)  | The library this builds on                                      |

## Build from source

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

### Regenerate the command reference

The [command reference](docs/command-reference.md) and
[command metadata](docs/commands.json) come from the native parser. Regenerate
them after changing command definitions:

```console
$ bun run --cwd packages/workspace-cli docs:generate
```

The build checks that the reference and packaged completion scripts are
current.

## Development status

- Native discovery, conversion, imports, common searches, detached load, append,
  capture, editor invocation, diagnostics, and the Python shell have executable
  tests.
- The Linux installed-package check packs the CLI and core, installs both
  offline into an empty project, and exercises every command in JSON and NDJSON
  on Node 22 and Bun. It needs the optional Python runtime
  ([setup](#use-python-plugins-builders-and-the-shell)):

```console
$ bun run --cwd packages/workspace-cli test:install
```

- Plugin and custom-builder execution has output, cancellation and
  borrowed-state tests using the optional interpreter.
- Confirmation and destination choices use explicit command-line flags.
- The native process and terminal tests run on Linux, including WSL. macOS is
  supported on a best-effort basis, and CI coverage for it is highly limited.
  Benchmark results cover isolated Linux fixtures.
- The core library keeps its zero-runtime-dependency contract. Commander, YAML,
  and terminal text helpers are bundled into this CLI; `libtmux` remains a
  separate package.
- Machine commands skip loading the progress renderer.

[cli-completion]: https://libtmux.org/en/ts/latest/workspace/cli/completion/
[cli-convert]: https://libtmux.org/en/ts/latest/workspace/cli/convert/
[cli-debug-info]: https://libtmux.org/en/ts/latest/workspace/cli/debug-info/
[cli-edit]: https://libtmux.org/en/ts/latest/workspace/cli/edit/
[cli-freeze]: https://libtmux.org/en/ts/latest/workspace/cli/freeze/
[cli-import]: https://libtmux.org/en/ts/latest/workspace/cli/import/
[cli-import-teamocil]: https://libtmux.org/en/ts/latest/workspace/cli/import-teamocil/
[cli-import-tmuxinator]: https://libtmux.org/en/ts/latest/workspace/cli/import-tmuxinator/
[cli-index]: https://libtmux.org/en/ts/latest/workspace/cli/
[cli-load]: https://libtmux.org/en/ts/latest/workspace/cli/load/
[cli-ls]: https://libtmux.org/en/ts/latest/workspace/cli/ls/
[cli-search]: https://libtmux.org/en/ts/latest/workspace/cli/search/
[cli-shell]: https://libtmux.org/en/ts/latest/workspace/cli/shell/
[concept-workspaces]: https://libtmux.org/en/ts/latest/concepts/workspaces/
[examples-gallery]: https://libtmux.org/en/ts/latest/workspace/examples/gallery/
[guide-automation]: https://libtmux.org/en/ts/latest/workspace/guides/automation/
[guide-discovery]: https://libtmux.org/en/ts/latest/workspace/guides/discovery/
[guide-export-session]: https://libtmux.org/en/ts/latest/workspace/guides/export-session/
[guide-index]: https://libtmux.org/en/ts/latest/workspace/guides/
[guide-inspect-with-mcp]: https://libtmux.org/en/ts/latest/workspace/guides/inspect-with-mcp/
[guide-installation]: https://libtmux.org/en/ts/latest/workspace/guides/installation/
[guide-troubleshooting]: https://libtmux.org/en/ts/latest/workspace/guides/troubleshooting/
[mcpref-policy-toolsets]: https://libtmux.org/en/ts/latest/mcp/reference/mcp-policy-policy-toolsets/
[res-capabilities]: https://libtmux.org/en/ts/latest/mcp/resources/capabilities/
[tool-capture_pane]: https://libtmux.org/en/ts/latest/mcp/tools/capture_pane/
[tool-capture_since]: https://libtmux.org/en/ts/latest/mcp/tools/capture_since/
[tool-list_panes]: https://libtmux.org/en/ts/latest/mcp/tools/list_panes/
[tool-list_sessions]: https://libtmux.org/en/ts/latest/mcp/tools/list_sessions/
[tool-list_windows]: https://libtmux.org/en/ts/latest/mcp/tools/list_windows/
[tool-wait_for_text]: https://libtmux.org/en/ts/latest/mcp/tools/wait_for_text/
[topic-socket-and-servers]: https://libtmux.org/en/ts/latest/topics/socket-and-servers/
[wsconfig-commands]: https://libtmux.org/en/ts/latest/workspace/configuration/commands/
[wsconfig-directories]: https://libtmux.org/en/ts/latest/workspace/configuration/directories/
[wsconfig-environment]: https://libtmux.org/en/ts/latest/workspace/configuration/environment/
[wsconfig-hooks]: https://libtmux.org/en/ts/latest/workspace/configuration/hooks/
[wsconfig-index]: https://libtmux.org/en/ts/latest/workspace/configuration/
[wsconfig-layouts]: https://libtmux.org/en/ts/latest/workspace/configuration/layouts/
[wsconfig-panes]: https://libtmux.org/en/ts/latest/workspace/configuration/panes/
[wsconfig-session]: https://libtmux.org/en/ts/latest/workspace/configuration/session/
[wsconfig-windows]: https://libtmux.org/en/ts/latest/workspace/configuration/windows/
[wsref-compatibility]: https://libtmux.org/en/ts/latest/workspace/reference/compatibility/
[wsref-exit-codes]: https://libtmux.org/en/ts/latest/workspace/reference/exit-codes/
[wsref-output]: https://libtmux.org/en/ts/latest/workspace/reference/output/
