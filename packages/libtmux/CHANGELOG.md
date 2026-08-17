# Changelog

Notable changes to `libtmux`.

Every release so far is an **alpha**: a prerelease whose API can change between
versions without a deprecation cycle. Semantic versioning starts applying at the
`0.1.0` release itself, which the alphas leading to it precede. The newest one is
always `latest`, so `npm i libtmux` fetches it — there is no second tag to
remember.

<!-- KEEP THIS PLACEHOLDER: new work lands under "Unreleased" until a release is cut. -->

## Unreleased

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
