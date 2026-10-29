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

**Typed control of tmux for Bun and TypeScript — immutable snapshots, declarative queries, and a library that ships zero runtime dependencies.**

[Quickstart](#quickstart) •
[Querying](#what-querying-looks-like) •
[Packages](#packages) •
[API reference](packages/libtmux/docs/api.md) •
[Hosted API reference][ref-reference] •
[Examples](examples) •
[Changelog](packages/libtmux/CHANGELOG.md)

[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![libtmux](https://img.shields.io/npm/v/libtmux?label=libtmux)](https://www.npmjs.com/package/libtmux)
[![libtmux.org](https://img.shields.io/badge/docs-libtmux.org-0b7285)](https://libtmux.org/en/ts/)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/libtmux/libtmux-ts/blob/master/LICENSE)

</div>

---

> [!WARNING]
> Releases are numbered `0.1.N`, and each release increments `N`. The API is not
> settled: any release may change or remove exported identifiers, and each
> package's changelog marks its breaks. Pin an exact version to avoid one.
> Read the changelog of each package you use before you upgrade:
> [`libtmux`](packages/libtmux/CHANGELOG.md),
> [`@libtmux/mcp`](packages/mcp/CHANGELOG.md),
> [`@libtmux/workspace`](packages/workspace/CHANGELOG.md) and
> [`@libtmux/workspace-cli`](packages/workspace-cli/CHANGELOG.md).

## Is this for you?

**Yes, if** you drive tmux from a program — an agent that runs commands and reads
what they printed, a workspace launcher, a test harness, a dashboard — and you
want the terminal's state as typed data rather than as parsed strings.

**Probably not, if** you want a `.tmux.conf` generator or a TUI. This library
controls a running server; it does not write your tmux configuration.

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

Requires [Bun](https://bun.sh) 1.3.14+ or Node 22+, and tmux 3.3a or newer.

- The version that counts is the running daemon's.
- An older daemon, or an executable that would start one, is refused with
  [`VersionTooLowError`][ref-versiontoolowerror] before any command takes effect.
- A client reporting a newer release does not change that.

Runs on Linux, including WSL. macOS is supported on a best-effort basis,
and CI coverage for it is highly limited.

```ts
import { Server } from "libtmux";

const server = new Server();
const snapshot = await server.snapshot();

// No further tmux calls: everything below resolves against the snapshot.
const editors = snapshot.panes.where({ currentCommand: "vim" });
console.log(editors.count(), editors.at(0)?.session?.name);
```

Building something rather than reading it looks like this — and this block is a
literal excerpt of [`examples/quickstart/quickstart.ts`](examples/quickstart/quickstart.ts), which the
integration suite runs against a real tmux server:

<!-- runs: examples/quickstart/quickstart.ts -->

```ts
const session = await server.newSession({ name: "quickstart" });
const editor = await session.newWindow({ name: "editor" });
await editor.split();

const snapshot = await server.snapshot();

const found = snapshot.windows.where({ name: "editor" }).one();

const paneCount = found.panes.length;
```

## What querying looks like

This is the part worth judging the library on. [`.where()`][ref-selection-where] takes declarative,
serializable criteria; [`.filter()`][ref-selection-filter] takes an ordinary predicate. They are
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

A [`Selection`][ref-selection] is immutable, ordered, replayable, and `Iterable`.
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

Criteria are data. [`encodeWhereDocument`][ref-encodewheredocument] writes a model-tagged query;
[`decodeWhereDocument`][ref-decodewheredocument] validates one read from a config file, MCP call, or CLI.

## Packages

The library, MCP server, workspace builder, and workspace CLI share one release version.

| Package                                              | What it is                                                                     | npm                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[libtmux](packages/libtmux)**                      | The library. Server, session, window, pane and client handles over a snapshot. | [![npm](https://img.shields.io/npm/v/libtmux?label=libtmux)](https://www.npmjs.com/package/libtmux)                                                  |
| **[@libtmux/mcp](packages/mcp)**                     | An MCP server exposing tmux to an AI agent.                                    | [![npm](https://img.shields.io/npm/v/@libtmux/mcp?label=%40libtmux%2Fmcp)](https://www.npmjs.com/package/@libtmux/mcp)                               |
| **[@libtmux/workspace](packages/workspace)**         | Declarative workspace builder, tmuxp-shaped config.                            | [![npm](https://img.shields.io/npm/v/@libtmux/workspace?label=%40libtmux%2Fworkspace)](https://www.npmjs.com/package/@libtmux/workspace)             |
| **[@libtmux/workspace-cli](packages/workspace-cli)** | The native [`tmux-workspace`][cli-reference] command for Node and Bun.         | [![npm](https://img.shields.io/npm/v/@libtmux/workspace-cli?label=%40libtmux%2Fworkspace-cli)](https://www.npmjs.com/package/@libtmux/workspace-cli) |
| [examples](examples)                                 | Runnable examples, executed as tests.                                          | —                                                                                                                                                    |

---

### [libtmux](https://github.com/libtmux/libtmux-ts/tree/master/packages/libtmux) — the library

The library: [`Server`][ref-server], [`Session`][ref-session], [`Window`][ref-window], [`Pane`][ref-pane] and [`Client`][ref-client] handles over an
immutable snapshot of tmux.

[API reference][ref-reference] ·
[npm](https://www.npmjs.com/package/libtmux) ·
[Changelog](packages/libtmux/CHANGELOG.md)

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

Read next: [Snapshots](packages/libtmux/README.md#read-what-tmux-holds) ·
[Querying](packages/libtmux/README.md#find-sessions-windows-and-panes) ·
[Operations](packages/libtmux/README.md#change-sessions-windows-and-panes) ·
[Watching](packages/libtmux/README.md#watch-tmux-change) ·
[Recipes](packages/libtmux/README.md#type-into-a-pane-and-wait) ·
[Errors](packages/libtmux/README.md#errors) ·
[API reference](packages/libtmux/docs/api.md)

### [@libtmux/mcp](https://github.com/libtmux/libtmux-ts/tree/master/packages/mcp) — tmux for an AI agent

A stdio MCP server. Point it at a socket and an agent can list sessions, read a
pane, send keys, and **wait for output** rather than polling for it.

[API reference][mcpref-reference] ·
[Tools][mcp-tools] ·
[npm](https://www.npmjs.com/package/@libtmux/mcp) ·
[Changelog](packages/mcp/CHANGELOG.md)

With no configuration it starts its own tmux server on the `libtmux-mcp`
socket:

```console
$ npx -y @libtmux/mcp@0.1.1
```

Add it to any MCP client — this is the whole configuration:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "npx",
      "args": ["-y", "@libtmux/mcp@0.1.1"],
      "env": { "LIBTMUX_SOCKET": "agent" }
    }
  }
}
```

<details>
<summary>Claude Code, in one command</summary>

```console
$ claude mcp add tmux --env LIBTMUX_SOCKET=agent -- \
    npx -y @libtmux/mcp@0.1.1
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

The tools are split into `inspect`, `manage`, `execute`, and `teardown`.
[`tmux://capabilities`][mcp-resources-capabilities] is the only resource; the server exposes no prompts,
resource templates, background jobs, or generic mutation tools.

Read next: [Why it exists](packages/mcp/README.md#why-this-exists) ·
[Configuration](packages/mcp/README.md#point-it-at-a-server) ·
[Toolsets and trust](packages/mcp/README.md#toolsets-and-trust) ·
[Choosing the right tool](packages/mcp/README.md#choosing-the-right-tool)

### [@libtmux/workspace](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace) — declarative sessions

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

const server = new Server();

await applyWorkspace(server, {
  session_name: "api",
  windows: [
    { window_name: "editor", panes: ["vim", "git status"] },
    { window_name: "server", panes: [{ shell_command: "bun dev", focus: true }] },
  ],
});
```

Read next: [The config shape](packages/workspace/README.md#describe-a-session) ·
[Converging](packages/workspace/README.md#apply-it)

### [@libtmux/workspace-cli](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace-cli) — tmuxp workspaces from the shell

[`tmux-workspace`][cli-reference] loads, captures and converts tmuxp workspace files on Node or
Bun. Ordinary loads start no Python.

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
$ npx -y @libtmux/workspace-cli@0.1.1 load ./workspace.yaml \
    -L workspace-cli-demo \
    -d
```

Read next: [Install](packages/workspace-cli/README.md#install) ·
[Load and capture](packages/workspace-cli/README.md#load-and-capture) ·
[Command reference](packages/workspace-cli/docs/command-reference.md)

### [examples](examples) — runnable, and run

Programs covering acquisition, control-mode watching, the act-then-wait
loop an agent needs, and building a workspace. Each is executed by the
integration suite, so the code there is the code that runs.

```console
$ bun test examples
```

## How work is arranged

Observation, planning and concurrency compose around the same command engine —
[the full table is here](packages/libtmux/README.md#choosing-how-work-is-arranged).

| Mode       | Turn it on                                        | When to use it                                      |
| ---------- | ------------------------------------------------- | --------------------------------------------------- |
| connected  | [`await server.connect()`][ref-server-connect]    | Pairing commands with a persistent event observer   |
| watching   | [`server.watch()`][ref-server-watch]              | Reacting to a change rather than polling to find it |
| pipeline   | [`server.pipeline([…])`][ref-server-pipeline]     | Ordered commands when printed output is enough      |
| planned    | `.plan` + [`server.batch([…])`][ref-server-batch] | Ordered mutations that must return typed handles    |
| concurrent | `Promise.all`                                     | Independent work that may safely overlap            |

Creating twelve windows costs, each figure including the one query that reads
the result back:

- 25 tmux invocations one at a time, 13 through
  [`pipeline`][ref-server-pipeline], and 14 through
  [`batch`][ref-server-batch], whose extra is the snapshot that turns printed ids
  into typed handles.
- A snapshot is one invocation whatever the server's size, and querying it is
  none.
- The wall-clock beside those counts, and why `Promise.all` buys nothing over
  doing the same work in order, are in
  [the benchmarks](packages/libtmux/docs/benchmarks.md).

```console
$ bun packages/libtmux/scripts/bench-modes.ts
```

## What this project promises

- **The library ships zero runtime dependencies.** [A test](packages/libtmux/tests/unit/package_contract.test.ts) holds it. `@libtmux/mcp` and `@libtmux/workspace` declare their own.
- **Real tmux, every commit.** [CI](.github/workflows/typescript.yml) runs the suite against tmux 3.3a and 3.8 on each push, and against every release from 3.3a to 3.8, the `release_3.8a` branch and tmux master before each release — no mocks stand in for a server.
- **Documentation is a gate.** Every public symbol carries a compiled example, [the API reference](packages/libtmux/docs/api.md) is generated from the source that implements it, and every link, install command and recipe on this page is checked on each run.
- **Softly tracks Python [libtmux](https://github.com/tmux-python/libtmux).** Names and shapes follow 0.62.0 where TypeScript agrees with them; each departure is a decision a gate holds to the code.

## Repository

```
packages/libtmux     the library
packages/mcp         the MCP server
packages/workspace   the workspace builder
packages/workspace-cli the tmux-workspace command
examples             runnable examples, used as tests
attic                reference notes
```

Working here: [AGENTS.md](AGENTS.md) routes to the policy that governs a
change. The layout and the change discipline live there; how we write is in
[.github/WRITING.md](.github/WRITING.md), and the gates, real tmux, and
releases are in [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Attribution

Please use the following BibTeX template to cite libtmux-ts in scientific discourse:

```bibtex
@misc{libtmux-ts,
   author = {Tony Narlock},
   year = {2026},
   note = {https://libtmux.org/en/ts/},
   title = {libtmux-ts: TypeScript wrapper for tmux}
}
```

## License

[MIT](LICENSE) — a port of
[tmux-python/libtmux](https://github.com/tmux-python/libtmux).

[cli-reference]: https://libtmux.org/en/ts/latest/workspace/cli/
[mcp-resources-capabilities]: https://libtmux.org/en/ts/latest/mcp/resources/capabilities/
[mcp-tools]: https://libtmux.org/en/ts/latest/mcp/tools/
[mcp-tools-create_session]: https://libtmux.org/en/ts/latest/mcp/tools/create_session/
[mcpref-reference]: https://libtmux.org/en/ts/latest/mcp/reference/
[ref-client]: https://libtmux.org/en/ts/latest/reference/client-client/
[ref-decodewheredocument]: https://libtmux.org/en/ts/latest/reference/selection-decodewheredocument/
[ref-encodewheredocument]: https://libtmux.org/en/ts/latest/reference/selection-encodewheredocument/
[ref-pane]: https://libtmux.org/en/ts/latest/reference/pane-pane/
[ref-reference]: https://libtmux.org/en/ts/latest/reference/
[ref-selection]: https://libtmux.org/en/ts/latest/reference/selection-selection/
[ref-selection-filter]: https://libtmux.org/en/ts/latest/reference/selection-selection-filter/
[ref-selection-where]: https://libtmux.org/en/ts/latest/reference/selection-selection-where/
[ref-server]: https://libtmux.org/en/ts/latest/reference/server-server/
[ref-server-batch]: https://libtmux.org/en/ts/latest/reference/server-server-batch/
[ref-server-connect]: https://libtmux.org/en/ts/latest/reference/server-server-connect/
[ref-server-pipeline]: https://libtmux.org/en/ts/latest/reference/server-server-pipeline/
[ref-server-watch]: https://libtmux.org/en/ts/latest/reference/server-server-watch/
[ref-session]: https://libtmux.org/en/ts/latest/reference/session-session/
[ref-versiontoolowerror]: https://libtmux.org/en/ts/latest/reference/errors-versiontoolowerror/
[ref-window]: https://libtmux.org/en/ts/latest/reference/window-window/
[tool-capture_since]: https://libtmux.org/en/ts/latest/mcp/tools/capture_since/
[tool-list_sessions]: https://libtmux.org/en/ts/latest/mcp/tools/list_sessions/
[tool-run_shell_command]: https://libtmux.org/en/ts/latest/mcp/tools/run_shell_command/
[tool-wait_for_text]: https://libtmux.org/en/ts/latest/mcp/tools/wait_for_text/
[wsref-reference]: https://libtmux.org/en/ts/latest/workspace/reference/
