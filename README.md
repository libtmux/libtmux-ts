<div align="center">

# libtmux

**Typed control of tmux for Bun and TypeScript — immutable snapshots, declarative queries, zero runtime dependencies.**

[Quickstart](#quickstart) •
[Querying](#what-querying-looks-like) •
[Packages](#packages) •
[API reference](packages/libtmux/docs/api.md) •
[Examples](examples) •
[Changelog](packages/libtmux/CHANGELOG.md)

[![npm](https://img.shields.io/npm/v/libtmux?label=libtmux&color=cb3837)](https://www.npmjs.com/package/libtmux)
[![downloads](https://img.shields.io/npm/dm/libtmux?color=cb3837)](https://www.npmjs.com/package/libtmux)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.2a%20%7C%203.7%20%7C%203.7b-1bb91f)](.github/workflows/typescript.yml)
[![dependencies](https://img.shields.io/badge/dependencies-0-1bb91f)](packages/libtmux/tests/unit/package_contract.test.ts)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

> [!WARNING]
> **Alpha.** Published as a prerelease: the API can change between alpha
> releases without a deprecation cycle, and it is not covered by semantic
> versioning until `0.1.0`. Pin an exact version, and read the
> [changelog](packages/libtmux/CHANGELOG.md) before you upgrade.
>
> What is already true: the suite runs against real tmux on every commit, and
> every example on this page is compiled — several are executed.

## Is this for you?

**Yes, if** you drive tmux from a program — an agent that runs commands and reads
what they printed, a workspace launcher, a test harness, a dashboard — and you
want the terminal's state as typed data rather than as parsed strings.

**Probably not, if** you want a `.tmux.conf` generator or a TUI. This is a
library for controlling a running server, not for configuring one.

**The idea in one line:** read the whole server once into an immutable snapshot,
then query it like data.

## Quickstart

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

Requires [Bun](https://bun.sh) 1.3.14+ or Node 22+, and tmux 3.2a or newer.

```ts
import { Server } from "libtmux";

const server = new Server();
const snapshot = await server.snapshot();

// No further tmux calls: everything below resolves against the snapshot.
const editors = snapshot.panes.where({ currentCommand: "vim" });
console.log(editors.count(), editors.at(0)?.sessionName);
```

Building something rather than reading it looks like this — and this block is a
literal excerpt of [`examples/quickstart.ts`](examples/quickstart.ts), which the
integration suite runs against a real tmux server:

<!-- runs: examples/quickstart.ts -->

```ts
const session = await server.newSession({ name: "quickstart" });
const editor = await session.newWindow({ name: "editor" });
await editor.split();

const snapshot = await server.snapshot();

const found = snapshot.windows.where({ name: "editor" }).one();

const paneCount = found.panes.length;
```

## What querying looks like

This is the part worth judging the library on. `.where()` takes declarative,
serializable criteria; `.filter()` takes an ordinary predicate. They are
[never overloaded into each other](packages/libtmux/README.md#querying).

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

A `Selection` is immutable, ordered, replayable, and `Iterable` — but it is
deliberately **not** an `Array`:

```ts
selection.length;
selection.at(-1);
selection.toArray();
[...selection];

selection.one({ name: "work" }); // throws NoMatchError / MultipleMatchesError
selection.oneOrUndefined({ name: "work" });
selection.exists({ name: "work" });
```

Criteria are data, so they serialize — the same object can come from a config
file, an MCP call, or a CLI flag.

## Packages

Three packages, released together, each usable on its own.

| Package                                      | What it is                                                                     | npm                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **[libtmux](packages/libtmux)**              | The library. Server, session, window, pane and client handles over a snapshot. | [![npm](https://img.shields.io/npm/v/libtmux?color=cb3837&label=)](https://www.npmjs.com/package/libtmux)                       |
| **[@libtmux/mcp](packages/mcp)**             | An MCP server exposing tmux to an AI agent.                                    | [![npm](https://img.shields.io/npm/v/@libtmux/mcp?color=cb3837&label=)](https://www.npmjs.com/package/@libtmux/mcp)             |
| **[@libtmux/workspace](packages/workspace)** | Declarative workspace builder, tmuxp-shaped config.                            | [![npm](https://img.shields.io/npm/v/@libtmux/workspace?color=cb3837&label=)](https://www.npmjs.com/package/@libtmux/workspace) |
| [examples](examples)                         | Runnable examples, executed as tests.                                          | —                                                                                                                               |

---

### [libtmux](packages/libtmux) — the library

```console
$ bun add libtmux
```

```ts
import { Server } from "libtmux";

const server = new Server();
const session = await server.newSession({ name: "work" });
const editor = await session.newWindow({ name: "editor" });
await editor.split();

await editor.panes.at(0)?.sendKeys("echo hello");
const lines = await editor.panes.at(0)?.capture();
```

Read next: [Snapshots](packages/libtmux/README.md#snapshots) ·
[Querying](packages/libtmux/README.md#querying) ·
[Operations](packages/libtmux/README.md#operations) ·
[Watching](packages/libtmux/README.md#watching) ·
[Recipes](packages/libtmux/README.md#recipes) ·
[Errors](packages/libtmux/README.md#errors) ·
[API reference](packages/libtmux/docs/api.md)

### [@libtmux/mcp](packages/mcp) — tmux for an AI agent

A stdio MCP server. Point it at a socket and an agent can list sessions, read a
pane, send keys, and **wait for output** rather than polling for it.

```console
$ npx -y @libtmux/mcp
```

Add it to any MCP client — this is the whole configuration:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["-y", "@libtmux/mcp"],
      "env": { "LIBTMUX_SOCKET_NAME": "agent" }
    }
  }
}
```

<details>
<summary>Claude Code, in one command</summary>

```console
$ claude mcp add tmux --env LIBTMUX_SOCKET_NAME=agent -- npx -y @libtmux/mcp
```

</details>

| Tool              | What it does                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `list_sessions`   | Every session with its id, name and window count                        |
| `list_panes`      | Panes, optionally restricted to one session                             |
| `capture_pane`    | A pane's visible contents, or its scrollback                            |
| `send_keys`       | Send keys, optionally literally and without Enter                       |
| `new_session`     | Create a detached session                                               |
| `wait_for_output` | Block until a pane prints something, streaming tmux's own notifications |

Read next: [Why it exists](packages/mcp/README.md#why-this-exists) ·
[Configuration](packages/mcp/README.md#point-it-at-a-server) ·
[The echo caveat](packages/mcp/README.md#one-caveat-worth-knowing)

### [@libtmux/workspace](packages/workspace) — declarative sessions

Describe a session; apply it. Applying twice converges rather than duplicating.

```console
$ bun add @libtmux/workspace
```

```ts
import { Server } from "libtmux";
import { applyWorkspace } from "@libtmux/workspace";

const server = new Server();

await applyWorkspace(server, {
  session_name: "api",
  windows: [
    { window_name: "editor", panes: ["vim", "git status"] },
    { window_name: "server", panes: [{ shell_command: "bun dev", focus: true }] },
  ],
});
```

Read next: [The config shape](packages/workspace/README.md#the-shape) ·
[Converging](packages/workspace/README.md#converging-not-just-creating)

### [examples](examples) — runnable, and run

Four programs covering acquisition, control-mode watching, the act-then-wait
loop an agent needs, and building a workspace. Each is executed by the
integration suite, so the code there is the code that runs.

```console
$ bun test examples/tests
```

## How commands travel

Transport, chaining and concurrency are independent, each one token at the call
site, and **none of them changes what you get back** —
[the full table is here](packages/libtmux/README.md#choosing-how-commands-travel).

| Mode      | Turn it on                    | When to use it                                      |
| --------- | ----------------------------- | --------------------------------------------------- |
| spawning  | the default                   | A script that runs a few commands and exits         |
| connected | `await server.connect()`      | Anything long-lived, or a loop reacting to events   |
| watching  | `server.watch()`              | Reacting to a change rather than polling to find it |
| planned   | `.plan` + `server.batch([…])` | Creating or changing several things at once         |

Twelve windows, measured: one-at-a-time costs 64 tmux invocations and about a
second; batched costs 5 and about 40 ms. Same answer, different cost —
[reproduce it](packages/libtmux/README.md#choosing-how-commands-travel) with
`bun packages/libtmux/scripts/bench-modes.ts`.

## What this package promises

- **Zero runtime dependencies.** A property [under test](packages/libtmux/tests/unit/package_contract.test.ts), not an aspiration.
- **Real tmux, every commit.** CI runs the suite against tmux 3.2a, 3.7 and 3.7b — no mocks stand in for a server.
- **Documentation is a gate.** Every public symbol carries a compiled example, [the API reference](packages/libtmux/docs/api.md) is generated from the source that implements it, and every link, install command and recipe on this page is checked on each run.
- **Parity is recorded, not claimed.** Every public symbol of Python [libtmux](https://github.com/tmux-python/libtmux) 0.62.0 carries a decision in [a ledger](packages/libtmux/parity), checked on every run.

## Repository

```
packages/libtmux     the library
packages/mcp         the MCP server
packages/workspace   the workspace builder
examples             runnable examples, used as tests
attic                reference notes
```

Working here: [AGENTS.md](AGENTS.md) covers the layout, the gates, how to probe
real tmux without tripping over socket path limits, and why a gate that has
never been red is an assumption.

## License

[MIT](LICENSE) — a port of
[tmux-python/libtmux](https://github.com/tmux-python/libtmux).
