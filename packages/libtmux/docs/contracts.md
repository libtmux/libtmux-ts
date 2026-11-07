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
they already hold, `{ session: { is: { id } } }` to scope to it. Consumers
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

`Server.run` and `Server.spawn` start `argv` in a pane of its own and type
nothing into it.

- One tmux command list starts the program and waits for its exit, so tmux
  cannot see the exit before the exit watch exists.
- A wrapper `sh` runs it and lingers 50 ms before exiting; in none of the 15000
  `seq 1 3000` runs measured below on each tmux did tmux then miss the last
  output.
- `kill()` sends SIGTERM, then SIGKILL, to the process group, and returns once
  tmux has reaped it or two seconds after the SIGKILL.
- Every run and spawn holds a lease that the caller renews, unless
  `orphanAfterMs` is `null`. Should the caller die, tmux ends the program and
  removes its pane.
- After the program, the `sh` writes a mark tmux reads only if it read
  everything before it, so `lostEnd` reports a lost end.

| tmux          | Program runs         | Why                                                                |
| ------------- | -------------------- | ------------------------------------------------------------------ |
| 3.8 and newer | Supported            | `wait-for -E` reports the exit; the pipe closes when the pane dies |
| 3.7 to 3.7c   | `VersionTooLowError` | No `wait-for -E`; a remain-on-exit pane never closes its pipe      |
| 3.3a to 3.6b  | `VersionTooLowError` | Also: `history-limit` does not reach an existing pane              |

