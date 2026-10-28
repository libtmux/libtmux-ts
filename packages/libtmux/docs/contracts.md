# Contracts

The detail the [README](../README.md) summarises, moved here unchanged from the
sections it names. The hosted [API reference](https://libtmux.org/en/ts/latest/reference/)
and [topics](https://libtmux.org/en/ts/latest/topics/) cover the same ground by symbol.

## Snapshots and handles

[`server.sessions()`](https://libtmux.org/en/ts/latest/reference/server-server-sessions/), [`windows()`](https://libtmux.org/en/ts/latest/reference/server-server-windows/), [`panes()`](https://libtmux.org/en/ts/latest/reference/server-server-panes/), and [`clients()`](https://libtmux.org/en/ts/latest/reference/server-server-clients/) each take a
snapshot of their own — one invocation apiece, carrying an identity read and
four listings — so reaching for several in a row costs several round trips and
describes several different instants. In a
loop that is an N+1. Take one `snapshot()` and read the collections off it:
they are cheaper together and they agree with each other.

To read one handle at a later instant rather than re-acquiring everything, call
`refreshed()`. It answers with a _new_ handle and leaves the receiver alone, so
the snapshot you already hold keeps agreeing with itself — a handle that
advanced in place would leave `where({ name: "old" })` matching an object whose
`name` had become `"new"`. A window keeps its placement, so one linked into two
sessions stays on the one you resolved.

## Querying

Most programs need equality and a relation: `one({ id })` to re-find something
they already hold, `{ session: { is: { id } } }` to scope to it. Both consumers
in this repository use those and nothing else, and `.filter()` covers the rest
of what a program that built the server itself wants.

The operators below are for the other case — a caller exploring a server it did
not build, or one holding a query it did not write: a saved filter, a `--where`
flag, an argument from an agent. That is also what `encodeWhereDocument` and
[`decodeWhereDocument`](https://libtmux.org/en/ts/latest/reference/selection-decodewheredocument/) are for, and why criteria are
data. If you know the ids, you do not need any of this.

Which fields those are comes from tmux's own `format.c`, and an integration test
holds every one of them to a live server on each version CI runs. Anything else
is left exactly as tmux sent it, empty string included.

Criteria take decoded values as well as wire text. A non-null decoded value
lowers to its exact wire spelling. A `null` criterion instead matches every
value that field's decoder treats as absent or invalid, including an empty
typed field and a time reported as `0`. Serialized bytes use stable tmux field
names and text values; a decoded `WhereDocumentV1` restores camelCase criteria
names. The same type therefore covers what you write and what comes back.

A numeric criterion takes any `number`, and a value that is not an exact
integer — `NaN`, an infinity, a fraction, an unsafe integer — raises
[`QueryValidationError`](https://libtmux.org/en/ts/latest/reference/errors-queryvalidationerror/) naming the field it was written under. That check is at
the boundary rather than in the type because the type cannot see a number that
arrived at runtime, and making the literal case pay for the runtime one cost
every correct query a `safeInteger` call.

`SafeInteger` is what decoded fields carry, so a value read off a handle is
already proven exact. `safeInteger` authenticates one from elsewhere and throws
when it is not, and `isSafeInteger` narrows without throwing — useful where you
want the refusal at the point the value arrives rather than at the query.

A criterion is spelled like the handle accessor it filters, so a pane reads
`pane.currentCommand` and filters on `currentCommand`. Only the serialized name
is fixed by the schema. A field keeps its prefix in the rare case where dropping
it would shadow a relation: `sessionWindows` is a window count, `windows` is the
windows themselves.

Fields that carry one value for the whole server — `version`, `pid`,
`socketPath` — are readable on a handle but are not criteria, since filtering
rows by one would match all of them or none.

## Operations

[`zoom`](https://libtmux.org/en/ts/latest/reference/pane-pane-zoom/) and [`unzoom`](https://libtmux.org/en/ts/latest/reference/pane-pane-unzoom/) set a state rather than flipping one. tmux offers only
`resize-pane -Z`, which toggles, so each call asks tmux to evaluate
`#{window_zoomed_flag}` and toggle in the same command — idempotent, one
invocation, and no window in which someone else's resize changes the answer
between the read and the write. Any ordinary `resize` unzooms first, so a size
and a zoom cannot both hold.

A window's placement is measured from the session's selected window, since the
command addresses the session. `shellCommand` runs something other than the
default shell. tmux hands it to a
shell, so a whole command line works, and it replaces the shell rather than
running inside it — when it exits the window or pane closes, unless
`remain-on-exit` says otherwise:

A tmux id is unique only within one running daemon, so `@1` exists on every
server that has a window. Passing a handle from a different server raises
`TypeError` rather than addressing whatever holds that id here — which is what
a bare id cannot be checked for, since a string carries no server.

A handle names a placement, because one window can sit in two sessions at
once. Moving a window leaves the handle pointing at a placement
that no longer exists, so read the moved window back from a fresh snapshot
instead of reusing the handle that moved it.

The choosers and popups all need a client, and they divide on what awaiting
one means. A popup and a menu stay open until someone dismisses them, and tmux
answers only then, so the promise reports that it is over:

<!-- static: each stays on screen until a person dismisses it -->

```ts
await pane.displayPopup("less README.md");
await pane.displayMenu("Pane", [{ command: "kill-pane", key: "k", name: "Kill" }]);
```

The rest resolve as soon as the chooser is on screen. Awaiting one tells you it
opened, never what was chosen — measured on tmux 3.7c, where `choose-tree`
returns in milliseconds against the seconds a menu spends waiting to be
dismissed. Bind a tmux command to the selection if you need to act on it:

## Handles and options

`refreshed` answers with a new handle rather than advancing this one, so use
what it returns. `equals` compares the connection and daemon generation as well
as the tmux id, because `%1` is unique only within one running daemon — two
servers both have one, and so does the pane that replaced it after a restart.
`sameTmuxIdAs` is the raw-id comparison when that is genuinely what you want.
Every handle also has `showOptions` / `setOption` / `unsetOption`, and `format`
for tmux's own field names. [`Pane.pipeTo`](https://libtmux.org/en/ts/latest/reference/pane-pane-pipeto/) streams a pane to a command for as
long as the pipe is open, and [`Server.saveBuffer`](https://libtmux.org/en/ts/latest/reference/server-server-savebuffer/) writes a buffer to a file
without bringing it back through this process. Those read one object's own view: a session that
has set nothing reports nothing, while the values actually governing it are
tmux's global defaults. [`Server.showGlobalOptions`](https://libtmux.org/en/ts/latest/reference/server-server-showglobaloptions/), [`setGlobalOption`](https://libtmux.org/en/ts/latest/reference/server-server-setglobaloption/) and
[`unsetGlobalOption`](https://libtmux.org/en/ts/latest/reference/server-server-unsetglobaloption/) reach those, taking `"session"` or `"window"` for which
table — `history-limit` and `default-shell` live in the first, `remain-on-exit`
in the second, and none of the three is readable any other way.
`showResolvedOptions` answers the other question: what governs this object,
with its own values and everything it inherits resolved into one map.

## Batching

Creating things one at a time costs two tmux invocations per mutation: one runs
its command and one captures the snapshot needed to find what it made. That
second one is what turns the id into a handle — tmux prints the
new id, but a handle is only meaningful inside a consistent graph, and acquiring
one is the whole server. A batch shares a single final snapshot across all of
its mutations, so twelve windows cost 14 invocations rather than 25 —
twenty-four against thirteen for the creations themselves, plus in each case the
one query that reads the result back. [The benchmarks](benchmarks.md)
measure both. The invocation counts hold anywhere; the snapshot's wall-clock
grows with the server, at about 1.6 ms per pane on the machine that page
reports.

For a command this package does not model, or one whose output you want raw,
[`pipeline`](https://libtmux.org/en/ts/latest/reference/server-server-pipeline/) takes arguments and returns a result per command, in order — so a
creating command's `-P -F` lands where you asked for it and a silent command
stays empty rather than shifting the one behind it:

It is not atomic. tmux runs the commands in order and stops at the first
failure, leaving everything before it applied; the `TmuxCommandError` names the
command that failed rather than the whole sequence. Take a `snapshot()`
afterwards when you need to know what survived.

Each command is a separate tmux invocation. Arbitrary command output has no
delimiter that a command alias cannot replace or print, so one combined stream
cannot promise positional results.

## Waiting and recipes

Name the session to watch when reading pane output. Structural notifications —
a window opening, a session renaming — reach a control client wherever it is
attached, but tmux sends pane output only for the session that client attached
to, and an untargeted `watch()` lands on whichever session tmux considers
current. On a server with one session that is the one you meant; on a server
with two it is silence and no error.

A pane echoes what is typed into it, so waiting for text that also appears in
the keys you just sent matches the echo rather than the output. Wait for
something the command prints.

[`capture()`](https://libtmux.org/en/ts/latest/reference/pane-pane-capture/) reads the visible pane; pass `start` to reach into the scrollback.
`sendKeys` presses Enter unless you say otherwise, and takes keys literally with
`{ literal: true }` when the text could be read as a tmux key name. The keys and
the Enter travel as two commands in one tmux invocation, so nothing interleaves
between them and tmux resolves each against the pane as it finds it — a key
that leaves copy mode is followed by an Enter the pane itself receives.

## Program runs

`Server.run` and `Server.spawn` start `argv` in a pane of its own, with nothing
typed, so the output holds no command line or echo. In short:

- One tmux command list starts the program and waits for its exit, so no exit
  is missed.
- A small `sh` runs it and lingers 50 ms, so tmux reads the last output first.
- `kill()` sends SIGTERM, then SIGKILL, to the process group, and returns once
  tmux has reaped it or two seconds after the SIGKILL.
- Should the caller die, tmux removes the run and ends an overdue program.

Each step below is the one that held when measured; the version table says
where.

| tmux          | Program runs         | Why                                                                |
| ------------- | -------------------- | ------------------------------------------------------------------ |
| 3.8 and newer | Supported            | `wait-for -E` reports the exit; the pipe closes when the pane dies |
| 3.7 to 3.7c   | `VersionTooLowError` | No `wait-for -E`; a remain-on-exit pane never closes its pipe      |
| 3.3a to 3.6b  | `VersionTooLowError` | Also: `history-limit` does not reach an existing pane              |

### Starting the program

- The session's one pane starts with a placeholder that exits at once and stays
  as a dead pane, so its id exists before the program does.
- `remain-on-exit` is set in the list that creates the session: set by a second
  invocation, it arrives after an instant program's pane is already gone.
- The pane is respawned with `sh` and `argv` as its positional parameters, so
  `sh` does not parse them and `argv[0]` is always a program name, never shell
  text or an assignment the way `env` would read `A=b`.
- That `sh` runs the program in a subshell and lingers 50 ms after it, then
  exits or dies the way it did. tmux removes a pane on its child's exit once
  `FIONREAD` reads 0, which on Linux misses output still in the pty's flip
  buffer, so a program that exits right after writing could lose the end of
  its output under load. `pane_pid` is that `sh`, and
  `pane_current_command` names it.
- Its own signals are caught, not ignored, so the program keeps the default
  dispositions, and a status above 128 is re-raised as that signal, as a shell
  reports one.
- A start directory is entered by that `sh`, not by tmux's `-c`, which falls
  back to `$HOME` for one it cannot enter: a missing one ends the run with exit
  code 126 and the shell's message, and its `#` is never expanded.

### Waiting for the exit

- No exit is missed: the waiter exists before tmux can see the program exit,
  because tmux handles no other event inside one command list.
- That list holds the respawn, the optional `pipe-pane`, a `wait-for -S` on a
  channel of the run's own, and a
  `wait-for -E -F '#{==:#{pane},%N}' pane-died` waiter.
- Setup waits on that channel rather than polling: a channel signalled before
  its waiter arrives stays woken.
- A death counts only once tmux has the exit status: `pane_dead` turns 1 when the
  pty closes, which can come first.
- The wait still reads the pane every second, because tmux fires no event for a
  pane killed from outside.
- The list ends in that wait, so it holds no slot of `maxInFlight` for the
  program's life; each live program costs one waiting tmux client instead,
  a process far larger than what the tmux server adds.

### Ending it

- `kill()`, and the end of a run's timeout, send the program's process group
  SIGTERM and, two seconds later, SIGKILL, then return once tmux has reaped it, or two seconds after the SIGKILL.
  Removing the session only closes the pty, which a program ignoring SIGHUP
  outlives.
- The signal goes through `run-shell` on the tmux server's own machine, where
  the pane's pid names that process. `kill -s NAME -- -PID` is the form every
  `/bin/sh` accepts: dash refuses `kill -NAME -- -PID`.
- A spawn whose setup fails after the program started ends it the same way.

### When the caller dies

- A run sets a `pane-died` hook on its pane that removes the session a minute
  after the program exits. tmux runs a hook itself; a queued command would not
  survive, because tmux drops a departed client's queue (`server_client_free`).
- A run with `timeoutMs` also queues `run-shell -b -d`, a timer the tmux server
  keeps after its client is gone. A minute past the deadline it SIGKILLs the
  process group if the pane is still alive; the death fires the hook.
- The timer reads the pane's state when it fires (`##` defers the format), so a
  pane already dead, whose pid may name another process by then, is never
  signalled. It kills rather than removes, since a pane destroyed before its
  death is seen fires no `pane-died` and leaves the run's own waiting client
  blocked.
- A run without `timeoutMs` keeps a program that never exits, and a spawn leaves
  cleanup to its caller, including a `stream: true` copy in the temporary
  directory.
- The hook and the timer arrive with the program. A caller killed in the moment
  between creating the session and starting the program leaves the dead
  placeholder's session, which nothing removes.
- Each run leaves its timers in the tmux server until they fire: the hook's a
  minute after the exit, and the deadline's a minute past `timeoutMs`. Once the
  session is gone, each does nothing.

### From another pane

- With `from`, the placeholder is a new window of that pane's session, created
  `-d` so no client's view moves, by a unique name that the same list sets
  remain-on-exit on, which keeps even an instant placeholder.
- It starts in `#{pane_current_path}` and gets the session's tmux environment.
- The program owns only that window: `kill()` and the after-exit hook remove the
  window, never the session. Size and `historyLimit` belong to the session, so
  `from` refuses them.

### Output and streams

- `output()` and `run`'s `output` are `capture-pane` of the program's pane,
  scrollback included and wrapped lines joined. Tabs and trailing spaces are
  kept, colors dropped, and blank lines after the last printed one left out,
  since the pane's unused rows read as blank too. What a program draws on the
  alternate screen, as `less` and `vim` do, is gone once it leaves that screen;
  `stream()` has every byte.
- The pane's history, up to its limit, is the run's memory in the tmux server,
  and tmux keeps that memory from the system after the session is removed.
- `truncated` reads `#{history_collected}`, the lines tmux dropped past
  `historyLimit`; `history_size` stays below the limit after tmux drops a chunk,
  so it cannot say.
- `stream()` reads a file that `pipe-pane -O` writes in the program's own 0700
  temporary directory. tmux keeps a dying pane until its pipe has drained
  (`window_pane_destroy_ready`), so the last write arrives.
- A control client cannot promise that: `control_write_pending` discards output
  still queued once the pane's fd closes, and a raw `tmux -C` client often
  missed the last write, on every release measured from 3.3a to tmux master, when the
  program exited right after writing it.
- The copy grows with the output until the program is killed or disposed.
- The file is written on the tmux server's machine, so `stream: true` refuses a
  server that cannot write to this process's temporary directory. Its path has
  its `#` and `%` doubled, since `pipe-pane` expands its command as a format and
  with strftime.
- A kill ends a stream in progress with `LibTmuxError`, and a pane removed from
  outside ends it with the wait's `ObjectNotFoundError`, after what arrived.
- The reader polls the copy every 25 ms, which behaves the same on every
  platform and filesystem.

A `Program` is made from its prototype rather than by `new`, so its constructor
is not public API.

## Watching

Each `watch()` or `connect()` owns a real attached tmux client until it closes.
That client appears in snapshots, increments `session_attached`, and is visible
to client hooks and attachment-sensitive policy such as `destroy-unattached`.
Multiple watches or connections create multiple clients.

Events are a discriminated union, so `event.kind` narrows the rest of the shape
with no cast. Names are tmux's own, without the leading `%`, and a notification
this version does not model arrives as `{ kind: "unknown", name, args }` rather
than being dropped.

The stream is an `AsyncDisposable`, so `await using` ends the tmux process when
the scope exits, including on a thrown error. A consumer that falls behind gets
its oldest events dropped and the buffer stays bounded; `events.dropped`
counts them and `bufferSize` sets the bound.

That bound is this side's. tmux keeps its own, and its remedy for a client that
lets a pane's output back up is to kill it — five minutes behind and the whole
connection goes with `too far behind`. `pauseAfterSeconds` asks tmux to pause
the one pane instead:

tmux then reports `pause` for the pane it stopped, the connection asks it back
at once, and `continue` follows. The pair records what was missed; there is
nothing to act on.

`watch()` is the notification observer and owns this pacing policy. `connect()`
adds the same event channel and daemon-lifetime tracking to a server; its
commands still use ordinary tmux processes.

tmux sends a control client no pane output until it attaches, so watching
attaches to a session. A server with no sessions has nothing to watch, and a
client hears about the session it attached to — name the one you care about
with `target` rather than relying on whichever tmux considers most recent.

`await using` needs `Symbol.asyncDispose`, so a consumer's `lib` includes
`ESNext.Disposable` alongside its ECMAScript target. `events.close()` is the
same operation for a project that cannot add it.

tmux expands each subscription at most once per second and reports only when the
value differs from the last report for that object, so each report marks a
change. The first evaluation always reports.

`scope` takes a pane or window id, `"all-panes"`, or `"all-windows"`; omitted,
the format expands once per session. A report names the object it expanded
against, so a pane-scope one carries `paneId`, `windowId` and `windowIndex`.

A connected server adds and drops them while it runs with [`subscribeFormat`](https://libtmux.org/en/ts/latest/reference/types-connectedserver-subscribeformat/) and
[`unsubscribeFormat`](https://libtmux.org/en/ts/latest/reference/types-connectedserver-unsubscribeformat/). A subscription belongs to the control client, so the
connection re-issues its own after a reconnect.

Each `subscribe()` is an independent view with its own buffer, so a loop and a
`waitFor` can run side by side without taking each other's events.

A connection can reopen itself after a drop with
`watch({ reconnect: { attempts: 3 } })`, which reports a `reconnected` event so
the gap is visible. The count bounds one outage rather than the connection's
whole life, so a watcher that recovers today still recovers next week. It is off
by default. A connected server refuses to start commands while its observer is
reconnecting; after the attach, it binds each new command to the daemon carrying
that observer. It never replays a mutation.

The API is the same `Server`. Connecting adds the observer and daemon binding;
commands, including [`loadBuffer`](https://libtmux.org/en/ts/latest/reference/server-server-loadbuffer/), still use the server's engine.

`waitFor` subscribes before it reads, so a change landing between the two is
still seen rather than leaving you waiting on something that already happened:

To wait for a single event, `find` takes the first match and answers
`undefined` on its deadline. It raises instead when the connection ends, so the
`undefined` a caller reports on is only ever the thing not happening:

## Observing

[`TmuxInvocationReport`](https://libtmux.org/en/ts/latest/reference/common-tmuxinvocationreport/) is exported for a typed collector. Every command
reports, including the identity read and four listings behind `snapshot()`,
the version probe, and commands a custom engine executed. The report carries
the commands tmux received, `durationMs` for the invocation itself, `queuedMs`
for any wait under `maxInFlight`, `exitCode` when tmux answered, and `error`
with `delivery` when it did not.

An observer cannot change what a command does. Anything it throws is
swallowed: a command must not fail on account of the code watching it. An
`async` observer is allowed and is never awaited — the invocation is already
decided, so waiting would only delay it — and a rejection is swallowed on the
same grounds rather than left to the host's unhandled rejection policy.

[`examples/observe/`](../../../examples/observe/README.md) runs this against a
real server, and counts its own reports to check the two costs above rather
than restate them.

## Deadlines and cancellation

A cancelled or timed-out command always rejects with a [`TmuxTransportError`](https://libtmux.org/en/ts/latest/reference/errors-tmuxtransporterror/)
rather than with the reason itself, because the error also says how far the
command got — `delivery` distinguishes one tmux never started from one it may
have run. What you passed to `abort()` is preserved as `cause`.

Every operation that takes options accepts both, so the rule you learn on one
method holds on the next. The default applies to every command the server runs,
including the version probe it makes first and the identity read plus four
listings behind `snapshot()` — except a popup, a menu, a prompt, a confirmation,
`display-panes` and `wait-for`. Those wait on a person or on another command,
and a default would cut them off; a deadline passed on the call still binds
them. `signal` is
typed structurally, so a real `AbortSignal` satisfies it without the published
types requiring a DOM or Node library.

## Concurrency and engines

The ceiling costs no throughput, because there was none to lose: tmux runs
commands on one thread. [The benchmarks](benchmarks.md) show `Promise.all`
over twelve creations costing the same twenty-five processes as doing them in
order, and arriving out of order in two or three of every three runs. Fanning
out buys no work — `pipeline` does the same twelve in thirteen. Both totals
count the query that reads the result back, which is why neither is a multiple
of twelve.

An invocation whose last command blocks (`wait-for`, a popup, a prompt or a
menu) takes no slot, whatever runs before that command: it holds a client for as
long as the wait, and what releases it may need a slot. An invocation with a
command after the wait counts. A program's run is one of the first kind, so it
holds no slot for its life.

Waiting for a slot spends the request's own deadline rather than extending it.
A request that never gets one raises `TmuxTransportError` with
`delivery` of `"not_started"` — the one status a mutation may retry blindly —
and `signal` cancels the wait as it cancels the command.

An engine can put tmux behind SSH, a container, or a daemon. It receives the
complete invocation, including environment, stdin, cancellation, and deadline.
This runnable example keeps execution local on the current server's socket; a
remote runner has the same obligations:

The seam is one structured invocation in and bytes plus status out. One at the
graph would make every implementer responsible for framing, capability gating
and normalization; this one leaves them responsible only for execution. The
request carries global flags and a nonempty command list separately, so an
engine cannot accidentally split a snapshot into several clients. Honour its
[`daemonGuard`](https://libtmux.org/en/ts/latest/reference/engine-daemonguard/) with `guardRequest`, or bind the engine to one daemon.

`watch()` and `connect()` are the two calls an engine does not carry. Both hold
a local `tmux -C attach` process open, which is the thing an engine exists to
avoid needing, so they refuse rather than attaching to whichever tmux this
machine happens to be running.

`pipeline` and `batch` stay per-call-site choices because both stop at the first
failure. `batch` adds one final snapshot that turns printed ids into handles;
`pipeline` returns the printed lines directly.

Use `pipeline` or `batch` when command order matters; a connection does not make
concurrent mutations safe to reorder.

## Options and environments

Typed option and hook methods treat names as literal data, including `#`. Use
`cmd` when deliberately asking tmux to expand a computed name.

Window and pane scopes report only what was set on them, never inherited
values. [`OptionScope`](https://libtmux.org/en/ts/latest/reference/constants-optionscope/) supplies the same lowercase scope values when a named
constant is clearer than a string literal.

[`removeEnvironment`](https://libtmux.org/en/ts/latest/reference/server-server-removeenvironment/) is the middle row and [`unsetEnvironment`](https://libtmux.org/en/ts/latest/reference/server-server-unsetenvironment/) is the last: the
first leaves an entry saying "unset this before spawning", which is how tmux
keeps a stale `SSH_AUTH_SOCK` out of a new pane. Removal marks are routine
rather than exotic — tmux's own `update-environment` puts several in every
session. [`SetEnvironmentOptions`](https://libtmux.org/en/ts/latest/reference/types-setenvironmentoptions/) covers tmux's `-F` and `-h` as `expandFormat`
and `hidden`, and [`EnvironmentScope`](https://libtmux.org/en/ts/latest/reference/types-environmentscope/) names the two scopes.

## Errors

`delivery` is the question a retry depends on. `not_started` is the only value
that is safe to retry blindly; after a timeout the answer is `indeterminate`,
because tmux may well have created that window before the pipe went quiet. Every
path reports the same type, so a timeout during `snapshot()` is not a different
shape from a timeout during `kill()`.

The refusal comes from tmux: a command carrying a raw id goes as `if-shell -F` conditioned on the
daemon's pid and start time, and tmux evaluates that inside the same command
queue entry that would run it. The connected observer invalidates its runtime
when that daemon disappears.
Reading a stale handle's captured fields still works; only commands are refused.

A query that matches nothing raises [`NoMatchError`](https://libtmux.org/en/ts/latest/reference/errors-nomatcherror/), one that
matches several where you asked for one raises [`MultipleMatchesError`](https://libtmux.org/en/ts/latest/reference/errors-multiplematcheserror/), and
criteria the schema rejects raise `QueryValidationError`. A `waitFor` that
reaches its deadline with the condition still unmet raises
[`WaitTimeoutError`](https://libtmux.org/en/ts/latest/reference/errors-waittimeouterror/), which is worth catching by name: it says the state never
arrived, where a `LibTmuxError` from the same call says only that the
connection ended and nothing about the condition. A criterion naming a field
newer than the tmux that answered raises [`VersionTooLowError`](https://libtmux.org/en/ts/latest/reference/errors-versiontoolowerror/) rather than
matching nothing — the error names the field, the release that has it, and
the release running, because "no pane has this" and "your tmux has never
heard of this" are different answers.

Two bases sit above those. Catch [`ObjectNotFoundError`](https://libtmux.org/en/ts/latest/reference/errors-objectnotfounderror/) for "not there, however
you asked": a query that matched nothing (`NoMatchError`) and tmux refusing a
target that does not exist ([`TmuxObjectNotFoundError`](https://libtmux.org/en/ts/latest/reference/errors-tmuxobjectnotfounderror/)) both extend it.
[`MultipleObjectsError`](https://libtmux.org/en/ts/latest/reference/errors-multipleobjectserror/) is its counterpart and has one subclass today,
`MultipleMatchesError`; it stays so the pair reads the same, and so code ported
from Python, which catches `ObjectDoesNotExist` and `MultipleObjectsReturned`,
has a name to catch. Import library errors from `libtmux` or `libtmux/errors`.

`libtmux/selection` carries [`parseLegacyWhere`](https://libtmux.org/en/ts/latest/reference/selection-parselegacywhere/), which converts Python-style
`name__contains=` filter strings into criteria. It is for code being ported
rather than written fresh, so it sits on the subpath rather than in the root
export, as the engine and type inventories do.

Use these error names. The old names remain deprecated aliases to the same
constructors, so existing `instanceof` checks still work. `error.name` reports
the canonical name. The `libtmux/exc` entrypoint remains a compatibility export;
use `libtmux/errors` for new imports.

`QueryValidationError.code` is now `reason`, because every error now carries a
`code` naming its own class.

Completed command results, including custom [`TmuxEngine`](https://libtmux.org/en/ts/latest/reference/engine-tmuxengine/) results, use
`exitCode` instead of `returncode`. Update result construction and property
reads together. `TmuxCommandError.exitCode` is unchanged. Transport failures
retain their `kind`, `delivery`, partial output and optional signal; they
have no completed exit code. A `TmuxEngine` that resolves without a numeric
`exitCode` raises `TmuxTransportError` with `kind: "contract"` rather than
being read as a failed command.

Use [`server.checkAlive()`](https://libtmux.org/en/ts/latest/reference/server-server-checkalive/) in place of the deprecated [`server.raiseIfDead()`](https://libtmux.org/en/ts/latest/reference/server-server-raiseifdead/).
Both reject when the server cannot be reached.

For [`pane.split()`](https://libtmux.org/en/ts/latest/reference/pane-pane-split/), `window.split()` and planned splits, replace
`vertical: true` with `direction: PaneDirection.Below`, and `vertical: false`
with `direction: PaneDirection.Right`. Omitting both still splits below. The
legacy `vertical` option is deprecated; passing it with `direction` throws
`TypeError` before executing a command.

## Entry points and testing

The root export carries the everyday handle, query, operation, error, and
constant surface. Each model is also its own subpath: `libtmux/server`,
`libtmux/session`, `libtmux/window`, `libtmux/pane`, `libtmux/client`, and
`libtmux/selection`. Supporting subpaths are `libtmux/formats`,
`libtmux/constants`, `libtmux/common`, and `libtmux/errors`.

A recording is JSON and replays a run rather than answering a query: the same
calls in the same order get the same answers, and one the recording never saw
raises rather than reporting an empty server. Record guards are rewritten to
the ones each replayed call asks for, so a fixture is not tied to the run that
made it.

Four specialist subpaths keep their complete contracts out of the root:
`libtmux/engine` for custom execution engines, `libtmux/types` for the full
operation and event type inventory, and `libtmux/field-types` for generated
format-field, decoded-value, and handle-alias types.

## tmux versions

`bun run test:compat` runs the real-tmux gates against every build in
`LIBTMUX_TMUX_BUILDS` (a directory of prefixes) plus whatever is on PATH, and
says so when it only found one. CI runs them against both ends of the range and
a release in between, since a difference between two releases is only visible
when both are present.

`raw` is tmux's own string, so a development form such as `next-3.8` survives
the parsed fields. Versions rank `next-X.Y` below `X.Y-rc`, below `X.Y`, below
`X.Ya`, so a development build or candidate has not yet reached the release it
names, and a form tmux does not print is refused.

A daemon, or an executable that would start one, older than tmux 3.3a is
refused before anything is sent to it, with `VersionTooLowError` and a
`delivery` of `not_started`. A version libtmux does not recognize, such as bare
`master`, is refused the same way. To continue, upgrade tmux and restart the
server, or pin the previous libtmux release:

## Parity with the Python library

`parity/python-0.62.0.json` is a ledger against libtmux 0.62.0. Every public
symbol in that release carries a decision: ported directly, adapted to a shape
that suits TypeScript better, or not ported for a recorded reason. A ported or
adapted symbol also names the TypeScript that covers it and the test that proves
it.

What is not ported mostly falls into three groups: neo.py, whose
responsibilities are split across the generated metadata, the codec, the graph,
and the handles; the pytest helpers, which have an equivalent here that is
internal and unpublished; and tmux's interactive commands, which resolve before
the user acts and so cannot be reported by a promise.

That last group is reachable through `cmd`, so "not ported" means "no typed
wrapper", not "out of reach".

A gate checks that every symbol the ledger names exists in the package, which
is what stops a recorded mapping from drifting away from the code.

## Dependencies

None. The package installs a tmux client and nothing else — no third-party code
to audit, pin, or deduplicate, and no transitive tree at all.

Validation of tmux's own output is real work, so it did not go away: it lives in
a small internal validator with a Zod-shaped surface. Its failures carry the
value that failed, which Zod reports only by type.

## Documentation gates

Every TypeScript block in this README is typechecked against the working tree by
`bun run typecheck:readme`, each one on its own, so a snippet here cannot drift
from the signature it documents.

`bun run typecheck:ambient-free` compiles a consumer against the emitted
declarations with no ambient types in scope — no `@types/node`, no DOM — so the
published types cannot start requiring either without the gate saying so.
