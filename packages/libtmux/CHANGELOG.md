# Changelog

Notable changes to `libtmux`.

Every release so far is an **alpha**: a prerelease whose API can change between
versions without a deprecation cycle. Semantic versioning starts applying at the
`0.1.0` release itself, which the alphas leading to it precede. The newest one is
always `latest`, so `npm i libtmux` fetches it — there is no second tag to
remember.

<!-- KEEP THIS PLACEHOLDER: new work lands under "Unreleased" until a release is cut. -->

## Unreleased

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
