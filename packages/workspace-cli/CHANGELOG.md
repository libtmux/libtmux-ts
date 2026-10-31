# Changelog

Notable changes to `@libtmux/workspace-cli`.

Releases are numbered `0.1.N`, and each release increments `N`. The API is not
settled: any release may change or remove exported identifiers, and this
changelog marks each break. Pin an exact version to avoid one. The newest
release is always `latest`, so `npm i @libtmux/workspace-cli` fetches it.
Releases before `0.1.0` were alphas, and their entries below keep that name.

The release packages share one version, so every release has a section here.
Changes that span packages, such as documentation, CI and release tooling,
are in the [`libtmux` changelog](../libtmux/CHANGELOG.md).

<!-- KEEP THIS PLACEHOLDER: new work lands under "Unreleased" until a release is cut. -->

<!-- toc -->

- [Unreleased](#unreleased)
- [0.1.1 (2026-10-31)](#011-2026-10-31)
- [0.1.0 (2026-10-25)](#010-2026-10-25)
- [0.1.0-alpha.15 (2026-10-24)](#010-alpha15-2026-10-24)
- [0.1.0-alpha.14 (2026-10-20)](#010-alpha14-2026-10-20)
- [0.1.0-alpha.13 (2026-10-18)](#010-alpha13-2026-10-18)
- [0.1.0-alpha.12 (2026-09-27)](#010-alpha12-2026-09-27)
- [0.1.0-alpha.11 (2026-09-26)](#010-alpha11-2026-09-26)

<!-- /toc -->

## Unreleased

## 0.1.1 (2026-10-31)

No entries for `@libtmux/workspace-cli`.

## 0.1.0 (2026-10-25)

No entries for `@libtmux/workspace-cli`.

## 0.1.0-alpha.15 (2026-10-24)

No entries for `@libtmux/workspace-cli`.

## 0.1.0-alpha.14 (2026-10-20)

No entries for `@libtmux/workspace-cli`.

## 0.1.0-alpha.13 (2026-10-18)

### `@libtmux/workspace-cli`

`tmux-workspace load` no longer starts a new tmux server when the server it
loaded into exits before the final attach; the attach fails instead. (#72)

`tmux-workspace shell` and Python extension loads check the tmux they use
before Python starts it. A live server is judged by its own version; with none
listening, `tmux -V` is asked, so neither an unsupported executable nor a
supported one creates a socket or reads the user's configuration. The
client lookup and the final attach carry `-N` after a checked read of the
server; they cannot carry the version fence. (#72)

A tmux below the minimum fails with the `tmux_unsupported` code, in text and
JSON output, with the remedy in the message. (#72)

## 0.1.0-alpha.12 (2026-09-27)

### `@libtmux/workspace-cli`

`@libtmux/workspace-cli` now depends on `libtmux` rather than declaring it a
peer, so `yarn dlx @libtmux/workspace-cli` runs `tmux-workspace`. Yarn installs
no peer dependencies, and the command failed at startup when it could not
import `libtmux`. (#32)

## 0.1.0-alpha.11 (2026-09-26)

### `@libtmux/workspace-cli`

A new package: `tmux-workspace` discovers, loads, captures, converts and imports
tmuxp workspaces from Node and Bun, with JSON and NDJSON output, terminal load
progress and generated shell completion. (#24)

`import` preserves source command groups, pane order, focus and directory
context. Tmuxinator window arrays stay in one pane; Teamocil `commands` and
legacy `cmd` retain their grouped execution. Tmuxinator imports refuse
unexpanded ERB markup in a key or value before output or overwrite; Teamocil
evaluates no templates, so such text in a Teamocil source is preserved
literally. `import teamocil` derives a session name from the file for the
current teamocil format, which starts at `windows:` with no session name of its
own. Unsupported source behavior and invalid native fields fail before preview
or destination replacement. (#24)

`load` rejects unsupported workspace, window, pane, command, and readiness
fields before scripts or tmux mutations, and treats a misspelled execution key
or a control placed at the wrong scope the same way. Descriptions, native option
and environment names, lossless conversion, and delegated Python extension
fields are accepted; `focus: 'true'` and `focus: 'false'`, the quoted strings
`tmuxp freeze` writes, are accepted alongside the YAML boolean. A key starting
with `x-`, at any scope, is accepted and ignored at load, matching `convert`;
the refusal for any other unsupported key names `x-` as the way to keep a custom
one. An unknown key inside `workspace_builder_options` is a warning, and a
`start_directory` tmux cannot change into is a warning naming the path and the
fallback to `$HOME`, neither one stopping the build. A window option named under
a session's `options:` -- `pane-base-index` and its like -- applies at window
scope to every window the load creates. With no pane declaring `focus`, the pane
left active after a load is the last pane created in the window, matching tmuxp.
`load` splits one pane at a time and rebalances between splits, so a window of
five or more panes builds without tmux refusing "no space for a new pane"; it
builds every pane in a window and applies the window's layout before typing into
any of them, so a window with `synchronize-panes` set sends every command to
every pane regardless of build order. A pane's prompt is waited for whatever the
server's `default-shell` is; `workspace_builder_options.pane_readiness` turns
the wait off. (#24)

`load` starts the tmux server itself when none is listening on the target
socket, whether or not the load will attach, so `tmux-workspace load -L project
-d ws.yaml` is a valid first command against a socket with no daemon yet.
Loading onto a different tmux server than the current pane's, an `--append` with
no current pane, an attached load with no terminal outside tmux, and a stale
daemon PID, a socket that no longer exists, a pane id not on the target server,
a pane id that is not an id, or a `TMUX` that does not parse each refuse with
one message, `code: "usage"`, exit 2, before anything is built; the message for
an unreachable tmux names the socket the caller gave or the executable. `load -d
--append` builds a new detached session and ignores `--append`, matching tmuxp:
`--append` only takes effect without `-d`, inside tmux or out. `load --append`
moves the client to the first appended window only when that window sets `focus:
true`. (#24)

`load`, run from a real terminal without `--yes`, asks before acting. Inside
tmux, loading a session that does not exist yet asks `switch (y), load detached
(n), or append (a)`; loading a session that already exists asks `Attach? [Y/n]`,
inside tmux or out. Piped or non-interactive input answers yes, and `--yes`,
`-d`, `--json` and `--ndjson` never prompt. An attached load inside tmux needs
no controlling terminal: it ends in `switch-client`, which needs none, so a
`bind-key ... run-shell "tmux-workspace load -y ws.yaml"` key binding loads and
switches; outside tmux, or for `--append`, a terminal (respectively a current
pane) is still required. Declining the "already running. Attach?" prompt leaves
the session exactly as it was -- exit 0, nothing compared, no `session_mismatch`
reported, since declining means the tool never goes to reuse that session.
Accepting the prompt still compares, as does every other reuse: a `load` that
reuses an existing session compares it against the document, and a window the
document declares that the session does not hold gives `code:
"session_mismatch"`, `status: "error"`, exit 1, and a message naming it, with
the session left exactly as it was. (#24)

A `load` that creates a session and cannot finish it removes that session:
`status: "error"`, exit 1, `session_removed: true`, and the result's
`created_windows`/`created_panes` are empty. An interrupted `load` is the
exception: it was stopped, not refused, so it leaves standing whatever session
and windows it had already built, with `status: "partial"`. An `--append` that
fails partway names the windows it kept, in the machine message and the human
line; load results carry `created_window_names` and, on a reuse mismatch,
`missing_windows`, and a session that could not be removed carries
`session_removal_error`. (#24)

`--json`/`--ndjson` error records carry one of ten closed `code` values:
`workspace_not_found`, `invalid_workspace`, `unsupported_key`,
`session_not_found`, `session_mismatch`, `tmux_unavailable`, `tmux_failed`,
`script_failed`, `destination_exists` and `usage`. An invalid layout name, and a
document `convert` cannot parse, are both `invalid_workspace`. A `before_script`
that cannot start at all -- missing or not executable -- is `script_failed`,
matching tmuxp's `BeforeLoadScriptNotExists`, removes the session `load` created
for it, and names the failed step `before_script` in its message, which never
ends in a bare `: ` when the script produced no output. `convert` with neither
`--yes` nor `--save-to`, an interactive `shell` with no terminal, the legacy
`-8` colour flag, an ambiguous `freeze`, an unusable `--log-file`, and `freeze
<name>` with no `--save-to` and no `--json`/`--ndjson` are all `usage`, exit 2.
A cancelled load reports `interrupted`, and a failed diagnostic sink reports
`log_error`. A failed `--json`/`--ndjson` load, whether the failure is at
argument parsing or during the load itself, writes exactly one flat
`{"schema_version":1,"code":"…","message":"…"}` error record to stderr, the
shape every other reported failure uses, with nothing else ahead of it. An
unrecognized subcommand reports `unknown command '<name>'`. (#24)

`--ndjson` spells a load result's input path `input`, in `results[]` and in
every event that carries one (`workspace-started`, `workspace-completed`,
`completed`, `failed`), matching cxx, dotnet, go, java and rs; the
`--progress-format` token `{workspace_path}` and `freeze`'s own `workspace`
field (the captured document) are a different thing and are unaffected. The
`started` event spells the input count `inputs`; `window-created`,
`window-completed` and `pane-created` spell position
`window_index`/`pane_index`; every window and pane event carries `session_id`.
`--ndjson` brackets a `before_script`'s output with `script-started`
(`input_index`) and `script-completed` (`input_index`, `child_status`,
`truncated`), matching go. (#24)

Attached `load` sizes `-x`/`-y` to the real terminal a client attaches from, the
way `tmuxp` and `TMUXP_DETECT_TERMINAL_SIZE` do; every window, focused or not,
matches the session's size from creation. `convert`'s YAML output quotes any
string scalar a YAML 1.1 or YAML 1.2 resolver would read as
`true`/`false`/`null`/a number -- `yes`, `off`, `on`, `1.0`, `08` and similar
bare spellings. `convert --json` emits the document as one compact line.
`--version` prints `tmux-workspace <version>`. (#24)

`freeze` refuses a session or window whose name `load` would reject -- one
holding `.` or `:`, which tmux reads as target separators -- and writes no
file. An explicit `freeze <name>` checks the requested name itself before
looking for a session, so a name holding either character is refused whether
or not a session exists under it. Against a socket whose server has not
started, `freeze <name>` otherwise reports `session_not_found`, the same
answer as a name that is not running. `freeze`
writes window options under `options_after`, since `automatic-rename: off` only
holds when applied after the panes exist (`load` accepts both spellings); it
omits a pane's `shell_command` when the pane runs the session's default shell,
and otherwise writes it as a one-element array; it writes no `default-size`,
since that option records the capturing terminal, not anything the workspace
declared. (#24)

The published package ships `THIRD-PARTY-NOTICES.md`, reproducing the license
text of every package the bundle inlines -- `commander`, `yaml`, `cli-truncate`,
`string-width` and their runtime dependencies. MIT and ISC both require the
notice to travel with the copy; a check fails the build when a bundled package
is missing from it. (#24)
