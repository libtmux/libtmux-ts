# Program

Run a program in tmux and read only what it printed.

Reach for this when you want a program's output and exit status and it does not
need an existing shell. The output holds no command line or echo, and the
program still gets a real terminal.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/program
```

Needs tmux 3.8 or newer; below it the library refuses.

## What it shows

`server.run` is the one-call form. The program runs in a detached session of
its own, gone when the call returns, and `output` is the terminal's rendering.

- `timedOut` is part of the result, with the output printed so far.
- `sortLines` gives the program a stdin with `input`.
- `readJson` keeps stderr apart with `separateStderr`, so `output` is stdout
  alone.
- `runUnlessCancelled` ends a run when a signal fires, and the cancel's
  `delivery` says whether the program had started.
- `runBeside` runs a program in a split beside a pane, where a person sees it,
  and `keep` leaves the pane showing the output.

`server.spawn` hands the program back once it has started.

- `prependLine` drives vim with keys after its first screen: a program still
  setting up its terminal can discard what was typed before.
- With `stream: true`, `stream()` yields the terminal's text as UTF-8 until the
  program exits. `followOutput` caps the copy, and `startService` reads the
  stream until the program says it is ready.
- Every program holds a lease: should this process die without ending it, tmux
  does. `startService` shortens it with `orphanAfterMs`.
- `await using` removes the program's pane however the function leaves.

## Where to go next

[`../agent/`](../agent/README.md) runs a command in a shell you already have,
and waits for its result; [`../capture/`](../capture/README.md) reads a pane
something else is writing to.
