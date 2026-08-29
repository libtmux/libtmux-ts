# AGENTS.md

Rules for `@libtmux/mcp`, which serves one tmux server to Model Context
Protocol clients. The repository-wide rules are in [AGENTS.md](../../AGENTS.md)
and the files it routes to; this adds only what applies here.

## Five facts hold the design up

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

**`run_command`'s framing is POSIX shell and nothing else.** It calls a
short-lived, argument-free shell function inside a subshell. The marker stays
in that outer scope; the command subshell unsets it and clears its positional
parameters before evaluating the command. The wrapper disables inherited
tracing and errexit while it handles the marker, then restores both in the
marker-free command subshell. fish, csh, and PowerShell do not share that
grammar. The tool refuses a shell it cannot address rather than letting the
wait run out against a syntax error — and `force` does not override that one,
because forcing it cannot work. The marker is framing, not confinement: code
with the tmux socket's authority can inspect the pane.

**Two wait ceilings, not one.** A blocking wait spends the agent's turn, so it
is held low. As an MCP task it hands back a handle at once, so it may run as long
as the work does. Both paths accept request cancellation. `taskSupport` is
`optional`, so a client without tasks gets the SDK's polling fallback. Keep the
task's `pollInterval` low because it is added latency on that path.

## Cancellation

Every wait takes the request's `AbortSignal` and stops on it. Without that a
cancelled call keeps its loop and its connection for the rest of a deadline
nobody is waiting on, which is why the gate for it is a unit test on
`PaneTail.changed` rather than a tool call.

## Two ways to read a pane, and they differ

`observe` reports the byte stream in write order and cannot resolve cursor
addressing. `capture_pane` reads tmux's rendered grid. They are not two ways to
read one thing, and the tool descriptions say so.
