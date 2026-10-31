# Changelog

Notable changes to `@libtmux/workspace`.

Releases are numbered `0.1.N`, and each release increments `N`. The API is not
settled: any release may change or remove exported identifiers, and this
changelog marks each break. Pin an exact version to avoid one. The newest
release is always `latest`, so `npm i @libtmux/workspace` fetches it. Releases
before `0.1.0` were alphas, and their entries below keep that name.

The release packages share one version, so every release has a section here.
Changes that span packages, such as documentation, CI and release tooling,
are in the [`libtmux` changelog](../libtmux/CHANGELOG.md).

<!-- KEEP THIS PLACEHOLDER: new work lands under "Unreleased" until a release is cut. -->

<!-- toc -->

- [Unreleased](#unreleased)
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
- [0.1.0-alpha.6](#010-alpha6)
- [0.1.0-alpha.5](#010-alpha5)
- [0.1.0-alpha.4](#010-alpha4)
- [0.1.0-alpha.3](#010-alpha3)
- [0.1.0-alpha.2](#010-alpha2)
- [0.1.0-alpha.1](#010-alpha1)
- [0.0.1-alpha.7](#001-alpha7)
- [0.0.1-alpha.6](#001-alpha6)
- [0.0.1-alpha.5](#001-alpha5)

<!-- /toc -->

## Unreleased

## 0.1.1 (2026-10-31)

No entries for `@libtmux/workspace`.

## 0.1.0 (2026-10-25)

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.15 (2026-10-24)

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.14 (2026-10-20)

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.13 (2026-10-18)

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.12 (2026-09-27)

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.11 (2026-09-26)

### `@libtmux/workspace`

- `applyWorkspace` and `planWorkspace` accept a `signal`, so a build that is
  no longer wanted stops instead of running to completion. Every tmux call
  they make carries it, and the gap between two calls is checked as well.
  A build already begun is not rolled back; planning changes nothing, so
  there is nothing to unwind. (#24)
- The README states what happens when two calls race on one session name:
  tmux offers no lock on a session that does not exist yet, so both can
  observe none and each start one. Serialize calls that target the same
  name. (#24)
- **Breaking.** `applyWorkspace` now rebalances a window between splits, so a
  window of five or more panes builds at a default 80x24 where tmux previously
  answered `size or position no space for a new pane` on the fifth. A window
  that names no layout, or names the empty string, now comes up tiled; a
  declared layout is still applied last. (#24)
- The README and `applyWorkspace` now state that this package and
  `@libtmux/workspace-cli` are separate implementations: they answer
  differently for a session that already exists, and the strict schema here
  rejects the CLI's additional document fields. (#24)

## 0.1.0-alpha.10 (2026-09-19)

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.9 (2026-09-12)

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.8 (2026-09-06)

### `@libtmux/workspace`

**Breaking.** `workspaceSchema` is no longer exported, and the published types
are declared rather than inferred from it. Installing the package no longer
makes a consumer's `tsc` resolve zod's own declarations, which since zod 4.5.4
name the `URL` global and fail under a `lib` without `DOM` and no `@types/node`.
`parseWorkspace` and `parseWorkspaceYaml` are unchanged. (#19)

`WorkspaceWindowInput` is exported, naming a window as written — before `panes`
defaults to one implicit pane. (#19)

## 0.1.0-alpha.7 (2026-08-30)

### `@libtmux/workspace`

Workspace application reports partial progress when tmux changes state before
a later operation fails. (#11)

Workspace commands use literal argument arrays and preserve the requested
working directory without shell reinterpretation. (#11)

Implicit panes are normalized before planning so equivalent workspace
documents produce the same operation sequence. (#11)

`WorkspaceInput` describes input before schema defaults and transforms, while
`Workspace` describes validated output. `applyWorkspace` and `planWorkspace`
accept `WorkspaceInput`, including a window whose `panes` field is omitted.
(#14)

Pruning distinguishes linked windows and grouped sessions instead of deleting
a shared underlying window. (#11)

`prune: "always"` is documented as authority for one `planWorkspace` or
`applyWorkspace` call, not a persistent ownership claim. It does not stamp a
found session, so a later default `"owned"` apply leaves new surplus alone.
(#14)

Workspace plans expose immutable, typed operation inputs so callers cannot
silently change a validated plan before execution. (#11)

## 0.1.0-alpha.6

### `@libtmux/workspace`

`applyWorkspace` and `planWorkspace` build against a server that is not running
yet, which is what a first run starts from. Both opened by reading the server,
and reading one raises where no daemon is listening, so the branch that creates
the session was never reached.

## 0.1.0-alpha.5

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.4

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.3

No entries for `@libtmux/workspace`.

## 0.1.0-alpha.2

### Changed

**`@libtmux/workspace` prunes only what it created.** `applyWorkspace` found a
session by name and then killed every window and pane the file did not describe;
a name is a lookup, not a claim, so converging a session somebody made by hand
destroyed their work. A session this package creates is now marked, and pruning
asks the mark. `prune: "always"` is how you say a session you did not create is
this file's, and `prune: "never"` turns it off entirely.

### Added

`@libtmux/workspace` exports `planWorkspace`, which reads the server once and
answers what an apply would create, rename, kill, and deliberately leave alone.

## 0.1.0-alpha.1

No entries for `@libtmux/workspace`.

## 0.0.1-alpha.7

No entries for `@libtmux/workspace`.

## 0.0.1-alpha.6

No entries for `@libtmux/workspace`.

## 0.0.1-alpha.5

No entries for `@libtmux/workspace`.
