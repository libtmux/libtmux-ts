<!-- libtmux-logo -->
<div align="center">
  <picture>
    <source srcset="assets/logo.svg" type="image/svg+xml">
    <img src="assets/logo.png" width="128" height="128" alt="libtmux for TypeScript">
  </picture>
</div>
<!-- /libtmux-logo -->

<div align="center">

# libtmux for TypeScript

**Typed control of tmux for Bun and TypeScript — immutable snapshots,
declarative queries, and zero runtime dependencies.**

[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![libtmux](https://img.shields.io/npm/v/libtmux?label=libtmux)](https://www.npmjs.com/package/libtmux)
[![libtmux.org](https://img.shields.io/badge/docs-libtmux.org-0b7285)](https://libtmux.org/en/ts/)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/libtmux/libtmux-ts/blob/master/LICENSE)

</div>

Drive a running tmux server from agents, workspace launchers, test harnesses,
and dashboards: read the whole server once into an
[immutable snapshot][ref-server-snapshot], query it as typed data with
[`Selection.where`][ref-selection-where], batch mutations with
[`Server.batch`][ref-server-batch], and subscribe to events with
[`Server.watch`][ref-server-watch].

```console
$ bun add libtmux
```

<details>
<summary>npm, pnpm, yarn</summary>

```console
$ npm i libtmux
```

```console
$ pnpm add libtmux
```

```console
$ yarn add libtmux
```

</details>

- tmux 3.3a or newer. An older daemon is refused with
  [`VersionTooLowError`][ref-versiontoolowerror] before any command runs.
- [Bun](https://bun.sh) 1.3.14 or newer, or Node 22 or newer.
- Runs on Linux, including WSL. macOS is supported on a best-effort basis,
  and CI coverage for it is highly limited.

> Releases are numbered `0.1.N`. The API is not settled: any release may change
> or remove exported identifiers. Pin an exact version, and read the changelog
> of each package you use before you upgrade. The [root changelog](CHANGELOG.md)
> summarizes each release and links the package changelogs.

## Quickstart

Create a session, split a window, and read it back. The program starts a tmux
server of its own and stops it on the way out:

```ts
import { Server } from "libtmux";

const server = new Server({ socketName: "libtmux-demo" });
try {
  const session = await server.newSession({ name: "work" });
  const editor = await session.newWindow({ name: "editor" });
  await editor.split();

  // One read of the server. Everything after it resolves locally.
  const snapshot = await server.snapshot();
  const found = snapshot.windows.where({ name: "editor" }).one();
  console.log(found.panes.length);
  // 2
} finally {
  await server.kill();
}
```

More: [`examples/quickstart`](examples/quickstart) runs the same calls and adds a
pane action and a failed command.

## Find sessions, windows and panes

### [`Server.snapshot`][ref-server-snapshot]: read the server once

`new Server()` reaches the server your own `tmux` command does. A snapshot
reads it once, then answers every query without another tmux call:

```ts
import { Server } from "libtmux";

const server = new Server();
const snapshot = await server.snapshot();

const editors = snapshot.panes.where({ currentCommand: "vim" });
console.log(editors.count(), editors.at(0)?.session?.name);
```

### [`Selection.where`][ref-selection-where]: criteria as data

[`.where()`][ref-selection-where] takes declarative, serializable criteria;
[`.filter()`][ref-selection-filter] takes an ordinary predicate. They are
[never overloaded into each other](packages/libtmux/README.md#find-sessions-windows-and-panes).

```ts
// Equality, string operators, AND/OR/NOT, and regular expressions as data.
snapshot.sessions.where({
  AND: [
    { name: { startsWith: "prod" } },
    { windows: { some: { name: { regex: { pattern: "^log", flags: "" } } } } },
  ],
});

// Quantifiers over relations: some / every / none, and is / isNot.
snapshot.windows.where({ session: { is: { name: "work" } } });

// Case-insensitive when you ask for it.
snapshot.sessions.where({ name: { contains: "API", mode: "insensitive" } });
```

More: [every field and operator](packages/libtmux/docs/criteria.md).

### [`Selection`][ref-selection]: immutable, ordered, iterable

It is not an `Array`:

```ts
selection.length;
selection.at(-1);
selection.toArray();
[...selection];

selection.one({ name: "work" }); // throws NoMatchError / MultipleMatchesError
selection.oneOrUndefined({ name: "work" });
selection.exists({ name: "work" });
```

### [`encodeWhereDocument`][ref-encodewheredocument]: store a query

Criteria are data. `encodeWhereDocument` writes a model-tagged query;
[`decodeWhereDocument`][ref-decodewheredocument] validates one read from a
config file, MCP call, or CLI.

## Refresh an object

### [`Window.refreshed`][ref-window-refreshed]: read a handle again

A `Session`, `Window` or `Pane` you hold is what tmux said when it was read.
`refreshed()` reads it again and returns a new handle, and the handle you called
it on stays as it was. [`Session`][ref-session] and [`Pane`][ref-pane] have it too.

```ts
import { Server } from "libtmux";

const server = new Server({ socketName: "libtmux-refresh" });
try {
  await server.newSession({ name: "work", windowName: "editor" });
  const window = (await server.snapshot()).windows.one({ name: "editor" });

  await window.rename("build");
  console.log(window.name, (await window.refreshed()).name);
  // editor build
} finally {
  await server.kill();
}
```

## Type into a pane

### [`Pane.sendKeys`][ref-pane-sendkeys] and [`Pane.capture`][ref-pane-capture]: type, then read

[`Window.split`][ref-window-split] makes the pane and
[`Pane.resize`][ref-pane-resize] sets its height. `sendKeys` returns when tmux
has the keys, so read until `cat` has echoed them:

```ts
import { Server } from "libtmux";

const server = new Server({ socketName: "libtmux-pane" });
try {
  const session = await server.newSession({ name: "work" });
  const pane = await session.windows.one().split({ shellCommand: "cat" });
  await pane.resize({ height: 5 });

  await pane.sendKeys("hello");
  let lines = await pane.capture();
  while (lines.length === 0) lines = await pane.capture();
  console.log(lines[0], (await pane.refreshed()).height);
  // hello 5
} finally {
  await server.kill();
}
```

More: [options and hooks](packages/libtmux/README.md#options-and-hooks), from
[`Session.setOption`][ref-session-setoption] to
[`Server.setHook`][ref-server-sethook].

## Run several commands at once

### [`Server.batch`][ref-server-batch]: plan, then run

[`plan`][ref-session-plan] describes a mutation without running it. `batch` runs
the planned commands in order and resolves each to a typed handle, from one
final snapshot:

```ts
import { Server } from "libtmux";

const server = new Server({ socketName: "libtmux-batch" });
try {
  const session = await server.newSession({ name: "work" });
  const [editor, logs] = await server.batch([
    session.plan.newWindow({ name: "editor" }),
    session.plan.newWindow({ name: "logs" }),
  ]);
  const [pane] = await server.batch([editor.plan.split()]);

  await pane.sendKeys("echo hello");
  console.log(editor.name, logs.name);
  // editor logs
} finally {
  await server.kill();
}
```

[`pipeline`][ref-server-pipeline] runs raw tmux arguments the same way, one
result each. More:
[batching](packages/libtmux/README.md#run-several-commands-at-once).

## Watch tmux change

### [`Server.watch`][ref-server-watch]: control mode, no polling

`watch()` holds one persistent `tmux -C` connection and yields each change as
tmux announces it. Open it, await `ready()`, then act:

```ts
import { Server } from "libtmux";

const server = new Server({ socketName: "libtmux-watch" });
try {
  const session = await server.newSession({ name: "work" });
  await using events = server.watch({ target: session.id });
  await events.ready();

  await session.newWindow({ name: "build" });
  const opened = await events.find((event) => event.kind === "window-add", {
    timeoutMs: 10_000,
  });
  console.log(opened?.kind);
  // window-add
} finally {
  await server.kill();
}
```

- Needs tmux 3.7 or newer.
- [`Server.connect`][ref-server-connect] pairs the same observer with a server's
  commands, and [`waitFor`][ref-connected-waitfor] waits for a state to hold.

More: [watching](packages/libtmux/README.md#watch-tmux-change).

## Packages

The four packages share one release version.

| Package                                              | What it is                                                                     | npm                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[libtmux](packages/libtmux)**                      | The library. Server, session, window, pane and client handles over a snapshot. | [![npm](https://img.shields.io/npm/v/libtmux?label=libtmux)](https://www.npmjs.com/package/libtmux)                                                  |
| **[@libtmux/mcp](packages/mcp)**                     | An MCP server exposing tmux to an AI agent.                                    | [![npm](https://img.shields.io/npm/v/@libtmux/mcp?label=%40libtmux%2Fmcp)](https://www.npmjs.com/package/@libtmux/mcp)                               |
| **[@libtmux/workspace](packages/workspace)**         | Declarative workspace builder, tmuxp-shaped config.                            | [![npm](https://img.shields.io/npm/v/@libtmux/workspace?label=%40libtmux%2Fworkspace)](https://www.npmjs.com/package/@libtmux/workspace)             |
| **[@libtmux/workspace-cli](packages/workspace-cli)** | The native [`tmux-workspace`][cli-reference] command for Node and Bun.         | [![npm](https://img.shields.io/npm/v/@libtmux/workspace-cli?label=%40libtmux%2Fworkspace-cli)](https://www.npmjs.com/package/@libtmux/workspace-cli) |
| [examples](examples)                                 | Runnable examples, executed as tests.                                          | —                                                                                                                                                    |

### [libtmux](https://github.com/libtmux/libtmux-ts/tree/master/packages/libtmux): the library

[`Server`][ref-server], [`Session`][ref-session], [`Window`][ref-window],
[`Pane`][ref-pane] and [`Client`][ref-client] handles over an immutable snapshot
of tmux.

[API reference][ref-reference] ·
[npm](https://www.npmjs.com/package/libtmux) ·
[Changelog](packages/libtmux/CHANGELOG.md)

```console
$ bun add libtmux
```

```ts
import { Server } from "libtmux";

const server = new Server({ socketName: "libtmux-package" });
try {
  const session = await server.newSession({ name: "work" });
  const editor = await session.newWindow({ name: "editor" });
  await editor.split();

  await editor.panes.at(0)?.sendKeys("echo hello");
  const lines = await editor.panes.at(0)?.capture();
} finally {
  await server.kill();
}
```

Read next: [Snapshots](packages/libtmux/README.md#read-what-tmux-holds) ·
[Querying](packages/libtmux/README.md#find-sessions-windows-and-panes) ·
[Operations](packages/libtmux/README.md#change-sessions-windows-and-panes) ·
[Watching](packages/libtmux/README.md#watch-tmux-change) ·
[Recipes](packages/libtmux/README.md#type-into-a-pane-and-wait) ·
[Errors](packages/libtmux/README.md#errors) ·
[API reference](packages/libtmux/docs/api.md)

### [@libtmux/mcp](https://github.com/libtmux/libtmux-ts/tree/master/packages/mcp): tmux for an AI agent

A stdio MCP server. Point it at a socket and an agent can list sessions, read a
pane, send keys, and wait for output instead of polling for it.

[API reference][mcpref-reference] ·
[Tools][mcp-tools] ·
[npm](https://www.npmjs.com/package/@libtmux/mcp) ·
[Changelog](packages/mcp/CHANGELOG.md)

With no socket chosen it passes tmux none, so tmux picks the server: the one it
is launched inside, otherwise its default socket:

```console
$ npx -y @libtmux/mcp@0.1.2
```

Add it to any MCP client — this is the whole configuration:

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

<details>
<summary>Claude Code, in one command</summary>

```console
$ claude mcp add tmux --env LIBTMUX_SOCKET=agent -- \
    npx -y @libtmux/mcp@0.1.2
```

</details>

The tools an agent reaches for first:

| Tool                                          | What it does                                                       |
| --------------------------------------------- | ------------------------------------------------------------------ |
| [`list_sessions`][tool-list_sessions]         | Lists stable session identities and metadata                       |
| [`capture_since`][tool-capture_since]         | Returns only pane output after a cursor                            |
| [`wait_for_text`][tool-wait_for_text]         | Waits for bounded literal or regular-expression matches            |
| [`run_shell_command`][tool-run_shell_command] | Runs a command through a pane and reports output and exit status   |
| [`create_session`][mcp-tools-create_session]  | Creates a session without accepting a command or environment value |

Tools are grouped in the toolsets `inspect`, `manage`, `execute` and `teardown`.
[`tmux://capabilities`][mcp-resources-capabilities] is the one resource.

Read next: [Why it exists](packages/mcp/README.md#why-this-exists) ·
[Configuration](packages/mcp/README.md#point-it-at-a-server) ·
[Toolsets and trust](packages/mcp/README.md#toolsets-and-trust) ·
[Choosing the right tool](packages/mcp/README.md#choosing-the-right-tool)

### [@libtmux/workspace](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace): declarative sessions

Describe a session; apply it. Applying twice converges rather than duplicating.

[API reference][wsref-reference] ·
[npm](https://www.npmjs.com/package/@libtmux/workspace) ·
[Changelog](packages/workspace/CHANGELOG.md)

```console
$ bun add @libtmux/workspace libtmux
```

```ts
import { Server } from "libtmux";
import { applyWorkspace } from "@libtmux/workspace";

const server = new Server({ socketName: "libtmux-workspace" });
try {
  const devPane = { shell_command: "bun dev", focus: true };
  await applyWorkspace(server, {
    session_name: "api",
    windows: [
      { window_name: "editor", panes: ["vim", "git status"] },
      { window_name: "server", panes: [devPane] },
    ],
  });
} finally {
  await server.kill();
}
```

Read next: [The config shape](packages/workspace/README.md#describe-a-session) ·
[Converging](packages/workspace/README.md#apply-it)

### [@libtmux/workspace-cli](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace-cli): tmuxp workspaces from the shell

[`tmux-workspace`][cli-reference] loads, captures and converts tmuxp workspace
files on Node or Bun. Ordinary loads start no Python.

[Command reference][cli-reference] ·
[npm](https://www.npmjs.com/package/@libtmux/workspace-cli) ·
[Changelog](packages/workspace-cli/CHANGELOG.md)

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

Load it detached, on a socket of its own:

```console
$ npx -y @libtmux/workspace-cli@0.1.2 load ./workspace.yaml \
    -L workspace-cli-demo \
    -d
```

Read next: [Install](packages/workspace-cli/README.md#install) ·
[Load and capture](packages/workspace-cli/README.md#load-and-capture) ·
[Command reference](packages/workspace-cli/docs/command-reference.md)

### [examples](examples): runnable programs

Reading a server, watching it, driving a pane and waiting, and building a
workspace.

```console
$ bun test examples
```

## How work is arranged

Observation, planning and concurrency compose around one command engine.
[The full table](packages/libtmux/README.md#choosing-how-work-is-arranged) has
more.

| Mode       | Turn it on                                        | When to use it                                      |
| ---------- | ------------------------------------------------- | --------------------------------------------------- |
| connected  | [`await server.connect()`][ref-server-connect]    | Pairing commands with a persistent event observer   |
| watching   | [`server.watch()`][ref-server-watch]              | Reacting to a change rather than polling to find it |
| pipeline   | [`server.pipeline([…])`][ref-server-pipeline]     | Ordered commands when printed output is enough      |
| planned    | `.plan` + [`server.batch([…])`][ref-server-batch] | Ordered mutations that must return typed handles    |
| concurrent | `Promise.all`                                     | Independent work that may safely overlap            |

- Twelve windows cost 25 tmux invocations one at a time, 13 through
  [`pipeline`][ref-server-pipeline] and 14 through [`batch`][ref-server-batch].
  Each count includes the query that reads the result back.
- A snapshot is one invocation whatever the server's size, and querying it is
  none.
- [The benchmarks](packages/libtmux/docs/benchmarks.md) add wall-clock time and
  say why `Promise.all` buys nothing over doing the same work in order.

```console
$ bun packages/libtmux/scripts/bench-modes.ts
```

### [`maxInFlight`][ref-serveroptions]: bound the tmux processes

Every invocation is a tmux client process, so a `Promise.all` over a whole
server starts that many. `maxInFlight` caps them. A custom
[`TmuxEngine`][ref-tmuxengine] runs tmux over SSH or in a container instead.

```ts
import { Server } from "libtmux";

const server = new Server({ socketName: "libtmux-bounded", maxInFlight: 4 });
try {
  const session = await server.newSession({ name: "work" });
  const names = ["a", "b", "c", "d", "e", "f"];
  await Promise.all(names.map(async (name) => session.newWindow({ name })));
  console.log((await server.snapshot()).windows.count());
  // 7
} finally {
  await server.kill();
}
```

## What it leaves out

- **Live objects.** A [`Session`][ref-session], [`Window`][ref-window] or
  [`Pane`][ref-pane] is a record of what tmux said when it was read. Read again
  with [`refreshed()`][ref-window-refreshed], or subscribe with
  [`watch()`][ref-server-watch], to see a change.
- **A terminal emulator.** [`Pane.capture`][ref-pane-capture] and
  [`Server.run`][ref-server-run] return the screen tmux drew rather than running
  an in-process terminal emulator or TUI.
- **Your tmux configuration file.** This controls a running server; nothing
  here generates or edits `~/.tmux.conf`.

## Support and status

- **Unsettled API.** Releases are numbered `0.1.N`, and any release may change
  or remove exports. Pin an exact version and check [`CHANGELOG.md`](CHANGELOG.md).
- **No runtime dependencies in the library.** A
  [test](packages/libtmux/tests/unit/package_contract.test.ts) holds it.
  `@libtmux/mcp` and `@libtmux/workspace` declare their own.
- **Real tmux.** [CI](.github/workflows/typescript.yml) runs the suite against
  real servers, with no mocks standing in for tmux.
- **Tracks Python [libtmux](https://github.com/tmux-python/libtmux).** Names and
  shapes follow it where TypeScript agrees.

## Repository

```
packages/libtmux         the library
packages/mcp             the MCP server
packages/workspace       the workspace builder
packages/workspace-cli   the tmux-workspace command
examples                 runnable examples
```

Working here: [AGENTS.md](AGENTS.md) routes to the policy for a change. Writing
rules are in [.github/WRITING.md](.github/WRITING.md); gates, real tmux and
releases are in [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).

## AI policy

Use these packages with AI tools as you like. When contributing, check what you
submit and wait for a maintainer's invitation before preparing a pull request.
See the [AI policy](https://libtmux.org/en/meta/ai-policy/), also kept as
[AI_POLICY.md](https://github.com/libtmux/.github/blob/HEAD/AI_POLICY.md).

## License

[MIT](LICENSE) — a port of
[tmux-python/libtmux](https://github.com/tmux-python/libtmux). See
[libtmux.org](https://libtmux.org/) for all sibling ports.

[cli-reference]: https://libtmux.org/en/ts/latest/workspace/cli/
[mcp-resources-capabilities]: https://libtmux.org/en/ts/latest/mcp/resources/capabilities/
[mcp-tools]: https://libtmux.org/en/ts/latest/mcp/tools/
[mcp-tools-create_session]: https://libtmux.org/en/ts/latest/mcp/tools/create_session/
[mcpref-reference]: https://libtmux.org/en/ts/latest/mcp/reference/
[ref-client]: https://libtmux.org/en/ts/latest/reference/client-client/
[ref-connected-waitfor]: https://libtmux.org/en/ts/latest/reference/types-connectedserver-waitfor/
[ref-decodewheredocument]: https://libtmux.org/en/ts/latest/reference/selection-decodewheredocument/
[ref-encodewheredocument]: https://libtmux.org/en/ts/latest/reference/selection-encodewheredocument/
[ref-pane]: https://libtmux.org/en/ts/latest/reference/pane-pane/
[ref-pane-capture]: https://libtmux.org/en/ts/latest/reference/pane-pane-capture/
[ref-pane-resize]: https://libtmux.org/en/ts/latest/reference/pane-pane-resize/
[ref-pane-sendkeys]: https://libtmux.org/en/ts/latest/reference/pane-pane-sendkeys/
[ref-reference]: https://libtmux.org/en/ts/latest/reference/
[ref-selection]: https://libtmux.org/en/ts/latest/reference/selection-selection/
[ref-selection-filter]: https://libtmux.org/en/ts/latest/reference/selection-selection-filter/
[ref-selection-where]: https://libtmux.org/en/ts/latest/reference/selection-selection-where/
[ref-server]: https://libtmux.org/en/ts/latest/reference/server-server/
[ref-server-batch]: https://libtmux.org/en/ts/latest/reference/server-server-batch/
[ref-server-connect]: https://libtmux.org/en/ts/latest/reference/server-server-connect/
[ref-server-pipeline]: https://libtmux.org/en/ts/latest/reference/server-server-pipeline/
[ref-server-run]: https://libtmux.org/en/ts/latest/reference/server-server-run/
[ref-server-sethook]: https://libtmux.org/en/ts/latest/reference/server-server-sethook/
[ref-server-snapshot]: https://libtmux.org/en/ts/latest/reference/server-server-snapshot/
[ref-server-watch]: https://libtmux.org/en/ts/latest/reference/server-server-watch/
[ref-serveroptions]: https://libtmux.org/en/ts/latest/reference/server-serveroptions/
[ref-session]: https://libtmux.org/en/ts/latest/reference/session-session/
[ref-session-plan]: https://libtmux.org/en/ts/latest/reference/session-session-plan/
[ref-session-setoption]: https://libtmux.org/en/ts/latest/reference/session-session-setoption/
[ref-tmuxengine]: https://libtmux.org/en/ts/latest/reference/engine-tmuxengine/
[ref-versiontoolowerror]: https://libtmux.org/en/ts/latest/reference/errors-versiontoolowerror/
[ref-window]: https://libtmux.org/en/ts/latest/reference/window-window/
[ref-window-refreshed]: https://libtmux.org/en/ts/latest/reference/window-window-refreshed/
[ref-window-split]: https://libtmux.org/en/ts/latest/reference/window-window-split/
[tool-capture_since]: https://libtmux.org/en/ts/latest/mcp/tools/capture_since/
[tool-list_sessions]: https://libtmux.org/en/ts/latest/mcp/tools/list_sessions/
[tool-run_shell_command]: https://libtmux.org/en/ts/latest/mcp/tools/run_shell_command/
[tool-wait_for_text]: https://libtmux.org/en/ts/latest/mcp/tools/wait_for_text/
[wsref-reference]: https://libtmux.org/en/ts/latest/workspace/reference/
