# @libtmux/workspace

**Describe a tmux session as data; apply it. Applying twice converges rather
than duplicating.**

[![npm](https://img.shields.io/npm/v/@libtmux/workspace?color=cb3837)](https://www.npmjs.com/package/@libtmux/workspace)
[![downloads](https://img.shields.io/npm/dm/@libtmux/workspace?color=cb3837)](https://www.npmjs.com/package/@libtmux/workspace)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.2a%E2%80%933.7c-1bb91f)](../../.github/workflows/typescript.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Part of [libtmux for Bun and TypeScript](../../README.md). Built on
[`libtmux`](../libtmux).

> [!WARNING]
> **Alpha.** Prerelease software: the config shape and the exported functions
> can change between alpha releases without a deprecation cycle. Pin an exact
> version.

## Install

```console
$ bun add --exact @libtmux/workspace@0.1.0-alpha.6 libtmux@0.1.0-alpha.6
```

<details>
<summary>npm, pnpm, yarn</summary>

```console
$ npm i --save-exact @libtmux/workspace@0.1.0-alpha.6 libtmux@0.1.0-alpha.6
```

```console
$ pnpm add --save-exact @libtmux/workspace@0.1.0-alpha.6 libtmux@0.1.0-alpha.6
```

```console
$ yarn add --exact @libtmux/workspace@0.1.0-alpha.6 libtmux@0.1.0-alpha.6
```

</details>

`libtmux` is a peer of this package in practice: you pass it the `Server`.
Requires Node 22+ or [Bun](https://bun.sh) 1.3.14+, and tmux 3.2a or newer.

Linux is the only supported host for real tmux control. The macOS CI lane
checks package artifacts without exercising tmux; macOS runtime behavior is
unproven. WSL is untested.

## Use it

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

`applyWorkspace` resolves to the `Session` it built or converged.

Commands use `create-only` policy by default: `shell_command` and
`shell_command_before` run only in panes this apply created. Pass
`{ commands: "always" }` only for commands that are safe to repeat. This
package converges tmux topology; it does not monitor or restart processes.

Options named in the workspace are set on every apply. Removing an option from
the file does not unset it because tmux does not record which current value the
workspace owns. `@libtmux-workspace` is reserved for ownership bookkeeping and
is rejected in workspace options. Option names are literal; tmux format syntax
in a key is not expanded.

If tmux rejects a later operation, `applyWorkspace` throws
`WorkspaceApplyError`. Its frozen `completed` milestones name the high-level
work that finished, `failed` names the stage that stopped, and `cause` retains
the original error. `requiresReplan` is always true: callers must rediscover
tmux structure before deciding what to do next. It does not report whether pane
commands ran; mutations are not transactions, and transport failure may leave
delivery indeterminate.

## The shape

Config is [tmuxp](https://tmuxp.git-pull.com/)-shaped, so the field names are
the ones people already know — `session_name`, `windows`, `panes`,
`shell_command`, `shell_command_before`, `start_directory`, `layout`, `focus`,
`options`.

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

Because the config is data, it can come from a YAML file, an HTTP request, or a
literal. `parseWorkspace` validates one you already parsed; `parseWorkspaceYaml`
is a convenience that needs Bun's YAML parser and says so when it is missing.

`start_directory` resolves pane, then window, then workspace. The same order
applies to the first pane tmux creates with the session.

## Converging, not just creating

Two details that are easy to get wrong and are handled here:

**No stray leading window.** tmux gives every new session a window and every new
window a pane, so the first of each is adopted rather than created. Creating
them anyway is the classic workspace-builder bug.

**Position, not index.** tmux window indexes are not positions — `base-index`
shifts them and a killed window leaves a gap — so a window is matched by
ordinal.

**It prunes what it built, not what it found.** A session name is a lookup, not
a claim: `dev` in this file and `dev` you started by hand are the same name. So
a session this package creates is stamped with a tmux user option, and surplus
windows and panes are removed only from a session carrying that stamp. Against
one it merely found, applying converges additively and leaves the rest alone.

Pruning follows tmux's sharing model. An independently linked surplus window is
unlinked only from this session. A grouped session shares one window list, so
its surplus windows are retained. Surplus panes are also retained when their
window has another placement because killing a pane changes every placement.

Ask before applying, which is the question a converging tool cannot answer
afterwards:

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

Plan entries are frozen data carrying tmux IDs, indexes, positions, and names.
The plan covers session, window, and pane membership, not options, layouts,
focus, or pane commands. It is advisory: acquire a fresh one after any delay or
failed apply because tmux structure may have changed.
Planning accepts `prune`; command policy is apply-only.

`prune` decides the rest. `"owned"` is the default above; `"never"` never
removes anything; `"always"` is how you say a session somebody else made is now
this file's, at the call site rather than in a comment:

```ts
await applyWorkspace(
  server,
  { session_name: "api", windows: [{ panes: ["vim"] }] },
  { prune: "always" },
);
```

## A worked example

[`examples/workspace/workspace.ts`](../../examples/workspace/workspace.ts) calls
`applyWorkspace` with a declared layout, inspects the resulting session, and
tears it down while treating "already gone" as an answer. The integration suite
runs it against a real tmux server.

## License

[MIT](LICENSE)
