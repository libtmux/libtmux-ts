# Workspace contracts

The full text of the rules the [package README](../README.md) summarizes, one
section per topic. The README links to the matching section from each rule.

[Command policy](#command-policy) · [Option ownership](#option-ownership) ·
[Layout validation](#layout-validation) ·
[Pruning and ownership](#pruning-and-ownership) ·
[Pruning and sharing](#pruning-and-sharing) · [Plan scope](#plan-scope) ·
[Failed applies](#failed-applies) · [Racing applies](#racing-applies) ·
[Library and CLI](#library-and-cli)

## Command policy

Commands use `create-only` policy by default: `shell_command` and
`shell_command_before` run only in panes this apply created.

Pass [`{ commands: "always" }`][wsref-applyworkspaceoptions-commands] only for
commands that are safe to repeat.

This package converges tmux topology; it does not monitor or restart processes.

The [builder topic][topic-workspace-commands] on libtmux.org states the same
policy for [`CommandPolicy`][wsref-commandpolicy].

## Option ownership

Options named in the workspace are set on every apply. Removing an option from
the file does not unset it because tmux does not record which current value the
workspace owns.

`@libtmux-workspace` is reserved for ownership bookkeeping and is rejected in
workspace options. Option names are literal; tmux format syntax in a key is not
expanded.

## Layout validation

[`applyWorkspace`][wsref-applyworkspace] validates every window layout before
claiming a session or changing options.

Names accept unique abbreviations supported by the running daemon; classic
layouts require a valid checksum. Classic and JSON layouts require a nonempty
tree and enough pane cells; JSON requires tmux 3.8 or newer.

A window is rebalanced between splits, because halving one pane in turn runs out
of room by the fifth at a default 80x24, so a window that names no layout — or
names the empty string — comes up tiled.

A declared layout is applied last and has the final say. tmux remains
responsible for geometry and pruning.

The library limits custom layouts to 8192 characters and classic layouts to 256
nested groups. JSON layouts share tmux's limit of 200 nested objects.

The check is [`Server.validateLayouts`][ref-server-validatelayouts].

## Pruning and ownership

**It prunes what it built, not what it found.** A session name is a lookup, not
a claim: `dev` in this file and `dev` you started by hand are the same name.

So a session this package creates is stamped with a tmux user option
([`claimSession`][wsref-claimsession]), and surplus windows and panes are
removed only from a session carrying that stamp
([`ownedByWorkspace`][wsref-ownedbyworkspace]).

Against one it merely found, applying converges additively and leaves the rest
alone.

[`prune`][wsref-applyworkspaceoptions-prune] decides the rest. `"owned"` is the
default; `"never"` removes nothing; `"always"` authorizes this one plan or apply
to remove surplus from a session the workspace did not create.

`"always"` does not claim the session or stamp persistent ownership. A later
apply using the default `"owned"` policy leaves new surplus alone.

The [builder topic][topic-workspace-ownership] on libtmux.org states the same
policy.

## Pruning and sharing

Pruning follows tmux's sharing model. An independently linked surplus window is
unlinked only from this session. A grouped session shares one window list, so
its surplus windows are retained.

Surplus panes are also retained when their window has another placement because
killing a pane changes every placement.

## Plan scope

[`planWorkspace`][wsref-planworkspace] returns a
[`WorkspacePlan`][wsref-workspaceplan]. Its entries are frozen data carrying
tmux IDs, indexes, positions, and names.

The plan covers session, window, and pane membership, not options, layouts,
focus, or pane commands. It is advisory: acquire a fresh one after any delay or
failed apply because tmux structure may have changed.

Planning accepts `prune`; command policy is apply-only.

## Failed applies

If tmux rejects a later operation, `applyWorkspace` throws
[`WorkspaceApplyError`][wsref-workspaceapplyerror]. Its frozen
[`completed`][wsref-workspaceapplyerror-completed] milestones name the
high-level work that finished,
[`failed`][wsref-workspaceapplyerror-failed] names the stage that stopped, and
`cause` retains the original error.

[`requiresReplan`][wsref-workspaceapplyerror-requiresreplan] is always true:
callers must rediscover tmux structure before deciding what to do next.

It does not report whether pane commands ran; mutations are not transactions,
and transport failure may leave delivery indeterminate.

## Racing applies

Two `applyWorkspace` calls racing on the same session name are not coordinated:
tmux offers no lock on a session that does not exist yet, so either can observe
no session and both attempt to create one, or one apply's converge can run
against a session mid-build by the other.

Serialize calls that target the same name.

## Library and CLI

This package and
[`@libtmux/workspace-cli`](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace-cli)
are two implementations, not one product with two faces.

They differ in what they do with a session that already exists — this one
converges it, the CLI compares it against the document and refuses when they
disagree — and in what a document may say.

The schema here is strict, so `environment`, `before_script`, `window_index`,
`suppress_history`, `x-` keys and the CLI's other fields are rejected. A file
written for the CLI is not necessarily one this accepts.

The command compares a session that already exists against the document instead
of converging it. Its
[README](https://github.com/libtmux/libtmux-ts/tree/master/packages/workspace-cli#readme)
lists what else differs.

[ref-server-validatelayouts]: https://libtmux.org/en/ts/latest/reference/server-server-validatelayouts/
[topic-workspace-commands]: https://libtmux.org/en/ts/latest/workspace/internals/topics/#commands-and-options
[topic-workspace-ownership]: https://libtmux.org/en/ts/latest/workspace/internals/topics/#ownership-and-shared-objects
[wsref-applyworkspace]: https://libtmux.org/en/ts/latest/workspace/reference/builder-applyworkspace/
[wsref-applyworkspaceoptions-commands]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-applyworkspaceoptions-commands/
[wsref-applyworkspaceoptions-prune]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-applyworkspaceoptions-prune/
[wsref-claimsession]: https://libtmux.org/en/ts/latest/workspace/reference/ownership-claimsession/
[wsref-commandpolicy]: https://libtmux.org/en/ts/latest/workspace/reference/operation_options-commandpolicy/
[wsref-ownedbyworkspace]: https://libtmux.org/en/ts/latest/workspace/reference/ownership-ownedbyworkspace/
[wsref-planworkspace]: https://libtmux.org/en/ts/latest/workspace/reference/builder-planworkspace/
[wsref-workspaceapplyerror]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplyerror/
[wsref-workspaceapplyerror-completed]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplyerror-completed/
[wsref-workspaceapplyerror-failed]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplyerror-failed/
[wsref-workspaceapplyerror-requiresreplan]: https://libtmux.org/en/ts/latest/workspace/reference/builder-workspaceapplyerror-requiresreplan/
[wsref-workspaceplan]: https://libtmux.org/en/ts/latest/workspace/reference/planning-workspaceplan/
