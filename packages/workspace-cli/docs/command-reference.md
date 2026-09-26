# Workspace command reference

Commands and options come from the native parser. See the [CLI README](../README.md)
for operation behavior, output, and development status.

Root options precede the subcommand. Each command lists its own accepted options.

## tmux-workspace

Manage tmux workspaces from YAML and JSON configuration.

Usage: `tmux-workspace [options] [command]`

Commands: `load`, `shell`, `import`, `convert`, `debug-info`, `ls`, `search`, `edit`, `freeze`, `completion`.

- `-V, --version`: output the version number
- `--log-level <log_level>`: log level (debug, info, warning, error, critical) (default "warning") Choices: `debug`, `info`, `warning`, `error`, `critical`. Default: `"warning"`.
- `--color <color>`: when to use colors: auto (default), always, or never Choices: `auto`, `always`, `never`. Default: `"auto"`.
- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `-h, --help`: display help for command

## tmux-workspace load

Load workspace files, attach to existing sessions, or append windows.

Usage: `tmux-workspace load [options] <workspace_files...>`

- `workspace_files`: filepath to session or filename of session in tmuxp workspace directory

- `-L <socket_name>`: passthru to tmux(1) -L
- `-S <socket_path>`: passthru to tmux(1) -S
- `-f <tmux_config_file>`: passthru to tmux(1) -f
- `-s <new_session_name>`: start new session with new session name
- `-y, --yes`: always answer yes Default: `false`.
- `-d`: load the session without attaching it Default: `false`.
- `-a, --append`: load workspace, appending windows to the current session Default: `false`.
- `-2`: force tmux to assume the terminal supports 256 colours.
- `-8`: Reject unsupported legacy 88-color mode before loading.
- `--log-file <log_file>`: file to log errors/output to
- `--progress-format <progress_format>`: Progress line format: preset name (default, minimal, window, pane, verbose) or a format string with tokens {session}, {window}, {progress}, {window_progress}, {pane_progress}, etc. Env: TMUXP_PROGRESS_FORMAT
- `--progress-lines <panel_lines>`: Recent script-output lines in the terminal panel (default: 3). 0 forwards each stream directly; -1 uses terminal height. Retention is bounded. Env: TMUXP_PROGRESS_LINES
- `--no-progress`: Disable terminal progress. Env: TMUXP_PROGRESS=0 Default: `false`.
- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command

## tmux-workspace shell

Open the Python tmuxp shell with the selected tmux context.

Usage: `tmux-workspace shell [options] [session_name] [window_name]`

- `session_name`
- `window_name`

- `-S <socket_path>`: pass-through for tmux -S
- `-L <socket_name>`: pass-through for tmux -L
- `-c <command>`: instead of opening shell, execute python code in libtmux and exit
- `--best`: use best shell available in site packages Default: `"best"`.
- `--pdb`: use plain pdb
- `--code`: use stdlib's code.interact()
- `--ptipython`: use ptpython + ipython
- `--ptpython`: use ptpython
- `--ipython`: use ipython
- `--bpython`: use bpython
- `--use-pythonrc`: load PYTHONSTARTUP env var and ~/.pythonrc.py script in --code Default: `false`.
- `--no-startup`: Do not load Python startup files. Default: `false`.
- `--use-vi-mode`: use vi-mode in ptpython/ptipython Default: `false`.
- `--no-vi-mode`: Disable vi editing mode. Default: `false`.
- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command

## tmux-workspace import

Import a teamocil or tmuxinator workspace.

Usage: `tmux-workspace import [options] [command]`

Commands: `teamocil`, `tmuxinator`.

- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command

## tmux-workspace import teamocil

Convert a teamocil workspace to tmuxp configuration.

Usage: `tmux-workspace import teamocil [options] <workspace_file>`

- `workspace_file`: checks current ~/.teamocil and current directory for yaml files

- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `--save-to <path>`: Write to this destination instead of machine stdout.
- `--workspace-format <format>`: Document format: yaml or json. Choices: `yaml`, `json`.
- `--force`: Allow replacing an existing destination.
- `-h, --help`: display help for command

## tmux-workspace import tmuxinator

Convert a tmuxinator workspace to tmuxp configuration.

Usage: `tmux-workspace import tmuxinator [options] <workspace_file>`

- `workspace_file`: checks current ~/.tmuxinator and current directory for yaml files

- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `--save-to <path>`: Write to this destination instead of machine stdout.
- `--workspace-format <format>`: Document format: yaml or json. Choices: `yaml`, `json`.
- `--force`: Allow replacing an existing destination.
- `-h, --help`: display help for command

## tmux-workspace convert

Convert a workspace between YAML and JSON.

Usage: `tmux-workspace convert [options] <workspace_file>`

- `workspace_file`: checks tmuxp and current directory for workspace files.

- `-y, --yes`: always answer yes Default: `false`.
- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `--save-to <path>`: Write to this destination instead of machine stdout.
- `--workspace-format <format>`: Document format: yaml or json. Choices: `yaml`, `json`.
- `--force`: Allow replacing an existing destination.
- `-h, --help`: display help for command

## tmux-workspace debug-info

Show runtime, configuration, and tmux diagnostics.

Usage: `tmux-workspace debug-info [options]`

- `--json`: output as JSON Default: `false`.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command

## tmux-workspace ls

List project and saved workspace files.

Usage: `tmux-workspace ls [options]`

- `--tree`: display workspaces grouped by directory Default: `false`.
- `--json`: output as JSON Default: `false`.
- `--ndjson`: output as NDJSON (one JSON per line) Default: `false`.
- `--full`: include full config content in output Default: `false`.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command

## tmux-workspace search

Search workspace names, sessions, windows, and pane commands.

Usage: `tmux-workspace search [options] [query_terms...]`

- `query_terms`: search patterns (prefix with field: for field-scoped search)

- `-f, --field <field>`: restrict search to field(s): name, session/s, path/p, window/w, pane
- `-i, --ignore-case`: case-insensitive matching Default: `false`.
- `-S, --smart-case`: case-insensitive unless pattern has uppercase Default: `false`.
- `-F, --fixed-strings`: treat patterns as literal strings, not regex Default: `false`.
- `-w, --word-regexp`: match whole words only Default: `false`.
- `-v, --invert-match`: show workspaces that do NOT match Default: `false`.
- `--any`: match ANY pattern (OR logic); default is ALL (AND logic) Default: `false`.
- `--json`: output as JSON Default: `false`.
- `--ndjson`: output as NDJSON (one JSON per line) Default: `false`.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command

## tmux-workspace edit

Open a discovered workspace in your editor.

Usage: `tmux-workspace edit [options] <workspace_file>`

- `workspace_file`: checks current tmuxp and current directory for workspace files.

- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command

## tmux-workspace freeze

Capture a live tmux session as a workspace document.

Usage: `tmux-workspace freeze [options] [session_name]`

- `session_name`

- `-S <socket_path>`: pass-through for tmux -S
- `-L <socket_name>`: pass-through for tmux -L
- `-f, --workspace-format <workspace_format>`: format to save in Choices: `yaml`, `json`.
- `-o, --save-to <save_to>`: file to save to
- `-y, --yes`: always answer yes Default: `false`.
- `-q, --quiet`: Suppress human status messages. Default: `false`.
- `--force`: overwrite the workspace file Default: `false`.
- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command

## tmux-workspace completion

Print a shell completion script.

Usage: `tmux-workspace completion [options] <shell>`

- `shell`: Shell to complete in. Choices: `bash`, `zsh`, `fish`.

- `--json`: Write JSON; machine operations never prompt.
- `--ndjson`: Stream NDJSON; takes precedence over --json.
- `--color <mode>`: Human color: auto, always, or never. Machine output disables color. Choices: `auto`, `always`, `never`.
- `-h, --help`: display help for command
