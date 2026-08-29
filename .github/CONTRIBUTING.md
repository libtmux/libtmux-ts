# Contributing

Thanks for looking. This is alpha software and the API is still moving, so the
most useful contributions right now are bug reports with a reproduction, and
notes on where the documentation misled you.

How this project writes prose — README, changelog, release notes, commit
messages, TSDoc, and source comments — is set out separately in
[WRITING.md](WRITING.md). Read that before changing any of it. The constraints
every change is held to, and the map of what is where, are in
[AGENTS.md](../AGENTS.md). For anything under `packages/mcp`, read
[packages/mcp/AGENTS.md](../packages/mcp/AGENTS.md) as well.

## Getting set up

Requires [Bun](https://bun.sh) 1.3.14 or newer, Node 22 or newer, and tmux 3.2a
or newer.

Development uses the exact Bun 1.4.0 `packageManager` pin; CI also runs the
supported 1.3.14 floor. The three-runtime regex corpus is evidence that Bun,
Node and Python agree on a pattern, and it records which engines produced each
answer, so running it on an unrecorded Bun is asking a question the answers do
not cover. It says so when that happens.

```console
$ bun install
```

The suite creates its own tmux servers on its own sockets and never touches the
one you are attached to.

## The gates

Bun, `oxlint`, `oxfmt`, `tsgolint`. `package.json` is the list of gates; run
them, do not re-derive them. [workflows/typescript.yml](workflows/typescript.yml)
is the order CI runs them in, and every script it runs has to pass before a
change is done.

From the root, formatting and linting are the workspace's, not any one
package's:

```console
$ bun run format:check
```

```console
$ bun run lint
```

The gates below are themselves TypeScript, and until this runs nothing has
compiled them — a gate that crashes on its own type error reports no failures,
which reads exactly like a clean tree:

```console
$ bun run typecheck:tooling
```

Documentation is a gate, not a courtesy. Every public method, getter, and
readonly field carries a compiled example; `docs/api.md` is generated from the
doc comments that implement it, and `docs/criteria.md` from the table the query
compiler matches against. Neither is edited by hand. The prose around
the snippets is checked too — `docs:links` resolves every relative link and
`#anchor` in every tracked Markdown file, `docs:claims` holds the ` ```console `
blocks to paths and packages that exist and pins any tmux badge to the CI
matrix, and `docs:runnable` requires a block marked

```
<!-- runs: examples/agent/agent.ts -->
```

to be drawn line for line from that example, which the integration suite runs
against a real server.

```console
$ bun run typecheck:readme
```

```console
$ bun run docs:links
```

```console
$ bun run docs:claims
```

```console
$ bun run docs:runnable
```

Then every snippet runs. Compiling one proves it typechecks; running it proves
the target exists and the recipe terminates. `test:readme` executes the blocks
in the library's own documents, and `test:symbols` the example on every public
symbol.

```console
$ bun run --cwd packages/libtmux test:readme
```

```console
$ bun run --cwd packages/libtmux test:symbols
```

`test:docs` executes the blocks in the documents above the library package,
each from inside the package that owns it, so an import means what a reader's
would mean. It runs after the consumers are built, because it imports what they
emit.

```console
$ bun run test:docs
```

All three start real tmux servers, and each fails on a server that outlives the
block or example that made it.

### Writing an example a gate can see

The fence decides whether a block is compiled. Only ` ```ts ` is collected; a
` ```typescript ` block is prose to every checker here, so it compiles nowhere
and fails nothing. Reach for `typescript` only where a fragment is meant not to
compile — the comment samples in [WRITING.md](WRITING.md#source-comments) are
that case.

The checks read those blocks from different files. `typecheck:readme`
at the root compiles the READMEs that span packages — `README.md`,
`examples/README.md`, `packages/mcp/README.md`, and
`packages/workspace/README.md` — each in the directory it lives in, so a bare
specifier resolves the way it would for someone who installed that package
rather than the way a hoisted `node_modules` happens to allow.
`packages/libtmux` runs its own against its own API. `typecheck:symbols`
compiles the example on every public method and getter, and fails naming the
ones that carry none. `docs:runnable` is the marker, described in
[examples/README.md](../examples/README.md#quoting-an-example-in-a-readme).

Each block is wrapped in a function of its own, so a `const` declared in one
cannot satisfy the next: a snippet has to stand on its own, the way a reader
will paste it. Imports hoist and merge by module, so two blocks may import the
same symbol without declaring it twice.

A block may also use a few names without introducing them. The cross-package
check declares `server`, `snapshot`, and `selection`; the library's own harness
declares those alongside `session`, `window`, `pane`, `client`, and the
arguments a runnable example takes. That last part is what lets a quoted recipe
name an argument where the example named one, instead of inventing a literal
the example never had.

Every temporary directory the suites create is named for this package, so a
sweep can never reap another libtmux port's servers:

```console
$ bun run test:namespace
```

dependabot is the one configuration nothing else here executes, so a
placeholder in it reads exactly like a working one until a dependency has been
stale for a year:

```console
$ bun run ci:config
```

Then, from `packages/libtmux`, the library's own gates — `lint:unused`,
`typecheck`, `typecheck:readme`, `typecheck:symbols`, `docs:api:check`,
`docs:criteria:check`, `generate:check`, `parity`, and `build`. Everything after
the build needs the emitted declarations it produced: `typecheck:ambient-free`,
`typecheck:tooling`, `test:package`, and `test:install`. Then `test:types`,
`test:node`, and `test:coverage`.

`packages/mcp` and `packages/workspace` each run `typecheck`, `test` and
`test:package`. `examples` runs `typecheck` and `test`: every example is a
package of its own, and the umbrella runs each sibling, so adding one adds no
step here.

## Tests

Real tmux, isolated sockets, deterministic cleanup — no mocks standing in for a
server. A test asserting on timing carries a bound sized for what it does.

Before claiming a test or a gate works, show it failing. A gate that has never
been red is an assumption.

A parser that reads bytes this package did not write gets a randomized target.
`tests/unit/control_fuzz.test.ts` covers the control-mode framer, the
notification parser, and the UTF-8 holdback; add to it when adding a parser in
that position. It is seeded, so a failure reproduces from the printed seed, and
bounded, so it runs on an ordinary gate. Two environment variables turn it into
a soak:

```console
$ LIBTMUX_FUZZ_ITERATIONS=200000 bun test tests/unit/control_fuzz.test.ts
```

A target that has never caught anything proves only that the generator is
narrow. Break each parser it covers once, and confirm the target goes red for
that break specifically.

## Real tmux

Probe before you commit. `~/.local/share/libtmux-tmux-matrix` holds the
supported range as `<version>/bin/tmux` prefixes; point `LIBTMUX_TMUX_BUILDS`
at it for `test:compat`.

Other libtmux ports run their own suites on this machine, so everything this
one leaves in the temporary directory is named `ltx…` and nothing else is.
`/tmp/libtmux-*` is not ours to take — `/tmp/libtmux-java-test` and
`/tmp/libtmux-swift-dev` are someone else's, and a sweep that cannot tell them
apart reaps their servers. `test:namespace` is the gate, `makeTestDirectory`
applies the prefix, and a suite that starts a live server calls
`assertOwnedSocketPath` before it touches one.

Ownership is a prefix rather than a parent directory, deliberately. Nesting
everything under `/tmp/libtmux-ts-test/` was tried: it cost fifteen bytes of
the socket path budget, which put the longest fixture path at 104 and failed
the suite with "File name too long". Keep the names short for the same reason.
Unset `TMUX` and `TMUX_PANE` too, so a probe cannot reach the terminal you are
working in.

Do not edit the tree while `test:compat` runs. It spawns the suite once per
build and reads the working tree each time, so a mid-run edit produces failures
attributed to whichever tmux happened to be current.

One tmux grammar note that costs an afternoon: an adjustment like
`resize-pane -U 2` is a positional argument, so it has to follow every flag.
Written next to its direction it turns any later flag into surplus arguments
and tmux rejects the command.

## The parity ledger

`parity/python-0.62.0.json` records a decision for every public symbol of the
Python release it names. `oxfmt` formats TypeScript but not JSON, and
`check-parity.ts --write` re-renders the file in a style the committed one does
not use — so edit entries surgically as text and leave the rest byte for byte.

A ported row names the TypeScript that covers it:
`./module#instance:Class.member` for the prototype, and
`./module#value:Class.member` for the static side.
`./module#value:Class` compiles to `typeof Class` and says only that the class
is exported — the whole claim for a class row, and none of it for a method: a
rename leaves such a row citing a method that no longer exists, and the gate
stays green. A row claims a member when its kind is `method` or `property`, or
when its `typescript` field names `Class.member`; the gate reads that rather
than a list, so it needs no maintaining. A generic type needs instantiated
arguments in the locator — `./selection#type:Selection<never>.one` — because
`never` satisfies any parameter without asserting anything about it.

`parity/python-0.62.0.baseline.json` records what the Python release
contributes: the symbols it exposes, and the git object kind of every path
cited. It is generated, not written, and the gate reads it instead of a
checkout — so checking parity needs no Python sources and no network.
Regenerate it only to admit a new evidence path or to move releases, and commit
the result:

```console
$ bun packages/libtmux/scripts/check-parity.ts \
    --regenerate-baseline \
    --python-repo ../libtmux
```

The differential suite is separate from the ledger and does need the code: it
runs the real Python library as an oracle and compares. Point
`LIBTMUX_PYTHON_REPO` at a checkout of the pinned commit:

```console
$ git clone --branch v0.62.0 --depth 1 https://github.com/tmux-python/libtmux.git
```

Without it those tests skip rather than fail, because a missing oracle is not
evidence that the port is wrong. CI clones it, so they always run there.

## Node

The emitted-package lanes run on Node 22 and the floor is never substituted: a
newer Node says nothing about the version the package claims to support.
`resolveNode22` finds one from `LIBTMUX_NODE22` or from mise. Nothing else
should look for a Node itself.

## Platforms

CI builds, packs, installs, and evaluates every emitted package on macOS. The
library transport itself uses neither `/proc` nor pidfd:
`node_spawn_transport.ts` escalates SIGTERM to SIGKILL and force-settles a
process whose descendants hold the pipe.

The supervisor in `src/_internal/test/run_root.ts` is the Linux part: process
identity is `linux:<boot id>:<start time>`, read from `/proc`. The real-tmux,
cancellation, and process-ownership suites therefore remain Linux-only. The
macOS lane proves only the package boundary until that supervisor is ported.
WSL is untested. `preflight.ts` says which requirement is missing instead of
letting a checkout discover it as ENOENT from a file nobody mentioned.

## Releasing

A release is a tag, and the tag is refused unless every manifest agrees with
it. Everything ships as a prerelease under `latest` and no other dist-tag:
while every version is an alpha, the newest one is what `npm i` should fetch,
and `latest` is stated rather than inherited so it cannot lag. A second `alpha`
tag was tried and removed — trusted publishing authenticates `npm publish` and
nothing else, so writing one needs a token in the repository, which is what
publishing this way exists to avoid.

That reasoning holds only while every version is a prerelease, so the publish
workflow refuses a version that is not one rather than tagging it `latest` by
habit. The first stable release wants `latest`; a prerelease cut after it does
not, and moving `latest` backwards onto an alpha is the failure the check
exists to prevent. Whoever cuts that release decides the tag.

`test:package` reads the tarball and `test:install` uses it — a clean
directory, `npm install` of the packed file, and a Node 22 process that imports
the package by name and runs something. Nothing there can resolve through the
workspace, which is the point: the two releases this repository shipped broken
both packed and linted clean.

An in-repo consumer resolves `libtmux` to source through `paths` in its own
tsconfig, so a branded class has one type identity rather than one per build
output. The published `exports` deliberately name only `dist`: source is not in
the tarball, so no condition may point at it. Consumer tests use the library's
real-tmux fixture harness directly, across the package boundary — that harness
reaches into the library's internals and cannot be published, so it stays where
it is and in-repo consumers reach for it by path.

Never create tags and never push them. See
[Release commits](WRITING.md#release-commits).

## Benchmarks

Two, run by hand rather than as gates: `package.json` lists the gates, and a
number that varies with the machine is not one.

Grid the transports against batching and concurrency:

```console
$ bun packages/libtmux/scripts/bench-modes.ts
```

Measure what a snapshot costs as the server grows:

```console
$ bun packages/libtmux/scripts/bench-snapshot.ts
```

It reports the command count, which the design holds flat, against the bytes
and wall clock, which grow with the server — what a projection would address,
and what it would cost to give up.

## Pull requests

One subject per pull request. Unrelated cleanup found along the way belongs in
its own commit, and usually in its own pull request.

Commit format is in [WRITING.md](WRITING.md#commits).

## Security

Please do not open a public issue for a vulnerability. See
[SECURITY.md](../SECURITY.md).