tmux 3.8 [added `wait-for -E`](https://github.com/tmux/tmux/blob/3.8/CHANGES#L82-L83),
and its `server_destroy_pane`
[closes the pipe](https://github.com/tmux/tmux/blob/3.8/server-fn.c#L375-L380)
whatever `remain-on-exit` says. tmux 3.7
[applies a changed `history-limit` to existing panes](https://github.com/tmux/tmux/blob/3.8/CHANGES#L491-L492).

What each outcome looks like to a caller:

| What happened                                                      | What the caller sees                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| The program ended                                                  | `exitCode`, or `signalCode` with `exitCode` null when a signal ended it                                                |
| Its output's start scrolled past `historyLimit`                    | `lostStart`                                                                                                            |
| tmux removed the pane before reading the end                       | `lostEnd`; `stream()` ends with `OutputLostError`                                                                      |
| The stream copy reached `maxStreamBytes`                           | `stream()` ends with `StreamLimitError`; the program runs on                                                           |
| `run`'s `timeoutMs` passed                                         | `timedOut`, with the output so far                                                                                     |
| `argv[0]` cannot run, or `startDirectory` cannot be entered        | `ProgramStartError` from `run`, `wait()` and `stream()`, with `reason` and a shell's `exitCode`, 127 or 126            |
| `signal` fired                                                     | `TmuxTransportError` of kind `cancelled`, whose `delivery` says whether it had started                                 |
| tmux had not started the program after ten seconds                 | `LibTmuxError`; the pane is removed unless `keep` is set                                                               |
| The pane was killed from outside, its server with it or not        | `ObjectNotFoundError` from `wait()`, `output()` and `run`; the program is hung up, and one that ignores SIGHUP runs on |
| The caller died                                                    | tmux ends the program within `orphanAfterMs`                                                                           |
| `input`, `stream` or `separateStderr` with a tmux server elsewhere | `ServerNotLocalError`, before the program starts                                                                       |

What a run does not do:

- `output` is the terminal's rendering: escapes are applied, NUL and other
  control bytes are dropped, and wrapped lines are joined. `spawn` with
  `stream: true` yields what the program wrote, escapes included.
- stderr shares the terminal unless `separateStderr` keeps it apart, which needs
  the tmux server on this machine and leaves stderr no terminal.
- `lostEnd` leaves the exit status exact; only the output's tail is unproven.
  Run again a program that can be repeated, or have it write its output to a
  file through `sh -c`.
- A program a signal ended reads `signalCode`, with `exitCode` null.
- A program's alternate screen is gone once it leaves it, as in a terminal, so
  `output` holds only what the main screen kept.
- `argv` and `environment` go to tmux in one command, which tmux caps at about
  16 KiB, and a longer one is refused before the program starts; data that size
  belongs in `input`.
- A run costs a few tmux round trips and the 50 ms linger: `true` took about
  71 ms a run one after another, and sixteen side by side about 0.5 s in all,
  under half what they take in turn. [Benchmarks](benchmarks.md#running-a-program)
  has the run.

### Starting the program

- The session's one pane starts with a placeholder that exits at once and stays
  as a dead pane, so its id exists before the program does.
- `remain-on-exit` is set in the list that creates the session: set by a second
  invocation, it arrives after an instant program's pane is already gone.
- `destroy-unattached` is turned off for that session in the same list. tmux
  [checks it](https://github.com/tmux/tmux/blob/3.8/server-fn.c#L530) as each
  client [goes](https://github.com/tmux/tmux/blob/3.8/server-client.c#L565), so
  under `destroy-unattached on` the client that made the session would take it
  with it. Every other session keeps the option.
- The pane is respawned with `sh` and `argv` as its positional parameters, so
  `sh` does not parse them and runs `argv[0]` as a program name, `A=b`
  included, which `env` would read as an assignment.
- That `sh` runs the program in a subshell and lingers 50 ms after it, then
  exits with the status it saw; [the end race](#the-end-race) says why. Where
  `sleep` takes no fraction, it lingers a second instead. 50 ms is the one
  linger measured; shorter ones were not tried.
  `pane_pid` is that `sh`, and `pane_current_command` names it.
- Before the linger, the `sh` writes ST and then an OSC 7 path naming the run,
  which tmux applies to `#{pane_path}` with no option gating it and renders as
  nothing. tmux reads a pane's bytes in order, so a pane whose path is the run's
  mark was read to the end. `lostEnd` and `stream()` report a missing mark, as
  `OutputLostError` for a stream. A SIGKILL to the process group ends the `sh`
  before its mark too, which leaves the end unproven, so it counts as missing.
- The wrapper catches INT, QUIT and TERM with an empty handler, which `exec`
  resets, so the program keeps the default dispositions and the wrapper
  outlives it to report. It leaves HUP
  alone: a pane closed from outside hangs up the `sh`, and the kernel then
  hangs up the program, as it would a shell's. The `sh` exits with the status it
  saw, and the library reads 128 plus a signal's number as that signal. POSIX
  `sh` cannot tell a program's `exit 130` from a SIGINT death, so the first reads
  as SIGINT too, which is what that status means by convention; a status above
  128 that names no signal stays an exit status.
- A start directory is entered by that `sh`, not by tmux's `-c`, which falls
  back to `$HOME` for one it cannot enter, and its `#` is never expanded.
- The program's `PATH` is this process's: tmux gives a pane the `PATH` of the
  unattached client that asked for it, over the session's and over one `-e`
  passed ([`spawn_pane`](https://github.com/tmux/tmux/blob/3.8/spawn.c#L413-L424)).
  A `PATH` in `environment` is set by the wrapper instead, before it finds
  `argv[0]`.
- Before `exec`, the `sh` finds `argv[0]` as `exec` would: a path is tested as
  an executable file, and a name is looked for in each `PATH` directory, past
  builtins, which `command -v` would report. When that fails, or the start
  directory cannot be entered, it prints a complaint, skips the program, and
  writes the mark with `:` and the reason after it, through the linger. A wait
  then rejects with `ProgramStartError`, and a stream ends with it. A file
  found on `PATH` that cannot be executed is 126, as `exec` reports it, unless a
  later directory holds one that can. What `exec` meets past the file itself,
  such as a script whose `#!` interpreter is missing, comes back as its exit
  status, 127 for that one.

### The end race

tmux removes a pane on its child's exit
([`server_child_exited`](https://github.com/tmux/tmux/blob/3.8/server.c#L491-L511))
once `FIONREAD` reads 0
([`window_pane_destroy_ready`](https://github.com/tmux/tmux/blob/3.8/window.c#L495-L517)).
On Linux, as read in the 6.18 kernel WSL2 ships, `FIONREAD` counts only what
the line discipline holds
([`n_tty_ioctl`](https://github.com/microsoft/WSL2-Linux-Kernel/blob/d504d40ab83839cb61942a812a99d183c42227b9/drivers/tty/n_tty.c#L2500-L2507)),
not bytes still queued for
[`flush_to_ldisc`](https://github.com/microsoft/WSL2-Linux-Kernel/blob/d504d40ab83839cb61942a812a99d183c42227b9/drivers/tty/tty_buffer.c#L462),
so a program that exits right after writing can lose the end of its output: 8 to
16 of 15000 runs did without the wrapper, as measured below.

[`scripts/measure-program-end.ts`](../scripts/measure-program-end.ts) measures
the loss and the mark with the wrapper as it ships, three probes in parallel,
over rounds. Run as
`bun scripts/measure-program-end.ts 1000 5` on Linux 6.18 under WSL2, with
3.8, with 3.8a (the `release_3.8a` branch at
[089ad94](https://github.com/tmux/tmux/commit/089ad94e13c560db99fd4989b2774a5c6ad37a17))
and with master at
[523ac69](https://github.com/tmux/tmux/commit/523ac69601e1ea51a8ba718d32df6a00e4d0f6d4),
15000 runs a cell, each cell giving its runs that lost the end per round of
3000 and in all:

| Lost: range a round, total | No wrapper | Mark only | Linger and mark |
| -------------------------- | ---------- | --------- | --------------- |
| 3.8                        | 0-4, 8     | 0-7, 10   | 0-0, 0          |
| 3.8a                       | 1-5, 16    | 0-8, 10   | 0-0, 0          |
| master                     | 0-4, 9     | 0-0, 0    | 0-0, 0          |

None of the 20 runs the mark-only shape lost showed the mark. A whole run that
lost only its mark would read as a lost end, and tmux reads a pane's bytes in
order, so a shown mark cannot follow a lost end. `window_pane_destroy_ready`
checks the same `FIONREAD` on all three
([3.8](https://github.com/tmux/tmux/blob/3.8/window.c#L501),
[master](https://github.com/tmux/tmux/blob/523ac69601e1ea51a8ba718d32df6a00e4d0f6d4/window.c#L504)).
Only this kernel was measured; macOS and other Linux kernels count pending
bytes their own way.

### Waiting for the exit

- The exit watch, a `wait-for -E` client, exists before tmux can see the
  program exit, because tmux handles no other event inside one command list.
- That list holds the respawn, the optional `pipe-pane`, a `wait-for -S` on a
  channel of the run's own, and the exit watch,
  `wait-for -E -F '#{==:#{pane},%N}' pane-died`.
- Setup waits on that channel, and a channel signalled before its waiter
  arrives stays woken, so the wait cannot miss the start.
- A death counts only once tmux has the exit status: `pane_dead` turns 1 when
  the pty closes, which can come first.
- The wait still reads the pane every second, because tmux fires no event for a
  pane killed from outside, so it raises `ObjectNotFoundError` within about a second
  of such a kill.
- The list ends in that wait, so it holds no slot of `maxInFlight` for the
  program's life; each live program costs one tmux client, its exit watch. With
  50 programs on 3.8a, each client held about 4 MiB, while the tmux server grew
  by about 3 MiB for all of them
  ([#117](https://github.com/libtmux/libtmux-ts/issues/117) has the run).

### Ending it

- `kill()`, and the end of a run's timeout, send the program's process group
  SIGTERM and, two seconds later, SIGKILL, then return once tmux has reaped it,
  or two seconds after the SIGKILL. Removing the pane only closes the pty, which
  a program ignoring SIGHUP outlives.
- The signal goes through `run-shell` on the tmux server's own machine, where
  the pane's pid names that process. `kill -s NAME -- -PID` is the form every
  `/bin/sh` accepts: dash refuses `kill -NAME -- -PID`.
- A spawn whose setup fails after the program started ends it the same way.

### When the caller dies

- Every run and spawn leases its program from tmux, a minute long unless
  `orphanAfterMs` says otherwise. The pane option `@libtmux-lease` holds a
  token, and `run-shell -b -d` queues a timer the tmux server keeps after its
  client is gone.
- The lease is armed in the list that creates a session or window, so a caller
  that dies before the program starts leaves nothing, and is renewed from then
  on, however long the rest of setup takes. A window's target there is
  `$N:=name`, so every target in the timer's commands is single-quoted: tmux
  reads `$N` as a variable in an unquoted or double-quoted word. A split is
  made by one command, so its lease arrives with the program.
- The caller renews the lease every third of its length: it queues a new timer,
  then moves the token on, so a renewal that stops between the two leaves the
  last token's timer standing. A renewal still in flight is not overtaken, so
  the tokens reach tmux in order. A renewal stops only once the pane is gone.
- A timer whose token still stands when it fires SIGKILLs the program's process
  group if the pane is alive and removes its pane unless `keep` is set. A
  renewed timer does nothing.
- The run's files go a second later, from a background shell: the pane's end
  also ends a stream's writer, whose last step would otherwise recreate a file
  inside the directory being removed. The shell is not tmux's job, so it still
  runs when removing the pane's session stops the server. Files outlive a
  caller only when nothing is left to remove them: the tmux server died with
  it, or the run took no lease. They sit in a 0700 `ltx-program-` directory
  under this process's temporary directory.
- The timer reads the pane's state when it fires (`##` defers the format), so a
  pane already dead, whose pid may name another process by then, is never
  signalled. The files' path is a pane option quoted with `#{q:}`, since a
  temporary directory can hold any character.
- The renewal timer is unreferenced: a process with nothing else to do exits,
  and tmux then ends what it left running within the lease.
- Renewals run on this process's event loop, every third of the lease, and each
  sets a timer for the whole lease. A stall longer than the lease lets the last
  timer fire, and tmux ends the program as though the process had died; an
  `orphanAfterMs` above the longest stall expected keeps it.
- `orphanAfterMs: null` takes no lease: the program outlives its caller, and
  keeps its pane, its files and its exit watch until something
  removes them.
- A caller killed between creating a split and starting the program leaves its
  dead placeholder, which closes at the next key pressed in it.
- The kill and the lease signal the pane's process group. A process that
  leaves it, through `setsid` or by daemonizing, is not followed; contain such
  a program with a cgroup or a container.
- Each renewal leaves a timer in the tmux server until it fires. A timer that
  fires on a pane already removed fails to find it and does nothing; tmux never
  reuses a pane id within a server's run.

### From another pane

- With `from`, the placeholder is a new pane in that pane's session, starting
  in `#{pane_current_path}` with the session's tmux environment.
- `placement: "window"`, the default, makes it a background window, created
  `-d` so no client's view moves, by a unique name that the same list sets
  remain-on-exit on, which keeps even an instant placeholder.
- `placement: "split"` splits the pane with `split-window -d`, so focus stays
  where it was. `-m ''` sets `remain-on-exit key` and an empty
  `remain-on-exit-format` on the new pane alone, as tmux creates it, so the
  window's own options are untouched. A dead split closes at the next key
  pressed in it.
- The program owns only its window or split: `kill()` and the lease remove that,
  never the session. Size and `historyLimit` belong to the session, so `from`
  refuses them.
- `keep: true` leaves the pane, dead and showing the output, once the run
  returns or the program is killed; a person closes it.

### Input

- `input` is written to a file in the run's own 0700 temporary directory, and
  the wrapper redirects it into the program's stdin before running it, so
  the bytes pass through no shell parser and no tmux command.
- stdout and stderr stay the pane's terminal, so `output()` and `stream()` read
  as before, and a program that checks `isatty(1)` still sees a terminal.
- Before the program starts, `run-shell` writes a file into that directory; if
  it never appears here, the tmux server is on another machine and the call
  refuses before creating anything. `stream: true` takes the same check.

### Output and streams

- `output()` and `run`'s `output` are `capture-pane` of the program's pane,
  scrollback included and wrapped lines joined. Tabs and trailing spaces are
  kept, colors dropped, and blank lines after the last printed one left out,
  since the pane's unused rows read as blank too. What a program draws on the
  alternate screen, as `less` and `vim` do, is gone once it leaves that screen;
  `stream()` has every byte.
- The pane's history, up to its limit, is the run's memory in the tmux server.
- `lostStart` reads `#{history_collected}`, the lines tmux dropped past
  `historyLimit`; `history_size` stays below the limit after tmux drops a chunk,
  so it cannot say.
- `stream()` reads a file that `pipe-pane -O` writes in the program's own 0700
  temporary directory. tmux keeps a dying pane until its pipe has drained
  ([`window_pane_destroy_ready`](https://github.com/tmux/tmux/blob/3.8/window.c#L495-L517)), so whatever tmux read
  reaches the copy, and the wrapper's mark is taken out of what it yields. An
  end tmux never read ends the stream with `OutputLostError`.
- A control client cannot promise that:
  [`control_write_pending`](https://github.com/tmux/tmux/blob/3.8/control.c#L861) discards output still queued once
  the pane's fd closes. A raw `tmux -C` client got the last write of a program
  that exited right after writing it in 66 to 76 of 100 runs to a dead
  placeholder, and 35 to 49 of 100 to a live pane, on 3.3a, 3.8, 3.8a and
  master ([#118](https://github.com/libtmux/libtmux-ts/issues/118) has the run).
- The copy grows with the output until the program is killed or disposed.
  `maxStreamBytes` caps it: the pipe runs `head -c` for one byte past the cap,
  so a cut copy is told from one that fit, and `stream()` yields the cap's worth
  and throws `StreamLimitError`. The program runs on; tmux drops what the closed
  pipe no longer takes.
- The file is written on the tmux server's machine, so `stream: true` refuses a
  server that cannot write to this process's temporary directory. Its path has
  its `#` and `%` doubled, since `pipe-pane` expands its command as a format and
  with strftime.
- A kill ends a stream in progress with `LibTmuxError`, and a pane removed from
  outside ends it with the wait's `ObjectNotFoundError`, after what arrived.
- The reader polls the copy every 25 ms for as long as it is read, one small
  read a poll for each stream, which needs no file watching. A capped copy runs
  `head -c` under `stdbuf -o0` where there is one, since GNU `head` holds its
  writes to a file until it exits. That `stdbuf` gets the run's own directory
  as its `TMPDIR`: uutils' `stdbuf` leaves a directory there on every run.
  `stream({ signal })` ends the stream, and
  the program runs on.

## Pane waits

`Pane.waitForExit`, `Pane.waitForCommand` and `Pane.waitForText` wait on any
pane, whoever started it, through tmux 3.8's events.

- Each waiter is one tmux command list: `wait-for -S` on a channel of its own,
  then `wait-for -E -v -F '#{==:#{pane},%N}'` on the event. tmux handles no
  other event inside the list, so once the channel is signalled the waiter is
  registered, and only then is the pane read or the command sent.
- An exit is two events, fired one or the other: `pane-exited` for a pane that
  closes ([`server_fire_pane_exit`](https://github.com/tmux/tmux/blob/3.8/server-fn.c#L35-L56)) and `pane-died` for one that
  `remain-on-exit` keeps. A wait listens for both, and reads a pane already
  dead from `pane_dead_status` and `pane_dead_signal`.
- A pane that closes takes its status with it; the event's payload carries it,
  so the wait reads it from there.
- `-v` prints the payload of every event the waiter checked, matching or not,
  each as its keys in sorted order, so a key that does not sort after the one
  before it starts the next event, and the match is the last.
- `kill-pane` fires neither event, so the waits read the pane every second.
  Once it is gone, `waitForExit` and `waitForCommand` give the event a closing
  pane fires up to a second to arrive, then raise `ObjectNotFoundError`, within
  about two seconds of the kill; `waitForText` raises at that read.
- A command's end is `pane-command-finished`, which tmux fires on an OSC 133 `D`
  mark with the status in `command_status`; a mark without a status reports 0,
  and one tmux cannot read as 0 to 255 reports 255
  ([`input_osc_133_exit_status`](https://github.com/tmux/tmux/blob/3.8/input.c#L3197-L3222)). A shell's first prompt marks an end
  too, before any command ran.
- Events are not replayed to a waiter that arrives late, which is why the pane
  is read only after the waiter is registered.
- Text is `pane-activity`, which tmux fires the first time a pane prints in a
  pass of its event loop
  ([`input_parse_buffer`](https://github.com/tmux/tmux/blob/3.8/input.c#L1052-L1057))
  and re-arms at the end of each pass
  ([`server_client_loop`](https://github.com/tmux/tmux/blob/3.8/server-client.c#L1933-L1941)).
  `waitForText` arms a waiter, reads the visible screen with `capture-pane -J`,
  and arms the next only once that one fires, so output after a read always
  wakes another. A busy pane is read at most every 50 ms, and a quiet one once
  a second, which also notices a pane that died.

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

With `outputBytes: true`, output events also carry `bytes`: an owned
`Uint8Array` of the unescaped payload tmux delivered in that notification.
Invalid UTF-8 and NUL survive. `data` still carries decoded text; its UTF-8
carry can move a character across notification boundaries. Each subscriber
owns its buffer, so changing it does not change another subscriber's value.

`maxBufferedOutputBytes` requires `outputBytes` and defaults to 1 MiB per
subscriber. It bounds retained raw payload buffers alongside `bufferSize`,
not protocol metadata or total heap usage. Overflow drops whole notifications;
`dropped` counts events and `droppedOutputBytes` counts their raw payload bytes.
A notification larger than the byte bound is discarded whole.

Await `ready()` before triggering output. A dropped count change, `pause`, or
reconnect invalidates continuity. These bytes cover only what this observer
received; a capture cannot fill a byte gap. Closing the stream leaves the
borrowed server alive, and client exit loses its in-memory history.

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

Specialist subpaths keep their complete contracts out of the root:
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

tmux release candidates are not supported: a feature can require one only until
its release ships, and a candidate such as `X.Y-rcN` ranks below `X.Y`. See
[Release candidates](https://libtmux.org/en/tmux/guides/tmux-support/#release-candidates).

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
