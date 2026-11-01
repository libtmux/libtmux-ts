# Changelog

Notable changes to `libtmux-ts`.

This file is the product-level history: what each release brought across the
packages, which version each package shipped at, and the changes that span
packages, such as documentation, CI, tests, build and release tooling. A change
to one package is in that package's changelog, with its details and
migrations:

- [`libtmux`](packages/libtmux/CHANGELOG.md)
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md)
- [`@libtmux/workspace`](packages/workspace/CHANGELOG.md)
- [`@libtmux/workspace-cli`](packages/workspace-cli/CHANGELOG.md)

Releases are numbered `0.1.N`, and each release increments `N`. The packages
are released together and share one version, except that `@libtmux/workspace-cli`
first shipped in 0.1.0-alpha.11. The API is not settled: any release may change
or remove exported identifiers, and each package's changelog marks its breaks.
Pin an exact version to avoid one. Releases before `0.1.0` were alphas, and
their entries below keep that name.

Releases before 0.1.0-alpha.7 are in the package changelogs, which also hold
the repository-wide entries written before this file existed: the `libtmux`
changelog has the documentation, CI and release tooling entries up to 0.1.2.

<!-- KEEP THIS PLACEHOLDER: new work lands under "Unreleased" until a release is cut. -->

<!-- toc -->

