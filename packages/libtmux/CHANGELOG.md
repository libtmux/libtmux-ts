# Changelog

Notable changes to `libtmux`.

Releases are numbered `0.1.N`, and each release increments `N`. The API is not
settled: any release may change or remove exported identifiers, and this
changelog marks each break. Pin an exact version to avoid one. The newest
release is always `latest`, so `npm i libtmux` fetches it. Releases before
`0.1.0` were alphas, and their entries below keep that name.

The other release packages keep their own changelogs:
[`@libtmux/mcp`](../mcp/CHANGELOG.md),
[`@libtmux/workspace`](../workspace/CHANGELOG.md) and
[`@libtmux/workspace-cli`](../workspace-cli/CHANGELOG.md). Changes that
span packages, such as documentation, CI and release tooling, are listed
here.

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

### Development

A push or pull request runs the `tmux` job on tmux 3.3a and 3.8. The whole
table, `release_3.8a`, tmux master and the refused releases run for a release
and for a dispatch with `scope=full`. `workflow_dispatch` takes `scope`,
`tmux-ref`, `bun`, `os` and `tmate`, so any branch can run against any tmux
version, tag, branch or commit. `.github/ci-matrix.txt` lists the releases and
Bun versions once. The tmux badge names 3.3a–3.8, because 3.8a has no tag.

## 0.1.1 (2026-10-31)

### `libtmux`

