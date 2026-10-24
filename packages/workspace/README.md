<!-- libtmux-logo -->
<div align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/libtmux/libtmux-ts/HEAD/packages/workspace/assets/logo.svg" type="image/svg+xml">
    <img src="https://raw.githubusercontent.com/libtmux/libtmux-ts/HEAD/packages/workspace/assets/logo.png" width="128" height="128" alt="libtmux for TypeScript workspace">
  </picture>
</div>
<!-- /libtmux-logo -->

<div align="center">

# @libtmux/workspace

**Describe a tmux session as data; apply it. Applying twice converges rather
than duplicating.**

[API reference](https://libtmux.org/en/ts/latest/workspace/reference/) •
[Guide](https://libtmux.org/en/ts/latest/workspace/internals/guides/) •
[npm](https://www.npmjs.com/package/@libtmux/workspace)

[![npm](https://img.shields.io/npm/v/@libtmux/workspace?color=cb3837)](https://www.npmjs.com/package/@libtmux/workspace)
[![downloads](https://img.shields.io/npm/dm/@libtmux/workspace?color=cb3837)](https://www.npmjs.com/package/@libtmux/workspace)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.3a%E2%80%933.8-1bb91f)](../../.github/workflows/typescript.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

Part of [libtmux for Bun and TypeScript](https://github.com/libtmux/libtmux-ts#readme). Built on
[`libtmux`](https://github.com/libtmux/libtmux-ts/tree/master/packages/libtmux).

> [!WARNING]
> **Alpha.** Prerelease software: the config shape and the exported functions
> can change between alpha releases without a deprecation cycle. Pin an exact
> version.

This repository's README checks compile each `ts` example on this page and run
it against a real tmux server. The CLI package's README test runs the
[`tmux-workspace`][cli-tmux-workspace] command.

## Quick start

Install the package with `libtmux`, which supplies the [`Server`][ref-server]
you pass to every call:

```console
$ bun add --exact @libtmux/workspace@0.1.0-alpha.15 libtmux@0.1.0-alpha.15
```

<details>
<summary>npm, pnpm, yarn</summary>

```console
$ npm i --save-exact @libtmux/workspace@0.1.0-alpha.15 libtmux@0.1.0-alpha.15
```

```console
$ pnpm add --save-exact @libtmux/workspace@0.1.0-alpha.15 libtmux@0.1.0-alpha.15
```

```console
$ yarn add --exact @libtmux/workspace@0.1.0-alpha.15 libtmux@0.1.0-alpha.15
```

</details>

Requires Node 22+ or [Bun](https://bun.sh) 1.3.14+, and tmux 3.3a or newer.

Runs on Linux, including WSL. macOS is supported on a best-effort basis,
and CI coverage for it is highly limited.

This builds a session called `api` with two windows, or converges it when it
already exists:

```ts
import { Server } from "libtmux";
import { applyWorkspace } from "@libtmux/workspace";

const server = new Server();

await applyWorkspace(server, {
  session_name: "api",
  windows: [
    { window_name: "editor", panes: ["vim", "git status"] },
    {
      window_name: "server",
      layout: "even-horizontal",
      panes: [{ shell_command: "bun dev", focus: true }, "bun test --watch"],
    },
  ],
});
```

[`applyWorkspace`][wsref-applyworkspace] resolves to the
[`Session`][ref-session] it built or converged. Run it again and nothing is
duplicated.

The session stays on tmux's default socket. Remove it with
`tmux kill-session -t =api`.

## Describe a session

A workspace is plain data in [tmuxp](https://tmuxp.git-pull.com/)'s shape, so
the field names are the ones people already know. This package reads these:

| Field                  | On                      | Effect                                          |
| ---------------------- | ----------------------- | ----------------------------------------------- |
| `session_name`         | workspace               | The session to build or converge                |
| `start_directory`      | workspace, window, pane | Working directory, inherited downward           |
| `options`              | workspace, window       | String, finite number, or boolean tmux values   |
| `window_name`          | window                  | Renamed if it differs                           |
| `layout`               | window                  | Applied once the pane count settles             |
| `panes`                | window                  | A string is shorthand for `{ shell_command }`   |
| `shell_command`        | pane                    | One command or a list, sent in order            |
| `shell_command_before` | window                  | Run in every pane of the window, before its own |
| `focus`                | window, pane            | Selected last, so the final one wins            |

- [`WorkspaceInput`][wsref-workspaceinput] is the type
  [`applyWorkspace`][wsref-applyworkspace] accepts.
  [`Workspace`][wsref-workspace] is the same data after validation.
- `start_directory` resolves pane, then window, then workspace, as
  [`paneStartDirectory`][wsref-panestartdirectory] and
  [`windowStartDirectory`][wsref-windowstartdirectory] do.
- The first pane tmux creates with the session follows the same order
  ([`initialPaneStartDirectory`][wsref-initialpanestartdirectory]).

### [`parseWorkspace`][wsref-parseworkspace]: validate data you already have

The config is data, so it can come from a YAML file, an HTTP request, or a
literal. `parseWorkspace` validates one you already parsed and returns a
`Workspace`.

- An unknown key throws a `ZodError` instead of being dropped.
- A window without `panes` comes back with one empty pane.
- Import it, and [`parseWorkspaceYaml`][wsref-parseworkspaceyaml], from
  `@libtmux/workspace/config`.

### [`parseWorkspaceYaml`][wsref-parseworkspaceyaml]: read a YAML document

It parses a YAML or JSON document with Bun's YAML parser, then validates the
result. Under Node it throws and says so: parse the document yourself and pass
the object to `parseWorkspace`.

## Apply it

### [`applyWorkspace`][wsref-applyworkspace]: build or converge a session

It takes a [`Server`][ref-server], a workspace, and optional
[`ApplyWorkspaceOptions`][wsref-applyworkspaceoptions], and resolves to a
[`Session`][ref-session]. The quick start above is this call.

It creates the session when none has that name and converges the one that
exists. Two details make a second apply safe:

- **No stray leading window.** tmux gives every new session a window and every
  new window a pane, so the first of each is adopted, not created. Creating them
  anyway is the classic workspace-builder bug.
- **Position, not index.** `base-index` shifts tmux window indexes and a killed
  window leaves a gap, so a window is matched by ordinal.

### [`commands`][wsref-applyworkspaceoptions-commands]: choose which panes run commands

The [`CommandPolicy`][wsref-commandpolicy] decides when `shell_command` and
`shell_command_before` are sent.

- `"create-only"`, the default, sends them only to panes this apply created.
- [`{ commands: "always" }`][wsref-applyworkspaceoptions-commands] sends them
  to every pane on every apply. Use it only for commands safe to repeat.
- Full contract: [command policy](docs/contracts.md#command-policy) and the
  [builder topic][topic-workspace-commands].

### [`WorkspaceOptionValue`][wsref-workspaceoptionvalue]: set tmux options

`options` takes string, finite number, or boolean values on the workspace and on
each window.

- Options named in the workspace are set on every apply.
- Removing an option from the file does not unset it: tmux does not record which
  current value the workspace owns.
- `@libtmux-workspace` is reserved for ownership bookkeeping and is rejected in
  workspace options. Option names are literal.
- Full contract: [option ownership](docs/contracts.md#option-ownership).

### [`Server.validateLayouts`][ref-server-validatelayouts]: layouts are checked first

`applyWorkspace` checks every window `layout` before it claims a session or
changes options, so a bad layout throws before tmux changes.

- Names accept unique abbreviations the running daemon supports. A classic
  layout needs a valid checksum.
- Classic and JSON layouts need a nonempty tree and enough pane cells. JSON
  layouts need tmux 3.8 or newer.
- A window that names no layout, or names the empty string, comes up tiled. A
  declared layout is applied last and has the final say.
- Full contract: [layout validation](docs/contracts.md#layout-validation).

## Remove what you no longer declare

An apply removes surplus windows and panes only from a session this package
created. Surplus is whatever the workspace no longer describes.

### [`prune`][wsref-applyworkspaceoptions-prune]: choose what an apply may remove

`prune` takes a [`PrunePolicy`][wsref-prunepolicy].

- `"owned"`, the default, removes surplus only from a session this package
  created.
- `"never"` removes nothing.

`"always"` authorizes this one plan or apply to remove surplus from a session
the workspace did not create:

```ts
await applyWorkspace(
  server,
  { session_name: "api", windows: [{ panes: ["vim"] }] },
  { prune: "always" },
);
```

`"always"` does not claim the session or stamp persistent ownership. A later
apply using the default `"owned"` policy leaves new surplus alone.

### [`ownedByWorkspace`][wsref-ownedbyworkspace]: what counts as built by this package

- A name does not show ownership: `dev` in this file and `dev` you started by
  hand are the same name.
- A session this package creates is stamped with a tmux user option
  ([`claimSession`][wsref-claimsession]).
- Surplus is removed only from a stamped session. Against one it merely found,
  applying converges additively and leaves the rest alone.
- Full contract:
  [pruning and ownership](docs/contracts.md#pruning-and-ownership) and the
  [builder topic][topic-workspace-ownership].

### [`WorkspaceRetention`][wsref-workspaceretention]: what a prune keeps

Pruning follows tmux's sharing model.

- An independently linked surplus window is unlinked only from this session.
- A grouped session shares one window list, so its surplus windows are retained.
- Surplus panes are retained when their window has another placement, because
  killing a pane changes every placement.
- Full contract: [pruning and sharing](docs/contracts.md#pruning-and-sharing).

## Ask before applying

### [`planWorkspace`][wsref-planworkspace]: see what would be removed

It reads the server once and changes nothing. It answers the question a
converging tool cannot answer afterwards, and returns a
[`WorkspacePlan`][wsref-workspaceplan]:

```ts
import { planWorkspace } from "@libtmux/workspace";

const desired = { session_name: "api", windows: [{ panes: ["vim"] }] };
const plan = await planWorkspace(server, desired);
plan.owned; // false for a session this workspace did not create
plan.removesWindows; // ID-keyed kill or unlink actions
plan.removesPanes; // exact pane IDs, grouped by their window placement
plan.renamesWindows; // an array, so duplicate current names stay distinct
plan.retains; // surplus plus the policy or sharing reason
```

The removals are in [`removesWindows`][wsref-workspaceplan-removeswindows] and
[`removesPanes`][wsref-workspaceplan-removespanes];
[`renamesWindows`][wsref-workspaceplan-renameswindows] lists the renames.
[`retains`][wsref-workspaceplan-retains] says what stays and why, and
[`owned`][wsref-workspaceplan-owned] says whether this package created the
session.

[`createsSession`][wsref-workspaceplan-createssession],
[`createsWindows`][wsref-workspaceplan-createswindows] and
[`createsPanes`][wsref-workspaceplan-createspanes] report what an apply would
add.

- Entries are frozen data carrying tmux IDs, indexes, positions, and names.
- The plan covers session, window, and pane membership, not options, layouts,
  focus, or pane commands.
- It is advisory: acquire a fresh one after any delay or failed apply.
- Planning accepts [`prune`][wsref-planworkspaceoptions-prune]; command policy
  is apply-only.
- Full contract: [plan scope](docs/contracts.md#plan-scope) and the
  [builder topic][topic-workspace-plans].

## Handle a failed apply

### [`WorkspaceApplyError`][wsref-workspaceapplyerror]: when tmux refuses a step

If tmux rejects an operation after an apply has started,
[`applyWorkspace`][wsref-applyworkspace] throws it.

A workspace that fails the schema throws `ZodError`, and a bad option throws
`TypeError`. Both happen before tmux changes.

- [`completed`][wsref-workspaceapplyerror-completed] is a frozen list of
  [milestones][wsref-workspaceapplymilestone]: the high-level work that
  finished.
- [`failed`][wsref-workspaceapplyerror-failed] names the
  [stage][wsref-workspaceapplystage] that stopped. `cause` keeps the original
  error.
- [`requiresReplan`][wsref-workspaceapplyerror-requiresreplan] is always `true`:
  rediscover tmux structure before deciding what to do next.

```ts
import { WorkspaceApplyError, applyWorkspace } from "@libtmux/workspace";

try {
  await applyWorkspace(server, { session_name: "api", windows: [{ panes: ["vim"] }] });
} catch (error) {
  if (!(error instanceof WorkspaceApplyError)) throw error;
  error.completed; // frozen milestones for the work that finished
  error.failed; // the stage that stopped
  error.cause; // the original error
  error.requiresReplan; // always true: plan again before retrying
}
```

- It does not report whether pane commands ran. Mutations are not
  transactions, and transport failure may leave delivery indeterminate.
- Full contract: [failed applies](docs/contracts.md#failed-applies) and the
  [builder topic][topic-workspace-plans].

### [`signal`][wsref-applyworkspaceoptions-signal]: abandon an apply

Pass `signal` in the options to abandon an apply when it fires. A build already
begun is not rolled back. Planning changes nothing, so there is nothing to
unwind.

## Load a file from the shell

A YAML file loads without code through [`tmux-workspace`][cli-tmux-workspace],
the command in
[`@libtmux/workspace-cli`](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace-cli).

### [`tmux-workspace load`][cli-load]: build a YAML file from the shell

Save this document as `workspace.yaml`:

```yaml
session_name: api
windows:
  - window_name: editor
    panes:
      - vim
      - git status
  - window_name: server
    layout: even-horizontal
    panes:
      - bun dev
      - bun test --watch
```

Load it detached, on a socket of its own:

```console
$ npx -y @libtmux/workspace-cli@0.1.0-alpha.15 load ./workspace.yaml \
    -L workspace-demo \
    -d
```

- The command compares a session that already exists against the document
  instead of converging it.
- Its [README](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace-cli#readme)
  lists what else differs.
- The command reads a wider document than this package. Its fields are
  [session][cli-config-session], [windows][cli-config-windows],
  [panes][cli-config-panes], [commands][cli-config-commands],
  [environment][cli-config-environment], [directories][cli-config-directories]
  and [layouts][cli-config-layouts].
- To go the other way, [`freeze`][cli-freeze] captures a running session as a
  document.
- Full contract: [library and CLI](docs/contracts.md#library-and-cli).

## Run the worked example

[`examples/workspace/workspace.ts`](../../examples/workspace/workspace.ts)
builds a declared workspace with [`applyWorkspace`][wsref-applyworkspace] and
tears it down while treating "already gone" as an answer. The integration suite
runs it against a real tmux server.

To run it from a checkout of the repository:

```console
$ bun test examples/workspace
```

## What it leaves out

- **Process supervision.** It converges tmux topology. It does not monitor or
  restart processes.
- **Unsetting options.** Removing an option from the file does not unset it,
  because tmux does not record which current value the workspace owns.
- **Locking.** Two [`applyWorkspace`][wsref-applyworkspace] calls racing on the
  same session name are not coordinated. Serialize calls that target the same
  name ([racing applies](docs/contracts.md#racing-applies)).
- **Rollback.** An apply is not a transaction. A failed one leaves what it
  already did.
- **CLI-only fields.** The schema is strict, so `environment`,
  `before_script`, `window_index`, `suppress_history`, `x-` keys and the CLI's
  other fields are rejected. A file written for the CLI is not necessarily one
  this accepts.
- **Pruning sessions it did not create.** Only `prune: "always"` does, for one
  call.

## Support and status

- **Runtime.** Node 22+ or Bun 1.3.14+.
  [`parseWorkspaceYaml`][wsref-parseworkspaceyaml] needs Bun's YAML parser.
- **tmux.** 3.3a or newer. JSON layouts need 3.8 or newer.
- **Dependencies.** `zod` at runtime. `libtmux` is a peer dependency pinned to
  the same alpha release.
- **Releases.** Alpha. Pin an exact version; the config shape and the exported
  functions can change between alpha releases.

## See also

- [Reference][wsref-index]: every exported identifier, one page each.
- [Guide][guide-workspace-internals]: use the workspace builder, step by step.
- [Builder topics][topic-workspace-builder]: ownership, commands, plans and
  failures.
- [`docs/contracts.md`](docs/contracts.md): the full contracts behind the rules
  above.
- [Workspaces][concept-workspaces]: build one imperatively or declaratively.
- [`@libtmux/workspace-cli`](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace-cli):
  the [`tmux-workspace`][cli-tmux-workspace] command.
- [`libtmux`](https://github.com/libtmux/libtmux-ts/tree/master/packages/libtmux):
  the library this builds on.

## License

[MIT](LICENSE)

[cli-config-commands]: https://libtmux.org/en/ts/latest/workspace/configuration/commands/
[cli-config-directories]: https://libtmux.org/en/ts/latest/workspace/configuration/directories/
[cli-config-environment]: https://libtmux.org/en/ts/latest/workspace/configuration/environment/
[cli-config-layouts]: https://libtmux.org/en/ts/latest/workspace/configuration/layouts/
[cli-config-panes]: https://libtmux.org/en/ts/latest/workspace/configuration/panes/
[cli-config-session]: https://libtmux.org/en/ts/latest/workspace/configuration/session/
[cli-config-windows]: https://libtmux.org/en/ts/latest/workspace/configuration/windows/
[cli-freeze]: https://libtmux.org/en/ts/latest/workspace/cli/freeze/
[cli-load]: https://libtmux.org/en/ts/latest/workspace/cli/load/
[cli-tmux-workspace]: https://libtmux.org/en/ts/latest/workspace/cli/
[concept-workspaces]: https://libtmux.org/en/ts/latest/concepts/workspaces/
[guide-workspace-internals]: https://libtmux.org/en/ts/latest/workspace/internals/guides/
[ref-server]: https://libtmux.org/en/ts/latest/reference/server-server/
[ref-server-validatelayouts]: https://libtmux.org/en/ts/latest/reference/server-server-validatelayouts/
[ref-session]: https://libtmux.org/en/ts/latest/reference/session-session/
[topic-workspace-builder]: https://libtmux.org/en/ts/latest/workspace/internals/topics/
[topic-workspace-commands]: https://libtmux.org/en/ts/latest/workspace/internals/topics/#commands-and-options
[topic-workspace-ownership]: https://libtmux.org/en/ts/latest/workspace/internals/topics/#ownership-and-shared-objects
[topic-workspace-plans]: https://libtmux.org/en/ts/latest/workspace/internals/topics/#plans-and-failures
[wsref-applyworkspace]: https://libtmux.org/en/ts/latest/workspace/reference/builder-applyworkspace/
[wsref-applyworkspaceoptions]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-applyworkspaceoptions/
[wsref-applyworkspaceoptions-commands]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-applyworkspaceoptions-commands/
[wsref-applyworkspaceoptions-prune]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-applyworkspaceoptions-prune/
[wsref-applyworkspaceoptions-signal]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-applyworkspaceoptions-signal/
[wsref-claimsession]: https://libtmux.org/en/ts/latest/workspace/reference/ownership-claimsession/
[wsref-commandpolicy]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-commandpolicy/
[wsref-index]: https://libtmux.org/en/ts/latest/workspace/reference/
[wsref-initialpanestartdirectory]: https://libtmux.org/en/ts/latest/workspace/reference/config-initialpanestartdirectory/
[wsref-ownedbyworkspace]: https://libtmux.org/en/ts/latest/workspace/reference/ownership-ownedbyworkspace/
[wsref-panestartdirectory]: https://libtmux.org/en/ts/latest/workspace/reference/config-panestartdirectory/
[wsref-parseworkspace]: https://libtmux.org/en/ts/latest/workspace/reference/config-parseworkspace/
[wsref-parseworkspaceyaml]: https://libtmux.org/en/ts/latest/workspace/reference/config-parseworkspaceyaml/
[wsref-planworkspace]: https://libtmux.org/en/ts/latest/workspace/reference/builder-planworkspace/
[wsref-planworkspaceoptions-prune]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-planworkspaceoptions-prune/
[wsref-prunepolicy]: https://libtmux.org/en/ts/latest/workspace/reference/ownership-prunepolicy/
[wsref-windowstartdirectory]: https://libtmux.org/en/ts/latest/workspace/reference/config-windowstartdirectory/
[wsref-workspace]: https://libtmux.org/en/ts/latest/workspace/reference/config-workspace/
[wsref-workspaceapplyerror]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplyerror/
[wsref-workspaceapplyerror-completed]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplyerror-completed/
[wsref-workspaceapplyerror-failed]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplyerror-failed/
[wsref-workspaceapplyerror-requiresreplan]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplyerror-requiresreplan/
[wsref-workspaceapplymilestone]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplymilestone/
[wsref-workspaceapplystage]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplystage/
[wsref-workspaceinput]: https://libtmux.org/en/ts/latest/workspace/reference/config-workspaceinput/
[wsref-workspaceoptionvalue]: https://libtmux.org/en/ts/latest/workspace/reference/config-workspaceoptionvalue/
[wsref-workspaceplan]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan/
[wsref-workspaceplan-createspanes]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan-createspanes/
[wsref-workspaceplan-createssession]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan-createssession/
[wsref-workspaceplan-createswindows]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan-createswindows/
[wsref-workspaceplan-owned]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan-owned/
[wsref-workspaceplan-removespanes]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan-removespanes/
[wsref-workspaceplan-removeswindows]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan-removeswindows/
[wsref-workspaceplan-renameswindows]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan-renameswindows/
[wsref-workspaceplan-retains]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan-retains/
[wsref-workspaceretention]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceretention/