- [Unreleased](#unreleased)
- [0.1.2 (2026-10-31)](#012-2026-10-31)
- [0.1.1 (2026-10-31)](#011-2026-10-31)
- [0.1.0 (2026-10-25)](#010-2026-10-25)
- [0.1.0-alpha.15 (2026-10-24)](#010-alpha15-2026-10-24)
- [0.1.0-alpha.14 (2026-10-20)](#010-alpha14-2026-10-20)
- [0.1.0-alpha.13 (2026-10-18)](#010-alpha13-2026-10-18)
- [0.1.0-alpha.12 (2026-09-27)](#010-alpha12-2026-09-27)
- [0.1.0-alpha.11 (2026-09-26)](#010-alpha11-2026-09-26)
- [0.1.0-alpha.10 (2026-09-19)](#010-alpha10-2026-09-19)
- [0.1.0-alpha.9 (2026-09-12)](#010-alpha9-2026-09-12)
- [0.1.0-alpha.8 (2026-09-06)](#010-alpha8-2026-09-06)
- [0.1.0-alpha.7 (2026-08-30)](#010-alpha7-2026-08-30)

<!-- /toc -->

## Unreleased

### Development

- Every test entry point runs in a sandbox: an owner-only directory that
  becomes `TMUX_TMPDIR`, with `TMUX`, `TMUX_PANE`, `LIBTMUX_SOCKET` and
  `LIBTMUX_SOCKET_PATH` removed, so a test, doctest or example that names no
  socket reaches a server of the run's own. `bun test` enters it from the
  `bunfig.toml` in the repository root, each package and each example; the
  runners, the documentation and install gates and the Node lane enter it
  themselves. A server a run leaves on any socket under the sandbox is
  stopped, and fails the run. (#176)
- Workflows run `apt-get` through `scripts/apt-get.sh`, which bounds it by
  `APT_TIMEOUT` (180 seconds by default) and retries after moving the first
  mirror in `/etc/apt/apt-mirrors.txt` to the end, so a hung mirror fails in
  minutes instead of at the job timeout. `check-ci-config.ts` fails a workflow
  or composite action that calls `apt-get` or `apt` itself. (#169)
- The MCP settle test "releases a pane whose daemon PID vanished" no longer
  samples `settled` against a timer. It waits on a signal that settlement is
  parked, and its probe is given a PID other than the test process's own.
  (#180)

### Documentation

- The documentation site builds from newer shared docs source. Linked symbols
  in doc comments are written the way each language's documentation writes
  them (#170); a port's landing page shows an example for each product
  (#178); and a port's Workspace and MCP pages show the workspace files its
  tests load and the tools its server advertises (#181).

## 0.1.2 (2026-10-31)

Versions: `libtmux` 0.1.2, `@libtmux/mcp` 0.1.2, `@libtmux/workspace` 0.1.2 and
`@libtmux/workspace-cli` 0.1.2.

A socket chosen by the environment now reaches the library, the MCP server and
`tmux-workspace`. `new Server()` reads `LIBTMUX_SOCKET_PATH`, else `LIBTMUX_SOCKET`, and
with neither set passes tmux no socket, so tmux picks the server: the one
`TMUX` names, otherwise its default socket. This is a behaviour change.

- [`libtmux`](packages/libtmux/CHANGELOG.md#012-2026-10-31): `new Server()`
  reads the two variables when given no `socketName` or `socketPath`.
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#012-2026-10-31): the server no
  longer starts a tmux server of its own on the `libtmux-mcp` socket, and
  `teardown` is no longer in the default toolsets. Set
  `LIBTMUX_SOCKET=libtmux-mcp` to keep the old server.
- [`@libtmux/workspace-cli`](packages/workspace-cli/CHANGELOG.md#012-2026-10-31):
  `tmux-workspace` uses the same variables and no longer always passes the
  socket `TMUX` names as `-S`.
- [`@libtmux/workspace`](packages/workspace/CHANGELOG.md#012-2026-10-31): no
  entries.

CI now runs tmux 3.3a and 3.8 on each push and the whole table for a release
(#164), as the `libtmux` changelog records.

## 0.1.1 (2026-10-31)

Versions: `libtmux` 0.1.1, `@libtmux/mcp` 0.1.1, `@libtmux/workspace` 0.1.1 and
`@libtmux/workspace-cli` 0.1.1.

This release runs programs in a pane of their own, and waits on the panes of
programs it did not start.

- [`libtmux`](packages/libtmux/CHANGELOG.md#011-2026-10-31): adds
  `Server.run` and `Server.spawn` for running a program, `Pane.waitForExit`,
  `Pane.waitForCommand` and `Pane.waitForText`, and passes `-u` on every
  command so a locale that does not name UTF-8 reads tmux's answers whole.
  JSON layouts require tmux 3.8.
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#011-2026-10-31): adds
  `run_program`, `start_program`, `read_program`, `stop_program` and
  `wait_for_exit`; `run_program`, `start_program` and `wait_for_exit` require
  tmux 3.8. `run_shell_command` answers
  `pane_died` promptly, and the server shuts down on SIGTERM, SIGINT and
  SIGHUP.
- [`@libtmux/workspace`](packages/workspace/CHANGELOG.md#011-2026-10-31) and
  [`@libtmux/workspace-cli`](packages/workspace-cli/CHANGELOG.md#011-2026-10-31):
  no entries.

The READMEs show the program recipes, each wait's docs give its bound after a
`kill-pane`, and the README says tmux release candidates are unsupported.

## 0.1.0 (2026-10-25)

Versions: `libtmux` 0.1.0, `@libtmux/mcp` 0.1.0, `@libtmux/workspace` 0.1.0 and
`@libtmux/workspace-cli` 0.1.0.

The first release without an `-alpha` tag. No package's changelog records a
code change. The READMEs, `SECURITY.md` and `CONTRIBUTING.md` drop the alpha
warning for one saying any release may change or remove exported identifiers,
and the `libtmux` README says which nested tmux commands the argv guard does
not check. See the [`libtmux`](packages/libtmux/CHANGELOG.md#010-2026-10-25)
changelog.

## 0.1.0-alpha.15 (2026-10-24)

Versions: all four packages 0.1.0-alpha.15.

- [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha15-2026-10-24): a literal
  `refresh-client -l` needs tmux 3.6a and refuses with `VersionTooLowError` on
  an older daemon, because it stops the server on 3.3a and on 3.4 through 3.6.
- `@libtmux/mcp`, `@libtmux/workspace` and `@libtmux/workspace-cli`: no
  entries.

## 0.1.0-alpha.14 (2026-10-20)

Versions: all four packages 0.1.0-alpha.14.

Features above the supported floor refuse on an older tmux with
`VersionTooLowError` before anything is sent.

- [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha14-2026-10-20):
  `Server.watch`, `Server.connect` and `Server.withConnection` need tmux 3.7,
  `Server.deleteBuffer` needs 3.4 and `Server.runShell` needs 3.5. The releases
  each gate refuses are in one registry, serialized as `capabilities.json`.
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#010-alpha14-2026-10-20):
  `paste_text` needs tmux 3.4, and `wait_for_text` polls with `capture-pane`
  below tmux 3.7.
- `@libtmux/workspace` and `@libtmux/workspace-cli`: no entries.

CI no longer runs macOS; the READMEs and `CONTRIBUTING.md` say macOS is
supported on a best-effort basis. (#88)

## 0.1.0-alpha.13 (2026-10-18)

Versions: all four packages 0.1.0-alpha.13.

The packages require tmux 3.3a or newer, judged by the running server's
version. An earlier server is refused with `VersionTooLowError` before anything
is sent.

- [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha13-2026-10-18): the
  refusal covers `Server` methods, `cmd`, batches, plans, `watch` and
  `connect`; `MINIMUM_TMUX` and `assertSupportedTmux` export the floor. To keep
  an older tmux, pin `libtmux@0.1.0-alpha.12`.
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#010-alpha13-2026-10-18): a tmux
  below the minimum returns a failure result that names the fix.
- [`@libtmux/workspace-cli`](packages/workspace-cli/CHANGELOG.md#010-alpha13-2026-10-18):
  `tmux-workspace` checks the tmux it uses before Python starts it, and fails
  with the `tmux_unsupported` code below the minimum.
- `@libtmux/workspace`: no entries.

## 0.1.0-alpha.12 (2026-09-27)

Versions: all four packages 0.1.0-alpha.12.

- [`@libtmux/workspace-cli`](packages/workspace-cli/CHANGELOG.md#010-alpha12-2026-09-27):
  depends on `libtmux` rather than declaring it a peer, so
  `yarn dlx @libtmux/workspace-cli` runs `tmux-workspace`.
- `@libtmux/workspace-cli` is an established package: a tag release stops when
  the registry lacks it, as for every other package. See the
  [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha12-2026-09-27) changelog.
- `libtmux`, `@libtmux/mcp` and `@libtmux/workspace`: no code changes.

## 0.1.0-alpha.11 (2026-09-26)

Versions: all four packages 0.1.0-alpha.11.

This release adds a fourth package, `@libtmux/workspace-cli`, which ships
`tmux-workspace` to discover, load, capture, convert and import tmuxp
workspaces from Node and Bun.

- [`@libtmux/workspace-cli`](packages/workspace-cli/CHANGELOG.md#010-alpha11-2026-09-26):
  new package.
- [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha11-2026-09-26):
  `Server.validateLayouts` checks complete window plans, including tmux 3.8
  JSON layouts, before anything changes; `Session.newWindow` accepts an exact
  `index`; `Server.connect({ target })` attaches to the session of exactly that
  name. Breaking: `ServerOptions.colors` accepts `256` alone, and
  `ServerSnapshot` carries `daemonIdentity`.
- [`@libtmux/workspace`](packages/workspace/CHANGELOG.md#010-alpha11-2026-09-26):
  `applyWorkspace` and `planWorkspace` accept a `signal`. Breaking:
  `applyWorkspace` rebalances a window between splits, and a window that names
  no layout comes up tiled.
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#010-alpha11-2026-09-26): the
  stdio server closes pending waits on stdin EOF, and `select_layout` reports
  the observed layout without a false warning.

Release tooling coordinates version checks, package canaries and publication
for the fourth package. (#24)

## 0.1.0-alpha.10 (2026-09-19)

Versions: `libtmux`, `@libtmux/mcp` and `@libtmux/workspace` 0.1.0-alpha.10.

- [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha10-2026-09-19): several
  breaking changes. Commands time out after 30 seconds by default;
  `CommandResult` uses `exitCode` in place of `returncode`; the default engine
  returns `Uint8Array` output; errors take consistent `*Error` names. Adds
  `ServerOptions.onInvocation` to observe commands, and `recordInvocations`
  and `replayInvocations` in `libtmux/testing`.
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#010-alpha10-2026-09-19): pane
  input works in non-UTF-8 locales, `run_shell_command` keeps its helper
  script out of the pane's visible input, and session results include
  `humanAttachedClients`.
- [`@libtmux/workspace`](packages/workspace/CHANGELOG.md#010-alpha10-2026-09-19):
  no entries.

## 0.1.0-alpha.9 (2026-09-12)

Versions: `libtmux`, `@libtmux/mcp` and `@libtmux/workspace` 0.1.0-alpha.9.

- [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha9-2026-09-12):
  `Pane.zoom`, `Pane.unzoom` and `Window.unzoom` set the zoom state rather than
  flipping it, and `ServerOptions.maxInFlight` bounds how many tmux
  invocations one server runs at once. `Pane.swapWith`, `Window.swapWith` and
  `Client.switchTo` refuse an object from another tmux server.
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#010-alpha9-2026-09-12):
  `resize_pane` treats `zoom` as a state, so sending the same value twice is a
  no-op.
- [`@libtmux/workspace`](packages/workspace/CHANGELOG.md#010-alpha9-2026-09-12):
  no entries.

Every CI job now carries a timeout. (#22)

## 0.1.0-alpha.8 (2026-09-06)

Versions: `libtmux`, `@libtmux/mcp` and `@libtmux/workspace` 0.1.0-alpha.8.

- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#010-alpha8-2026-09-06): breaking
  rework of the tool surface. One registry backs registration, dispatch,
  schemas and the static `tmux://capabilities` report, which is the only
  resource. Prompts, dynamic resources, workspace tools and buffer tools are
  removed, and `LIBTMUX_TOOLSETS`, `LIBTMUX_TOOLS` and
  `LIBTMUX_EXCLUDE_TOOLS` replace the safety tiers.
- [`@libtmux/workspace`](packages/workspace/CHANGELOG.md#010-alpha8-2026-09-06):
  breaking: `workspaceSchema` is no longer exported, and `WorkspaceWindowInput`
  is.
- [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha8-2026-09-06):
  `compileBoundedRegex` is exported.

## 0.1.0-alpha.7 (2026-08-30)

Versions: `libtmux`, `@libtmux/mcp` and `@libtmux/workspace` 0.1.0-alpha.7.

- [`libtmux`](packages/libtmux/CHANGELOG.md#010-alpha7-2026-08-30):
  `ControlClient` supports format subscriptions; identifiers and model fields
  are scoped to their owning server and model; buffer APIs preserve arbitrary
  bytes; session and window names that tmux would rewrite fail before
  execution. Development and release tooling uses Bun 1.4.0.
- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md#010-alpha7-2026-08-30): MCP starts
  read-only by default, `run_command` reports explicit started, busy,
  completed, canceled and marker outcomes, and live streams keep split ANSI
  and UTF-8 sequences whole. The experimental task surface is removed.
- [`@libtmux/workspace`](packages/workspace/CHANGELOG.md#010-alpha7-2026-08-30):
  application reports partial progress when tmux changes state before a later
  operation fails, and plans expose immutable, typed operation inputs.