- JSON layouts require tmux 3.8, the first release that accepts one. On an
  older tmux, `Window.selectLayout` throws `VersionTooLowError` naming 3.8 as
  the minimum and `Server.validateLayouts` rejects with `TypeError`; both
  refuse before anything is sent. Upgrade to tmux 3.8 to apply a JSON layout.
  (#111)
- `Server.validateLayouts` on a socket with no server bounds its check of the
  tmux it would start by the call's `signal` and `timeoutMs`. (#123)
- `TmuxObjectNotFoundError` takes a `message`, for an object no listing names.
  (#129)

#### Program runs

- Add `Server.run(argv)`, which runs a program in a pane of its own and returns
  its `output`, `exitCode`, `signalCode`, `success` and `timedOut`. `output`
  holds what the program printed, with no command line or echo. (#123)
- Add `Server.spawn(argv)`, which returns the running `Program` to drive through
  `program.pane`, wait on with `wait()`, read with `output()` and end with
  `kill()` or `await using`. `Program` is also the `libtmux/program` entry
  point. (#123)
- `run` and `spawn` require tmux 3.8, as the `program-run` capability, and raise
  `VersionTooLowError` below it. (#123)
- `run` and `spawn` raise `TypeError` before tmux runs anything for an `argv`
  that is not an array, an `argv` element that is not a string, naming its index
  and type, or a `startDirectory` that is not a string. (#129)
- `environment`, `startDirectory`, `width`, `height` and `historyLimit` set up
  the program's pane. Its `PATH` is this process's, unless `environment` sets
  one, and `historyLimit` also bounds `output`. (#123)
- `from: pane`, with `placement: "window"` or `"split"`, runs the program beside
  that pane and leaves focus where it was. (#123)
- `keep: true` leaves the ended pane on screen for a person to read. (#123)
- `input` gives the program a stdin, from a string or bytes. (#123)
- `separateStderr` returns a run's stderr apart as `stderr`, so `output` is
  stdout alone. (#123)
- `stream: true` on `spawn` adds `stream()`, which yields what the program
  writes as it writes it. `maxStreamBytes` caps the copy, past which the stream
  ends with the new `StreamLimitError`. (#123)
- Add `ServerNotLocalError`: `input`, `separateStderr` and `stream: true` need
  the tmux server on this machine, and are refused for one elsewhere. (#123)
- Add `ProgramStartError`, which `run`, `wait()` and `stream()` reject with when
  the program never ran: `argv[0]` not found or not executable, or a
  `startDirectory` it cannot enter. `reason` says which, and `exitCode` is the
  shell's 127 or 126. (#123)
- `lostStart` says a run's output lost its start past `historyLimit`, and
  `lostEnd` that tmux removed the pane before reading its end; a stream ends
  with the new `OutputLostError` for the second. (#123)
- A program a signal ended reports `signalCode`, with `exitCode` null. One that
  exits 130 on its own reads as `"SIGINT"`, as that status means. (#123)
- `signal` cancels a run, or a spawn's setup, with a `TmuxTransportError` whose
  `delivery` says how far the program got. On `wait()` and `stream()` it stops
  only that wait or stream, with `delivery` `replied`. (#123)
- `orphanAfterMs` is the lease each run and spawn holds: should this process
  die, tmux ends the program within it, a minute by default. `null` takes none.
  (#123)
- `run` and `spawn` start a tmux server on a socket with none, as `newSession`
  does. Removing their own session stops a server with no other, unless
  `exit-empty` is off. (#123)
- The program's own session turns `destroy-unattached` off, so a configuration
  that sets it does not end the run; every other session keeps the option.
  (#129)
- A `Program`'s `wait()` and `output()` raise `TmuxServerRestartedError` once
  its tmux server has restarted, and its `kill()` leaves the new server's panes
  alone. (#123)
- A run's session or window is named `libtmux-program-` and an id, and its pane
  carries `@libtmux-lease` and `@libtmux-files` while they apply. (#123)

#### Pane waits

- Add `Pane.waitForExit()`, which waits for any pane's program to exit, whoever
  started it, and returns its exit code or signal. (#123)
- Add `Pane.waitForCommand()`, which waits for the next command a shell marks
  as finished with OSC 133 and returns its status; `send` types the command
  once the wait listens. (#123)
- Add `Pane.waitForText(pattern)`, which resolves with the first line of the
  pane's screen that a string or regular expression matches. A line the pane
  wrapped matches and returns whole. (#123, #129)
- The pane waits require tmux 3.8, as the `pane-wait` capability. (#123)
- The pane waits and a `Program`'s waits raise `ObjectNotFoundError` with
  `%N: the pane is gone` for a pane that is gone, also when its server exits
  with it or dies during the wait. (#129)

#### Transport

- Every command passes `-u`, so a process whose locale does not name UTF-8,
  such as one started by cron, systemd or a container without `LANG`, reads
  tmux's answers whole. A session named `café` read back as `caf_`. (#129)
- `maxInFlight` no longer counts an invocation whose last command waits, so a
  live program holds no slot. (#123)

### Documentation

- The README shows `Program.stream`, `Program.output` and `Program.kill`, and
  the MCP README shows `run_program` and `wait_for_exit`, as recipes drawn
  from examples the test suite runs. (#126)
- Each wait's docs give its bound after an outside `kill-pane`: about a second
  for a `Program`'s waits, about two for `Pane.waitForExit`,
  `Pane.waitForCommand` and `wait_for_exit`. (#129)
- The README's tmux versions section and `docs/contracts.md` say tmux release
  candidates are unsupported, and link the libtmux.org policy. (#128)
- The `Server` and `Session` docs open with a directory of their members,
  grouped by task. (#135)
- Every package README links its libtmux.org docs and its npm page, and the
  root README's badge row shows CI, version, docs and license. (#107, #108)

## 0.1.0 (2026-10-25)

### Documentation

- Releases are now numbered `0.1.N`, starting with `0.1.0`, and none carries an
  `-alpha` or other prerelease tag unless the maintainer asks for one. The
  READMEs, `SECURITY.md` and `CONTRIBUTING.md` drop the alpha warning for one
  that says any release may change or remove exported identifiers, and that an
  exact version avoids the change.
- The features table in the package README states that the guard reads each
  command's own argv, so a refused command nested in `if-shell`,
  `run-shell -C`, a brace block, a hook or a key binding is sent as written. It
  lists the affected commands and releases. The `refresh-client -l` row links
  tmux 3.6a's `CHANGES`. (#99)
- The nested-command list adds `break-pane -n NAME` without `-P` on tmux 3.7,
  where tmux ignores the name. The advice for 3.7 now covers only a nested or
  key-bound `break-pane`, since the guard refuses the direct forms: name it, or
  upgrade to 3.7a. (#101)
- The "tmux versions" section states the package's own range, tmux 3.3a and
  newer, instead of pointing at the Python library's. (#101)

## 0.1.0-alpha.15 (2026-10-24)

### `libtmux`

- A literal `refresh-client -l` needs tmux 3.6a and refuses with
  `VersionTooLowError` on an older daemon. On 3.3a, asking an attached
  terminal for its clipboard stops the server, and on 3.4 through 3.6 the
  server stops when that client leaves before its terminal answers.
  (#92, #93)

## 0.1.0-alpha.14 (2026-10-20)

### Development

CI no longer runs macOS. The `macOS package canary` job is removed from
`typescript.yml`, and the READMEs and `CONTRIBUTING.md` now say that macOS is
supported on a best-effort basis and that CI coverage for it is highly
limited. (#88)

### `libtmux`

Features above the floor refuse on an older daemon with `VersionTooLowError`
before sending anything, and the rest of the package keeps working. (#73)

- `Server.watch`, `Server.connect` and `Server.withConnection` need tmux 3.7.
  Earlier servers can crash or hang while a control client attaches, so the
  daemon is read before every attach and reconnect. A `3.7-rc2` or `next-3.7`
  daemon is refused too. (#73)
- `Server.deleteBuffer` and `set-buffer -n` need tmux 3.4. Earlier releases can
  delete an unrelated buffer when the named one is missing. (#73)
- `Server.runShell` needs tmux 3.5. tmux 3.3a and 3.4 print a clientless
  `run-shell`'s output to a view-mode pane. `cmd("run-shell", …)` still runs and
  returns no output there. (#73)

Literal argv, alone or in a list, is checked the same way and fails with a
`protocol` `TmuxTransportError`: `select-layout` with a value that is neither a
preset nor a checksummed layout on 3.3a, `split-window -p` on 3.4, and on 3.7
`break-pane` without `-n`, which crashes the server, `break-pane -n` without
`-P`, and names containing `:` or `.`. `Pane.breakOut()` with no name is refused
there too. (#73)

Commands spawned beside a `Server.connect` connection no longer fire
`after-list-clients` hooks. (#73)

The releases each gate refuses are recorded in one registry, and the root
`capabilities.json` is that registry serialized, for the capability pages of the
documentation site. (#73)

## 0.1.0-alpha.13 (2026-10-18)

### `libtmux`

`libtmux` now requires tmux 3.3a or newer, judged by the running server's
version rather than the `tmux` executable's. A server of an earlier release,
including 3.3 and the 3.0 and 3.1 lines, and an executable that would start
one are refused with `VersionTooLowError` before anything is sent. Release
candidates and `next-X.Y` builds of later releases (`3.8-rc2`, `next-3.9`)
pass; `3.3-rc`, `next-3.3`, bare `master`, `openbsd-*` and forms tmux never
prints (`3.3a-master`, `next-3.3a`) are refused, and the error says the version
is unrecognized rather than that the server is too old. (#72)

Before:

    libtmux 0.1.0-alpha.12 ran commands on tmux 3.2a.

After:

    VersionTooLowError, nothing sent.

To keep a tmux older than 3.3a, pin `libtmux@0.1.0-alpha.12`. Otherwise
upgrade tmux: upgrading the executable does not upgrade a server that is
already running, so restart it after saving its sessions. The error message and
`VersionTooLowError.remedy` say the same. (#72)

The refusal covers `Server` methods, `cmd`, batches, plans, `watch` and
`connect`, and so the workspace builder and the MCP server. (#72)

Nothing runs on a server replaced after its version was checked. A
replacement below the minimum raises `VersionTooLowError` with the remedy, a
supported one raises `TmuxServerRestartedError`, and a server that vanished is
not restarted by an older executable. (#72)

Reading the server's version no longer runs `after-display-message` hooks.
Custom engines receive that read as a request of its own before the first
command, so recordings made with `recordInvocations` before this change need
recording again; `recordInvocations` and `replayInvocations` leave the version
fence out. (#72)

`Server.versionAtLeast` and every feature gate rank versions as tmux orders
them: `next-X.Y` below `X.Y-rc`, below `X.Y`, below `X.Ya`. A candidate such as
`3.8-rc2` is no longer at least `3.8`, and `versionAtLeast` throws a
`TypeError` for a minimum tmux does not print, such as `master`. (#72)

A JSON layout string is accepted from `3.8-rc2`, the first release measured to
dump and accept one, so `Window.selectLayout` and `Server.validateLayouts` no
longer refuse it on a `3.8-rc2` or `3.8-rc3` server. (#72)

`MINIMUM_TMUX` exports the supported floor and `assertSupportedTmux(version)`
throws `VersionTooLowError` for a version report below it or one libtmux cannot
place. `VersionTooLowError.reason` is the message without its remedy, and
`VersionTooLowError.recognized` is `false` when the server's report names no
release libtmux can place. (#72)

The `since` of a format or criteria field that tmux had before 3.3a is `3.3a`,
the floor, in the generated field tables and in `docs/criteria.md`; no query
against a supported server can be refused for it. (#72)

A command's result is returned once the `tmux` client has exited and its pipes
have stayed silent for a second, with new output restarting the wait. A 3.0a or
3.1c daemon holds the client's stdout open after refusing it, which made every
refused call last the command timeout. (#72)

A refused version, and a version read that tmux does not answer, report
`delivery: "not_started"`: `VersionTooLowError.delivery` and
`TmuxTransportError.delivery` on the thrown error, and `onInvocation` on the
report. A failed read is a `TmuxTransportError` of kind `protocol`. (#72)

## 0.1.0-alpha.12 (2026-09-27)

### Release tooling

`@libtmux/workspace-cli` is an established package: a tag release stops when
the registry lacks it, as it does for every other package.

## 0.1.0-alpha.11 (2026-09-26)

### `libtmux`

#### Layouts

`Server.validateLayouts` checks complete window plans before scripts or tmux
mutations. `Window.selectLayout` rejects invalid names and serialized trees;
unique abbreviations use the daemon's version, while geometry and pruning stay
with tmux. Both workspace builders use this preflight before applying
inputs. (#24)

`Server.validateLayouts` accepts tmux 3.8 JSON layouts, including captured
workspace layouts. Preflight checks native syntax, dimensions, pane indexes
and cell counts before scripts or mutations. (#24)

#### Server

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
`LibTmuxError` when acquisition omits the identity. (#24)

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

### Release tooling

`@libtmux/workspace-cli` participates in coordinated version checks, package
canaries, and publication with the library, MCP server, and workspace builder.
The release policy declares it as not yet published, so the release that creates
it admits a package-level 404 for that package on the coordinated `latest`
channel. Every other package must exist in the registry. (#24)

## 0.1.0-alpha.10 (2026-09-19)

### `libtmux`

#### Errors

`libtmux/errors` exports errors under consistent `*Error` names; old names and
`libtmux/exc` remain deprecated aliases. **Breaking.** `error.name` and
`error.code` use the canonical names, so update string comparisons. (#26)

**Breaking.** `QueryValidationError.reason` replaces its former `code` field;
`code` now identifies the error class. Read `reason` for the validation
failure. (#26)

#### Queries and selections

**Breaking.** Import `parseLegacyWhere` from `libtmux/selection`; it is no
longer exported from the package root. (#26)

Numeric criteria accept ordinary integers, such as `where({ index: 3 })`,
without a `safeInteger` wrapper. (#26)

`Selection.one` and `oneOrUndefined` include chained `where` criteria in
`NoMatchError`, so a failed lookup identifies what it searched for. (#26)

#### Commands, deadlines and cancellation

**Breaking.** Commands time out after 30 seconds by default. Set `timeoutMs`
on the call or server to change the budget, or use `null` for no deadline;
commands waiting for a person or an external signal have no default. (#26)

**Breaking.** `CommandResult` and custom `TmuxEngine` results use `exitCode`
instead of `returncode`. Update result construction and property reads. (#26)

**Breaking.** The default engine returns plain `Uint8Array` output in place
of Node `Buffer` values. Use `TextDecoder` to decode it. (#26)

Cancelled commands retain the caller's abort reason as the rejection's
`cause`, including cancellation while queued. (#26)

`newSession`, `newWindow`, `split` and `runShell` honor their `signal`,
`timeoutMs` and `stdin` options. Cancellation also reaches the handle lookup
after creation and in `Server.batch`. (#26)

Names, commands, literal input, buffer data and channel names beginning with
`-` remain caller text in library and MCP operations, without changing tmux
options. (#26)

#### Panes and windows

`SplitOptions.direction` and `JoinOptions.direction` select any side of a
pane. They replace the deprecated `vertical` option; supply only one. (#26)

`Window.selectLayout` validates presets and serialized layouts before
dispatch, including unique preset prefixes. Invalid or unsupported layouts
are refused without reaching tmux. (#26)

#### Observing a server

`ServerOptions.onInvocation` reports completed invocations, their outcomes
and time spent waiting for a command slot. (#26)

**Breaking.** The unused `TmuxLogger`, `TmuxLogContext`, `TmuxWarning` and
`TmuxWarningSink` exports are removed. Use `onInvocation` to observe
commands. (#26)

Control connections report JSON layouts on tmux 3.8 and newer, matching
snapshot layout values. (#26)

#### tmux versions

`Server` capability checks work in non-UTF-8 locales, including restricted
service and MCP environments. (#26)

`parseTmuxVersion` accepts release candidates and ranks them as the release
they name. (#26)

`Server.versionAtLeast` bounds a named development build below its named
release instead of treating it as newer than every release. (#26)

#### Testing

`libtmux/testing` exports `recordInvocations` and `replayInvocations` to
record engine results and replay them without a tmux server. (#26)

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

## 0.1.0-alpha.4

No change to the published code: `dist` is identical to `0.1.0-alpha.3`, and
nothing in the API moved. The repository changed around it — the lint and
format toolchain, a contract test that had drifted from the manifests it
pins, and how the project writes down its own conventions — but none of that
reaches an installed package.

## 0.1.0-alpha.3

### Fixed

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
