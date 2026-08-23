# Capture

Move text through a tmux buffer, and read what a pane is showing.

Reach for this when the job is getting text _out_ of tmux or _into_ it —
collecting a pane's output, or handing a block of text to a pane without typing
it key by key.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/capture
```

The test drives both functions against a real tmux server the suite starts on
a socket of its own. Requires tmux 3.2a or newer.

## What it shows

A named buffer is tmux's own clipboard. Anything in it can be pasted into any
pane on that server — by this process or by a person at the keyboard — without
the text passing through your program a second time.

The check on empty text is the part worth copying. tmux stores no buffer for
an empty string and reports success anyway, so a buffer whose content is
computed can be absent while the call that made it looked fine. What fails is
the next call to read it, which points at the wrong line.

`capture` reads a pane without asking it to print anything, scrollback
included: `start: -100` means the last hundred lines, or as many as there are.
A pane that has printed nothing answers with nothing rather than with blanks.

## Where to go next

[`../agent/`](../agent/README.md) waits for a pane to print something before
reading it; [`../watch/`](../watch/README.md) follows a pane as it prints.
