# libtmux

Typed, Bun-first TypeScript control of [tmux](https://github.com/tmux/tmux).

[![npm](https://img.shields.io/npm/v/libtmux?color=cb3837)](https://www.npmjs.com/package/libtmux)
[![downloads](https://img.shields.io/npm/dm/libtmux?color=cb3837)](https://www.npmjs.com/package/libtmux)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.2a%E2%80%933.7b-1bb91f)](../../.github/workflows/typescript.yml)
[![dependencies](https://img.shields.io/badge/dependencies-0-1bb91f)](tests/unit/package_contract.test.ts)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Acquire an immutable snapshot of a tmux server, query it with declarative
criteria, and drive sessions, windows, and panes with a fully typed API.

Requires tmux 3.2a or newer, and Node 22+ or Bun 1.3.14+.

The library is portable; its proof is not. CI runs Linux, and the fixture
supervisor the real-tmux suites use identifies processes through `/proc`, so
those suites need Linux until it is ported. macOS is untested rather than
unsupported — the distinction matters most for cancellation and process
teardown, where the assumptions are the ones that differ.

```console
$ bun add libtmux
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
   what is true, and `server.connect()` to run commands over that same
   connection.

A snapshot answers _what is true now_; a watch answers _what changed_. Most
programs need the first, and reach for the second when they have to react.

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
[Commands on the same connection](#commands-on-the-same-connection)

**Getting the cost right** ·
[Choosing how commands travel](#choosing-how-commands-travel) ·
[Choosing the transport from outside](#choosing-the-transport-from-outside) ·
[Deadlines and cancellation](#deadlines-and-cancellation)

**Recipes** ·
[Wait for a pane to print something](#wait-for-a-pane-to-print-something) ·
[Act, then wait, on one connection](#act-then-wait-on-one-connection) ·
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

## Dependencies

None. The package installs a tmux client and nothing else — no third-party code
to audit, pin, or deduplicate, and no transitive tree at all.

Validation of tmux's own output is real work, so it did not go away: it lives in
a small internal validator with a Zod-shaped surface. Its failures carry the
value that failed, which Zod reports only by type.

## Deadlines and cancellation

A command with no deadline waits as long as tmux takes, which for a daemon that
stops answering is forever. Set one for the whole server, and override or cancel
a single call:

```ts
const server = new Server({ timeoutMs: 10_000 });

const controller = new AbortController();
const lines = pane.capture({ signal: controller.signal, timeoutMs: 30_000 });
controller.abort(); // `lines` rejects
```

Every operation that takes options accepts both, so the rule you learn on one
method holds on the next. The default applies to every command the server runs,
including the version probe it makes first and the four listings behind
`snapshot()`. `signal` is
typed structurally, so a real `AbortSignal` satisfies it without the published
types requiring a DOM or Node library.

## Watching

A snapshot answers what is true now. `server.watch()` answers what changed, over
one persistent `tmux -C` connection rather than a command per read.

```ts
await using events = server.watch();
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
await using paced = await server.connect({ pauseAfterSeconds: 5 });
```

tmux then reports `pause` for the pane it stopped, the connection asks it back
at once, and `continue` follows. The pair is a record of what was missed, not
something to act on.

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

```ts
const opened = await live.subscribe().find((event) => event.kind === "window-add");
```

Each `subscribe()` is an independent view with its own buffer, so a loop and a
`waitFor` can run side by side without taking each other's events.

### Commands on the same connection

`watch()` opens a connection for notifications only. `connect()` returns a
server whose commands travel over that connection too, so a snapshot costs four
writes instead of four processes:

```ts
await using live = await server.connect();

for await (const event of live.subscribe()) {
  if (event.kind !== "window-add") continue;
  const snapshot = await live.snapshot(); // no process spawned
  console.log(snapshot.windows.count());
}
```

A connection can reopen itself after a drop with
`watch({ reconnect: { attempts: 3 } })`, which reports a `reconnected` event so
the gap is visible. The count bounds one outage rather than the connection's
whole life, so a watcher that recovers today still recovers next week. It is off by default, and commands in flight when a
connection drops are failed rather than replayed — tmux cannot say whether it
already ran one, and re-sending a mutation would apply it twice.

The API is the same `Server`; only the transport differs. Commands that feed
tmux a stdin — `loadBuffer` — still need the spawning server, because control
mode has no channel for one.

## Querying

`.where()` takes declarative, serializable criteria. `.filter()` takes an
ordinary predicate. They are never overloaded into each other.

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

## Field values

tmux has one wire type, and everything on it is text. A field whose shape this
port knows is decoded on the way out, so a pid is a number, a flag is a boolean,
and a timestamp is a `Date`:

```ts
pane.panePid; // number | null
pane.active; // boolean | null
session.created; // Date | null
window.index; // number — an identity tmux always populates, so never null
```

Which fields those are comes from tmux's own `format.c`, and an integration test
holds every one of them to a live server on each version CI runs. Anything else
is left exactly as tmux sent it, empty string included.

The text is never lost. `format` is the row as it arrived:

```ts
pane.format.pane_pid; // "2334787"
pane.format.pane_active; // "1"
```

Criteria take the decoded shape as well as the text, and mean the same thing
either way. The text side is there because the wire is: a serialized query
carries tmux's text, and `WhereDocumentV1` types both what you write and what
comes back — so it is exactly what this library's encoder can emit for that
field, and nothing else.

```ts
snapshot.panes.where({ active: true });
snapshot.panes.where({ active: "1" }); // what a flag encodes to
snapshot.panes.where({ pid: "2334787" }); // and a number
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
snapshot.windows.where({ index: Number(fromConfig) });
// Or ask about the characters rather than the value, which is what the
// substring operators are for and why they stay plain strings.
snapshot.windows.where({ index: { contains: fromConfig } });
```

Together, on a server with two windows. This is a literal excerpt of
[`examples/fields.ts`](../../examples/fields.ts), which the integration suite
runs against a real tmux server:

<!-- runs: examples/fields.ts -->

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
  .filter((pid): pid is number => pid !== null);

// Times arrive as Date.
const created = snapshot.sessions.one({ name: "fields" }).created;
if (created === null) throw new Error("expected tmux to report a creation time");
const sessionAgeMs = Date.now() - created.getTime();

// The text tmux actually sent is still on the row. Each window has an active
// pane, so this narrows to one window before asking for one pane.
const raw = panes.one({ active: true, window: { is: { name: "second" } } }).format.pane_active;
if (raw !== "1") throw new Error(`expected the raw row to hold "1", saw ${JSON.stringify(raw)}`);
```

Criteria are camelCase too, and serialize to tmux's stable spellings so a stored
query stays readable by other tools:

```ts
snapshot.panes.where({ title: { contains: "log" } });
// serializes to {"where":{"pane_title":{"contains":"log"}}}
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
const session = await server.newSession({ name: "work" });
const window = await session.newWindow({ name: "editor" });
const pane = await window.split({ size: "30%", startDirectory: "/srv" });

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
await window.move({ index: 2, session: "other" });
await window.link({ session: "other" });
await window.unlink();
await window.swapWith(other);
await pane.breakOut();
await pane.joinTo("other:1");
await pane.swapWith(otherPane);
```

Pane input and contents:

```ts
await pane.sendKeys("ls -la");
await pane.sendKeys("q", { enter: false, literal: true });
await pane.sendPrefix();
const lines = await pane.capture({ start: -100 });
await pane.clearHistory();
await pane.respawn("htop");
await pane.displayMessage("#{pane_current_command}");
```

Copy mode and the interactive choosers, which need an attached client:

```ts
await pane.enterCopyMode();
await pane.exitCopyMode();
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
await server.sourceFile("~/.tmux.conf");
await server.listCommands();
await server.runShell("echo hi");
await server.ifShell("[ -d /srv ]", "display-message ok");

await server.setBuffer("scratch", "text");
await server.loadBuffer("scratch", await Bun.file("payload.bin").bytes());
await server.showBuffer("scratch");
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

## Commands this package does not model

tmux has far more commands than any wrapper types. `cmd` runs one through the
same path as everything else — same socket, environment, deadline, and errors —
so reaching an unmodelled command never means building your own subprocess:

```ts
await server.cmd("list-keys", ["-T", "copy-mode"]);
await pane.cmd("clock-mode");
await window.cmd("display-panes");
await server.cmd("display-message", ["-p", "#{version}"], { target: null });
```

A handle sends its own id as the target, so `pane.cmd("clock-mode")` addresses
that pane. Pass `target` to address something else, or `null` for a command that
takes none. Failure raises `TmuxCommandError` carrying tmux's own stderr.

## Running several commands at once

Creating things one at a time costs more than one process per command. Every
mutation runs its command and then a snapshot, because it has to find what it
just made — so twelve windows cost sixty-four invocations, not twelve.

`plan` describes a mutation instead of running it. It takes what the direct call
takes and resolves to what the direct call resolves to; `batch` then spends one
invocation and one snapshot on the whole group:

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
frames as empty rather than shifting the one behind it:

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

Length is not your problem: tmux refuses an argument vector past 1000 elements
and a sequence shares one, so long sequences are split across invocations and
returned as one result list. Eight thousand commands run in about a second.

A connected server sends the commands one at a time instead. tmux answers a
chained line with one response block per command while the connection pairs one
block with one request, and separate sends cost the same on a socket that is
already open.

## Choosing how commands travel

Three choices are independent and compose: how a command travels, whether it is
grouped with others, and whether it overlaps them. Each is one token at the call
site, and none of them changes what you get back:

| Mode           | Turn it on                         | What changes                                                        | When to use it                                                   |
| -------------- | ---------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **spawning**   | the default                        | Each command is its own `tmux` process.                             | A script that runs a few commands and exits.                     |
| **connected**  | `await server.connect()`           | Commands travel over one already-open control connection.           | Anything long-lived, and any loop that reacts to events.         |
| **watching**   | `server.watch()`                   | Yields tmux's notifications as they happen.                         | Reacting to a change, rather than polling to find it.            |
| **planned**    | `.plan` instead of the direct call | Describes the mutation for `server.batch([…])` to run as one group. | Creating or changing several things at once.                     |
| **concurrent** | `Promise.all`                      | Independent commands overlap.                                       | Slow work on independent targets — not ordering-sensitive setup. |

The API and the types are the same throughout, with no exceptions: `connect()`
hands back the same handles the spawning server does, and `.plan` takes what the
direct call takes and resolves to what the direct call resolves to. tmux's
control protocol has no channel for a command's stdin, so a connected server
hands `loadBuffer` to a spawned process against the same socket rather than
refusing it — choosing a transport does not decide which commands exist.

### Running tmux somewhere else

Both built-in transports run the `tmux` on this machine. Everything above them —
capabilities, snapshots, the graph, queries, mutations — is built on one
operation, so replacing that operation moves the whole library to a tmux reached
over ssh, inside a container, or behind a daemon:

```ts
import { Server, TmuxServerRestarted } from "libtmux";
import { asSingleInvocation, guardRequest, refusedByGuard } from "libtmux/engine";
import type { TmuxCommandResult, TmuxEngine } from "libtmux/engine";

/** `run` is yours: give it an argument vector, get back what tmux wrote. */
function engineOver(
  endpoint: string,
  run: (argv: readonly string[], stdin: Uint8Array | undefined) => Promise<TmuxCommandResult>,
): TmuxEngine {
  return {
    // Where this reaches tmux. A socket path on another machine is not an
    // address, so without this two servers on the same path compare equal.
    endpoint,
    async execute(request) {
      // A command addressed by id must not run on a daemon that reissued that
      // id. These two are the wrapper and its reply, published rather than
      // described so an engine inherits restart safety instead of rebuilding
      // it: `guardRequest` makes tmux refuse, `refusedByGuard` tells that
      // refusal from the command itself having failed.
      const guarded = guardRequest(request);
      const result = await run([guarded.executable, ...guarded.args], guarded.stdin);
      if (request.daemonGuard !== undefined && refusedByGuard(result.returncode, result.stderr)) {
        throw new TmuxServerRestarted("the daemon this handle was read from is gone");
      }
      return result;
    },
    async executeGroup(requests) {
      const first = requests[0];
      if (first === undefined) return [];
      // One tmux invocation, or a snapshot stops being one instant. This
      // assembles the command list and splits its output back apart; the
      // built-in engine calls the same helper.
      const invocation = asSingleInvocation(requests);
      const result = await run([first.executable, ...invocation.args], undefined);
      return invocation.sections(result.stdout).map((stdout) => ({ ...result, stdout }));
    },
  };
}

// Standing in for ssh or `docker exec`: the point is that nothing above the
// seam knows where tmux is.
const remote = new Server({
  engine: engineOver("ssh://build-host", async (argv) => {
    const child = Bun.spawn(["ssh", "build-host", ...argv], { stderr: "pipe", stdout: "pipe" });
    const [returncode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
    ]);
    return {
      cmd: argv,
      returncode,
      signal: null,
      stderr: new Uint8Array(stderr),
      stdout: new Uint8Array(stdout),
    };
  }),
});
```

The seam is bytes in, bytes out, and stops there on purpose. One at the graph
would make every implementer responsible for framing, capability gating and
normalization; this one leaves them responsible only for the part that differs.
Two obligations come with it, both documented on `TmuxEngine` and both with a
helper rather than a description to follow: run a group as one command list
(`asSingleInvocation`), and either honour a request's `daemonGuard`
(`guardRequest`) or be bound to one daemon the way a control connection is.

`watch()` and `connect()` are the two calls an engine does not carry. Both hold
a local `tmux -C attach` process open, which is the thing an engine exists to
avoid needing, so they refuse rather than attaching to whichever tmux this
machine happens to be running. `LIBTMUX_TRANSPORT` is ignored for the same
reason, and naming `transport: "control"` alongside an engine is refused
outright.

### Choosing the transport from outside

A test forcing a mode and a service configured by its deployment both need the
transport chosen without editing the code that uses it. Three places can name
it, and the more specific one wins:

1. **The call.** `server.connect()` and `server.watch()` open a connection
   whatever the other two say.
2. **Construction.** `Server.open({ transport })` takes the mode directly.
3. **The environment.** `Server.open()` reads `LIBTMUX_TRANSPORT` when the
   option is absent.

With none of them, commands spawn.

```ts
await using managed = await Server.open({ transport: "control" });
const counted = (await managed.snapshot()).sessions.count();
```

```console
$ LIBTMUX_TRANSPORT=control bun run ./script.ts
```

`new Server()` reads neither the option nor the variable and always spawns.
Attaching is asynchronous and can fail, so a constructor appearing to honour
them would either hide the wait or defer the failure to whichever command
happened to run first — `Server.open()` is asynchronous for exactly that reason.

`close()` is valid on what `open()` returns whichever mode it picked, and does
nothing on a spawning server — so switching modes never means changing the
caller. An unreadable value is refused where it is written rather than quietly
spawning.

For a connection scoped to one block, `withConnection` closes it on the way out
whether the body returns or throws — useful where `await using` is not
available, since it needs `Symbol.asyncDispose` in the consumer's `lib`:

```ts
const built = await server.withConnection(async (connected) => {
  await session.newWindow({ name: "build" });
  return connected.waitFor((current) => current.windows.exists({ name: "build" }));
});
```

Batching stays a per-call-site choice rather than a mode: it changes when
failures surface — a group stops at its first failure, leaving what ran applied
— so turning it on from outside would change a program's error handling without
touching its code.

Twelve windows, tmux 3.7b, 20 cores, median of three runs — reproduce with
`bun scripts/bench-modes.ts`:

| transport | batching      | concurrency | wall-clock | invocations | query result | order           |
| --------- | ------------- | ----------- | ---------- | ----------- | ------------ | --------------- |
| spawn     | one-at-a-time | sequential  | 1231 ms    | 64          | 12 windows   | as requested    |
| spawn     | one-at-a-time | concurrent  | 1541 ms    | 64          | 12 windows   | reordered (3/3) |
| spawn     | chained       | sequential  | 40 ms      | 5           | 12 windows   | as requested    |
| spawn     | planned       | sequential  | 175 ms     | 9           | 12 windows   | as requested    |
| control   | one-at-a-time | sequential  | 981 ms     | 0           | 12 windows   | as requested    |
| control   | one-at-a-time | concurrent  | 1516 ms    | 0           | 12 windows   | as requested    |
| control   | chained       | sequential  | 58 ms      | 0           | 12 windows   | as requested    |
| control   | planned       | sequential  | 206 ms     | 0           | 12 windows   | as requested    |

Every row answers the query identically. Only the cost differs, which is the
point of the table. Reading it:

**Batching is the one that matters.** Sixty-four invocations become nine, and a
second becomes a fifth of one. `plan` costs four invocations more than raw
`pipeline` because it takes the snapshot that turns printed ids into handles —
that is what you are buying.

**A connection removes processes, not round trips.** The `control` rows spawn
nothing at all, which is what makes reacting to `watch` events in a loop
affordable. It does not make a command sequence shorter, so batching still pays
on top of it.

**Concurrency is the one to be careful with.** It bought nothing here — twelve
`new-window` calls are dominated by tmux's own serialization, not by waiting —
and spawning them concurrently reordered the result in most runs: the windows
all exist, but not in the order they were asked for. The table reports how often,
because that is the hazard: an ordering that usually breaks is worse to rely on
than one that always does. Over a connection the order survives, because one
socket writes them in the order they were submitted. If order matters and you
want the speed, batch instead.

## Recipes

### Wait for a pane to print something

Polling a pane either misses output between reads or spends a command on each
one. Subscribe first, then act, so a line printed while you were still
connecting is not lost:

```ts
await using events = server.watch();
await events.ready();

await pane.sendKeys("make build");

let seen = "";
for await (const event of events) {
  if (event.kind !== "output" || event.paneId !== pane.id) continue;
  seen += event.data;
  if (seen.includes("BUILD OK")) break;
}
```

A pane echoes what is typed into it, so waiting for text that also appears in
the keys you just sent matches the echo rather than the output. Wait for
something the command prints.

### Act, then wait, on one connection

The loop an agent runs. `connect()` carries the commands and the notifications
that say what they did, so reacting costs nothing per iteration — and
subscribing before sending means a marker printed in between is still seen.

This recipe is a literal excerpt of [`examples/agent.ts`](../../examples/agent.ts),
which the integration suite runs against a real tmux server:

<!-- runs: examples/agent.ts -->

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

await server.setHook("after-new-window", "display-message created");
await server.showHooks();
await server.unsetHook("after-new-window");
```

Window and pane scopes report only what was set on them, never inherited
values.

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
queue entry that would run it. Over a control connection there is nothing to
condition — the connection is bound to one daemon, and losing it is the signal.
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
`QueryValidationError`. `ObjectDoesNotExist`, `MultipleObjectsReturned`, and
`DeprecatedError` exist for compatibility with the Python library's names.

`parseLegacyWhere` converts Python-style `name__contains=` filter strings into
criteria, for code being ported rather than written fresh.

## Running inside tmux

```ts
import { Session } from "libtmux";

const session = await Session.fromEnv();
```

The pane is authoritative: `$TMUX` carries a session id that goes stale when a
pane moves, so the session is resolved through `$TMUX_PANE`.

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

The root export carries everything. Each model is also its own subpath for a
consumer that wants to name one: `libtmux/server`, `libtmux/session`,
`libtmux/window`, `libtmux/pane`, `libtmux/client`, and `libtmux/selection`,
plus `libtmux/formats`, `libtmux/constants`, `libtmux/common`, and
`libtmux/exc`.

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

`raw` is tmux's own string, so a `master` build or a vendor suffix survives the
parsed fields. A `master` build compares above every tagged release.

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
