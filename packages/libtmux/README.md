<!-- libtmux-logo -->
<div align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/libtmux/libtmux-ts/HEAD/packages/libtmux/assets/logo.svg" type="image/svg+xml">
    <img src="https://raw.githubusercontent.com/libtmux/libtmux-ts/HEAD/packages/libtmux/assets/logo.png" width="128" height="128" alt="libtmux for TypeScript">
  </picture>
</div>
<!-- /libtmux-logo -->

<div align="center">

# libtmux

Typed, Bun-first TypeScript control of [tmux](https://github.com/tmux/tmux).

[![libtmux](https://img.shields.io/npm/v/libtmux?label=libtmux)](https://www.npmjs.com/package/libtmux)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.3a%E2%80%933.8-1bb91f)](../../.github/workflows/typescript.yml)
[![dependencies](https://img.shields.io/badge/dependencies-0-1bb91f)](tests/unit/package_contract.test.ts)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![libtmux.org](https://img.shields.io/badge/docs-libtmux.org-0b7285)](https://libtmux.org/en/ts/)

</div>

Read a server once into an [immutable snapshot][ref-server-snapshot],
[query it][ref-selection-where] with declarative criteria,
[change it][ref-session-newwindow] with typed calls, and
[hear about changes][ref-server-watch] as tmux makes them. It suits agents,
launchers, test harnesses and dashboards.

Part of [libtmux for Bun and TypeScript](https://github.com/libtmux/libtmux-ts#readme).
An MCP server, a workspace builder and a workspace command build on this
package: see [Packages](#packages).

Add it to your project:

```console
$ bun add libtmux
```

Requires tmux 3.3a or newer, Node 22+ or Bun 1.3.14+, and TypeScript 5.7+ —
5.6 and below ship no `ES2024` lib, which these declarations are built against.

Runs on Linux, including WSL. macOS is supported on a best-effort basis,
and CI coverage for it is highly limited.

> [!WARNING]
> Releases are numbered `0.1.N`, and each release increments `N`. The API is not
> settled: any release may change or remove exported identifiers, and the
> changelog marks each break. Pin an exact version to avoid one.
> Read the [changelog](CHANGELOG.md) before you upgrade.

**Contents** — [Quick start](#quick-start) ·
[Read what tmux holds](#read-what-tmux-holds) ·
[Find sessions, windows, and panes](#find-sessions-windows-and-panes) ·
[Change sessions, windows, and panes](#change-sessions-windows-and-panes) ·
[Run several commands at once](#run-several-commands-at-once) ·
[Run a program and read its output](#run-a-program-and-read-its-output) ·
[Type into a pane and wait](#type-into-a-pane-and-wait) ·
[Watch tmux change](#watch-tmux-change) ·
[Choosing how work is arranged](#choosing-how-work-is-arranged) ·
[Options and hooks](#options-and-hooks) · [Environments](#environments) ·
[Errors](#errors) · [Test your own code](#test-your-own-code) ·
[Run inside tmux](#run-inside-tmux) · [tmux versions](#tmux-versions) ·
[Consumers](#consumers) · [Packages](#packages) · [Entrypoints](#entrypoints) ·
[Parity with the Python library](#parity-with-the-python-library) ·
[What it leaves out](#what-it-leaves-out) ·
[Support and status](#support-and-status) · [Documentation](#documentation) ·
[License](#license)

## Quick start

Create a session, split a window, read the result back from a snapshot, and
type into a pane. This is the whole program:

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

`new Server()` drives the tmux server your own `tmux` command does: the one
`TMUX` names inside tmux, otherwise tmux's default socket. Set
`LIBTMUX_SOCKET_PATH` to a socket path, or `LIBTMUX_SOCKET` to a socket name,
to drive another; the path wins when both are set. Pass `socketName` or
`socketPath` to [`ServerOptions`][ref-serveroptions] for a private one, which
the variables never override. The program prints `2`: the `editor` window holds
two panes after the split.

Every TypeScript block here is type-checked by `bun run typecheck:readme` and,
unless a comment says otherwise, run against a real tmux server by
`bun run test:readme`. The programs in [`examples/`](../../examples) are run by
the integration suite.

## Start here

The API is small and the pieces stack in one order. Read them in this order and
each one uses the last:

1. **[Snapshots](#read-what-tmux-holds)** — [`server.snapshot()`][ref-server-snapshot] reads the whole server once.
   Everything else resolves off it without talking to tmux again.
2. **[Querying](#find-sessions-windows-and-panes)** — [`.where()`][ref-selection-where] for declarative criteria, [`.filter()`][ref-selection-filter]
   for a predicate. Both run against the snapshot you already hold.
3. **[Operations](#change-sessions-windows-and-panes)** — [`newWindow`][ref-session-newwindow], [`split`][ref-window-split], [`sendKeys`][ref-pane-sendkeys]: the calls
   that change something, each resolving to a handle.
4. **[Running several at once](#run-several-commands-at-once)** — [`plan`][ref-session-plan] and
   [`batch`][ref-server-batch], once you are making more than a couple of changes.
5. **[Watching](#watch-tmux-change)** — [`server.watch()`][ref-server-watch] for what changed rather than
   what is true, and [`server.connect()`][ref-server-connect] to pair a server with that observer.

A snapshot answers _what is true now_; a watch answers _what changed_. Most
programs need the first, and reach for the second when they have to react.

What follows those five — deadlines, engines, observation, options,
environments, errors — is depth for when a program needs it.

Call costs on this page are measured: [`examples/observe/`](../../examples/observe/README.md)
counts the invocations a snapshot and a hundred queries make, against a real
server.

<details>
<summary><b>Everything on this page</b></summary>

<!-- toc -->

- [Quick start](#quick-start)
- [Start here](#start-here)
- [Read what tmux holds](#read-what-tmux-holds)
  - [`Server.snapshot`: read the whole server once](#serversnapshot-read-the-whole-server-once)
  - [`ServerSnapshot`: it never changes](#serversnapshot-it-never-changes)
  - [`Server.sessions` and its siblings: one snapshot each](#serversessions-and-its-siblings-one-snapshot-each)
  - [`Window.refreshed`: read one handle at a later instant](#windowrefreshed-read-one-handle-at-a-later-instant)
- [Find sessions, windows, and panes](#find-sessions-windows-and-panes)
  - [`Selection.where` and `Selection.filter`: criteria or a predicate](#selectionwhere-and-selectionfilter-criteria-or-a-predicate)
  - [Operators: strings, AND/OR/NOT, regular expressions and relations](#operators-strings-andornot-regular-expressions-and-relations)
  - [`ClientWhere`: clients are queryable too](#clientwhere-clients-are-queryable-too)
  - [`Selection`: immutable, ordered, iterable](#selection-immutable-ordered-iterable)
  - [Relations are properties](#relations-are-properties)
  - [Handles read in TypeScript names](#handles-read-in-typescript-names)
  - [Field values arrive decoded](#field-values-arrive-decoded)
  - [Criteria take decoded values and wire text](#criteria-take-decoded-values-and-wire-text)
  - [`QueryValidationError`: numbers must be exact](#queryvalidationerror-numbers-must-be-exact)
  - [`encodeWhereDocument`: store a query](#encodewheredocument-store-a-query)
- [Change sessions, windows, and panes](#change-sessions-windows-and-panes)
  - [`Window.rename`: a change leaves the handle at its old instant](#windowrename-a-change-leaves-the-handle-at-its-old-instant)
  - [`Session.newWindow` and `Window.split`: the everyday calls](#sessionnewwindow-and-windowsplit-the-everyday-calls)
  - [`Pane.zoom` and `Pane.unzoom`: set a state](#panezoom-and-paneunzoom-set-a-state)
  - [`PaneDirection`: which side a split lands on](#panedirection-which-side-a-split-lands-on)
  - [`shellCommand`: run something other than the shell](#shellcommand-run-something-other-than-the-shell)
  - [`Window.move` and `Window.link`: move and link windows](#windowmove-and-windowlink-move-and-link-windows)
  - [Handles as targets](#handles-as-targets)
  - [`Window.unlink` and `Window.removePlacement`](#windowunlink-and-windowremoveplacement)
  - [`Pane.sendKeys` and `Pane.capture`: pane input and contents](#panesendkeys-and-panecapture-pane-input-and-contents)
  - [`Pane.enterCopyMode`: copy mode needs no client](#paneentercopymode-copy-mode-needs-no-client)
  - [`Pane.displayPopup` and the choosers need a client](#panedisplaypopup-and-the-choosers-need-a-client)
  - [Server-wide commands and paste buffers](#server-wide-commands-and-paste-buffers)
  - [`Client.switchTo`: clients, and re-reading a handle](#clientswitchto-clients-and-re-reading-a-handle)
  - [Describing a handle](#describing-a-handle)
  - [Comparing handles and reading options](#comparing-handles-and-reading-options)
  - [`Server.cmd`: a command this package does not model](#servercmd-a-command-this-package-does-not-model)
- [Run several commands at once](#run-several-commands-at-once)
  - [`Server.batch`: plan, then run](#serverbatch-plan-then-run)
  - [`Server.pipeline`: raw arguments, one result each](#serverpipeline-raw-arguments-one-result-each)
  - [`Server.newSession`: build a workspace](#servernewsession-build-a-workspace)
- [Run a program and read its output](#run-a-program-and-read-its-output)
  - [`Server.run`: one call, only the output](#serverrun-one-call-only-the-output)
  - [`Server.spawn`: drive it, then wait](#serverspawn-drive-it-then-wait)
  - [`Program.stream`: follow it as it writes](#programstream-follow-it-as-it-writes)
  - [`Program.output`: read it once it ends](#programoutput-read-it-once-it-ends)
  - [`Program.kill`: end it yourself](#programkill-end-it-yourself)
  - [`input`: give it a stdin](#input-give-it-a-stdin)
  - [`separateStderr`: keep stderr apart](#separatestderr-keep-stderr-apart)
  - [`signal`: cancel a run](#signal-cancel-a-run)
  - [`placement` and `keep`: run it where a person sees it](#placement-and-keep-run-it-where-a-person-sees-it)
  - [`orphanAfterMs`: end it with this process](#orphanafterms-end-it-with-this-process)
- [Type into a pane and wait](#type-into-a-pane-and-wait)
  - [`Pane.sendKeys`: type, then read what it said](#panesendkeys-type-then-read-what-it-said)
  - [`Server.watch`: wait for a pane to print something](#serverwatch-wait-for-a-pane-to-print-something)
  - [`Server.connect`: act, then wait, with an observer](#serverconnect-act-then-wait-with-an-observer)
  - [`Pane.waitForCommand`: a command's status from the shell's marks](#panewaitforcommand-a-commands-status-from-the-shells-marks)
  - [`Pane.waitForExit`: wait for a pane you did not start](#panewaitforexit-wait-for-a-pane-you-did-not-start)
- [Watch tmux change](#watch-tmux-change)
  - [`Server.watch`: hear changes as they happen](#serverwatch-hear-changes-as-they-happen)
  - [`pauseAfterSeconds`: pace a busy pane](#pauseafterseconds-pace-a-busy-pane)
  - [`Server.connect`: pair commands with the observer](#serverconnect-pair-commands-with-the-observer)
  - [Subscribing to a format](#subscribing-to-a-format)
  - [`waitFor`: wait for something to happen](#waitfor-wait-for-something-to-happen)
- [Choosing how work is arranged](#choosing-how-work-is-arranged)
  - [`maxInFlight`: how many commands run at once](#maxinflight-how-many-commands-run-at-once)
  - [`TmuxEngine`: put tmux behind SSH, a container, or a daemon](#tmuxengine-put-tmux-behind-ssh-a-container-or-a-daemon)
  - [`Server.withConnection`: a connection for one block](#serverwithconnection-a-connection-for-one-block)
  - [`onInvocation`: see what it runs](#oninvocation-see-what-it-runs)
  - [Deadlines and cancellation: `timeoutMs` and `signal`](#deadlines-and-cancellation-timeoutms-and-signal)
- [Options and hooks](#options-and-hooks)
  - [`Session.setOption`: read and write options and hooks](#sessionsetoption-read-and-write-options-and-hooks)
- [Environments](#environments)
  - [`Session.setEnvironment`: seed a variable for every pane](#sessionsetenvironment-seed-a-variable-for-every-pane)
- [Errors](#errors)
  - [`TmuxCommandError`: tmux said no](#tmuxcommanderror-tmux-said-no)
  - [`TmuxTransportError`: no answer](#tmuxtransporterror-no-answer)
  - [`TmuxServerRestartedError`: the daemon is gone](#tmuxserverrestartederror-the-daemon-is-gone)
  - [`Server.isAlive`: ask without raising](#serverisalive-ask-without-raising)
  - [`LibTmuxError`: the base class](#libtmuxerror-the-base-class)
  - [Query errors: `NoMatchError` and its relatives](#query-errors-nomatcherror-and-its-relatives)
  - [Migrating from alpha.9](#migrating-from-alpha9)
- [Test your own code](#test-your-own-code)
  - [`recordInvocations` and `replayInvocations`: no tmux in unit tests](#recordinvocations-and-replayinvocations-no-tmux-in-unit-tests)
- [Run inside tmux](#run-inside-tmux)
  - [`Session.fromEnv`: find the session you are in](#sessionfromenv-find-the-session-you-are-in)
- [tmux versions](#tmux-versions)
  - [`Server.version` and `versionAtLeast`: gate your own code](#serverversion-and-versionatleast-gate-your-own-code)
  - [`VersionTooLowError`: tmux older than 3.3a is refused](#versiontoolowerror-tmux-older-than-33a-is-refused)
  - [Features above the floor](#features-above-the-floor)
- [Consumers](#consumers)
- [Packages](#packages)
  - [`@libtmux/mcp`: a tmux server for agents](#libtmuxmcp-a-tmux-server-for-agents)
  - [`@libtmux/workspace`: tmuxp-style workspaces as data](#libtmuxworkspace-tmuxp-style-workspaces-as-data)
  - [`@libtmux/workspace-cli`: `tmux-workspace` for the shell](#libtmuxworkspace-cli-tmux-workspace-for-the-shell)
- [Entrypoints](#entrypoints)
- [Parity with the Python library](#parity-with-the-python-library)
- [What it leaves out](#what-it-leaves-out)
- [Support and status](#support-and-status)
- [Documentation](#documentation)
- [License](#license)

<!-- /toc -->

Also: [API reference](docs/api.md) · [Benchmarks](docs/benchmarks.md)

Hosted: [API reference][ref-reference] ·
[Guides][guides] ·
[Topics][topics] ·
[Concepts][concepts]

</details>

## Read what tmux holds

A snapshot is one read of the whole server. Everything reachable from it
resolves locally, and it never changes.

### [`Server.snapshot`][ref-server-snapshot]: read the whole server once

`snapshot()` acquires the server in one round of commands and returns a
[`ServerSnapshot`][ref-serversnapshot] whose
properties are [`Selection`][ref-selection]s of sessions, windows, panes and
clients:

```ts
const snapshot = await server.snapshot();

snapshot.sessions; // Selection<Session>
snapshot.windows; // Selection<Window>
snapshot.panes; // Selection<Pane>
snapshot.clients; // Selection<Client>
```

Reading a property issues no tmux command.

### [`ServerSnapshot`][ref-serversnapshot]: it never changes

Acquire again to see later state. The earlier snapshot keeps reporting its own
instant, so a value you captured cannot shift underneath you:

```ts
const before = await server.snapshot();
await server.newSession({ name: "later" });

before.sessions.length; // unchanged
(await server.snapshot()).sessions.length; // includes "later"
```

### [`Server.sessions`][ref-server-sessions] and its siblings: one snapshot each

[`windows()`][ref-server-windows], [`panes()`][ref-server-panes] and
[`clients()`][ref-server-clients] sit beside it, and each takes a snapshot of
its own.

- Several calls in a row cost several round trips and describe several instants.
- Take one `snapshot()` and read the collections off it.
- [Why](docs/contracts.md#snapshots-and-handles) the per-call accessors cost
  an invocation each.

### [`Window.refreshed`][ref-window-refreshed]: read one handle at a later instant

`refreshed()` answers with a new handle and leaves the receiver alone, so the
snapshot you hold keeps agreeing with itself:

```ts
const window = snapshot.windows.one({ name: "editor" });
await window.rename("build");

window.name; // "editor" — the instant this was read at
(await window.refreshed()).name; // "build"
```

A window keeps its placement, so one linked into two sessions stays on the one
you resolved. [The contract](docs/contracts.md#snapshots-and-handles) covers
why a handle never advances in place.

## Find sessions, windows, and panes

Ask a snapshot for what you want. [`.where()`][ref-selection-where] takes
declarative criteria and [`.filter()`][ref-selection-filter] takes a predicate;
they are never overloaded into each other. The hosted
[querying guide][guide-querying] and [queries concept][concept-queries] cover
the same ground.

### [`Selection.where`][ref-selection-where] and [`Selection.filter`][ref-selection-filter]: criteria or a predicate

`.where()` takes criteria as data, and [`encodeWhereDocument`][ref-encodewheredocument]
serializes them in a model-tagged document. `.filter()` takes an ordinary
predicate, and `.map()` returns an array:

```ts
snapshot.panes.where({ currentCommand: "vim" });
snapshot.panes.filter((pane) => pane.currentCommand?.startsWith("v") === true);
snapshot.panes.map((pane) => pane.id); // an array, not a Selection
```

- Most programs need only equality and a relation: [`one({ id })`][ref-selection-one]
  re-finds something you hold, and `{ session: { is: { id } } }` scopes a query
  to it.
- The operators below are for a caller exploring a server it did not build, or
  running a query it did not write: a saved filter, a `--where` flag, an
  agent's argument.
- If you know the ids, you do not need them.

### Operators: strings, AND/OR/NOT, regular expressions and relations

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

Matching is case-sensitive unless you say otherwise:

```ts
snapshot.sessions.where({ name: { contains: "API", mode: "insensitive" } });
```

[`decodeWhereDocument`][ref-decodewheredocument] validates a document read back
from a config file, an MCP call or a CLI. Every field and operator is in the
[criteria reference](docs/criteria.md), generated from the table the compiler
matches against.

### [`ClientWhere`][ref-clientwhere]: clients are queryable too

[`SessionWhere`][ref-sessionwhere], [`WindowWhere`][ref-windowwhere] and
[`PaneWhere`][ref-panewhere] have a sibling for clients. tmux gives a client no
id, so one is identified by the terminal it occupies, and a control client
occupies none:

<!-- static: names a terminal device that exists only on the reader's machine -->

```ts
snapshot.clients.where({ controlMode: "1" });
snapshot.clients.where({ session: { is: { name: "work" } } });
snapshot.clients.one({ tty: "/dev/pts/3" });
```

### [`Selection`][ref-selection]: immutable, ordered, iterable

A `Selection` is immutable, ordered and replayable. It is `Iterable`, but it is
not an `Array`:

```ts
selection.length;
selection.at(0);
selection.toArray();
[...selection];
```

The cardinality helpers [`first`][ref-selection-first], [`one`][ref-selection-one],
[`oneOrUndefined`][ref-selection-oneorundefined], [`exists`][ref-selection-exists]
and [`count`][ref-selection-count] each accept optional criteria:

```ts
selection.first({ name: "work" });
selection.one({ name: "work" }); // NoMatchError / MultipleMatchesError
selection.oneOrUndefined({ name: "work" });
selection.exists({ name: "work" });
selection.count({ name: "work" });
```

### Relations are properties

The data was already acquired, so reading a relation issues no tmux command.
[`Server`][ref-server] accessors are the async ones, because they acquire:

```ts
session.windows; // Selection<Window>
session.panes; // Selection<Pane>
window.session; // Session | undefined
window.linkedSessions; // every session a window is linked into
pane.window;
client.pane;
```

```ts
await server.sessions();
await server.windows();
```

### Handles read in TypeScript names

tmux's own token names stay available under `format`, which is also where you
reach fields the shortened names do not cover:

```ts
pane.id; // pane_id
pane.currentCommand; // pane_current_command
window.index; // window_index
session.name; // session_name

pane.format.pane_current_command;
```

Object ids are authenticated before a snapshot handle or event exposes them,
and their brands stop an id already read as one kind from being mixed with
another:

```ts
import type { PaneId, PaneIdInput } from "libtmux";

const capturedPane: PaneId = pane.id;
const configuredPane: PaneIdInput = "%0";
```

### Field values arrive decoded

tmux has one wire type, and everything on it is text. A field whose shape this
port knows is decoded on the way out, so a pid is an authenticated safe
integer, a flag is a boolean, and a timestamp is a `Date`:

```ts
pane.panePid; // SafeInteger | null
pane.active; // boolean | null
session.created; // Date | null
window.index; // SafeInteger — an identity tmux always populates
```

The text is never lost: `format` is the row as it arrived. Anything this port
does not decode is left exactly as tmux sent it, empty string included.

```ts
pane.format.pane_pid; // "2334787"
pane.format.pane_active; // "1"
```

### Criteria take decoded values and wire text

- A non-null decoded value lowers to its exact wire spelling.
- A `null` criterion matches every value the field's decoder treats as absent
  or invalid, including an empty typed field and a time reported as `0`.
- Serialized bytes use stable tmux field names and text values; a decoded
  `WhereDocumentV1` restores camelCase names, so one type covers what you write
  and what comes back.

```ts
import { isSafeInteger, safeInteger } from "libtmux";

snapshot.panes.where({ active: true });
snapshot.panes.where({ active: "1" }); // what a flag encodes to
snapshot.windows.where({ index: 3 }); // a number, written as one
snapshot.panes.where({ pid: "2334787" }); // or its wire text
snapshot.panes.where({ pid: process.pid }); // or one you computed
const candidate = Number(process.env["BUILD_PID"]);
if (isSafeInteger(candidate)) snapshot.panes.where({ pid: candidate });
```

### [`QueryValidationError`][ref-queryvalidationerror]: numbers must be exact

- A numeric criterion takes any `number`. One that is not an exact integer —
  `NaN`, an infinity, a fraction, an unsafe integer — raises the error, naming
  the field it was written under.
- `SafeInteger` is what decoded fields carry, so a value read off a handle is
  already proven exact.
- `safeInteger` authenticates a number from elsewhere and throws when it is
  not; [`isSafeInteger`][ref-issafeinteger] narrows without throwing.

Invalid wire spellings remain type errors:

<!-- static: the calls are intentionally invalid and would throw if executed -->

```ts
// @ts-expect-error a flag encodes to "0" or "1"; nothing else is a flag
snapshot.panes.where({ active: "yes" });
// @ts-expect-error and no number encodes to "banana"
snapshot.panes.where({ pid: "banana" });
```

A `string` you have at runtime — from a config file, an argument, a raw
`.format` value — says nothing yet about which it is. Say what it means:

```ts
const fromConfig = process.argv[2] ?? "";
// A number: refused here, by `safeInteger`, rather than at the query.
snapshot.windows.where({ index: safeInteger(Number(fromConfig)) });
// Or ask about the characters rather than the value, which is what the
// substring operators are for and why they stay plain strings.
snapshot.windows.where({ index: { contains: fromConfig } });
```

Together, on a server with two windows. This is a literal excerpt of
[`examples/fields/fields.ts`](../../examples/fields/fields.ts), which the
integration suite runs against a real tmux server:

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

### [`encodeWhereDocument`][ref-encodewheredocument]: store a query

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

[`compileBoundedRegex`][ref-compileboundedregex] applies the same bounded
regular-expression grammar when arbitrary input needs it:

```ts
import { compileBoundedRegex } from "libtmux";

const matcher = compileBoundedRegex("^ready-[0-9]+$");
if (!matcher.test("ready-12")) throw new Error("expected a match");
```

- A criterion is spelled like the accessor it filters: a pane reads
  `pane.currentCommand` and filters on `currentCommand`.
- A field keeps its prefix when dropping it would shadow a relation:
  `sessionWindows` is a window count, `windows` the windows themselves.
- Fields that hold one value for the whole server — `version`, `pid`,
  `socketPath` — are readable on a handle but are not criteria.

## Change sessions, windows, and panes

Every handle exposes the tmux commands that apply to it. Each returns a promise,
and those that create something return a handle to it.

### [`Window.rename`][ref-window-rename]: a change leaves the handle at its old instant

A mutation resolves to nothing and leaves the handle reading the instant it was
acquired at, so a mutation you need the result of is two calls:

```ts
await window.rename("build");
window.name; // still "editor": the instant this handle was read at
(await window.refreshed()).name; // "build"
```

### [`Session.newWindow`][ref-session-newwindow] and [`Window.split`][ref-window-split]: the everyday calls

[`Window.selectLayout`][ref-window-selectlayout], [`Pane.resize`][ref-pane-resize],
[`Pane.sendKeys`][ref-pane-sendkeys] and the rest sit beside them. Sessions,
windows, and panes:

```ts
import { isSplitSize, isTmuxName, splitSize } from "libtmux";

await server.validateLayouts([{ layout: "even-h", panes: 2 }]);
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
await pane.zoom();
await pane.unzoom();
await window.unzoom();
await pane.setTitle("build output");
await pane.kill();
```

### [`Pane.zoom`][ref-pane-zoom] and [`Pane.unzoom`][ref-pane-unzoom]: set a state

- Each call sets a state rather than flipping one, so calling twice does
  nothing the second time.
- An ordinary resize unzooms first, so a size and a zoom cannot both hold.
- [How](docs/contracts.md#operations) one invocation does it when tmux offers
  only a toggle.

### [`PaneDirection`][ref-panedirection]: which side a split lands on

`direction` says which side a split lands on, where a new window sits
([`WindowDirection`][ref-windowdirection]), and lets a resize adjust rather
than set. tmux reaches "above" and "left" only by pairing an axis with `-b`, so
a boolean cannot express them:

```ts
import { PaneDirection, ResizeAdjustmentDirection, WindowDirection } from "libtmux";

await pane.split({ direction: PaneDirection.Above });
await pane.split({ direction: PaneDirection.Left });
await session.newWindow({ direction: WindowDirection.Before, name: "logs" });
await pane.resize({ amount: 5, direction: ResizeAdjustmentDirection.Down });
```

### [`shellCommand`][ref-newwindowoptions]: run something other than the shell

- tmux hands it to a shell, so a whole command line works.
- It replaces the shell rather than running inside it: when it exits, the
  window or pane closes, unless `remain-on-exit` says otherwise.
- A new window's placement is measured from the session's selected window.

```ts
await session.newWindow({ name: "server", shellCommand: "npm run dev" });
await window.split({ shellCommand: "tail -f log/development.log" });
await server.newSession({ name: "ci", shellCommand: "just watch" });
```

### [`Window.move`][ref-window-move] and [`Window.link`][ref-window-link]: move and link windows

Moving and linking windows between sessions:

```ts
await window.swapWith(other);
await other.move({ index: 2, session: "other" });
await window.link({ session: "other" }); // one window, in two sessions
await pane.breakOut();
await pane.joinTo("other:1");
await pane.swapWith(otherPane);
```

### Handles as targets

Each of those takes a handle as readily as a string, and a handle is checked
against this object's server before the command runs:

```ts
const owner = await server.newSession({ name: "handle-targets" });
const shared = await owner.newWindow({ name: "shared" });
const guest = await server.newSession({ name: "handle-guest" });

await shared.link({ session: guest }); // the session, not its name
await owner.selectWindow(shared); // the window, not its index

const left = await owner.newWindow({ name: "left" });
const right = await owner.newWindow({ name: "right" });
await right.panes.one().joinTo(left.panes.one());
```

- A handle from a different server raises `TypeError`, because a bare id
  cannot be checked: `@1` exists on every server that has a window.
- A handle names a placement, and one window can sit in two sessions. After a
  move, read the window back from a fresh snapshot instead of reusing the
  handle that moved it.
- [The contract](docs/contracts.md#operations) covers both.

### [`Window.unlink`][ref-window-unlink] and [`Window.removePlacement`][ref-window-removeplacement]

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

[`killIfWindowUnshared`][ref-pane-killifwindowunshared] kills a pane only while
its window has one placement:

```ts
await pane.killIfWindowUnshared();
```

### [`Pane.sendKeys`][ref-pane-sendkeys] and [`Pane.capture`][ref-pane-capture]: pane input and contents

```ts
await pane.sendKeys("ls -la");
await pane.sendKeys("q", { enter: false, literal: true });
await pane.sendPrefix();
const lines = await pane.capture({ start: -100 });
await pane.clearHistory();
await pane.respawn("htop", { kill: true });
await pane.displayMessage("#{pane_current_command}");
```

### [`Pane.enterCopyMode`][ref-pane-entercopymode]: copy mode needs no client

A detached pane enters and leaves copy mode like any other:

```ts
await pane.enterCopyMode();
await pane.exitCopyMode();
```

### [`Pane.displayPopup`][ref-pane-displaypopup] and the choosers need a client

A popup and a menu stay open until someone dismisses them, and tmux answers
only then, so the promise reports that it is over:

<!-- static: each stays on screen until a person dismisses it -->

```ts
await pane.displayPopup("less README.md");
await pane.displayMenu("Pane", [{ command: "kill-pane", key: "k", name: "Kill" }]);
```

The choosers, such as [`chooseTree`][ref-pane-choosetree], resolve as soon as
the chooser is on screen. Awaiting one tells you it opened, never what was
chosen; bind a tmux command to the selection if you need to act on it:

<!-- static: each opens a chooser that stays on screen until a person dismisses it -->

```ts
await pane.chooseTree();
await pane.chooseBuffer();
await pane.findWindow("editor");
await pane.customizeMode();
```

### Server-wide commands and paste buffers

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

### [`Client.switchTo`][ref-client-switchto]: clients, and re-reading a handle

```ts
await client.switchTo(session);
await client.detach();
await session.detach();

const later = await pane.refreshed(); // a new handle, at a new instant
pane.equals(later); // true — the same pane, read twice
pane.sameTmuxIdAs(later); // same `%n`, wherever it came from
```

### Describing a handle

Every handle describes itself when logged or interpolated, rather than
rendering as `[object Object]`:

```ts
pane.toString(); // Pane(%1 Window(@1 0:editor, Session($0 work)))
window.toString(); // Window(@1 0:editor, Session($0 work))
server.toString(); // Server(/tmp/tmux-1000/default)
console.log(`${pane} stopped responding`);
```

### Comparing handles and reading options

- `equals` compares the connection and daemon generation as well as the id,
  because `%1` is unique only within one running daemon.
- `sameTmuxIdAs` is the raw-id comparison; [`refreshed`][ref-window-refreshed] returns a new handle.
- [`showOptions`][ref-session-showoptions], [`setOption`][ref-session-setoption] and [`unsetOption`][ref-session-unsetoption] read one object's own view; the
  global defaults are [`Server.showGlobalOptions`][ref-server-showglobaloptions]
  and its siblings.
- [`Pane.pipeTo`][ref-pane-pipeto] streams a pane to a command, and
  [`Server.saveBuffer`][ref-server-savebuffer] writes a buffer to a file.
- [Details](docs/contracts.md#handles-and-options), including
  [`showResolvedOptions`][ref-session-showresolvedoptions].

### [`Server.cmd`][ref-server-cmd]: a command this package does not model

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
takes none. Failure raises [`TmuxCommandError`][ref-tmuxcommanderror] carrying
tmux's own stderr.

## Run several commands at once

### [`Server.batch`][ref-server-batch]: plan, then run

[`plan`][ref-session-plan] describes a mutation instead of running it. It takes what the direct call
takes and resolves to what the direct call resolves to; `batch` runs the planned
commands in order and resolves all of them from one final snapshot:

```ts
const [first, second] = await server.batch([
  session.plan.newWindow({ name: "editor" }),
  session.plan.newWindow({ name: "logs" }),
]);
```

[`first`][ref-selection-first] and `second` are [`Window`][ref-window] handles, typed one by one. A
batch mixing kinds keeps each element's own type, so a planned split comes back
as a [`Pane`][ref-pane] with `Pane` methods on it:

```ts
const [created] = await server.batch([editor.plan.split()]);
const lines = await created.capture();
```

- One at a time, each mutation costs two tmux invocations: its command, then a
  snapshot to find what it made.
- A batch shares one final snapshot, so twelve windows cost 14 invocations
  rather than 25. Each count includes the query that reads the result back.
- The counts hold anywhere; the snapshot's wall-clock grows with the server.
  [The benchmarks](docs/benchmarks.md) measure both.
- Reach for [`cmd`][ref-server-cmd] where you want the id and not the handle:
  `server.cmd("new-window", ["-d", "-P", "-F", "#{window_id}"])` is one
  invocation, and its printed line is a target every other method accepts.

### [`Server.pipeline`][ref-server-pipeline]: raw arguments, one result each

For a command this package does not model, or one whose output you want raw,
`pipeline` returns a result per command, in order:

```ts
const [[madeWindow], , [madeOther]] = await server.pipeline([
  ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", "editor"],
  ["set-option", "-g", "status", "off"],
  ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", "logs"],
]);
```

- It is not atomic: tmux stops at the first failure and leaves everything
  before it applied.
- The [`TmuxCommandError`][ref-tmuxcommanderror] names the command that failed.
- Take a [`snapshot()`][ref-server-snapshot] afterwards when you need to know what survived.
- [Why](docs/contracts.md#batching) the results are positional and each command
  is a separate invocation.

### [`Server.newSession`][ref-server-newsession]: build a workspace

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

## Run a program and read its output

Use `run` when the result is all you need, and `spawn` when the program needs
keys, a live stream of its output, or a lifetime of your choosing. The recipes
after the first are literal excerpts of
[`examples/program/program.ts`](../../examples/program/program.ts), which the
integration suite runs against a real tmux server.

### [`Server.run`][ref-server-run]: one call, only the output

```ts
const result = await server.run(["git", "--version"], { timeoutMs: 10_000 });

result.success; // true
result.output.startsWith("git version"); // true
```

- By default the program runs in a detached session of its own, removed before
  the call returns, and tmux removes it should this process die first. Nothing
  is typed, so `output` holds no command line or echo, and `argv` reaches the
  program unexpanded: `["echo", "$HOME"]` prints `$HOME`.
- A server left with no session exits, unless its `exit-empty` option is off,
  and the next run starts it again. A session of your own keeps it up;
  [Benchmarks](docs/benchmarks.md#running-a-program) has what each costs.
- `output` is the terminal's rendering, scrollback included: NUL and other
  control bytes are dropped and wrapped lines joined. `lostStart` says the
  start scrolled past `historyLimit`, and `lostEnd` that tmux closed the pane
  before reading the end; the exit status is exact either way.
- `historyLimit` bounds `output`: at most that many rows of scrollback plus the
  screen, each as wide as the pane, the newest kept. The default, 100000 rows
  of 80 columns, holds at most about 8 MB of ASCII; pass a lower one to bound a
  run's output.
- A program that never ran, because `argv[0]` was not found or is not
  executable, or `startDirectory` could not be entered, rejects with
  [`ProgramStartError`][ref-programstarterror]. Its `reason` says which, and
  its `exitCode` is the 127 or 126 a shell would report; a program's own exit
  127 is still its `exitCode`, and so is a script's whose `#!` interpreter is
  missing, since `exec` meets that past the check.
- `timeoutMs` ends the program and reports `timedOut` with what it printed so
  far; `signal` ends it and rejects.
- `{ from: pane }` runs it in a background window of that pane's session, in
  the pane's directory and with the session's tmux environment. What the pane's
  shell exported stays in that shell: [`Pane.sendKeys`][ref-pane-sendkeys] is
  the way into it.
- The program runs on the tmux server's machine, which need not be this one;
  only `input`, `separateStderr` and `stream: true` need it here.
- Needs tmux 3.8 or newer. [Details](docs/contracts.md#program-runs).

### [`Server.spawn`][ref-server-spawn]: drive it, then wait

<!-- runs: examples/program/program.ts -->

```ts
await using vim = await server.spawn(["vim", "-Nu", "NONE", "-i", "NONE", "-n", file]);
await vim.pane.waitForText(/\S/u, { timeoutMs: 10_000 });
await vim.pane.sendKeys(`ggO${line}`, { enter: false });
await vim.pane.sendKeys("Escape", { enter: false });
await vim.pane.sendKeys(":wq");
const { exitCode } = await vim.wait({ timeoutMs: 10_000 });
```

- `spawn` returns a [`Program`][ref-program] once the program has started. A
  full-screen program may still be setting up its terminal then, and can
  discard what was typed before, so the keys wait for vim's first screen.
  [`Pane.waitForText`][ref-pane-waitfortext] reads the screen each time tmux
  says the pane printed, and resolves with the first line that matches. A
  line the pane's width wrapped is one line to it, returned whole.
- Each running program holds one tmux client, its exit watch, until it ends.
- `await using` ends the program and removes its pane however the scope
  leaves; without it, call [`kill()`][ref-program-kill] in a `finally`, which
  is safe after the program has ended. A `wait` that gives up throws
  `WaitTimeoutError` and leaves the program running, where `run` ends it and
  reports `timedOut`.
- With `{ stream: true }`, [`program.stream()`][ref-program-stream] yields what
  the program writes, as UTF-8 text, until it exits, and ends with
  `OutputLostError` if tmux closed the pane before reading the end.
  `maxStreamBytes` caps the copy; the stream then throws
  [`StreamLimitError`][ref-streamlimiterror] after what it kept, and the
  program runs on. The copy is read every 25 ms.

### [`Program.stream`][ref-program-stream]: follow it as it writes

<!-- runs: examples/program/program.ts -->

```ts
await using program = await server.spawn(argv, { maxStreamBytes: 1_048_576, stream: true });
for await (const chunk of program.stream()) onChunk(chunk);
```

- The text is the terminal's as written: `\r\n` line ends and escape sequences
  left in. The stream ends once the program has exited and its last write has
  arrived.
- `stream({ signal })` ends the stream, and the program runs on.

### [`Program.output`][ref-program-output]: read it once it ends

<!-- runs: examples/program/program.ts -->

```ts
await using program = await server.spawn(argv);
await program.wait({ timeoutMs: 10_000 });
const screen = await program.output();
```

- `output()` reads the pane as `run`'s `output` does: the terminal's
  rendering, scrollback included, wrapped lines joined.
- The ended pane stays for it until `kill()` or `await using` removes the
  pane; after that, `output()` raises `ObjectNotFoundError`.

### [`Program.kill`][ref-program-kill]: end it yourself

<!-- runs: examples/program/program.ts -->

```ts
const service = await server.spawn(argv, {
  maxStreamBytes: 1_048_576,
  orphanAfterMs: 10_000,
  stream: true,
});
await service.kill();
```

- `kill()` sends SIGTERM, then SIGKILL two seconds later, to the program's
  process group, and resolves once tmux has reaped it. It then removes the
  pane, unless `keep` is set, and the program's files.
- Every call waits for the same end, so a second `kill()`, or `await using`
  after one, is safe.

### [`input`][ref-spawnoptions]: give it a stdin

<!-- runs: examples/program/program.ts -->

```ts
const result = await server.run(["sort"], { input });
```

- `input` is a string or bytes, written to a private file the program reads,
  so it passes through no shell quoting and no tmux command.
- The terminal stays the program's output, so `output` reads as before.
- It needs the tmux server on this machine; one elsewhere is refused with
  `ServerNotLocalError` before the program starts.

### [`separateStderr`][ref-runoptions]: keep stderr apart

<!-- runs: examples/program/program.ts -->

```ts
const result = await server.run(argv, { separateStderr: true });
```

- stderr goes to a private file rather than the terminal and comes back as
  `stderr`, as written, so `output` holds stdout alone.
- stderr is then no terminal, which a program that colors its errors notices.
- Like `input`, it needs the tmux server on this machine.

### [`signal`][ref-runoptions]: cancel a run

<!-- runs: examples/program/program.ts -->

```ts
const outcome = await server.run(argv, { signal }).catch((error: unknown) => {
  if (!(error instanceof TmuxTransportError) || error.kind !== "cancelled") throw error;
  return { cancelled: error.delivery };
});
```

- An abort ends the program and removes its pane, and the call rejects with
  [`TmuxTransportError`][ref-tmuxtransporterror] of kind `cancelled`.
- `delivery` says how far it got: `not_started` when nothing ran,
  `indeterminate` when setup was cut short and the program may have begun, and
  `written` once it had started.
- `spawn` takes `signal` too, for setup alone; once it returns, the program is
  yours to end. A cancelled `wait()` or `stream()` leaves the program running,
  with `delivery` `replied`.

### [`placement` and `keep`][ref-spawnoptions]: run it where a person sees it

<!-- runs: examples/program/program.ts -->

```ts
const result = await server.run(argv, { from: pane, keep: true, placement: "split" });
```

- `placement: "split"` splits `pane` without moving focus, so a person sees
  the program run. `"window"`, the default with `from`, is a background window
  of that pane's session.
- `keep: true` leaves the pane, dead and showing the output, once the program
  ends. A kept split closes at the next key pressed in it.
- Either way the program runs in the pane's directory with the session's tmux
  environment; the pane's own shell is not involved.

### [`orphanAfterMs`][ref-spawnoptions]: end it with this process

<!-- runs: examples/program/program.ts -->

```ts
const service = await server.spawn(argv, {
  maxStreamBytes: 1_048_576,
  orphanAfterMs: 10_000,
  stream: true,
});
```

- This process renews a lease on the program every third of `orphanAfterMs`.
  Should it exit or die without `kill()`, tmux ends the program and removes
  its pane within that time.
- Every `run` and `spawn` holds one, a minute long unless set.
  `orphanAfterMs: null` takes none, for a program meant to outlive this
  process.
- A shorter lease ends an orphan sooner, but an event-loop stall longer than
  the lease ends a live program too, as though this process had died.
- A debugger paused at a breakpoint is such a stall: its renewals stop with
  everything else. Debugging past a minute, pass a longer `orphanAfterMs`, or
  `null`, so the program is there when you resume.

## Type into a pane and wait

The last three recipes are literal excerpts of
[`examples/agent/agent.ts`](../../examples/agent/agent.ts), which the
integration suite runs against a real tmux server.

### [`Pane.sendKeys`][ref-pane-sendkeys]: type, then read what it said

```ts
await pane.sendKeys("git status --short");

const lines = await pane.capture();
const changed = lines.filter((line) => line.trim() !== "").length;
```

- [`capture()`][ref-pane-capture] reads the visible pane; pass `start` to reach
  into the scrollback.
- `sendKeys` presses Enter unless you say otherwise, and takes keys literally
  with `{ literal: true }` when the text could be read as a tmux key name.
- The keys and the Enter travel as two commands in one invocation, so nothing
  interleaves between them. [Details](docs/contracts.md#waiting-and-recipes).

### [`Server.watch`][ref-server-watch]: wait for a pane to print something

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

- Name the session with `target`: tmux sends pane output only for the session
  the client attached to. An untargeted `watch()` lands on whichever session
  tmux considers current. On a server with two sessions that gives silence and
  no error.
- A pane echoes what is typed, so waiting for text that also appears in the
  keys you sent matches the echo. Wait for something the command prints.

### [`Server.connect`][ref-server-connect]: act, then wait, with an observer

The loop an agent runs. `connect()` pairs commands through the server engine
with notifications from a persistent observer. Subscribe before sending so a
marker printed in between is still seen.

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

### [`Pane.waitForCommand`][ref-pane-waitforcommand]: a command's status from the shell's marks

A shell whose prompt writes an OSC 133 `D` mark with the last status tells tmux
when a command ends and how, with no marker printed for the wait to read back.

<!-- runs: examples/agent/agent.ts -->

```ts
const status = await pane.waitForCommand({ send: command, timeoutMs: 30_000 });
```

- `send` types the command once the wait is listening, so one that ends at
  once is not missed. Without it, the wait is for whatever command finishes
  next, a person's included.
- A shell's first prompt marks an end too, so wait for it before sending to a
  shell that is still starting.
- A shell without the marks never resolves the wait; give it a `timeoutMs`.
- The mark carries a status alone. What the command printed is on the pane,
  for [`Pane.capture`][ref-pane-capture].
- Requires tmux 3.8 or newer. [Details](docs/contracts.md#pane-waits).

### [`Pane.waitForExit`][ref-pane-waitforexit]: wait for a pane you did not start

<!-- runs: examples/agent/agent.ts -->

```ts
const { exitCode } = await pane.waitForExit({ timeoutMs: 30_000 });
```

- It resolves when tmux reports the pane's program exiting, with the status a
  closing pane takes with it, or at once for a pane `remain-on-exit` kept.
- A pane killed from outside fires no event, and the wait raises
  `ObjectNotFoundError` within about two seconds of the kill. A read every second
  notices the pane gone, and the event a closing pane fires gets up to a second
  to arrive.
- Requires tmux 3.8 or newer.

## Watch tmux change

A snapshot answers what is true now. [`server.watch()`][ref-server-watch]
answers what changed, over one persistent `tmux -C` connection with no command
per read.

### [`Server.watch`][ref-server-watch]: hear changes as they happen

Each `watch()` or `connect()` owns a real attached tmux client until it closes:

- The client appears in snapshots and increments `session_attached`.
- Client hooks and policy such as `destroy-unattached` see it.
- Several watches or connections create several clients.

<!-- static: reads every event until the process is interrupted -->

```ts
await using events = server.watch({ target: session.id });
await events.ready(); // attached; changes from here on are announced

for await (const event of events) {
  if (event.kind === "window-add") console.log("opened", event.windowId);
  if (event.kind === "output") process.stdout.write(event.data);
}
```

- Events are a discriminated union, so `event.kind` narrows the rest of the
  shape with no cast. Names are tmux's own, without the leading `%`.
- A notification this version does not model arrives as
  `{ kind: "unknown", name, args }` rather than being dropped.
- The stream is an `AsyncDisposable`, so `await using` ends the tmux process when
  the scope exits, including on a thrown error. `events.close()` is the same
  operation where `lib` lacks `ESNext.Disposable`.
- A consumer that falls behind loses its oldest events; `events.dropped` counts
  them and `bufferSize` sets the bound. [More](docs/contracts.md#watching).

Set `outputBytes: true` on `watch` or `connect` to receive each output event's
owned `Uint8Array` in `event.bytes`, including invalid UTF-8 and NUL. `data`
remains decoded text. `maxBufferedOutputBytes` defaults to 1 MiB per subscriber;
`droppedOutputBytes` counts discarded raw bytes. A gap cannot be replayed.

### [`pauseAfterSeconds`][ref-watchoptions]: pace a busy pane

tmux kills a client that lets a pane's output back up, so five minutes behind
ends the whole connection with `too far behind`. `pauseAfterSeconds` asks tmux to
pause the one pane instead:

```ts
await using paced = server.watch({ pauseAfterSeconds: 5 });
```

tmux then reports `pause` for the pane it stopped, the connection asks it back
at once, and `continue` follows. The pair records what was missed; there is
nothing to act on.

### [`Server.connect`][ref-server-connect]: pair commands with the observer

`watch()` is the notification observer. `connect()` adds the same event channel
and daemon-lifetime tracking to a server; its commands still use ordinary tmux
processes, and the API is the same [`Server`][ref-server].

- A connection attaches, so it needs a session. `connect()` on a server with
  none fails with tmux's own words.
- Name the session with `target`; a client hears about the session it attached
  to.
- A connection can reopen itself with `watch({ reconnect: { attempts: 3 } })`,
  which reports a `reconnected` event. It is off by default.

```ts
await server.connect(); // LibTmuxError: ... could not attach: no sessions
```

Commands remain process-boundary invocations, because control mode cannot
delimit arbitrary alias-expanded or waiting command output truthfully:

<!-- static: reads every event until the process is interrupted -->

```ts
await using live = await server.connect();

for await (const event of live.subscribe()) {
  if (event.kind !== "window-add") continue;
  const snapshot = await live.snapshot(); // one atomic identity-plus-four-listings invocation
  console.log(snapshot.windows.count());
}
```

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

- tmux expands each subscription at most once per second and reports only when
  the value differs, so each report marks a change. The first evaluation always
  reports.
- `scope` takes a pane or window id, `"all-panes"`, or `"all-windows"`.
- A connected server adds and drops subscriptions while it runs with
  [`subscribeFormat`][ref-connected-subscribeformat] and
  [`unsubscribeFormat`][ref-connected-unsubscribeformat].

### [`waitFor`][ref-connected-waitfor]: wait for something to happen

Most work is "do this, then wait until that". `waitFor` is the join between a
snapshot and the stream, and it subscribes before it reads, so a change that
lands in between is still seen:

```ts
await using live = await server.connect();

await session.newWindow({ name: "build" });
const settled = await live.waitFor((server) => server.windows.exists({ name: "build" }));
```

To wait for a single event, [`find`][ref-tmuxeventstream] takes the first one
that matches and gives up on a deadline. Each [`subscribe()`][ref-connected-subscribe] is an
independent view with its own buffer:

<!-- static: waits for a window the reader opens -->

```ts
const opened = await live.subscribe().find((event) => event.kind === "window-add");
```

The same wait, asserting what it returned, and `find` with a deadline that
answers `undefined` when the thing does not happen:

```ts
await using connected = await server.connect();

await session.newWindow({ name: "build" });
const settled = await connected.waitFor((current) => current.windows.exists({ name: "build" }));

settled.windows.count({ name: "build" }); // 1
```

```ts
const opened = await live.subscribe().find((event) => event.kind === "window-add", {
  timeoutMs: 5_000,
});
```

## Choosing how work is arranged

Commands travel through the server's engine. Three independent choices compose
around that execution path:

| Mode           | Turn it on                                     | What changes                                                              | When to use it                                                    |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **connected**  | [`await server.connect()`][ref-server-connect] | Adds notifications and connection-lifetime tracking.                      | A server-shaped API in a loop that also reacts to events.         |
| **watching**   | [`server.watch()`][ref-server-watch]           | Yields tmux's notifications as they happen.                               | Reacting to a change without issuing commands through that value. |
| **planned**    | `.plan` instead of the direct call             | Shares one final snapshot across [`server.batch([…])`][ref-server-batch]. | Creating or changing several things in order.                     |
| **concurrent** | `Promise.all`                                  | Independent commands overlap, up to `maxInFlight`.                        | Slow work on independent targets — not ordering-sensitive setup.  |

`connect()` hands back the same handles as the base server and adds an event
observer. Its commands still use the server engine and process boundaries.

### [`maxInFlight`][ref-serveroptions]: how many commands run at once

Every invocation is a tmux client process with its own pipes, so a
`Promise.all` over a whole server starts that many processes. `maxInFlight`
bounds them, and defaults to 16:

```ts
const bounded = new Server({ maxInFlight: 4 });
bounded.tmuxBin;
```

- The ceiling costs no throughput, because tmux runs commands on one thread.
  [The benchmarks](docs/benchmarks.md) show twelve concurrent creations costing
  the same processes as twelve in order.
- Waiting for a slot spends the request's own deadline. A request that never
  gets one raises [`TmuxTransportError`][ref-tmuxtransporterror] with `delivery`
  of `"not_started"`, the one status a mutation may retry blindly.
- `signal` cancels the wait as it cancels the command.
- An invocation that ends in a wait, such as `wait-for` or a running program's
  start, takes no slot: it holds a client for as long as the wait.
  [More](docs/contracts.md#concurrency-and-engines).

### [`TmuxEngine`][ref-tmuxengine]: put tmux behind SSH, a container, or a daemon

An engine receives the complete invocation, including environment, stdin,
cancellation, and deadline. This runnable example keeps execution local on the
current server's socket; a remote runner has the same obligations:

```ts
import { Server, TmuxServerRestartedError } from "libtmux";
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
      if (guarded.refusedBy(result.exitCode, result.stderr)) {
        throw new TmuxServerRestartedError("the daemon this handle was read from is gone");
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
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ]);
      return {
        cmd: argv,
        exitCode,
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

- The seam is one structured invocation in and bytes plus status out, so an
  engine is responsible only for execution.
- Honour the request's [`daemonGuard`][ref-daemonguard] with `guardRequest`, or
  bind the engine to one daemon.
- `watch()` and `connect()` are not carried by an engine: both hold a local
  `tmux -C attach` process, so they refuse rather than attach to whichever tmux
  the machine happens to run.

### [`Server.withConnection`][ref-server-withconnection]: a connection for one block

`withConnection` closes the connection on the way out whether the body returns
or throws. Use it where `await using` is not available, since that needs
`Symbol.asyncDispose` in the consumer's `lib`:

```ts
const built = await server.withConnection(async (connected) => {
  await session.newWindow({ name: "build" });
  return connected.waitFor((current) => current.windows.exists({ name: "build" }));
});
```

- [`pipeline`][ref-server-pipeline] and `batch` stay per-call-site choices, because both stop at the
  first failure.
- `batch` adds one final snapshot that turns printed ids into handles;
  `pipeline` returns the printed lines directly.
- Use either when command order matters. A connection does not make concurrent
  mutations safe to reorder.

### [`onInvocation`][ref-serveroptions]: see what it runs

`onInvocation` is called once per tmux invocation, after it answers or fails.
It is the seam for logs, traces and metrics, so watching the library does not
mean supplying a whole engine:

```ts
import type { TmuxInvocationReport } from "libtmux";

const reports: TmuxInvocationReport[] = [];
const traced = new Server({
  socketPath: server.socketPath,
  onInvocation: (report) => reports.push(report),
});
await traced.snapshot();

reports[0]?.commands[0]?.[0]; // "run-shell", the version read
reports[1]?.commands[0]?.[0]; // "display-message", the identity read
reports[0]?.durationMs;
```

- [`TmuxInvocationReport`][ref-tmuxinvocationreport] is exported for a typed
  collector. Every command reports, including the identity read and four
  listings behind [`snapshot()`][ref-server-snapshot], and the version probe.
- A report carries the commands tmux received, `durationMs`, `queuedMs` for any
  wait under `maxInFlight`, `exitCode` when tmux answered, and `error` with
  `delivery` when it did not.
- An observer cannot change what a command does. Anything it throws is
  swallowed, and an `async` observer is never awaited.

[`examples/observe/`](../../examples/observe/README.md) runs this against a
real server, and counts its own reports to check the two costs above.

### Deadlines and cancellation: `timeoutMs` and `signal`

Every command gets 30 seconds unless the server or the call says otherwise.
Change it for the whole server, lift it with `null`, and override or cancel a
single call:

```ts
const server = new Server({ timeoutMs: 10_000 });
const patient = new Server({ timeoutMs: null }); // waits as long as tmux takes

const controller = new AbortController();
const lines = pane.capture({ signal: controller.signal, timeoutMs: 30_000 });
controller.abort(new Error("the caller moved on"));
// Rejects with a TmuxTransportError carrying kind: "cancelled", and your own
// reason as its `cause`.
await lines.catch(() => undefined);
```

- A cancelled or timed-out command rejects with a
  [`TmuxTransportError`][ref-tmuxtransporterror], with what you passed to
  `abort()` as its `cause`. `delivery` says how far the command got.
- The default applies to every command, including the version probe and the
  reads behind `snapshot()`.
- It does not apply to a popup, a menu, a prompt, a confirmation,
  `display-panes` or `wait-for`, which wait on a person or another command. A
  deadline passed on the call still binds them.
- `signal` is typed structurally, so a real `AbortSignal` satisfies it without
  a DOM or Node library. [More](docs/contracts.md#deadlines-and-cancellation).

## Options and hooks

### [`Session.setOption`][ref-session-setoption]: read and write options and hooks

[`Server.setHook`][ref-server-sethook] takes tmux's hook names, and the
[options and hooks topic][topic-options-and-hooks] has the rest:

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

- Typed option and hook methods treat names as literal data, including `#`. Use
  [`cmd`][ref-server-cmd] when you deliberately want tmux to expand a computed name.
- Window and pane scopes report only what was set on them, never inherited
  values.
- [`OptionScope`][ref-optionscope] supplies the lowercase scope values when a
  named constant is clearer than a string literal.

## Environments

### [`Session.setEnvironment`][ref-session-setenvironment]: seed a variable for every pane

A session's environment is what tmux hands to the processes it starts. [`Server`][ref-server]
carries the global environment and [`Session`][ref-session] its own:

```ts
await session.setEnvironment("DATABASE_URL", "postgres://localhost/dev");
await session.getEnvironment("DATABASE_URL");
await session.showEnvironment();
await session.unsetEnvironment("DATABASE_URL");
await session.removeEnvironment("SSH_AUTH_SOCK");
await server.setEnvironment("EDITOR", "vim");
```

A variable is in one of three states, which is why the value type is
[`EnvironmentValue`][ref-environmentvalue] — `string | null` — and lookups can
also answer `undefined`:

| State                                   | [`getEnvironment`][ref-session-getenvironment] | In [`showEnvironment`][ref-session-showenvironment] |
| --------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Set to a value                          | the value                                      | present                                             |
| Marked for removal from child processes | `null`                                         | present                                             |
| Not carried at all                      | `undefined`                                    | absent                                              |

- [`removeEnvironment`][ref-session-removeenvironment] is the middle row and [`unsetEnvironment`][ref-session-unsetenvironment] is the last. The
  first leaves an entry saying "unset this before spawning", which keeps a
  stale `SSH_AUTH_SOCK` out of a new pane.
- Removal marks are routine: tmux's own `update-environment` puts several in
  every session.
- [`SetEnvironmentOptions`][ref-setenvironmentoptions] covers tmux's `-F` and
  `-h` as `expandFormat` and `hidden`, and
  [`EnvironmentScope`][ref-environmentscope] names the two scopes.
  [More][topic-environment].

## Errors

A failing call raises a typed error you can branch on without parsing a
message. The [errors topic][topic-errors] describes the whole family.

### [`TmuxCommandError`][ref-tmuxcommanderror]: tmux said no

A failing tmux command raises it with its parts:

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

### [`TmuxTransportError`][ref-tmuxtransporterror]: no answer

A command that never got an answer raises it. It says what failed between this
process and tmux, and how far the command got:

```ts
import { TmuxTransportError } from "libtmux";

try {
  await session.newWindow({ name: "build" });
} catch (error) {
  if (error instanceof TmuxTransportError) {
    error.kind; // "cancelled" | "contract" | "pipe" | "protocol" | "spawn" | "timeout"
    error.delivery; // "not_started" | "written" | "replied" | "indeterminate"
    error.stdout; // whatever arrived before the failure
  }
}
```

- `delivery` is the question a retry depends on. `not_started` is the only
  value that is safe to retry blindly.
- After a timeout the answer is `indeterminate`: tmux may have created that
  window before the pipe went quiet.
- Every path reports the same type, so a timeout during [`snapshot()`][ref-server-snapshot] has the
  same shape as one during `kill()`.

### [`TmuxServerRestartedError`][ref-tmuxserverrestartederror]: the daemon is gone

A handle that outlived its daemon raises it. tmux numbers a restarted daemon's
objects from the start, so a `%1` read before the restart names a pane that
exists and belongs to somebody else:

```ts
import { TmuxServerRestartedError } from "libtmux";

try {
  await pane.kill();
} catch (error) {
  if (error instanceof TmuxServerRestartedError) {
    error.delivery; // always "not_started" — a refused command never ran
  }
}
```

- Reading a stale handle's captured fields still works; only commands are
  refused.
- The refusal is tmux's: a command carrying a raw id goes as `if-shell -F`
  conditioned on the daemon's pid and start time.
  [More](docs/contracts.md#errors).

### [`Server.isAlive`][ref-server-isalive]: ask without raising

An unreachable server raises rather than reading as empty, so an empty result
means exactly one thing. [`checkAlive`][ref-server-checkalive] is the assertion
form:

```ts
await server.isAlive(); // false for a missing daemon, socket, or binary
await server.checkAlive(); // the assertion form
```

### [`LibTmuxError`][ref-libtmuxerror]: the base class

Library failures extend it; invalid arguments may throw native `TypeError`.
Every one carries `code`, a string naming its class that survives a bundler
renaming identifiers:

```ts
try {
  await server.snapshot();
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "TmuxTransportError") {
    // the command never got an answer
  }
}
```

### Query errors: [`NoMatchError`][ref-nomatcherror] and its relatives

- A query that matches nothing raises [`NoMatchError`][ref-nomatcherror]; one
  that matches several where you asked for one raises
  [`MultipleMatchesError`][ref-multiplematcheserror].
- Criteria the schema rejects raise
  [`QueryValidationError`][ref-queryvalidationerror].
- A [`waitFor`][ref-connected-waitfor] that reaches its deadline raises
  [`WaitTimeoutError`][ref-waittimeouterror]; catch it by name.
- A criterion naming a field newer than the running tmux raises
  [`VersionTooLowError`][ref-versiontoolowerror], naming the field and both
  releases.
- Catch [`ObjectNotFoundError`][ref-objectnotfounderror] for "not there, however
  you asked", and [`MultipleObjectsError`][ref-multipleobjectserror] for its
  counterpart. Import errors from `libtmux` or `libtmux/errors`.
- [`parseLegacyWhere`][ref-parselegacywhere] on `libtmux/selection` converts
  Python-style `name__contains=` filters, for code being ported.

### Migrating from alpha.9

Use the canonical names. The old ones remain deprecated aliases to the same
constructors, so existing `instanceof` checks still work.

- `error.name` reports the canonical name; use `libtmux/errors` for new imports
  (`libtmux/exc` remains for compatibility).
- `QueryValidationError.code` is now `reason`, because every error now carries
  a `code` naming its own class.

| Previous name             | Canonical name                                           |
| ------------------------- | -------------------------------------------------------- |
| `LibTmuxException`        | `LibTmuxError`                                           |
| `ObjectDoesNotExist`      | `ObjectNotFoundError`                                    |
| `MultipleObjectsReturned` | `MultipleObjectsError`                                   |
| `TmuxObjectDoesNotExist`  | [`TmuxObjectNotFoundError`][ref-tmuxobjectnotfounderror] |
| `VersionTooLow`           | `VersionTooLowError`                                     |
| `WaitTimeout`             | `WaitTimeoutError`                                       |
| `TmuxServerRestarted`     | `TmuxServerRestartedError`                               |

- Completed command results, including custom [`TmuxEngine`][ref-tmuxengine]
  results, use `exitCode` instead of `returncode`. `TmuxCommandError.exitCode`
  is unchanged.
- A `TmuxEngine` that resolves without a numeric `exitCode` raises
  `TmuxTransportError` with `kind: "contract"`.
- Use [`server.checkAlive()`][ref-server-checkalive] in place of the deprecated
  [`server.raiseIfDead()`][ref-server-raiseifdead]; both reject when the server
  cannot be reached.

The compatibility call:

```ts
await server.raiseIfDead();
```

The canonical call:

```ts
await server.checkAlive();
```

For [`pane.split()`][ref-pane-split], `window.split()` and planned splits:

- Replace `vertical: true` with `direction: PaneDirection.Below`, and
  `vertical: false` with `direction: PaneDirection.Right`.
- Omitting both still splits below.
- Passing `vertical` with `direction` throws `TypeError` before executing a
  command.

## Test your own code

### [`recordInvocations`][ref-recordinvocations] and [`replayInvocations`][ref-replayinvocations]: no tmux in unit tests

`libtmux/testing` records a real server's answers and replays them, so a
consumer's own unit tests need no tmux. The [testing guide][guide-testing]
covers isolated servers for tests that do:

<!-- static: the recording is written by a run against a real server -->

```ts
import { recordInvocations, replayInvocations } from "libtmux/testing";

// Once, against real tmux: wrap the engine and keep what it answered.
const recorder = recordInvocations();
const recording = new Server({ engine: recorder.engine, socketPath: server.socketPath });
await recording.snapshot();

// Ever after, with no server, no binary and no daemon.
const replayed = new Server({ engine: replayInvocations(recorder.recording()) });
(await replayed.snapshot()).sessions.count();
```

- A recording is JSON and replays a run rather than answering a query: the same
  calls in the same order get the same answers.
- A call the recording never saw raises rather than reporting an empty server.
- Record guards are rewritten to the ones each replayed call asks for, so a
  fixture is not tied to the run that made it.

## Run inside tmux

### [`Session.fromEnv`][ref-session-fromenv]: find the session you are in

```ts
import { Session } from "libtmux";

const session = await Session.fromEnv();
```

The pane is authoritative: `$TMUX` carries a session id that goes stale when a
pane moves, so the session is resolved through `$TMUX_PANE`.

## tmux versions

The package supports tmux 3.3a and newer, and the format registry withholds
newer fields from an older server, so each version is asked only for the fields
it has.

tmux release candidates are not supported: a feature can require one only
until its release ships, and a candidate such as `X.Y-rcN` ranks below `X.Y`.
See [Release candidates](https://libtmux.org/en/tmux/guides/tmux-support/#release-candidates).

### [`Server.version`][ref-server-version] and [`versionAtLeast`][ref-server-versionatleast]: gate your own code

Ask the server rather than parsing `#{version}` yourself. The version is probed
once per connection and cached, so asking repeatedly costs nothing:

```ts
const version = await server.version(); // { major, minor, suffix, raw }

if (await server.versionAtLeast("3.4")) {
  await pane.customizeMode();
}
```

- `raw` is tmux's own string, so a development form such as `next-3.8` survives
  the parsed fields.
- Versions rank `next-X.Y` below `X.Y-rc`, below `X.Y`, below `X.Ya`, so a
  development build has not yet reached the release it names.
- A form tmux does not print is refused.
  [More](docs/contracts.md#tmux-versions).

### [`VersionTooLowError`][ref-versiontoolowerror]: tmux older than 3.3a is refused

A daemon, or an executable that would start one, older than tmux 3.3a is
refused before anything is sent to it, with a `delivery` of `not_started`.

So is a version libtmux does not recognize, such as bare `master`. Upgrade tmux
and restart the server, or pin the previous libtmux release:

```ts
import { VersionTooLowError } from "libtmux";

try {
  await server.newSession({ name: "work" });
} catch (error) {
  if (error instanceof VersionTooLowError) {
    error.serverVersion; // what the daemon reported, such as "3.2a"
    error.since; // "3.3a"
    error.remedy; // the upgrade-or-pin advice
    error.reason; // the refusal without the remedy
  }
}
```

`MINIMUM_TMUX` is that floor, and
[`assertSupportedTmux`][ref-assertsupportedtmux] applies the same ranking to a
version report you already hold, such as the output of `tmux -V`:

```ts
import { assertSupportedTmux, MINIMUM_TMUX } from "libtmux";

MINIMUM_TMUX; // "3.3a"
assertSupportedTmux("3.4"); // returns; throws VersionTooLowError below the floor
```

### Features above the floor

Ordinary operations need tmux 3.3a on the running daemon. A feature that
needs more refuses on an older daemon with `VersionTooLowError` before it
sends anything, and the rest of the package keeps working there.

| Feature                                                                          | Needs           | Below that                             |
| -------------------------------------------------------------------------------- | --------------- | -------------------------------------- |
| [`run`][ref-server-run], [`spawn`][ref-server-spawn]; MCP `run_program`          | 3.8             | refused before any session is made     |
| `watch`, `connect`, `withConnection`; the MCP server's live streams              | 3.7             | refused before any client attaches     |
| `deleteBuffer`, a buffer rename, MCP `paste_text`                                | 3.4             | refused, no buffer touched             |
| [`runShell`][ref-server-runshell] returning the command's output                 | 3.5             | refused; `cmd("run-shell", …)` runs it |
| a layout string for `select-layout` that is not a preset or checksummed          | 3.4             | refused before it can crash tmux       |
| `break-pane` without `-n`, or `-n` without `-P`, and names containing `:` or `.` | not exactly 3.7 | refused on 3.7 only                    |
| `split-window -p`, as literal argv                                               | not exactly 3.4 | refused on 3.4 only                    |
| `refresh-client -l`, as literal argv ([why 3.6a][tmux-3-6a-changes])             | 3.6a            | refused before it can stop tmux        |

On an older tmux the MCP server answers a wait or a capture by reading the pane
and types `run_shell_command`'s script instead of staging it; `paste_text`
refuses with the version it needs.
A polling wait runs `capture-pane` on every poll, so an `after-capture-pane`
hook fires each time, and it joins wrapped rows as the stream does.

The guard reads each command's own argv. A command carried inside a string that
tmux parses itself is sent as written: the body of `if-shell`, the argument of
`run-shell -C`, a brace block, a hook, a key binding or a sourced file. These
are the refused commands, the releases they affect, and what happens there:

- `break-pane` without `-n`: exact tmux 3.7 only. The server exits. tmux 3.7a
  fixes it ([`CHANGES`](https://github.com/tmux/tmux/blob/3.7a/CHANGES#L3),
  [the inverted name test in 3.7](https://github.com/tmux/tmux/blob/3.7/cmd-break-pane.c#L117-L124)).
- `select-layout` with a string tmux cannot parse: tmux 3.3 and 3.3a. The server
  exits. 3.4 answers "invalid layout".
- `refresh-client -l`: below 3.6a, and only with an attached client. The server
  exits at once on 3.3a when the client's terminal has the `Ms` clipboard
  capability, such as `xterm-256color` or `tmux-256color`, and on 3.4 to 3.6
  when the client leaves before its terminal answers.
- `delete-buffer -b NAME`, and `set-buffer -b NAME -n`: below 3.4. No crash; a
  name that does not exist acts on the newest buffer instead, so the wrong
  buffer is deleted or renamed.
- `split-window -p`: exactly 3.4. tmux answers "size missing" and changes
  nothing.
- `break-pane -n NAME` without `-P`: exactly 3.7. No crash; tmux accepts the
  command and ignores the name, so the window keeps its default name.
- Names containing `:` or `.`: exactly 3.7. tmux answers "invalid window name"
  and changes nothing.

On exact tmux 3.7 the guard refuses a direct `break-pane` that has no `-n` and
a direct `break-pane -n NAME` that has no `-P`. It accepts `break-pane -n NAME
-P`, which is the supported spelling. Only a nested or key-bound `break-pane`
reaches tmux without that check, so give each of those a name, or upgrade to
3.7a. The [default `prefix !` binding](https://github.com/tmux/tmux/blob/3.7/key-bindings.c#L358)
is itself a nameless `break-pane`, which no library check can reach.

Each refusal is tested against a daemon of the release it covers, with the
sentinel session or buffer it must leave untouched, and against a release that
allows it. Behaviour of a release that no CI lane builds is unverified.

## Consumers

Three working consumers live in this repository:

- [`packages/mcp`](../mcp) — an MCP server exposing tmux through this library.
  Its waits stream tmux's notifications on tmux 3.7 and later and poll the
  pane on earlier releases, and its
  [`run_shell_command`](https://libtmux.org/en/ts/latest/mcp/tools/run_shell_command/) frames what it sends so a pane's echo cannot be read as
  output.
- [`packages/workspace`](../workspace) — a tmuxp-shaped workspace builder.
  Applying a workspace twice converges the running session rather than
  duplicating it.
- [`packages/workspace-cli`](../workspace-cli) — the [`tmux-workspace`](https://libtmux.org/en/ts/latest/workspace/cli/) command.

## Packages

### [`@libtmux/mcp`](https://github.com/libtmux/libtmux-ts/tree/master/packages/mcp): a tmux server for agents

A stdio MCP server: an agent lists sessions, reads a pane, sends keys, and
waits for output instead of polling for it. Reference:
[API][mcpref-reference], [tools][mcp-tools] and
[npm](https://www.npmjs.com/package/@libtmux/mcp).

An MCP client launches it from this configuration:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["-y", "@libtmux/mcp@0.1.2"],
      "env": { "LIBTMUX_SOCKET": "agent" }
    }
  }
}
```

### [`@libtmux/workspace`](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace): tmuxp-style workspaces as data

Describes a session as tmuxp-shaped data and applies it. Reference:
[API][wsref-reference] and
[npm](https://www.npmjs.com/package/@libtmux/workspace).

```console
$ bun add @libtmux/workspace libtmux
```

A workspace is one call to [`applyWorkspace`][wsref-applyworkspace], shown in
the [package README](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace#quick-start).

### [`@libtmux/workspace-cli`](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace-cli): `tmux-workspace` for the shell

[`tmux-workspace`][cli-reference] loads, captures, converts and imports tmuxp
workspace files on Node or Bun. Ordinary loads start no Python. Reference:
[commands][cli-reference] and
[npm](https://www.npmjs.com/package/@libtmux/workspace-cli).

Save this document as `workspace.yaml`:

```yaml
session_name: dev
windows:
  - window_name: editor
    layout: main-vertical
    panes:
      - vim
      - top
```

Load it detached, on a socket of its own with [`load`][cli-load]:

```console
$ npx -y @libtmux/workspace-cli@0.1.2 load ./workspace.yaml \
    -L workspace-cli-demo \
    -d
```

## Entrypoints

The root export carries the everyday handle, query, operation, error, and
constant surface. Each model is also its own subpath:

- `libtmux/server`, `libtmux/session`, `libtmux/window`, `libtmux/pane`,
  `libtmux/program`, `libtmux/client` and `libtmux/selection`.
- `libtmux/formats`, `libtmux/constants`, `libtmux/common` and
  `libtmux/errors`, as supporting subpaths.
- `libtmux/testing`, to [record and replay](#test-your-own-code) a server's
  answers.
- `libtmux/engine` for custom execution engines, `libtmux/types` for the full
  operation and event type inventory, and `libtmux/field-types` for generated
  format-field, decoded-value, and handle-alias types.

## Parity with the Python library

[`parity/python-0.62.0.json`](parity/python-0.62.0.json) is a ledger against
libtmux 0.62.0:

- Every public symbol in that release carries a decision: ported directly,
  adapted to a shape that suits TypeScript better, or not ported for a recorded
  reason.
- A ported or adapted symbol names the TypeScript that covers it and the test
  that proves it. A gate checks that every symbol the ledger names exists.
- What is not ported falls into three groups: neo.py, the pytest helpers, and
  tmux's interactive commands. The last is reachable through
  [`cmd`][ref-server-cmd], so "not ported" means "no typed wrapper", not "out of
  reach". [More](docs/contracts.md#parity-with-the-python-library).

## What it leaves out

- **Live objects.** A [`Session`][ref-session] or a [`Pane`][ref-pane] is read
  at one instant and does not change when tmux does. Read again with
  [`refreshed()`][ref-window-refreshed], or [`watch()`][ref-server-watch], to
  see a change.
- **Every tmux command.** A command without a typed wrapper goes through
  [`cmd`][ref-server-cmd]. Interactive ones resolve before the user acts, so a
  promise cannot report them.
- **Atomic batches.** [`batch`][ref-server-batch] and
  [`pipeline`][ref-server-pipeline] stop at the first failure and leave the
  commands before it applied.
- **A configuration generator or a TUI.** This controls a running server. It
  does not write your `.tmux.conf`.

## Support and status

Releases are numbered `0.1.N`, and each release increments `N`. The API is not
settled: any release may change or remove exported identifiers, and the
changelog marks each break. Pin an exact version to avoid one.
Read the [changelog](CHANGELOG.md) before you upgrade.

- **No runtime dependencies.** The package installs a tmux client and nothing
  else. A small internal validator checks tmux's own output.
- **tmux 3.3a or newer**, checked against the running daemon: see
  [tmux versions](#tmux-versions).
- **Node 22+ or Bun 1.3.14+**, and TypeScript 5.7+.
- **Linux**, including WSL. CI runs the real-tmux test suites there only.

## Documentation

|                                                             |                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| [API reference][ref-reference]                              | Every public symbol, one page each, on libtmux.org                 |
| [Guides][guides], [topics][topics] and [concepts][concepts] | Walkthroughs, behaviour by subject, and how the pieces relate      |
| [`docs/api.md`](docs/api.md)                                | The same reference, generated from the doc comments                |
| [`docs/contracts.md`](docs/contracts.md)                    | The contract detail this page links to                             |
| [`docs/criteria.md`](docs/criteria.md)                      | Every field and operator [`.where()`][ref-selection-where] accepts |
| [`docs/benchmarks.md`](docs/benchmarks.md)                  | What each way of running commands costs                            |
| [`examples/`](../../examples)                               | Runnable programs, each run by the integration suite               |
| [`CHANGELOG.md`](CHANGELOG.md)                              | What each release changed                                          |

## License

MIT

[cli-load]: https://libtmux.org/en/ts/latest/workspace/cli/load/
[cli-reference]: https://libtmux.org/en/ts/latest/workspace/cli/
[concept-queries]: https://libtmux.org/en/ts/latest/concepts/queries/
[concepts]: https://libtmux.org/en/ts/latest/concepts/
[guide-querying]: https://libtmux.org/en/ts/latest/guides/querying-and-filtering/
[guide-testing]: https://libtmux.org/en/ts/latest/guides/testing-with-libtmux/
[guides]: https://libtmux.org/en/ts/latest/guides/
[mcp-tools]: https://libtmux.org/en/ts/latest/mcp/tools/
[mcpref-reference]: https://libtmux.org/en/ts/latest/mcp/reference/
[ref-assertsupportedtmux]: https://libtmux.org/en/ts/latest/reference/common-assertsupportedtmux/
[ref-client-switchto]: https://libtmux.org/en/ts/latest/reference/client-client-switchto/
[ref-clientwhere]: https://libtmux.org/en/ts/latest/reference/selection-clientwhere/
[ref-compileboundedregex]: https://libtmux.org/en/ts/latest/reference/selection-compileboundedregex/
[ref-connected-subscribe]: https://libtmux.org/en/ts/latest/reference/types-connectedserver-subscribe/
[ref-connected-subscribeformat]: https://libtmux.org/en/ts/latest/reference/types-connectedserver-subscribeformat/
[ref-connected-unsubscribeformat]: https://libtmux.org/en/ts/latest/reference/types-connectedserver-unsubscribeformat/
[ref-connected-waitfor]: https://libtmux.org/en/ts/latest/reference/types-connectedserver-waitfor/
[ref-daemonguard]: https://libtmux.org/en/ts/latest/reference/engine-daemonguard/
[ref-decodewheredocument]: https://libtmux.org/en/ts/latest/reference/selection-decodewheredocument/
[ref-encodewheredocument]: https://libtmux.org/en/ts/latest/reference/selection-encodewheredocument/
[ref-environmentscope]: https://libtmux.org/en/ts/latest/reference/types-environmentscope/
[ref-environmentvalue]: https://libtmux.org/en/ts/latest/reference/types-environmentvalue/
[ref-issafeinteger]: https://libtmux.org/en/ts/latest/reference/common-issafeinteger/
[ref-libtmuxerror]: https://libtmux.org/en/ts/latest/reference/errors-libtmuxerror/
[ref-multiplematcheserror]: https://libtmux.org/en/ts/latest/reference/errors-multiplematcheserror/
[ref-multipleobjectserror]: https://libtmux.org/en/ts/latest/reference/errors-multipleobjectserror/
[ref-newwindowoptions]: https://libtmux.org/en/ts/latest/reference/types-newwindowoptions/
[ref-nomatcherror]: https://libtmux.org/en/ts/latest/reference/errors-nomatcherror/
[ref-objectnotfounderror]: https://libtmux.org/en/ts/latest/reference/errors-objectnotfounderror/
[ref-optionscope]: https://libtmux.org/en/ts/latest/reference/constants-optionscope/
[ref-pane]: https://libtmux.org/en/ts/latest/reference/pane-pane/
[ref-pane-capture]: https://libtmux.org/en/ts/latest/reference/pane-pane-capture/
[ref-pane-choosetree]: https://libtmux.org/en/ts/latest/reference/pane-pane-choosetree/
[ref-pane-displaypopup]: https://libtmux.org/en/ts/latest/reference/pane-pane-displaypopup/
[ref-pane-entercopymode]: https://libtmux.org/en/ts/latest/reference/pane-pane-entercopymode/
[ref-pane-killifwindowunshared]: https://libtmux.org/en/ts/latest/reference/pane-pane-killifwindowunshared/
[ref-pane-pipeto]: https://libtmux.org/en/ts/latest/reference/pane-pane-pipeto/
[ref-pane-resize]: https://libtmux.org/en/ts/latest/reference/pane-pane-resize/
[ref-pane-sendkeys]: https://libtmux.org/en/ts/latest/reference/pane-pane-sendkeys/
[ref-pane-waitforcommand]: https://libtmux.org/en/ts/latest/reference/pane-pane-waitforcommand/
[ref-pane-waitforexit]: https://libtmux.org/en/ts/latest/reference/pane-pane-waitforexit/
[ref-pane-waitfortext]: https://libtmux.org/en/ts/latest/reference/pane-pane-waitfortext/
[ref-pane-split]: https://libtmux.org/en/ts/latest/reference/pane-pane-split/
[ref-pane-unzoom]: https://libtmux.org/en/ts/latest/reference/pane-pane-unzoom/
[ref-pane-zoom]: https://libtmux.org/en/ts/latest/reference/pane-pane-zoom/
[ref-panedirection]: https://libtmux.org/en/ts/latest/reference/constants-panedirection/
[ref-panewhere]: https://libtmux.org/en/ts/latest/reference/selection-panewhere/
[ref-parselegacywhere]: https://libtmux.org/en/ts/latest/reference/selection-parselegacywhere/
[ref-queryvalidationerror]: https://libtmux.org/en/ts/latest/reference/errors-queryvalidationerror/
[ref-recordinvocations]: https://libtmux.org/en/ts/latest/reference/testing-recordinvocations/
[ref-reference]: https://libtmux.org/en/ts/latest/reference/
[ref-replayinvocations]: https://libtmux.org/en/ts/latest/reference/testing-replayinvocations/
[ref-selection]: https://libtmux.org/en/ts/latest/reference/selection-selection/
[ref-selection-count]: https://libtmux.org/en/ts/latest/reference/selection-selection-count/
[ref-selection-exists]: https://libtmux.org/en/ts/latest/reference/selection-selection-exists/
[ref-selection-filter]: https://libtmux.org/en/ts/latest/reference/selection-selection-filter/
[ref-selection-first]: https://libtmux.org/en/ts/latest/reference/selection-selection-first/
[ref-selection-one]: https://libtmux.org/en/ts/latest/reference/selection-selection-one/
[ref-selection-oneorundefined]: https://libtmux.org/en/ts/latest/reference/selection-selection-oneorundefined/
[ref-selection-where]: https://libtmux.org/en/ts/latest/reference/selection-selection-where/
[ref-server]: https://libtmux.org/en/ts/latest/reference/server-server/
[ref-server-batch]: https://libtmux.org/en/ts/latest/reference/server-server-batch/
[ref-server-checkalive]: https://libtmux.org/en/ts/latest/reference/server-server-checkalive/
[ref-server-clients]: https://libtmux.org/en/ts/latest/reference/server-server-clients/
[ref-server-cmd]: https://libtmux.org/en/ts/latest/reference/server-server-cmd/
[ref-server-connect]: https://libtmux.org/en/ts/latest/reference/server-server-connect/
[ref-server-isalive]: https://libtmux.org/en/ts/latest/reference/server-server-isalive/
[ref-server-newsession]: https://libtmux.org/en/ts/latest/reference/server-server-newsession/
[ref-server-panes]: https://libtmux.org/en/ts/latest/reference/server-server-panes/
[ref-server-pipeline]: https://libtmux.org/en/ts/latest/reference/server-server-pipeline/
[ref-server-raiseifdead]: https://libtmux.org/en/ts/latest/reference/server-server-raiseifdead/
[ref-server-run]: https://libtmux.org/en/ts/latest/reference/server-server-run/
[ref-server-spawn]: https://libtmux.org/en/ts/latest/reference/server-server-spawn/
[ref-program]: https://libtmux.org/en/ts/latest/reference/program-program/
[ref-program-kill]: https://libtmux.org/en/ts/latest/reference/program-program-kill/
[ref-program-output]: https://libtmux.org/en/ts/latest/reference/program-program-output/
[ref-program-stream]: https://libtmux.org/en/ts/latest/reference/program-program-stream/
[ref-runoptions]: https://libtmux.org/en/ts/latest/reference/types-runoptions/
[ref-spawnoptions]: https://libtmux.org/en/ts/latest/reference/types-spawnoptions/
[ref-server-runshell]: https://libtmux.org/en/ts/latest/reference/server-server-runshell/
[ref-server-savebuffer]: https://libtmux.org/en/ts/latest/reference/server-server-savebuffer/
[ref-server-sessions]: https://libtmux.org/en/ts/latest/reference/server-server-sessions/
[ref-server-sethook]: https://libtmux.org/en/ts/latest/reference/server-server-sethook/
[ref-server-showglobaloptions]: https://libtmux.org/en/ts/latest/reference/server-server-showglobaloptions/
[ref-server-snapshot]: https://libtmux.org/en/ts/latest/reference/server-server-snapshot/
[ref-server-version]: https://libtmux.org/en/ts/latest/reference/server-server-version/
[ref-server-versionatleast]: https://libtmux.org/en/ts/latest/reference/server-server-versionatleast/
[ref-server-watch]: https://libtmux.org/en/ts/latest/reference/server-server-watch/
[ref-server-windows]: https://libtmux.org/en/ts/latest/reference/server-server-windows/
[ref-server-withconnection]: https://libtmux.org/en/ts/latest/reference/server-server-withconnection/
[ref-serveroptions]: https://libtmux.org/en/ts/latest/reference/server-serveroptions/
[ref-serversnapshot]: https://libtmux.org/en/ts/latest/reference/types-serversnapshot/
[ref-session]: https://libtmux.org/en/ts/latest/reference/session-session/
[ref-session-fromenv]: https://libtmux.org/en/ts/latest/reference/session-session-fromenv/
[ref-session-getenvironment]: https://libtmux.org/en/ts/latest/reference/session-session-getenvironment/
[ref-session-newwindow]: https://libtmux.org/en/ts/latest/reference/session-session-newwindow/
[ref-session-plan]: https://libtmux.org/en/ts/latest/reference/session-session-plan/
[ref-session-removeenvironment]: https://libtmux.org/en/ts/latest/reference/session-session-removeenvironment/
[ref-session-setenvironment]: https://libtmux.org/en/ts/latest/reference/session-session-setenvironment/
[ref-session-setoption]: https://libtmux.org/en/ts/latest/reference/session-session-setoption/
[ref-session-showenvironment]: https://libtmux.org/en/ts/latest/reference/session-session-showenvironment/
[ref-session-showoptions]: https://libtmux.org/en/ts/latest/reference/session-session-showoptions/
[ref-session-showresolvedoptions]: https://libtmux.org/en/ts/latest/reference/session-session-showresolvedoptions/
[ref-session-unsetenvironment]: https://libtmux.org/en/ts/latest/reference/session-session-unsetenvironment/
[ref-session-unsetoption]: https://libtmux.org/en/ts/latest/reference/session-session-unsetoption/
[ref-sessionwhere]: https://libtmux.org/en/ts/latest/reference/selection-sessionwhere/
[ref-setenvironmentoptions]: https://libtmux.org/en/ts/latest/reference/types-setenvironmentoptions/
[ref-tmuxcommanderror]: https://libtmux.org/en/ts/latest/reference/errors-tmuxcommanderror/
[ref-tmuxengine]: https://libtmux.org/en/ts/latest/reference/engine-tmuxengine/
[ref-tmuxeventstream]: https://libtmux.org/en/ts/latest/reference/types-tmuxeventstream/
[ref-tmuxinvocationreport]: https://libtmux.org/en/ts/latest/reference/common-tmuxinvocationreport/
[ref-tmuxobjectnotfounderror]: https://libtmux.org/en/ts/latest/reference/errors-tmuxobjectnotfounderror/
[ref-tmuxserverrestartederror]: https://libtmux.org/en/ts/latest/reference/errors-tmuxserverrestartederror/
[ref-tmuxtransporterror]: https://libtmux.org/en/ts/latest/reference/errors-tmuxtransporterror/
[ref-versiontoolowerror]: https://libtmux.org/en/ts/latest/reference/errors-versiontoolowerror/
[ref-streamlimiterror]: https://libtmux.org/en/ts/latest/reference/errors-streamlimiterror/
[ref-programstarterror]: https://libtmux.org/en/ts/latest/reference/errors-programstarterror/
[ref-waittimeouterror]: https://libtmux.org/en/ts/latest/reference/errors-waittimeouterror/
[ref-watchoptions]: https://libtmux.org/en/ts/latest/reference/types-watchoptions/
[ref-window]: https://libtmux.org/en/ts/latest/reference/window-window/
[ref-window-link]: https://libtmux.org/en/ts/latest/reference/window-window-link/
[ref-window-move]: https://libtmux.org/en/ts/latest/reference/window-window-move/
[ref-window-refreshed]: https://libtmux.org/en/ts/latest/reference/window-window-refreshed/
[ref-window-removeplacement]: https://libtmux.org/en/ts/latest/reference/window-window-removeplacement/
[ref-window-rename]: https://libtmux.org/en/ts/latest/reference/window-window-rename/
[ref-window-selectlayout]: https://libtmux.org/en/ts/latest/reference/window-window-selectlayout/
[ref-window-split]: https://libtmux.org/en/ts/latest/reference/window-window-split/
[ref-window-unlink]: https://libtmux.org/en/ts/latest/reference/window-window-unlink/
[ref-windowdirection]: https://libtmux.org/en/ts/latest/reference/constants-windowdirection/
[ref-windowwhere]: https://libtmux.org/en/ts/latest/reference/selection-windowwhere/
[tmux-3-6a-changes]: https://github.com/tmux/tmux/blob/3.6a/CHANGES#L21
[topic-environment]: https://libtmux.org/en/ts/latest/topics/environment/
[topic-errors]: https://libtmux.org/en/ts/latest/topics/errors-and-exceptions/
[topic-options-and-hooks]: https://libtmux.org/en/ts/latest/topics/options-and-hooks/
[topics]: https://libtmux.org/en/ts/latest/topics/
[wsref-applyworkspace]: https://libtmux.org/en/ts/latest/workspace/reference/builder-applyworkspace/
[wsref-reference]: https://libtmux.org/en/ts/latest/workspace/reference/
