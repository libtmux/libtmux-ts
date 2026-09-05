# AGENTS.md

Rules for `@libtmux/mcp`, which serves one tmux server to Model Context
Protocol clients. The repository-wide rules are in [AGENTS.md](../../AGENTS.md)
and the files it routes to; this adds only what applies here.

## Four facts hold the design up

Each was read out of tmux's source or found by running the thing, and each is
expensive to rediscover.

**Output notifications are session-scoped.** `control_write_output` in
`control.c` returns early unless the pane's window is linked into the control
client's own session, so one connection cannot tail a whole server. Structural
notifications — `%pane-mode-changed`, `%sessions-changed` — are global;
`%output` is not. That is why `LiveHub` keys connections by session and opens
one only for a session something is watching.

**Attaching a control client does not resize anything.** `ignore_client_size`
in `resize.c` skips a control client that has not set `CLIENT_SIZECHANGED` or
`CLIENT_WINDOWSIZECHANGED`, which only `refresh-client -C` does. Nothing here
sends it. Send it and every persistent connection starts shrinking the panes of
whoever is attached.

**An error result must carry no `structuredContent`.** A client validates that
field against the tool's `outputSchema` whether or not `isError` is set, so a
failure with its own diagnostic shape is rejected as a protocol violation and
the model never reads the reason. `fail()` returns text alone for this.

**`run_shell_command`'s framing is POSIX shell and nothing else.** A
marker-free wrapper prints an exact readiness line before reading the marker as
terminal input. It suspends Bash and zsh debug traps while the marker exists,
validates the marker, and restores shell state only after removing it from the
command subshell. fish, csh, and PowerShell do not share that grammar, so the
tool refuses them even with `force`. The marker is framing, not confinement:
code with the tmux socket's authority can inspect the pane.

## Cancellation

Every wait takes the request's `AbortSignal` and stops on it. Without that a
cancelled call keeps its loop and its connection for the rest of a deadline
nobody is waiting on, which is why the gate for it is a unit test on
`PaneTail.changed` rather than a tool call.

## Two ways to read a pane, and they differ

`capture_since` reports the byte stream in write order and cannot resolve
cursor addressing. `capture_pane` reads tmux's rendered grid. They are not two
ways to read one thing, and the tool descriptions say so.

## Public surface boundary

The MCP is a curated, semantic surface for detached-safe operations, not a
one-to-one wrapper around libtmux. Library parity does not imply MCP parity;
retain useful core APIs even when they have no public MCP route.

Keep modal, human-client UX out when a noninteractive equivalent exists. This
includes copy and clock modes, choose-tree, command prompts, menus, popups, and
mouse gestures. Use `capture_pane` for the rendered grid and history,
`search_panes` for discovery, `snapshot_pane` for content and reported mode, and
`capture_since` for cursor-based observation. Report a human-owned mode instead
of entering or cancelling it.

Paired cleanup, unclear ownership, or dependence on a key table, mouse,
clipboard, attachment, or timing are signals to exclude a route from MCP. Core
library APIs remain available to explicit programmatic clients.

Every public tool belongs to exactly one ADR toolset. The manifest owns its
runtime registration, schemas, capability report, documentation, and tests.
