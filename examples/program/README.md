# Program

Run a program in tmux and read only what it printed.

Reach for this when you want a program's output and exit status and it does not
need an existing shell: nothing is typed, so there is no command line or echo
to strip, and the program still gets a real terminal.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/program
```

The test drives each function against a real tmux server the suite starts on a
socket of its own. Requires tmux 3.8 or newer; below it the test checks that
the library refuses.

## What it shows

`server.run` is the one-call form: by default the program runs in a detached
session of its own, gone when the call returns. Its `output` is the terminal's
rendering, so colors are applied rather than returned and a progress bar that
redrew itself shows only its last frame. `timedOut` is part of the result, with
the output printed so far. `sortLines` gives the program a stdin with `input`.

`runBeside` runs a program in a split beside a pane, where a person sees it,
and leaves the pane showing the output with `keep`.

`server.spawn` keeps the program running and hands it back. Its pane is a real
terminal, which is what lets `prependLine` drive vim with keys; keys sent at
once reach the program, because `spawn` returns only after it has started.

`stream: true` copies everything the program writes, and `stream()` yields it as
UTF-8 text until the program exits. It is the terminal's text, `\r\n` line ends
and escape sequences included. `followOutput` caps the copy at a mebibyte, and
`startService` reads the stream until the program says it is ready.

Every program holds a lease: should this process die without ending it, tmux
does. `startService` shortens it to ten seconds.

`await using` removes the program's pane however the function leaves,
including on a throw.

## Where to go next

[`../agent/`](../agent/README.md) runs a command in a shell you already have,
and waits for its result; [`../capture/`](../capture/README.md) reads a pane
something else is writing to.
