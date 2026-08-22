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

**`run_command`'s framing is POSIX shell and nothing else.** It sends
`m=id; printf …; ( … ); s=$?`; fish rejects the assignment and csh spells the
status `$status`. The tool refuses a shell it cannot address rather than
letting the wait run out against a syntax error — and `force` does not override
that one, because forcing it cannot work. The echo trap is worth knowing: the
command carries `${m}_S` and the shell prints `<id>_S`, so the two are equal
only after expansion. The literal never appears in what was typed, and a match
on it is always the printed one.

**Two wait ceilings, not one.** A blocking wait spends the agent's turn and
cannot be cancelled mid-flight, so it is held low. As an MCP task it hands back
a handle at once and can be cancelled, so it may run as long as the work does.
`taskSupport` is `optional`, which is what makes shipping tasks safe rather
than a compatibility break — a client that does not speak tasks has the SDK
poll on its behalf. Keep the task's `pollInterval` low, because it is the added
latency of that path.

## Cancellation

Every wait takes the request's `AbortSignal` and stops on it. Without that a
cancelled call keeps its loop and its connection for the rest of a deadline
nobody is waiting on, which is why the gate for it is a unit test on
`PaneTail.changed` rather than a tool call.

## Two ways to read a pane, and they differ

`observe` reports the byte stream in write order and cannot resolve cursor
addressing. `capture_pane` reads tmux's rendered grid. They are not two ways to
read one thing, and the tool descriptions say so.
