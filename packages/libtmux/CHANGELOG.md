# Changelog

Notable changes to `libtmux`.

Every release so far is an **alpha**: a prerelease whose API can change between
versions without a deprecation cycle. Semantic versioning starts applying at the
`0.1.0` release itself, which the alphas leading to it precede. The newest one is
always `latest`, so `npm i libtmux` fetches it — there is no second tag to
remember.

<!-- KEEP THIS PLACEHOLDER: new work lands under "Unreleased" until a release is cut. -->

## Unreleased

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

### `@libtmux/workspace`

- `applyWorkspace` and `planWorkspace` accept a `signal`, so a build that is
  no longer wanted stops instead of running to completion. Every tmux call
  they make carries it, and the gap between two calls is checked as well.
  A build already begun is not rolled back; planning changes nothing, so
  there is nothing to unwind. (#24)
- The README states what happens when two calls race on one session name:
  tmux offers no lock on a session that does not exist yet, so both can
  observe none and each start one. Serialize calls that target the same
  name. (#24)
- **Breaking.** `applyWorkspace` now rebalances a window between splits, so a
  window of five or more panes builds at a default 80x24 where tmux previously
  answered `size or position no space for a new pane` on the fifth. A window
  that names no layout, or names the empty string, now comes up tiled; a
  declared layout is still applied last. (#24)
- The README and `applyWorkspace` now state that this package and
  `@libtmux/workspace-cli` are separate implementations: they answer
  differently for a session that already exists, and the strict schema here
  rejects the CLI's additional document fields. (#24)

### `libtmux`

#### Layouts

`Server.validateLayouts` checks complete window plans before scripts or tmux
mutations. `Window.selectLayout` rejects invalid names and serialized trees;
unique abbreviations use the daemon's version, while geometry and pruning stay
with tmux. Both workspace builders use this preflight before applying
inputs. (#24)

#### Server

A tmux release candidate is read rather than refused: `parseTmuxVersion` no
longer throws on tmux's own `3.8-rc` or `3.0-rc3` spellings. A candidate now
ranks as the release it names, unlike a `next-X.Y` development build, which
sits somewhere in that release's cycle and may predate any of it. (#24)

`Server.versionAtLeast` no longer treats a named development build such as
`next-3.9` as satisfying every minimum: it now ranks below the release it
names and above the one before it. An untargeted build (bare `master`, or
`<tag>-master`) still satisfies any minimum. (#24)

`Server.connect({ target })` attaches to the session with exactly that name.
The name went to tmux as a bare target, which it matches as a prefix, so
asking for `doom` when only `doomsday` existed attached to `doomsday` and
streamed its output. A session id is still addressed as given. (#24)

**Breaking.** `ServerOptions.colors` accepts `256` alone, and `Server.colors`
reports `256` or `undefined`. Any other value throws `TypeError` before tmux is
contacted.

Before:

    new Server({ colors: 88 })

After:

    new Server({ colors: 256 })

Every supported tmux answers `-8` with `unknown option`, so `88` built an
invocation none of them could run. (#24)

**Breaking.** `ServerSnapshot` carries `daemonIdentity`, the daemon that
answered the acquisition, so a value standing in for a snapshot supplies it too.

Before:

    { clients, panes, sessions, windows }

After:

    { clients, daemonIdentity, panes, sessions, windows }

A snapshot of a server with no sessions named no daemon, so a reader could not
tell whether two instants came from the same one. `Server.snapshot` throws
`LibTmuxException` when acquisition omits the identity. (#24)

`Server.newSession`, `Session.newWindow`, `Window.split` and `Pane.split` apply
the `signal` and `timeoutMs` they accept, to the command and to the acquisition
that resolves the created object. A cancelled caller previously created it
anyway. (#24)

`Session.newWindow`, and `session.plan.newWindow`, accept an exact `index`,
placing the window at that slot instead of the first free one; an occupied
index fails without touching the window there. `index` cannot be combined
with `direction`. (#24)

`showOptions` and `showResolvedOptions` on `Server`, `Session`, `Window` and
`Pane`, plus `Server.showGlobalOptions` and `Server.daemonIdentity`, now
accept `CommandOptions` (`daemonIdentity` only a `signal`), so a caller's
deadline or cancellation reaches these reads too. (#24)

`Server.hasSession` now lists sessions and compares the name in JavaScript,
rather than asking tmux to resolve a `-t` target: no target spelling is both
exact and correct for a name holding `.` or `:`, so a session actually named
`my.proj` previously answered no. A cold socket still answers `false`; any
other failure to list sessions now raises instead of also reading as
"no such session". (#24)

### `@libtmux/mcp`

The stdio server now closes pending waits and joins its control connections on
stdin EOF, preserving existing tmux sessions. Backend cleanup errors reach the
process exit status. (#24)

`select_layout` reports the observed window layout without falsely warning
that a valid abbreviation, mirrored name or adapted saved layout was not
applied. Descriptions now explain that tmux may resize or prune saved
cells. (#24)

### Release tooling

`@libtmux/workspace-cli` participates in coordinated version checks, package
canaries, and publication with the library, MCP server, and workspace builder.
The release policy declares it as not yet published, so the release that creates
it admits a package-level 404 for that package on the coordinated `latest`
channel. Every other package must exist in the registry. (#24)

## 0.1.0-alpha.9 (2026-09-12)

### `libtmux`

#### Panes and windows

`Pane.zoom`, `Pane.unzoom` and `Window.unzoom` set the zoom state rather than
flipping it. tmux offers only `resize-pane -Z`, which toggles, so each call
carries its condition through `if-shell -F` and lets tmux decide inside its own
command queue: idempotent, and no window in which another resize changes the
answer between a read and a write. `Pane.zoom` selects the pane first, because
`window_zoomed_flag` belongs to the window and would otherwise report a pane
zoomed while a sibling is the zoomed one; both commands travel as one
invocation, so no reader sees a selected pane that is not yet zoomed. Any
ordinary `resize` unzooms first, which is tmux's behaviour rather than this
package's.

`Pane.sendKeys` now sends the keys and Enter as two `send-keys` commands in one
tmux invocation. Two invocations left a window in which another writer's Enter
submitted this caller's half-typed line; one command carrying both would let
tmux resolve Enter against whatever the keys before it had just done, which in
copy mode is a mode that is no longer there.

#### Cross-object targets

`Pane.swapWith`, `Window.swapWith` and `Client.switchTo` now refuse an object
from another tmux server with a `TypeError`. A tmux id is unique only within
one running daemon, so `@1` exists on every server that has a window: the
command previously ran against whichever object held that id here and reported
success.

`Window.move`, `Window.link`, `Pane.joinTo` and `Session.selectWindow` accept a
handle as well as a string, and check a handle the same way. A handle read
before the daemon restarted raises `TmuxServerRestarted` as it already did when
addressed directly, since the same socket is not the same daemon.
`Session.selectWindow` keeps the placement a window handle names, because a
window linked twice into one session holds two indexes behind one id, and
refuses a window placed in another session. A string is
still accepted unchecked, because it carries neither to check.

#### Server

`ServerOptions.maxInFlight` bounds how many tmux invocations one server runs at
once, and defaults to 16. Every invocation is a tmux client process with its
own pipes, so a `Promise.all` over a whole server previously started that many.
The ceiling costs no throughput: tmux runs commands on one thread, and measured
capture throughput stops rising at four concurrent clients and is flat from
there to sixty-four. Waiting for a slot spends the request's own deadline
rather than extending it — the engine receives what is left of `timeoutMs`,
not a fresh copy — and a request that never gets one raises
`TmuxTransportError` with `delivery` of `"not_started"`. An invocation that
blocks until something outside it releases it is not counted — `wait-for` on a
channel, a popup or menu on its dismissal, a prompt on an answer. Each occupies
a client and no throughput, and counting one would let it hold the slot its own
release needs. Each is recognised by its canonical name, its built-in short
name and any unambiguous abbreviation, because tmux resolves all three.
Commands that wait on tmux doing work, such as `run-shell`, are counted,
because they finish on their own, and a request that finds a free slot is
dispatched without suspending, so an uncontended command reaches tmux exactly
as it did before.

### `@libtmux/mcp`

`resize_pane` treats `zoom` as a state: `true` makes the pane fill its window
and `false` restores the layout, and sending the same value twice is a no-op.
It previously passed tmux's toggle through, so two identical calls undid each
other. A call carrying both `zoom` and a size is now refused, because tmux
unzooms a window before applying any size.

### Development

Every CI job now carries a timeout. No lane here has hung, but three sibling
ports reached GitHub's six-hour ceiling on a single stuck job; a bound turns
that into a failure in minutes. (#22)

## 0.1.0-alpha.8 (2026-09-06)

### `libtmux`

#### Queries and selections

`compileBoundedRegex` is exported for callers that compile selection patterns
outside a query, under the same input ceilings the `WHERE` predicates apply.
Its emitted declaration resolves without reaching into private modules. (#16)

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

### `@libtmux/workspace`

**Breaking.** `workspaceSchema` is no longer exported, and the published types
are declared rather than inferred from it. Installing the package no longer
makes a consumer's `tsc` resolve zod's own declarations, which since zod 4.5.4
name the `URL` global and fail under a `lib` without `DOM` and no `@types/node`.
`parseWorkspace` and `parseWorkspaceYaml` are unchanged. (#19)

`WorkspaceWindowInput` is exported, naming a window as written — before `panes`
defaults to one implicit pane. (#19)

## 0.1.0-alpha.7 (2026-08-30)

### `libtmux`

#### Control mode

`ControlClient` supports format subscriptions for notification-driven state
updates without polling. Per-name changes stay ordered through reconnects and
update local subscription state only after tmux accepts them. Refusal or close
leaves prior state intact; indeterminate delivery is retried after reconnect.
(#11)

**Breaking.** Connected-mode options `maxCommandBytes` and
`maxPendingCommands` are removed; issue commands through `Server` and use the
control connection for observation. (#11)

Control connections validate reconnect settings, reject stale successor
daemons, and resolve `ready` only for the current connection. (#11)

Control parsing preserves `%output` bodies and split UTF-8 sequences across
flow-control pauses, and close failures reach pending callers. (#11)

`Server.watch` and `Server.connect` now document that each open control
connection is a tmux-visible attached client. It appears in snapshots,
increments `session_attached`, triggers client hooks, and affects
attachment-sensitive policy until the connection closes. (#14)

#### Types

**Breaking.** Public identifiers and model fields are scoped to their owning
server and model, and numeric fields use their declared scalar domains.
Update code that interchanged raw IDs or relied on widened number types. (#11)

`OptionScope`, `CommandOptions`, `JoinOptions`, and `SetOptionOptions` are
exported for callers building typed wrappers. (#11)

Generated declarations preserve public predicates, exact-map types, and all
types reachable from exported APIs. (#11)

**Breaking.** Exception classes that no public operation threw are no longer
exported; remove those imports and handle the operation's documented result
or error instead. (#11)

#### Sessions, windows, and panes

Session and window names that tmux would rewrite now fail before execution;
use `isTmuxName` to preflight user input. (#11)

Linked-window operations preserve exact placement identity when selecting,
moving, linking, swapping, or unlinking a window. (#11)

`Window.remove` and `Pane.kill` expose direct, typed removal operations. (#11)

Option and hook operations pass names literally, preserve cancellation and
timeout settings, and validate the requested scope. (#11)

#### Queries and selections

String predicates use Unicode-aware case folding while scalar predicates keep
their declared wire types. (#11)

Regex and key predicates enforce finite input limits, and null relations
retain deterministic ordering. (#11)

The public `WHERE` codecs are exported for callers that serialize or inspect
typed query expressions. (#11)

#### Buffers and capture

Buffer APIs preserve arbitrary bytes instead of decoding and re-encoding
payloads as text. (#11)

Capture options can retain trailing blank cells without losing the distinction
between spaces and absent content. (#11)

#### Server, transport, and snapshots

Packed commands enforce `MAX_PACKED_ARGV_BYTES` and
`MAX_PACKED_ARGV_COUNT`, charging only command arguments and failing before
tmux receives an oversized request. (#11)

Server snapshots expose the signal that invalidated them and verify daemon
liveness before returning cached state. (#11)

`Server.daemonIdentity` returns a concrete identity for a reachable daemon with
no sessions. An unreachable server rejects instead of returning `undefined`;
identity capture and the four listings remain one tmux invocation. (#14)

Subprocess output and diagnostic bytes are bounded, drained, and included in
typed failures without allowing child processes to block indefinitely. (#11)

Server handles remain bound to the daemon identity they observed and refuse
operations after that identity changes. (#11)

#### Runtime support

Development and release tooling uses Bun 1.4.0, and CI runs the gates on both
Bun 1.3.14 and 1.4.0. The published floors are unchanged: Bun 1.3.14, Node 22,
and tmux 3.2a.

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

### `@libtmux/workspace`

Workspace application reports partial progress when tmux changes state before
a later operation fails. (#11)

Workspace commands use literal argument arrays and preserve the requested
working directory without shell reinterpretation. (#11)

Implicit panes are normalized before planning so equivalent workspace
documents produce the same operation sequence. (#11)

`WorkspaceInput` describes input before schema defaults and transforms, while
`Workspace` describes validated output. `applyWorkspace` and `planWorkspace`
accept `WorkspaceInput`, including a window whose `panes` field is omitted.
(#14)

Pruning distinguishes linked windows and grouped sessions instead of deleting
a shared underlying window. (#11)

`prune: "always"` is documented as authority for one `planWorkspace` or
`applyWorkspace` call, not a persistent ownership claim. It does not stamp a
found session, so a later default `"owned"` apply leaves new surplus alone.
(#14)

Workspace plans expose immutable, typed operation inputs so callers cannot
silently change a validated plan before execution. (#11)

## 0.1.0-alpha.6

### `libtmux`

#### Control mode

A command whose output holds a line beginning `%begin`, `%end` or `%error` now
returns that output. tmux writes command output to a control client without
escaping a leading `%`, so a pane, a buffer or a log carrying one closed or
reopened the block it was inside — truncating a capture, failing a command that
succeeded, or leaving the connection unable to answer. A closing guard now has
to carry the command number of the one that opened the block.

An argument holding a newline no longer becomes a tmux command. Control mode
reads one line as one command list and has no continuation, so everything after
a newline was parsed as further commands, `run-shell` among them. Such a command
now travels over a spawned process, which passes the argument to `execve` whole.

Closing a connection on purpose no longer leaves an abandoned `waitFor` as an
unhandled rejection. A close rejects every wait in flight, and one nobody holds
any more — the losing side of a race, or one caught by a scope ending — rejected
with nothing left to catch it. Only those are silenced: a wait somebody still
holds raises as before, and a daemon that dies does not come through `close` at
all.

`Server.runShell` returns the command's output over a control connection. tmux
writes `run-shell`'s closing guard before the job it started produces anything,
so the output followed the block belonging to no command.

A connection that breaks under a command in flight fails it with a
`TmuxTransportError` carrying `delivery: "indeterminate"`, rather than with
Node's `EPIPE`, which no `LibTmuxException` handler could catch.

`TmuxOutputEvent` carries a pane's output whichever way tmux wrote it, and
`TmuxExtendedOutputEvent` is gone. `pauseAfterSeconds` switches tmux to
`%extended-output` for every pane, so a consumer matching on `"output"` stopped
seeing anything at the moment backpressure began.

Before:

    if (event.kind === "output" || event.kind === "extended-output") read(event.data);

After:

    if (event.kind === "output") read(event.data);

The age tmux reports arrives as `event.age`, set only where tmux reported one.

`TmuxEventStream.find` answers `undefined` for its deadline and for a stream or
connection somebody closed, and raises when the connection ends under it.
Answering `undefined` for all three left a caller unable to tell a condition
that never came true from a server that went away.

`WaitTimeout` is exported from `libtmux`, so a deadline can be caught by type.
`ConnectedServer.waitFor` raises `WaitTimeout` for its deadline and a
`LibTmuxException` naming the ended stream otherwise. Both were one message.

#### Options and hooks

`showOptions`, `showGlobalOptions` and `showHooks` return the value that was
set. tmux prints a value through `args_escape`, so `status-left` holding
`#S $USER` read back as `#S \$USER`, and an option set to the empty string read
back as `''`.

`showHooks` is keyed by the name `setHook` and `unsetHook` take, and its values
are the commands tmux holds for that hook, in tmux's order. tmux prints one
element per line as `after-new-window[0]`, which composed with neither writer.

Before:

    (await session.showHooks()).get("after-new-window[0]")

After:

    (await session.showHooks()).get("after-new-window")?.[0]

`Server.setHook` and `Session.setHook` accept `append`, tmux's `-a`, which adds
to the commands a hook already holds. A write without it replaces the list, so
this is the only way to build the several commands `showHooks` reports.
`SetHookOptions` is exported from `libtmux`, so those options can be held as a
typed value.

`Server`, `Session`, `Window` and `Pane` gain `showResolvedOptions`, the values
that govern the object rather than the values set on it. A window that has set
nothing reports nothing from `showOptions`, while `history-limit` and
`default-shell` govern it from the tables it inherits.

#### Sessions, windows and panes

`Window.select`, `Window.unlink`, `Window.move` and `Window.swapWith` act on the
placement the handle was reached through. A window that linked or grouped
sessions share has one id and a placement in each, and these addressed it by
that id alone, so `select` made the window active in the other session and
`unlink` removed the other placement.

`Window.move` and `Window.link` keep a window in its own session when no
destination session is named, which is what `MoveWindowOptions.session`
documents. tmux reads a destination of `:3` as index 3 of whichever session it
considers current.

`Pane.breakOut` puts the new window in the session the pane is in. tmux takes
the destination session from `-t` and resolves an absent one to whichever
session is current, so a pane broken out of a detached session arrived in the
attached one — a window in somebody's workspace, from a call that named neither.

`NewSessionOptions` accepts `groupWith`, tmux's `-t`, naming a session to share
windows with. Members of a group hold one window list, so a window created or
moved in either happens in both — which two sessions merely linking a window do
not do.

`NewSessionOptions`, `NewWindowOptions` and `SplitOptions` accept
`environment`, tmux's `-e`, giving a created process its own variables.
`setEnvironment` writes the session's, which every pane made in it afterwards
inherits too.

`SplitOptions` accepts `size`, tmux's `-l`: a number of cells, or a `"30%"`
share of the pane being divided.

`CaptureOptions` accepts `escapeSequences` and `alternateScreen`, tmux's `-e`
and `-a`. The first keeps the sequences that colour and style the text; the
second reads the normal screen saved underneath a full-screen program, which
exists only while such a program is running.

`Session.detach()` detaches the session's clients. It sent tmux's `-t`, which
names a client rather than a session, so tmux answered `can't find client: $0`
and the documented method never worked. The operation now takes `{ client }` or
`{ session }` and picks the flag, because one opaque target parameter is what
let the two meanings look alike at the call site.

Refreshing a handle whose window has moved to another session says where the
window is now, rather than that it no longer exists. A handle names a
placement — one window can sit in two sessions at once — so only the placement
was gone, and reporting the window as absent sent a reader looking for
something in plain sight.

#### Queries

`.where()` accepts the fields tmux has rather than only those the Python
library this package ports carries. Panes gained `alternateOn`,
`historyAllBytes`, `unseenChanges`, `keyMode`, `cursorShape`, `cursorColour`,
`cursorBlinking` and `cursorVeryVisible`; sessions gained `active`,
`activityFlag`, `alert`, `bellFlag` and `silenceFlag`. Each carries the release
that has it, so a criterion an older server predates is refused by name rather
than matched against nothing.

A criterion naming a field newer than the tmux that answered raises
`VersionTooLow` instead of matching nothing. tmux says nothing about a field its
release lacks, so filtering on `bracketPasteFlag` against 3.2a returned an empty
selection — the same answer as "no pane has it", and a different statement. The
error names the field, the release that has it and the release running, and
carries the three as `criteriaName`, `since` and `serverVersion`.

`QueryValidationError` names where in the criteria the problem is and what was
expected there, and carries the same location as `path` — keys and array
indices, as in `["OR", 1, "nmae"]`. Every refusal read `Invalid selection
query`, which named neither the field, the reason, nor the vocabulary that would
have worked.

    Invalid selection query at windows.any: unknown quantifier; windows holds
    many, so expected one of "every", "none", "some" over its windows

A near miss gets a suggestion and the closed vocabularies are listed in full;
no operand is quoted back, because a criterion's value can be a pane title or a
path.

`Selection.one` and `oneOrUndefined` name the sessions a shared id spans, and
the criterion that reaches one of them. A window or pane that linked or grouped
sessions share raises for an id that is perfectly good.

`ServerSnapshot.windows` and `panes` document that they hold placements rather
than distinct objects, so an id matches every placement of one.

`docs/criteria.md` lists every field each model accepts and the operators that
go with them, generated from the table the compiler matches against. What
`.where()` takes was answerable from editor completion or from generated
source, which leaves a caller writing criteria as data with nothing to read.

#### Documentation

`Server.sourceFile` documents that tmux does not expand `~`. `source-file`
globs a path that is not absolute against the client's working directory, so
`sourceFile("~/.tmux.conf")` looked for a directory named `~` — the shell
expands the tilde when it is typed, and nothing does when it is passed as a
string.

`Server.loadBuffer` documents that empty data stores nothing. tmux exits zero
for `set-buffer -b name ""` and creates no buffer, so the name a caller believes
they wrote is absent, and they learn that from whatever reads it next.

`Server.showBuffer` documents that a control connection stops at the first NUL,
because tmux writes a command's output as a C string. `saveBuffer` and a
spawning server both read the value whole.

`Session.showOptions`, `Window.showOptions` and `Pane.showOptions` describe
their own view rather than an inherited one. They read tmux's `show-options`
without `-A`, so a fresh object answers with an empty map;
`showResolvedOptions` is the reader that resolves what an object inherits.

`Window.move` and `Window.unlink` document how a group differs from a link: a
move is shared by every member of a group, and tmux refuses to unlink a window a
group shares.

`NewSessionOptions.width` and `height` document that tmux 3.2 ignores them for a
detached session. 3.3 is the first release that honours them.

`Pane.chooseTree`, `chooseBuffer`, `findWindow`, `sendPrefix` and
`customizeMode` document that they need a client attached to draw anything, and
do nothing while reporting success without one.

`Pane.enterCopyMode` and `Pane.exitCopyMode` no longer document a client
requirement. Copy mode works on a pane whether or not a client is attached.

`Selection`'s iterator is in the API reference, carrying the example every
public member carries. The reader that builds that reference matched plain
names only, so the member `for...of`, spread and destructuring all go through
was undocumented and exempt from the gate that requires an example.

The README's `Pane.respawn` recipe passes `kill: true`. tmux refuses to
respawn a pane that is still running, which is the only kind a caller holds.

`Server.watch` documents that pane output arrives only for the session the
control client attached to. Without a `target` on a server with more than one
session, a watch reads no output and reports no error.

`Selection.where`'s recipe for moving windows runs in an order that composes. A
handle names a placement, so moving a window first left every later line
addressing a placement that no longer existed.

The abort example awaits the promise it aborts, which rejects with the abort
reason rather than being left unhandled.

### `@libtmux/workspace`

`applyWorkspace` and `planWorkspace` build against a server that is not running
yet, which is what a first run starts from. Both opened by reading the server,
and reading one raises where no daemon is listening, so the branch that creates
the session was never reached.

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

### `libtmux`

`Server.showGlobalOptions`, `Server.setGlobalOption` and
`Server.unsetGlobalOption` reach the defaults every session or window inherits,
taking `"session"` or `"window"` for which table. A handle reports only what was
set on it, so a session that has set nothing reports nothing while the values
governing it live here — `history-limit` and `default-shell` among them.

`Pane.pipeTo` sends everything a pane writes to a shell command, for as long as
the pipe is open. A pane keeps `history-limit` lines and a stream reader keeps a
bounded buffer, so output larger than either is gone before anything asks for
it. Passing no command stops an open pipe; `toggle` stops one that is open and
starts one when none is.

`pipe_pane` reports whether the pane is piped now, read back from tmux rather
than inferred from the request. A `toggle` against a pane already being piped
closes that pipe and opens none, so a command supplied is not a pipe opened —
and the caller that stopped somebody else's capture is the one that most needs
to be told.

`Server.saveBuffer` writes a paste buffer to a file. `showBuffer` returns the
contents through the calling process; this leaves them with tmux.

`NewSessionOptions` accepts `width` and `height`, passed as tmux's `-x` and
`-y`. A detached session has no client to size it, so tmux gives it 80x24 and
every program in it formats to that.

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

No change to the published code: `dist` is identical to `0.1.0-alpha.3`, and
nothing in the API moved. The repository changed around it — the lint and
format toolchain, a contract test that had drifted from the manifests it
pins, and how the project writes down its own conventions — but none of that
reaches an installed package.

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

**A supplied engine no longer loses its commands to this machine's tmux.** An
engine says tmux is somewhere this process cannot spawn it, and four calls did
not know that. `watch()` and `connect()` opened a local `tmux -C attach` and ran
everything over it. `Server.open()` consulted `LIBTMUX_TRANSPORT` and routed to
`connect()` when it said `control`, so a variable set by whoever launched the
process silently moved an engine-backed server to the local daemon and reported
success. `equals()` compared socket addresses alone, so two engines reaching
different hosts through the same socket path were one server. This was already
reaching users through `@libtmux/workspace`, which held a control connection for
the whole reconciliation: a workspace applied through an engine was built on the
wrong machine.

`watch()` and `connect()` now refuse an engine-backed server and name what to
use instead; `Server.open()` ignores `LIBTMUX_TRANSPORT` when an engine is
given, and refuses `transport: "control"` written alongside one.

### Added

**`CommandTransport.endpoint`, so two engines can be told apart.** A socket path
on another machine is not an address. `equals()` compares it, and reports two
engines that declare none as different rather than guessing from the socket.

**`Server.engine`**, the accessor every other `ServerOptions` field already had.
A caller choosing between one connection and a command per read needs it, which
is how `applyWorkspace` now decides.

**`wait_for_text` reports `alreadyOnScreen`.** A wait that misses now says when
the pattern is on the pane already, because it printed before the wait began. A
wait still refuses to match what was there first — stale text satisfying a wait
is the bug that avoids — but "it printed before you asked" and "it never
printed" are different answers, and only one is worth waiting again for.

**`guardRequest` and `refusedByGuard` from `libtmux/engine`.** The wrapper that
makes tmux refuse a command on a daemon that reissued its ids was private to the
built-in transport, while `asSingleInvocation` was published — so an engine
author inherited the obligation whose absence is invisible until a restart, and
none of the helper for it. These are the same functions the built-in engine
calls, so the two cannot drift.

### Changed

The control-mode parsers are now fuzzed on the ordinary gate: chunking is
invisible to the line framer, the carry stays inside its bound, and neither the
notification parser nor the UTF-8 holdback throws on arbitrary bytes. Each was
broken once and confirmed red for the property it breaks.

## 0.1.0-alpha.2

### Changed

**A snapshot is now one instant, rather than four readings taken near each
other.** It was four concurrent `list-*` processes, which are four tmux clients
with four command queues, so a change landing between them left the capture
holding rows from two topologies. Under window churn, 669 of 3211 captures
disagreed about the window set and 25 of 982 failed outright with "conflicting
winlink ownership for one session index" — an error that read as though the
caller had asked something invalid. The four listings now go as one tmux command
list, which tmux drains without letting another client in, and the same churn
tore none of 3340. It also costs one process instead of four.

**`equals()` compares the daemon, which its documentation already claimed.** Two
handles could agree on socket and id and name different panes, because a
restarted daemon reissues `%0`. If you relied on the old behaviour — the raw id
on one socket, whichever daemon answered — that question is `sameTmuxIdAs`.

**Criteria text is narrowed to what this library can encode for the field.** A
flag takes `"0" | "1"`, a number and a time take digits, and text outside that
is refused:

```ts
snapshot.panes.where({ active: "1" }); // still fine
snapshot.panes.where({ pid: "banana" }); // no longer compiles
```

The rule is not a preference: it is exactly what `encodeFormatValue` emits for
that kind of field, which is what lets a serialized query decode back into the
type it was authored in. A `string` known only at runtime is not in that domain,
so say what it means — `where({ index: Number(value) })`, or
`where({ index: { contains: value } })` to ask about the characters instead.

**`@libtmux/workspace` prunes only what it created.** `applyWorkspace` found a
session by name and then killed every window and pane the file did not describe;
a name is a lookup, not a claim, so converging a session somebody made by hand
destroyed their work. A session this package creates is now marked, and pruning
asks the mark. `prune: "always"` is how you say a session you did not create is
this file's, and `prune: "never"` turns it off entirely.

### Added

`libtmux/engine` exports the seam every command travels through, so a tmux
reached over ssh, inside a container, or behind a daemon carries the whole
library — snapshots, queries, handles and all:

```ts
import { Server } from "libtmux";
import { asSingleInvocation, type TmuxEngine } from "libtmux/engine";
```

`asSingleInvocation` is part of it rather than an implementation detail: an
engine has to run a group as one tmux command list or its snapshots stop being
one instant, and the built-in engine calls the same helper.

`TmuxServerRestarted` is thrown when a handle outlives the daemon that issued its
id, with `delivery: "not_started"` — a refused command never ran, so retrying
against a fresh handle is safe.

`@libtmux/workspace` exports `planWorkspace`, which reads the server once and
answers what an apply would create, rename, kill, and deliberately leave alone.

`@libtmux/mcp` takes `LIBTMUX_MCP_TOOLS`, a comma-separated allowlist for when a
safety tier is the wrong shape: read and type but never kill is not a degree of
typing. A tool left off is never registered, so an agent cannot spend a turn
discovering it. It also says what to do about a tmux server it cannot reach,
naming the variable that configured the socket — an agent given only "cannot
reach tmux" reports "unavailable" and stops.

### Fixed

A handle held across a daemon restart could still command its successor. The
epoch that guards against it only moved when an acquisition happened to notice,
so capture a pane, restart the daemon, and `kill()` went through — reproduced,
and it killed the successor's pane. A command carrying a raw id now goes as
`if-shell -F` conditioned on the daemon's pid and start time, which tmux
evaluates inside the same queue entry that would run it. Over a control
connection there is nothing to condition: losing the connection is the signal.

`Session.cmd` and `Window.cmd` documented examples that did not work.
`cmd("rename-session -- new")` was answered by tmux with `unknown command`, and
`window.cmd("display-panes")` sent a window where tmux wants a client. Both are
now run against a real server on every build rather than only compiled.

## 0.1.0-alpha.1

### Changed

Fields now read as the values they stand for. tmux answers everything as text,
and this decoded none of it, so a pid was `"2334787"`, an active pane was `"1"`,
and a creation time was `"1786878571"`.

```ts
pane.panePid; // number | null, was string | null
pane.active; // boolean | null, was string | null
session.created; // Date | null, was string | null
window.index; // number, was string
```

**This is a breaking change to every typed accessor.** A comparison against a
string no longer holds — `pane.active === "1"` is now always false, and
`Number(pane.width)` is a number of a number. The text tmux sent is unchanged
and still on the row, so `pane.format.pane_active` is the escape hatch and the
mechanical fix for anything this gets in the way of.

Criteria accept the decoded shape as well as the text, and mean the same thing
either way, so `where({ active: true })` and `where({ active: "1" })` compile to
the same query and serialize identically. Stored queries are unaffected: the
wire format is unchanged, and no schema version was added.

Which fields are numbers, booleans and times is derived from tmux's own
`format.c` and held to a live server on every tmux version CI runs, so a field
this port has the shape of is a field tmux agrees about.

### Added

`connect()` and `watch()` take `pauseAfterSeconds`, which asks tmux to pause a
pane that falls behind rather than drop the whole connection. Without it tmux's
own remedy applies: a control client that lets a pane's output back up for five
minutes is killed with "too far behind", taking every other pane and every
pending command with it. With it, tmux stops that one pane and reports `pause`;
the connection asks it back and reports `continue`.

### Fixed

A pane that tmux paused while a command was in flight was never asked back, and
stopped for the rest of the connection's life. tmux appends what it writes to
whatever command block is open, so the `%pause` arrived as that command's output
and was read as such — and a command in flight is the normal condition when a
pane is falling behind.

## 0.0.1-alpha.7

### Fixed

`mcp_swap` wrote `npx -y libtmux-mcp@<version>` into an agent's MCP config for
its `published` source. That is the executable inside the package rather than
the package, so npx resolved nothing and the server never started; it now names
`@libtmux/mcp`.

### Documentation

Install instructions name the package on its own — `bun add libtmux`. An
`alpha` dist-tag was documented and then could not be created: trusted
publishing authenticates `npm publish` and nothing else, so writing a second
tag would need a token in the repository. `latest` already points at the newest
prerelease, and every page says the release is an alpha, so there is one tag
and the docs match it.

### Release

A registry error that was not a 404 used to be read as "this package has never
been published", so a network blip during a release could skip a package while
reporting success. Anything other than a 404 now stops the release. The MCP
manifest no longer needs correcting by npm at publish time.

## 0.0.1-alpha.6

### Fixed

Three unit files each rebuilt `dist` while the suite was running four files at
a time, and `build` begins by deleting it — so tests that read the emitted
package could observe it missing, which is what turned CI red twice. The build
now happens once, before any test runs.

A fixture marker was read as soon as it existed rather than once it held
anything, so a PID that was mid-write was rejected as invalid.

### Documentation

Install instructions name the published package rather than telling readers to
clone the repository, and every link, shell command and recipe in the
documentation is now checked on each run — a recipe marked as runnable has to
be a literal excerpt of an example the integration suite executes.

## 0.0.1-alpha.5

### What's new

#### Typed control of tmux, with a snapshot at its centre

`Server.snapshot()` reads the whole server in one round of commands and returns
sessions, windows, panes, and clients already related to each other. Everything
reachable from the result resolves locally and never changes, so a value read
from it cannot shift underneath the code holding it.

Queries are declarative. `Selection.where()` takes criteria that are data —
equality, string operators, `AND`/`OR`/`NOT`, regular expressions as
`{ pattern, flags }`, and quantifiers over relations — while `Selection.filter()`
takes an ordinary predicate. The two are never overloaded into each other.

#### Control-mode streaming

`Server.watch()` holds one `tmux -C` connection open and yields notifications as
a discriminated union, so `event.kind` narrows the rest of the shape with no
cast. A notification this release does not model arrives as
`{ kind: "unknown", name, args }` rather than being dropped.

`Server.connect()` routes commands over that same connection, so a snapshot
costs four writes instead of four processes. Each `subscribe()` is an
independent view with its own buffer, and `waitFor()` subscribes before it reads
so a change landing in between is still seen. `ready()` resolves once tmux has
accepted the attach — await it before making the change you mean to observe,
since a control client is told nothing that happened before it attached.

#### Environments, buffers, and the escape hatch

Session and server environments are readable and writable, modelling the three
states tmux distinguishes: a value, `null` for a variable marked for removal
from child processes, and absent. `loadBuffer` feeds tmux's stdin, so a payload
too large or too binary for a command-line argument arrives whole.

`cmd()` runs any tmux command through the same socket, deadline, and error
handling as everything else, so a command this package does not model never
means building a subprocess.

### Compatibility

Requires tmux 3.2a or newer, and Node 22+ or Bun 1.3.14+. The format registry
withholds newer fields from an older server. CI runs the suite against 3.2a,
3.7 and 3.7b on every commit; `test:compat` sweeps a wider local matrix.

One behaviour differs across the range rather than being gated: tmux 3.3a
suppressed `run-shell` output for an invocation with no attached client, which
later versions restored. `runShell` returns an empty result there rather than
failing.

### Dependencies

None. The package installs a tmux client and nothing else — no transitive tree
to audit, pin, or deduplicate. Validation of tmux's own output lives in a small
internal validator whose failures carry the value that failed.
