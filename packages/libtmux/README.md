# libtmux

Typed, Bun-first TypeScript control of [tmux](https://github.com/tmux/tmux).

[![npm](https://img.shields.io/npm/v/libtmux?color=cb3837)](https://www.npmjs.com/package/libtmux)
[![downloads](https://img.shields.io/npm/dm/libtmux?color=cb3837)](https://www.npmjs.com/package/libtmux)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.2a%E2%80%933.7c-1bb91f)](../../.github/workflows/typescript.yml)
[![dependencies](https://img.shields.io/badge/dependencies-0-1bb91f)](tests/unit/package_contract.test.ts)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Acquire an immutable snapshot of a tmux server, query it with declarative
criteria, and drive sessions, windows, and panes with a fully typed API.

Requires tmux 3.2a or newer, and Node 22+ or Bun 1.3.14+.

Linux is the only supported host for real tmux control. The macOS CI lane
checks package artifacts without exercising tmux; macOS runtime behavior is
unproven. WSL is untested. This is a proof boundary, not an OS rejection.

```console
$ bun add --exact libtmux@0.1.0-alpha.6
```

> [!WARNING]
> **Alpha.** Prerelease software: the API can change between alpha releases
> without a deprecation cycle, and it is not covered by semantic versioning
> until the `0.1.0` release itself — `0.1.0-alpha.N` comes before it. Pin an
> exact version, and read the [changelog](CHANGELOG.md) before you upgrade.

## Quickstart

```ts
import { Server } from "libtmux";

const server = new Server();

const session = await server.newSession({ name: "work" });
const editor = await session.newWindow({ name: "editor" });
await editor.split();

const snapshot = await server.snapshot();
const window = snapshot.windows.where({ name: "editor" }).one();

console.log(window.panes.length); // 2
await window.panes.at(0)?.sendKeys("echo hello");
```

## Start here

The API is small and the pieces stack in one order. Read them in this order and
each one uses the last:

1. **[Snapshots](#snapshots)** — `server.snapshot()` reads the whole server once.
   Everything else resolves off it without talking to tmux again.
2. **[Querying](#querying)** — `.where()` for declarative criteria, `.filter()`
   for a predicate. Both run against the snapshot you already hold.
3. **[Operations](#operations)** — `newWindow`, `split`, `sendKeys`: the calls
   that change something, each resolving to a handle.
4. **[Running several at once](#running-several-commands-at-once)** — `plan` and
   `batch`, once you are making more than a couple of changes.
5. **[Watching](#watching)** — `server.watch()` for what changed rather than
   what is true, and `server.connect()` to pair a server with that observer.

A snapshot answers _what is true now_; a watch answers _what changed_. Most
programs need the first, and reach for the second when they have to react.

Those five are the page, in the order it is written. What follows them —
deadlines, engines, observation, options, environments, errors — is depth for
when a program needs it, and nothing above depends on any of it.

<details>
<summary><b>Everything on this page</b></summary>

**Reading the server** ·
[Snapshots](#snapshots) ·
[Querying](#querying) ·
[Relations](#relations) ·
[Field names](#field-names) ·
[Field values](#field-values)

**Changing it** ·
[Operations](#operations) ·
[Running several commands at once](#running-several-commands-at-once) ·
[Commands this package does not model](#commands-this-package-does-not-model) ·
[Options and hooks](#options-and-hooks) ·
[Environments](#environments)

**Reacting to it** ·
[Watching](#watching) ·
[Waiting for something to happen](#waiting-for-something-to-happen) ·
[Commands beside a connection](#commands-beside-a-connection)

**Getting the cost right** ·
[Choosing how work is arranged](#choosing-how-work-is-arranged) ·
[Supplying an engine](#supplying-an-engine) ·
[Deadlines and cancellation](#deadlines-and-cancellation)

**Recipes** ·
[Wait for a pane to print something](#wait-for-a-pane-to-print-something) ·
[Act, then wait, with an observer](#act-then-wait-with-an-observer) ·
[Build a workspace](#build-a-workspace) ·
[Drive a pane and read what it said](#drive-a-pane-and-read-what-it-said) ·
[Watch for a change and react to it](#watch-for-a-change-and-react-to-it)

**The rest** ·
[Errors](#errors) ·
[Running inside tmux](#running-inside-tmux) ·
[Dependencies](#dependencies) ·
[Entrypoints](#entrypoints) ·
[tmux versions](#tmux-versions) ·
[Consumers](#consumers) ·
[Examples](#examples) ·
[Parity with the Python library](#parity-with-the-python-library) ·
[API reference](docs/api.md)

</details>

## Snapshots

`snapshot()` is the only call that talks to tmux. It acquires the whole server
in one round of commands, and everything reachable from the result resolves
locally.

```ts
const snapshot = await server.snapshot();

snapshot.sessions; // Selection<Session>
snapshot.windows; // Selection<Window>
snapshot.panes; // Selection<Pane>
snapshot.clients; // Selection<Client>
```

A snapshot never changes. Acquire again to see later state, and the earlier
snapshot keeps reporting its own instant, so a value you captured cannot shift
underneath you.

```ts
const before = await server.snapshot();
await server.newSession({ name: "later" });

before.sessions.length; // unchanged
(await server.snapshot()).sessions.length; // includes "later"
```

`server.sessions()`, `windows()`, `panes()`, and `clients()` each take a
snapshot of their own — four tmux commands apiece — so reaching for several in
a row costs several round trips and describes several different instants. In a
loop that is an N+1. Take one `snapshot()` and read the collections off it:
they are cheaper together and they agree with each other.

To read one handle at a later instant rather than re-acquiring everything, call
`refreshed()`. It answers with a _new_ handle and leaves the receiver alone, so
the snapshot you already hold keeps agreeing with itself — a handle that
advanced in place would leave `where({ name: "old" })` matching an object whose
`name` had become `"new"`. A window keeps its placement, so one linked into two
sessions stays on the one you resolved.

```ts
const window = snapshot.windows.one({ name: "editor" });
await window.rename("build");

window.name; // "editor" — the instant this was read at
(await window.refreshed()).name; // "build"
```

## Querying

`.where()` takes declarative criteria. `encodeWhereDocument` serializes them in
a model-tagged document. `.filter()` takes an ordinary predicate. They are never
overloaded into each other.

```ts
snapshot.panes.where({ currentCommand: "vim" });
snapshot.panes.filter((pane) => pane.currentCommand?.startsWith("v") === true);
snapshot.panes.map((pane) => pane.id); // an array, not a Selection
```

Criteria support equality, string operators, `AND`/`OR`/`NOT`, regular
expressions as data, and relation quantifiers:

```ts
snapshot.sessions.where({
  AND: [
    { name: { startsWith: "prod" } },
    { windows: { some: { name: { regex: { pattern: "^log", flags: "" } } } } },
  ],
});

snapshot.windows.where({ session: { is: { name: "work" } } });
```

Clients are queryable on the same terms — `ClientWhere` alongside
`SessionWhere`, `WindowWhere`, and `PaneWhere`. tmux gives a client no id of
its own, so it is identified by the terminal it occupies, and a control client
occupies none:

<!-- static: names a terminal device that exists only on the reader's machine -->

```ts
snapshot.clients.where({ controlMode: "1" });
snapshot.clients.where({ session: { is: { name: "work" } } });
snapshot.clients.one({ tty: "/dev/pts/3" });
```

Matching is case-sensitive unless you say otherwise:

```ts
snapshot.sessions.where({ name: { contains: "API", mode: "insensitive" } });
```

A `Selection` is immutable, ordered, and replayable. It is `Iterable`, but it is
not an `Array`:

```ts
selection.length;
selection.at(0);
selection.toArray();
[...selection];
```

Cardinality helpers each accept optional criteria:

```ts
selection.first({ name: "work" });
selection.one({ name: "work" }); // NoMatchError / MultipleMatchesError
selection.oneOrUndefined({ name: "work" });
selection.exists({ name: "work" });
selection.count({ name: "work" });
```

Every field each model accepts, and the operators that go with them, are in the
[criteria reference](docs/criteria.md) — generated from the same table the
compiler matches against, so it lists what `.where()` actually takes.

## Relations

Relations are plain properties, because the data was already acquired. Reading
one issues no tmux command.

```ts
session.windows; // Selection<Window>
session.panes; // Selection<Pane>
window.session; // Session | undefined
window.linkedSessions; // every session a window is linked into
pane.window;
client.pane;
```

`Server` accessors are the async ones, because they acquire:

```ts
await server.sessions();
await server.windows();
```

## Field names

Handles read in idiomatic TypeScript. tmux's own token names stay available
under `format`, which is also where you reach fields the shortened names do not
cover.

```ts
pane.id; // pane_id
pane.currentCommand; // pane_current_command
window.index; // window_index
session.name; // session_name

pane.format.pane_current_command;
```

Object IDs are authenticated before a snapshot handle or event exposes them.
Their brands stop an ID already read as one kind from being mixed with another,
while the input types still accept configuration and other raw strings:

```ts
import type { PaneId, PaneIdInput } from "libtmux";

const capturedPane: PaneId = pane.id;
const configuredPane: PaneIdInput = "%0";
```

## Field values

tmux has one wire type, and everything on it is text. A field whose shape this
port knows is decoded on the way out, so a pid is an authenticated safe integer,
a flag is a boolean, and a timestamp is a `Date`:

```ts
pane.panePid; // SafeInteger | null
pane.active; // boolean | null
session.created; // Date | null
window.index; // SafeInteger — an identity tmux always populates
```

Which fields those are comes from tmux's own `format.c`, and an integration test
holds every one of them to a live server on each version CI runs. Anything else
is left exactly as tmux sent it, empty string included.

The text is never lost. `format` is the row as it arrived:

```ts
pane.format.pane_pid; // "2334787"
pane.format.pane_active; // "1"
```

Criteria take decoded values as well as wire text. A non-null decoded value
lowers to its exact wire spelling. A `null` criterion instead matches every
value that field's decoder treats as absent or invalid, including an empty
typed field and a time reported as `0`. Serialized bytes use stable tmux field
names and text values; a decoded `WhereDocumentV1` restores camelCase criteria
names. The same type therefore covers what you write and what comes back.

```ts
import { isSafeInteger, safeInteger } from "libtmux";

snapshot.panes.where({ active: true });
snapshot.panes.where({ active: "1" }); // what a flag encodes to
snapshot.panes.where({ pid: "2334787" }); // and a number
snapshot.panes.where({ pid: safeInteger(process.pid) }); // a computed number
const candidate = Number(process.env["BUILD_PID"]);
if (isSafeInteger(candidate)) snapshot.panes.where({ pid: candidate });
```

`SafeInteger` keeps `NaN`, infinities, fractions, and unsafe integers out of
typed criteria. Decoded numeric fields already carry the proof; authenticate a
number from elsewhere with `safeInteger`, which throws when it is not exact.
Use `isSafeInteger` to narrow an unknown value without throwing.

Invalid wire spellings remain type errors:

<!-- static: the calls are intentionally invalid and would throw if executed -->

```ts
// @ts-expect-error a flag encodes to "0" or "1"; nothing else is a flag
snapshot.panes.where({ active: "yes" });
// @ts-expect-error and no number encodes to "banana"
snapshot.panes.where({ pid: "banana" });
```

A `string` you have at runtime — from a config file, an argument, a raw
`.format` value — is not in that domain, because nothing knows yet whether it
is. Say what it means:

```ts
const fromConfig = process.argv[2] ?? "";
snapshot.windows.where({ index: safeInteger(Number(fromConfig)) });
// Or ask about the characters rather than the value, which is what the
// substring operators are for and why they stay plain strings.
snapshot.windows.where({ index: { contains: fromConfig } });
```

Together, on a server with two windows. This is a literal excerpt of
[`examples/fields/fields.ts`](../../examples/fields/fields.ts), which the integration suite
runs against a real tmux server:

<!-- runs: examples/fields/fields.ts -->

```ts
const snapshot = await server.snapshot();
const panes = snapshot.panes.where({ session: { is: { name: "fields" } } });

// Numbers arrive as numbers, so geometry is arithmetic rather than parsing.
const area = panes
  .toArray()
  .reduce((total, pane) => total + (pane.width ?? 0) * (pane.height ?? 0), 0);

// Flags arrive as booleans. `"0"` is truthy; `false` is not.
const activeCount = panes.count({ active: true });

// A criterion takes the decoded shape as readily as the text tmux sends.
const pids = panes
  .toArray()
  .map((pane) => pane.panePid)
  .filter((pid) => pid !== null);

// Times arrive as Date.
const created = snapshot.sessions.one({ name: "fields" }).created;
if (created === null) throw new Error("expected tmux to report a creation time");
const sessionAgeMs = Date.now() - created.getTime();

// The text tmux actually sent is still on the row. Each window has an active
// pane, so this narrows to one window before asking for one pane.
const raw = panes.one({ active: true, window: { is: { name: "second" } } }).format.pane_active;
if (raw !== "1") throw new Error(`expected the raw row to hold "1", saw ${JSON.stringify(raw)}`);
```

Criteria are camelCase too. WHERE documents use tmux's stable spellings so a
stored query stays readable by other tools:

```ts
import { decodeWhereDocument, encodeWhereDocument } from "libtmux";

const encoded = encodeWhereDocument({
  model: "pane",
  version: 1,
  where: { title: { contains: "log" } },
});
const document = decodeWhereDocument(JSON.parse(encoded) as unknown);
if (document.model === "pane") snapshot.panes.where(document.where);
```

A criterion is spelled like the handle accessor it filters, so a pane reads
`pane.currentCommand` and filters on `currentCommand`. Only the serialized name
is fixed by the schema. A field keeps its prefix in the rare case where dropping
it would shadow a relation: `sessionWindows` is a window count, `windows` is the
windows themselves.

Fields that carry one value for the whole server — `version`, `pid`,
`socketPath` — are readable on a handle but are not criteria, since filtering
rows by one would match all of them or none.

## Operations

Every handle exposes the tmux commands that apply to it. Each returns a promise;
those that create something return a handle to it.

Sessions, windows, and panes:

```ts
import { isSplitSize, isTmuxName, splitSize } from "libtmux";

const session = await server.newSession({ name: "work" });
const requestedName: unknown = "editor";
// A name holding `:` or `.` is refused: tmux rewrites it before 3.7, fails on
// 3.7, keeps it after, and it cannot be addressed as a target on any of them.
if (!isTmuxName(requestedName)) throw new TypeError("invalid window name");
const window = await session.newWindow({ name: requestedName });
const requestedSize: unknown = "30%";
if (!isSplitSize(requestedSize)) throw new TypeError("invalid split size");
const pane = await window.split({ size: requestedSize, startDirectory: "/srv" });
await pane.split({ size: splitSize(20) });

const active = session.activePane; // the active window's active pane
const focused = window.activePane;
await window.rename("build");
await window.selectLayout("even-horizontal");
await window.nextLayout();
await window.previousLayout();
await window.rotate(); // panes move through the layout; the layout stays
await pane.pasteBuffer("scratch");
await window.select();
await session.selectWindow("build");
await pane.resize({ width: 100 });
await pane.setTitle("build output");
await pane.kill();
```

`direction` says which side a split lands on, which window a new one sits
beside, and lets a resize adjust rather than set. tmux reaches "above" and
"left" only by pairing an axis with `-b`, so a boolean cannot express them:

```ts
import { PaneDirection, ResizeAdjustmentDirection, WindowDirection } from "libtmux";

await pane.split({ direction: PaneDirection.Above });
await pane.split({ direction: PaneDirection.Left });
await session.newWindow({ direction: WindowDirection.Before, name: "logs" });
await pane.resize({ amount: 5, direction: ResizeAdjustmentDirection.Down });
```

A window's placement is measured from the session's selected window, since the
command addresses the session. `shellCommand` runs something other than the
default shell. tmux hands it to a
shell, so a whole command line works, and it replaces the shell rather than
running inside it — when it exits the window or pane closes, unless
`remain-on-exit` says otherwise:

```ts
await session.newWindow({ name: "server", shellCommand: "npm run dev" });
await window.split({ shellCommand: "tail -f log/development.log" });
await server.newSession({ name: "ci", shellCommand: "just watch" });
```

Moving and linking windows between sessions:

```ts
await window.swapWith(other);
await other.move({ index: 2, session: "other" });
await window.link({ session: "other" }); // one window, in two sessions
await pane.breakOut();
await pane.joinTo("other:1");
await pane.swapWith(otherPane);
```

A handle names a placement rather than a window, because one window can sit in
two sessions at once. Moving a window leaves the handle pointing at a placement
that no longer exists, so read the moved window back from a fresh snapshot
instead of reusing the handle that moved it.

Unlink the placement resolved in the session you intend to remove:

```ts
const destination = await server.newSession({ name: "unlink-example" });
await window.link({ session: destination.id });
const placement = (await server.snapshot()).windows.one({
  id: window.id,
  session: { is: { id: destination.id } },
});
await placement.unlink();
```

`removePlacement` unlinks a linked placement or destroys the final ungrouped
window. It refuses a grouped session, whose members share one window list:

```ts
await window.removePlacement();
```

`killIfWindowUnshared` kills a pane only while its window has one placement:

```ts
await pane.killIfWindowUnshared();
```

Pane input and contents:

```ts
await pane.sendKeys("ls -la");
await pane.sendKeys("q", { enter: false, literal: true });
await pane.sendPrefix();
const lines = await pane.capture({ start: -100 });
await pane.clearHistory();
await pane.respawn("htop", { kill: true });
await pane.displayMessage("#{pane_current_command}");
```

Copy mode needs no client, so a detached pane enters and leaves it like any
other:

```ts
await pane.enterCopyMode();
await pane.exitCopyMode();
```

The choosers and popups do need a client, and each stays up until someone
dismisses it:

<!-- static: each opens a chooser that stays on screen until a person dismisses it -->

```ts
await pane.displayPopup("less README.md");
await pane.displayMenu("Pane", [{ command: "kill-pane", key: "k", name: "Kill" }]);
await pane.chooseTree();
await pane.chooseBuffer();
await pane.findWindow("editor");
await pane.customizeMode();
```

Server-wide commands and paste buffers:

```ts
await server.hasSession("work");
await server.sourceFile(`${process.env["HOME"] ?? "."}/.tmux.conf`); // tmux does not expand `~`
await server.listCommands();
await server.runShell("echo hi");
await server.ifShell("[ -d /srv ]", "display-message ok");

await server.setBuffer("scratch", "text");
await server.loadBuffer("scratch", await Bun.file("payload.bin").bytes());
await server.showBuffer("scratch");
await server.showBufferBytes("scratch");
await server.listBuffers();
await server.deleteBuffer("scratch");
await server.kill();
```

Clients, and re-reading a handle:

```ts
await client.switchTo(session);
await client.detach();
await session.detach();

const later = await pane.refreshed(); // a new handle, at a new instant
pane.equals(later); // true — the same pane, read twice
pane.sameTmuxIdAs(later); // same `%n`, wherever it came from
```

Every handle describes itself when logged or interpolated, rather than rendering
as `[object Object]`. `toString` and the runtime inspect hook give the same text,
so `console.log` is useful without reaching for a field:

```ts
pane.toString(); // Pane(%1 Window(@1 0:editor, Session($0 work)))
window.toString(); // Window(@1 0:editor, Session($0 work))
server.toString(); // Server(/tmp/tmux-1000/default)
console.log(`${pane} stopped responding`);
```

`refreshed` answers with a new handle rather than advancing this one, so use
what it returns. `equals` compares the connection and daemon generation as well
as the tmux id, because `%1` is unique only within one running daemon — two
servers both have one, and so does the pane that replaced it after a restart.
`sameTmuxIdAs` is the raw-id comparison when that is genuinely what you want.
Every handle also has `showOptions` / `setOption` / `unsetOption`, and `format`
for tmux's own field names. `Pane.pipeTo` streams a pane to a command for as
long as the pipe is open, and `Server.saveBuffer` writes a buffer to a file
without bringing it back through this process. Those read one object's own view: a session that
has set nothing reports nothing, while the values actually governing it are
tmux's global defaults. `Server.showGlobalOptions`, `setGlobalOption` and
`unsetGlobalOption` reach those, taking `"session"` or `"window"` for which
table — `history-limit` and `default-shell` live in the first, `remain-on-exit`
in the second, and none of the three is readable any other way.
`showResolvedOptions` answers the other question: what governs this object,
with its own values and everything it inherits resolved into one map.

## Commands this package does not model

tmux has far more commands than any wrapper types. `cmd` runs one through the
same path as everything else — same socket, environment, deadline, and errors —
so reaching an unmodelled command never means building your own subprocess:

```ts
await server.cmd("list-keys", ["-T", "copy-mode"]);
await pane.cmd("clock-mode");
await window.cmd("rotate-window");
await server.cmd("display-message", ["-p", "#{version}"], { target: null });
```

A handle sends its own id as the target, so `pane.cmd("clock-mode")` addresses
that pane. Pass `target` to address something else, or `null` for a command that
takes none. Failure raises `TmuxCommandError` carrying tmux's own stderr.

## Running several commands at once

Creating things one at a time costs two processes per mutation: one runs its
command and one captures the snapshot needed to find what it made. A batch
shares one final snapshot across all of its mutations.

`plan` describes a mutation instead of running it. It takes what the direct call
takes and resolves to what the direct call resolves to; `batch` runs the planned
commands in order and resolves all of them from one final snapshot:

```ts
const [first, second] = await server.batch([
  session.plan.newWindow({ name: "editor" }),
  session.plan.newWindow({ name: "logs" }),
]);
```

`first` and `second` are `Window` handles, typed one by one — a batch mixing
kinds keeps each element's own type, so a planned split comes back as a `Pane`
with `Pane` methods on it:

```ts
const [created] = await server.batch([editor.plan.split({ vertical: true })]);
const lines = await created.capture();
```

For a command this package does not model, or one whose output you want raw,
`pipeline` takes arguments and returns a result per command, in order — so a
creating command's `-P -F` lands where you asked for it and a silent command
stays empty rather than shifting the one behind it:

```ts
const [[madeWindow], , [madeOther]] = await server.pipeline([
  ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", "editor"],
  ["set-option", "-g", "status", "off"],
  ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", "logs"],
]);
```

It is not atomic. tmux runs the commands in order and stops at the first
failure, leaving everything before it applied; the `TmuxCommandError` names the
command that failed rather than the whole sequence. Take a `snapshot()`
afterwards when you need to know what survived.

Each command is a separate tmux invocation. Arbitrary command output has no
delimiter that a command alias cannot replace or print, so one combined stream
cannot promise positional results.

## Watching

A snapshot answers what is true now. `server.watch()` answers what changed, over
one persistent `tmux -C` connection rather than a command per read.

Each `watch()` or `connect()` owns a real attached tmux client until it closes.
That client appears in snapshots, increments `session_attached`, and is visible
to client hooks and attachment-sensitive policy such as `destroy-unattached`.
Multiple watches or connections create multiple clients.

<!-- static: reads every event until the process is interrupted -->

```ts
await using events = server.watch({ target: session.id });
await events.ready(); // attached; changes from here on are announced

for await (const event of events) {
  if (event.kind === "window-add") console.log("opened", event.windowId);
  if (event.kind === "output") process.stdout.write(event.data);
}
```

Events are a discriminated union, so `event.kind` narrows the rest of the shape
with no cast. Names are tmux's own, without the leading `%`, and a notification
this version does not model arrives as `{ kind: "unknown", name, args }` rather
than being dropped.

The stream is an `AsyncDisposable`, so `await using` ends the tmux process when
the scope exits, including on a thrown error. A consumer that falls behind gets
its oldest events dropped rather than an unbounded buffer; `events.dropped`
counts them and `bufferSize` sets the bound.

That bound is this side's. tmux keeps its own, and its remedy for a client that
lets a pane's output back up is to kill it — five minutes behind and the whole
connection goes with `too far behind`. `pauseAfterSeconds` asks tmux to pause
the one pane instead:

```ts
await using paced = server.watch({ pauseAfterSeconds: 5 });
```

tmux then reports `pause` for the pane it stopped, the connection asks it back
at once, and `continue` follows. The pair is a record of what was missed, not
something to act on.

`watch()` is the notification observer and owns this pacing policy. `connect()`
adds the same event channel and daemon-lifetime tracking to a server; its
commands still use ordinary tmux processes.

A connection attaches, so it needs a session to attach to. Connecting to a
server with none fails at `connect()` with tmux's own words rather than through
whichever command runs first:

```ts
await server.connect(); // LibTmuxException: ... could not attach: no sessions
```

tmux sends a control client no pane output until it attaches, so watching
attaches to a session. A server with no sessions has nothing to watch, and a
client hears about the session it attached to — name the one you care about
with `target` rather than relying on whichever tmux considers most recent.

`await using` needs `Symbol.asyncDispose`, so a consumer's `lib` includes
`ESNext.Disposable` alongside its ECMAScript target. `events.close()` is the
same operation for a project that cannot add it.

### Subscribing to a format

A snapshot reads a format when you ask for it. A subscription reports it when it
changes:

```ts
await using events = server.watch({
  subscriptions: [{ format: "#{pane_current_command}", name: "cmd", scope: "all-panes" }],
});

const report = await events.find((event) => event.kind === "subscription-changed");
if (report?.kind === "subscription-changed") console.log(report.name, report.value);
```

tmux expands each subscription at most once per second and reports only when the
value differs from the last report for that object, so a report is a change
rather than a sample. The first evaluation always reports.

`scope` takes a pane or window id, `"all-panes"`, or `"all-windows"`; omitted,
the format expands once per session. A report names the object it expanded
against, so a pane-scope one carries `paneId`, `windowId` and `windowIndex`.

A connected server adds and drops them while it runs with `subscribeFormat` and
`unsubscribeFormat`. A subscription belongs to the control client, so the
connection re-issues its own after a reconnect.

### Waiting for something to happen

Most work is "do this, then wait until that". `waitFor` is the join between a
snapshot and the stream, and it subscribes before it reads — so a change that
lands in between is still seen, rather than leaving you waiting on a condition
that already came true:

```ts
await using live = await server.connect();

await session.newWindow({ name: "build" });
const settled = await live.waitFor((server) => server.windows.exists({ name: "build" }));
```

For a single event rather than a state, `find` takes the first one that matches
and gives up on a deadline:

<!-- static: waits for a window the reader opens -->

```ts
const opened = await live.subscribe().find((event) => event.kind === "window-add");
```

Each `subscribe()` is an independent view with its own buffer, so a loop and a
`waitFor` can run side by side without taking each other's events.

### Commands beside a connection

`watch()` opens a connection for notifications only. `connect()` returns a
server paired with that observer. Commands remain process-boundary invocations
because control mode cannot delimit arbitrary alias-expanded or waiting command
output truthfully:

<!-- static: reads every event until the process is interrupted -->

```ts
await using live = await server.connect();

for await (const event of live.subscribe()) {
  if (event.kind !== "window-add") continue;
  const snapshot = await live.snapshot(); // one four-command tmux invocation
  console.log(snapshot.windows.count());
}
```

A connection can reopen itself after a drop with
`watch({ reconnect: { attempts: 3 } })`, which reports a `reconnected` event so
the gap is visible. The count bounds one outage rather than the connection's
whole life, so a watcher that recovers today still recovers next week. It is off
by default. A connected server refuses to start commands while its observer is
reconnecting; after the attach, it binds each new command to the daemon carrying
that observer. It never replays a mutation.

The API is the same `Server`. Connecting adds the observer and daemon binding;
commands, including `loadBuffer`, still use the server's engine.

## Recipes

### Wait for a pane to print something

Polling a pane either misses output between reads or spends a command on each
one. Subscribe first, then act, so a line printed while you were still
connecting is not lost:

```ts
await using events = server.watch({ target: session.id });
await events.ready();

await pane.sendKeys("make build");

let seen = "";
for await (const event of events) {
  if (event.kind !== "output" || event.paneId !== pane.id) continue;
  seen += event.data;
  if (seen.includes("BUILD OK")) break;
}
```

Name the session to watch when reading pane output. Structural notifications —
a window opening, a session renaming — reach a control client wherever it is
attached, but tmux sends pane output only for the session that client attached
to, and an untargeted `watch()` lands on whichever session tmux considers
current. On a server with one session that is the one you meant; on a server
with two it is silence rather than an error.

A pane echoes what is typed into it, so waiting for text that also appears in
the keys you just sent matches the echo rather than the output. Wait for
something the command prints.

### Act, then wait, with an observer

The loop an agent runs. `connect()` pairs commands through the server engine
with notifications from a persistent observer. Subscribe before sending so a
marker printed in between is still seen.

This recipe is a literal excerpt of [`examples/agent/agent.ts`](../../examples/agent/agent.ts),
which the integration suite runs against a real tmux server:

<!-- runs: examples/agent/agent.ts -->

```ts
const session = await server.newSession({ name: "agent" });

await using live = await server.connect({ target: session.id });

const pane = (await live.snapshot()).sessions.one({ id: session.id }).panes.one();

const printed = live
  .subscribe()
  .find(
    (event) => event.kind === "output" && event.paneId === pane.id && event.data.includes(marker),
    { timeoutMs: 30_000 },
  );

await pane.sendKeys(command);

const event = await printed;
```

### Build a workspace

One session, a window per concern, each pane already running its process. The
first window is named as the session is created, so the workspace does not open
with a stray shell nobody asked for:

```ts
const built = await server.newSession({
  name: "work",
  shellCommand: "nvim",
  windowName: "editor",
});

const [logs, shell] = await server.batch([
  built.plan.newWindow({ name: "logs", shellCommand: "journalctl -f" }),
  built.plan.newWindow({ name: "shell" }),
]);

await logs.selectLayout("even-horizontal");
shell.name; // "shell"
```

### Drive a pane and read what it said

```ts
await pane.sendKeys("git status --short");

const lines = await pane.capture();
const changed = lines.filter((line) => line.trim() !== "").length;
```

`capture()` reads the visible pane; pass `start` to reach into the scrollback.
`sendKeys` presses Enter unless you say otherwise, and takes keys literally with
`{ literal: true }` when the text could be read as a tmux key name.

### Watch for a change and react to it

`waitFor` subscribes before it reads, so a change landing between the two is
still seen rather than leaving you waiting on something that already happened:

```ts
await using connected = await server.connect();

await session.newWindow({ name: "build" });
const settled = await connected.waitFor((current) => current.windows.exists({ name: "build" }));

settled.windows.count({ name: "build" }); // 1
```

For a single event rather than a state, `find` takes the first match and answers
`undefined` on its deadline. It raises instead when the connection ends, so the
`undefined` a caller reports on is only ever the thing not happening:

```ts
const opened = await live.subscribe().find((event) => event.kind === "window-add", {
  timeoutMs: 5_000,
});
```

## Deadlines and cancellation

A command with no deadline waits as long as tmux takes, which for a daemon that
stops answering is forever. Set one for the whole server, and override or cancel
a single call:

```ts
const server = new Server({ timeoutMs: 10_000 });

const controller = new AbortController();
const lines = pane.capture({ signal: controller.signal, timeoutMs: 30_000 });
controller.abort();
await lines.catch(() => undefined); // rejects with the abort reason
```

Every operation that takes options accepts both, so the rule you learn on one
method holds on the next. The default applies to every command the server runs,
including the version probe it makes first and the four listings behind
`snapshot()`. `signal` is
typed structurally, so a real `AbortSignal` satisfies it without the published
types requiring a DOM or Node library.

## Choosing how work is arranged

Commands travel through the server's engine. Three independent choices compose
around that execution path:

| Mode           | Turn it on                         | What changes                                          | When to use it                                                    |
| -------------- | ---------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| **connected**  | `await server.connect()`           | Adds notifications and connection-lifetime tracking.  | A server-shaped API in a loop that also reacts to events.         |
| **watching**   | `server.watch()`                   | Yields tmux's notifications as they happen.           | Reacting to a change without issuing commands through that value. |
| **planned**    | `.plan` instead of the direct call | Shares one final snapshot across `server.batch([…])`. | Creating or changing several things in order.                     |
| **concurrent** | `Promise.all`                      | Independent commands overlap.                         | Slow work on independent targets — not ordering-sensitive setup.  |

`connect()` hands back the same handles as the base server and adds an event
observer. Its commands still use the server engine and process boundaries.

### Supplying an engine

An engine can put tmux behind SSH, a container, or a daemon. It receives the
complete invocation, including environment, stdin, cancellation, and deadline.
This runnable example keeps execution local on the current server's socket; a
remote runner has the same obligations:

```ts
import { Server, TmuxServerRestarted } from "libtmux";
import { flattenInvocation, guardRequest } from "libtmux/engine";
import type { TmuxCommandResult, TmuxEngine, TmuxInvocationRequest } from "libtmux/engine";

/** `run` is yours: execute one complete request and return what tmux wrote. */
function engineOver(
  endpoint: string,
  run: (request: TmuxInvocationRequest) => Promise<TmuxCommandResult>,
): TmuxEngine {
  return {
    // Where this reaches tmux. A socket path on another machine is not an
    // address, so without this two servers on the same path compare equal.
    endpoint,
    async execute(request) {
      // A command addressed by id must not run on a daemon that reissued that
      // id. This plan keeps the wrapper and its exact refusal detector together
      // so an engine inherits restart safety instead of rebuilding it.
      const guarded = guardRequest(request);
      const result = await run(guarded.request);
      if (guarded.refusedBy(result.returncode, result.stderr)) {
        throw new TmuxServerRestarted("the daemon this handle was read from is gone");
      }
      return result;
    },
  };
}

const socketPath = server.socketPath;
if (socketPath === undefined) throw new Error("this example needs a socket path");
const tmuxBin = server.tmuxBin;

const throughEngine = new Server({
  engine: engineOver(`local://${socketPath}`, async (request) => {
    const argv = [request.executable, ...flattenInvocation(request)];
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) abort();

    try {
      const child = Bun.spawn([tmuxBin, "-S", socketPath, ...argv.slice(1)], {
        ...(request.environment === undefined ? {} : { env: request.environment }),
        signal: controller.signal,
        stderr: "pipe",
        stdout: "pipe",
        stdin: request.stdin === undefined ? "ignore" : "pipe",
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      });
      if (request.stdin !== undefined && child.stdin !== undefined) {
        await child.stdin.write(request.stdin);
        await child.stdin.end();
      }
      const [returncode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ]);
      return {
        cmd: argv,
        returncode,
        signal: child.signalCode,
        stderr: new Uint8Array(stderr),
        stdout: new Uint8Array(stdout),
      };
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
  }),
});

(await throughEngine.snapshot()).sessions.count();
```

The seam is one structured invocation in and bytes plus status out. One at the
graph would make every implementer responsible for framing, capability gating
and normalization; this one leaves them responsible only for execution. The
request carries global flags and a nonempty command list separately, so an
engine cannot accidentally split a snapshot into several clients. Honour its
`daemonGuard` with `guardRequest`, or bind the engine to one daemon.

`watch()` and `connect()` are the two calls an engine does not carry. Both hold
a local `tmux -C attach` process open, which is the thing an engine exists to
avoid needing, so they refuse rather than attaching to whichever tmux this
machine happens to be running.

For a connection scoped to one block, `withConnection` closes it on the way out
whether the body returns or throws — useful where `await using` is not
available, since it needs `Symbol.asyncDispose` in the consumer's `lib`:

```ts
const built = await server.withConnection(async (connected) => {
  await session.newWindow({ name: "build" });
  return connected.waitFor((current) => current.windows.exists({ name: "build" }));
});
```

`pipeline` and `batch` stay per-call-site choices because both stop at the first
failure. `batch` adds one final snapshot that turns printed ids into handles;
`pipeline` returns the printed lines directly.

Use `pipeline` or `batch` when command order matters; a connection does not make
concurrent mutations safe to reorder.

## Options and hooks

```ts
// A pane keeps history-limit lines and a stream reader keeps a bounded buffer,
// so output larger than either is gone before anything asks. tmux can send it
// somewhere durable instead, and write a buffer out without reading it back.
await pane.pipeTo("cat >> /tmp/build.log");
await pane.pipeTo();
await server.saveBuffer("captured", "/tmp/captured.txt");

await session.setOption("status-left", "[work] ");
(await session.showOptions()).get("status-left");
await session.unsetOption("status-left");

// A handle reports its own view. A session that has set nothing reports
// nothing, while the defaults governing it are tmux's global tables.
(await server.showGlobalOptions("session")).get("history-limit");
await server.setGlobalOption("window", "remain-on-exit", "on");
await server.unsetGlobalOption("window", "remain-on-exit");

// Or ask what governs one object, own and inherited resolved together.
(await session.showResolvedOptions()).get("history-limit");
(await window.showResolvedOptions()).get("main-pane-width");
(await pane.showResolvedOptions()).get("allow-rename");
(await server.showResolvedOptions()).get("message-limit");

// A hook holds a list of commands; a write replaces it unless it appends.
await server.setHook("after-new-window", "display-message created");
await server.setHook("after-new-window", "display-message again", { append: true });
await server.showHooks();
await server.unsetHook("after-new-window");
```

Typed option and hook methods treat names as literal data, including `#`. Use
`cmd` when deliberately asking tmux to expand a computed name.

Window and pane scopes report only what was set on them, never inherited
values. `OptionScope` supplies the same lowercase scope values when a named
constant is clearer than a string literal.

## Environments

A session's environment is what tmux hands to the processes it starts, so it is
how you seed a variable for every pane a workspace creates. `Server` carries the
global environment and `Session` its own:

```ts
await session.setEnvironment("DATABASE_URL", "postgres://localhost/dev");
await session.getEnvironment("DATABASE_URL");
await session.showEnvironment();
await session.unsetEnvironment("DATABASE_URL");
await session.removeEnvironment("SSH_AUTH_SOCK");
await server.setEnvironment("EDITOR", "vim");
```

A variable is in one of three states, which is why the value type is
`EnvironmentValue` — `string | null` — and lookups can also answer `undefined`:

| State                                   | `getEnvironment` | In `showEnvironment` |
| --------------------------------------- | ---------------- | -------------------- |
| Set to a value                          | the value        | present              |
| Marked for removal from child processes | `null`           | present              |
| Not carried at all                      | `undefined`      | absent               |

`removeEnvironment` is the middle row and `unsetEnvironment` is the last: the
first leaves an entry saying "unset this before spawning", which is how tmux
keeps a stale `SSH_AUTH_SOCK` out of a new pane. Removal marks are routine
rather than exotic — tmux's own `update-environment` puts several in every
session. `SetEnvironmentOptions` covers tmux's `-F` and `-h` as `expandFormat`
and `hidden`, and `EnvironmentScope` names the two scopes.

## Errors

A failing tmux command raises `TmuxCommandError`, which carries its parts so you
can branch without parsing a message:

```ts
import { TmuxCommandError } from "libtmux";

try {
  await pane.capture();
} catch (error) {
  if (error instanceof TmuxCommandError) {
    error.args; // the argument vector
    error.exitCode;
    error.stderr; // tmux's own lines
    error.target; // the -t target, when there was one
  }
}
```

A command that never got an answer raises `TmuxTransportError` instead. It says
what failed between this process and tmux, and — the part that matters for a
mutation — how far the command got:

```ts
import { TmuxTransportError } from "libtmux";

try {
  await session.newWindow({ name: "build" });
} catch (error) {
  if (error instanceof TmuxTransportError) {
    error.kind; // "cancelled" | "pipe" | "protocol" | "spawn" | "timeout"
    error.delivery; // "not_started" | "written" | "replied" | "indeterminate"
    error.stdout; // whatever arrived before the failure
  }
}
```

`delivery` is the question a retry depends on. `not_started` is the only value
that is safe to retry blindly; after a timeout the answer is `indeterminate`,
because tmux may well have created that window before the pipe went quiet. Every
path reports the same type, so a timeout during `snapshot()` is not a different
shape from a timeout during `kill()`.

A handle that outlived its daemon raises `TmuxServerRestarted`. tmux numbers a
restarted daemon's objects from the start, so a `%1` read before the restart
names a pane that exists and belongs to somebody else — and a socket path is a
place, not a process:

```ts
import { TmuxServerRestarted } from "libtmux";

try {
  await pane.kill();
} catch (error) {
  if (error instanceof TmuxServerRestarted) {
    error.delivery; // always "not_started" — a refused command never ran
  }
}
```

The refusal is tmux's, not a check this library made first and hoped would still
hold: a command carrying a raw id goes as `if-shell -F` conditioned on the
daemon's pid and start time, and tmux evaluates that inside the same command
queue entry that would run it. The connected observer invalidates its runtime
when that daemon disappears.
Reading a stale handle's captured fields still works; only commands are refused.

An unreachable server raises rather than reading as empty, so an empty result
means exactly one thing. Ask without raising when you need to:

```ts
await server.isAlive(); // false for a missing daemon, socket, or binary
await server.raiseIfDead(); // the assertion form
```

Every error extends `LibTmuxException`. A query that matches nothing raises
`NoMatchError`, one that matches several where you asked for one raises
`MultipleMatchesError`, and criteria the schema rejects raise
`QueryValidationError`. A `waitFor` that reaches its deadline with the condition
still unmet raises `WaitTimeout`, which is worth catching by name: it says the
state never arrived, where a `LibTmuxException` from the same call says only
that the connection ended and nothing about the condition.
A criterion naming a field newer than the tmux that answered raises
`VersionTooLow` rather than matching nothing — the error names the field, the
release that has it, and the release running, because "no pane has this" and
"your tmux has never heard of this" are different answers.
`ObjectDoesNotExist` and `MultipleObjectsReturned` preserve the Python library's
selection-error ancestry. The `libtmux/exc` subpath exports those bases and the
errors raised by the TypeScript implementation.

`parseLegacyWhere` converts Python-style `name__contains=` filter strings into
criteria, for code being ported rather than written fresh.

## Running inside tmux

```ts
import { Session } from "libtmux";

const session = await Session.fromEnv();
```

The pane is authoritative: `$TMUX` carries a session id that goes stale when a
pane moves, so the session is resolved through `$TMUX_PANE`.

## Dependencies

None. The package installs a tmux client and nothing else — no third-party code
to audit, pin, or deduplicate, and no transitive tree at all.

Validation of tmux's own output is real work, so it did not go away: it lives in
a small internal validator with a Zod-shaped surface. Its failures carry the
value that failed, which Zod reports only by type.

## Consumers

Two working consumers live in this repository:

- [`packages/mcp`](../mcp) — an MCP server exposing tmux through this library.
  Its waits stream tmux's notifications rather than polling, and its
  `run_command` frames what it sends so a pane's echo cannot be read as output.
- [`packages/workspace`](../workspace) — a tmuxp-shaped workspace builder.
  Applying a workspace twice converges the running session rather than
  duplicating it.

## Examples

See `examples/`. Every example is executed by the integration suite.

Every TypeScript block in this README is typechecked against the working tree by
`bun run typecheck:readme`, each one on its own, so a snippet here cannot drift
from the signature it documents.

`bun run typecheck:ambient-free` compiles a consumer against the emitted
declarations with no ambient types in scope — no `@types/node`, no DOM — so the
published types cannot start requiring either without the gate saying so.

## Entrypoints

The root export carries the everyday handle, query, operation, error, and
constant surface. Each model is also its own subpath: `libtmux/server`,
`libtmux/session`, `libtmux/window`, `libtmux/pane`, `libtmux/client`, and
`libtmux/selection`. Supporting subpaths are `libtmux/formats`,
`libtmux/constants`, `libtmux/common`, and `libtmux/exc`.

Three specialist subpaths keep their complete contracts out of the root:
`libtmux/engine` for custom execution engines, `libtmux/types` for the full
operation and event type inventory, and `libtmux/field-types` for generated
format-field, decoded-value, and handle-alias types.

## tmux versions

The package targets the same range as the Python library, and the format
registry withholds newer fields from an older server, so each version is asked
only for the fields it has.

`bun run test:compat` runs the real-tmux gates against every build in
`LIBTMUX_TMUX_BUILDS` (a directory of prefixes) plus whatever is on PATH, and
says so when it only found one. CI runs them against both ends of the range and
a release in between, since a difference between two releases is only visible
when both are present.

To gate your own code on a version, ask the server rather than parsing
`#{version}` yourself. The version is probed once per connection and cached, so
asking repeatedly costs nothing:

```ts
const version = await server.version(); // { major, minor, suffix, raw }

if (await server.versionAtLeast("3.4")) {
  await pane.customizeMode();
}
```

`raw` is tmux's own string, so a development form such as `next-3.8` survives
the parsed fields. Development builds compare above every tagged release.

One behaviour differs across the range rather than being gated: tmux 3.3a
suppressed `run-shell` output for an invocation with no attached client, which
later versions restored. `runShell` returns an empty result there rather than
failing.

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

## License

MIT
