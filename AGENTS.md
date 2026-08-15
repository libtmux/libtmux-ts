# AGENTS.md

Rules for this repository: `libtmux` for Bun and TypeScript, a port of the
Python library of the same name. Nothing here is Python — a convention you
recognise from that project (uv, ruff, mypy, pytest, doctests, NumPy
docstrings) does not apply unless it is written down below.

Commit subjects are `Scope(type[detail]): concise description`, at most 50
characters, followed by a blank line, a `why:` paragraph explaining the
necessity, and a `what:` list of the changes. Types: `feat`, `fix`,
`refactor`, `docs`, `chore`, `test`, `style`, `ci`.

## Toolchain

Bun, `oxlint`, `oxfmt`, `tsgolint`. `package.json` is the list of gates; run
them, do not re-derive them. `.github/workflows/typescript.yml` is the order CI
runs them in, and every script it runs has to pass before a change is done.

Zero runtime dependencies is a property under test, not an aspiration. Anything
new belongs in `devDependencies` or nowhere.

## Documentation is a gate

Every public method, getter, and readonly field carries a ` ```ts ` example, and
every example is compiled against the tree — a signature with no example fails
`typecheck:symbols`, and one that no longer compiles fails it too.

`docs/api.md` is generated from the doc comments that implement it. Never edit
it by hand; run `bun run docs:api` and commit the result.

Do not write counts into prose — how many symbols are ported, how many fields a
version is asked for. They go stale silently and no reader needs them. Counts
that pin a fixture or guard an invariant are different, and belong in code.

## The parity ledger

`parity/python-0.62.0.json` records a decision for every public symbol of the
Python release it names. `oxfmt` formats TypeScript but not JSON, and
`check-parity.ts --write` re-renders the file in a style the committed one does
not use — so edit entries surgically as text and leave the rest byte-for-byte.

A ported row names the TypeScript that covers it. Prefer
`./module#instance:Class.member`, which pins the member, over
`./module#value:Class`, which only pins its class.

## Real tmux

Probe before you commit. `~/.local/share/libtmux-tmux-matrix` holds the
supported range as `<version>/bin/tmux` prefixes; point `LIBTMUX_TMUX_BUILDS` at
it for `bun run test:compat`.

Other libtmux ports run their own suites on this machine, so take a socket root
belonging to this package — `/tmp/libtmux-ts-test/…` — and never a shared or
default one. Two workspaces on one root see each other's servers, and a cleanup
sweep in either reaps the other's.

Keep that root short. A socket path has a hard length limit, and a long one
fails as "File name too long", which does not read like a path problem. Unset
`TMUX` and `TMUX_PANE` too, so a probe cannot reach the terminal you are
working in.

Do not edit the tree while `test:compat` runs. It spawns the suite once per
build and reads the working tree each time, so a mid-run edit produces failures
attributed to whichever tmux happened to be current.

tmux argument grammar is worth checking rather than assuming: an adjustment like
`resize-pane -U 2` is a _positional_ argument, so it has to follow every flag.
Written next to its direction it turns any later flag into surplus arguments and
tmux rejects the command.

## Node

The emitted-package lanes run on Node 22 and the floor is never substituted: a
newer Node says nothing about the version the package claims to support.
`resolveNode22` finds one from `LIBTMUX_NODE22` or from mise; nothing else
should look for a Node itself.

## Tests

Real tmux, isolated sockets, deterministic cleanup — no mocks standing in for a
server. A test asserting on timing carries a bound sized for what it does.

Before claiming a test or a gate works, show it failing. A gate that has never
been red is an assumption.
