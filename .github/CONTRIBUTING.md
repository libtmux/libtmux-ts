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
blocks to paths and packages that exist, requires public install examples to
pin prerelease packages exactly, and pins any tmux badge to the CI matrix.
`docs:runnable` requires a block marked

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

The library's unit and real-tmux runners use four Bun workers by default. On a
constrained machine, lower both with one setting:

```console
$ LIBTMUX_TEST_PARALLEL=2 bun run --cwd packages/libtmux test:unit
```

The formatter and linter take every core instead, and say how many they used.
Both accept a bound, which costs little — halving the threads on a ten-core
machine left a full-tree format within forty milliseconds of the default:

```console
$ bun run format:check --threads=5
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

Every real-tmux runner sweeps before it starts. A suite reaps its own run root
in a `finally`, which `SIGKILL` skips, and each root is created under a fresh
`mkdtemp` name that no later run would otherwise revisit — so a killed run left
a tmux daemon serving with nothing left that knew to collect it. The sweep
reaps a root only when the process recorded as its owner is gone, decided by pid
and start identity rather than by age, so a root a concurrent run still holds is
refused. Set `LIBTMUX_TEST_DEADLINE_SCALE` on a machine slower or busier than
the ones these bounds were tuned on.

Ownership is a prefix rather than a parent directory, deliberately. Nesting
everything under `/tmp/libtmux-ts-test/` was tried: it cost fifteen bytes of
the socket path budget, which put the longest fixture path at 104 and failed
the suite with "File name too long". Keep the names short for the same reason.
Unset `TMUX` and `TMUX_PANE` too, so a probe cannot reach the terminal you are
working in.

Do not edit the tree while `test:compat` runs. It spawns the suite once per
build and reads the working tree each time, so a mid-run edit produces failures
attributed to whichever tmux happened to be current.

Do not run another suite beside it either. The bounds here are liveness bounds
sized for an idle machine, and a second suite competing for the same cores turns
one into a failure reported against whichever tmux was current. That happened:
one cleanup case failed on 3.3a at 15,211ms against a 15,000ms bound, and the
same case passes on 3.3a and 3.7c alike with the bound cut to 300ms once the
machine is quiet.

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
it. A stable release uses `latest`. A prerelease uses `latest` until a stable
version has held that tag; later prereleases use their first identifier, such
as `alpha` in `1.1.0-alpha.1`. The credentialed workflow accepts only `v*` tag
pushes and waits for that commit to pass the full Bun, Node, tmux, and package
matrix. Set `GITHUB_EVENT_NAME=workflow_dispatch` when running the coordinator
locally to use its dry-run mode without an npm identity.

The release coordinator first requires every package version and internal
`libtmux` dependency to agree. It then builds all three npm tarballs and reads
every package, target version, integrity digest, and dist-tag before publishing
any of them. It publishes those exact tarballs, then checks all three registry
artifacts and tags again. A partial rerun skips an existing version only when
its integrity and intended tag match. A different artifact, a missing
established package, or any registry error other than a target-version 404
stops the release.

npm cannot publish three packages as one transaction. A failure can therefore
leave a prefix published for the next run to verify and resume. Trusted
publishing authenticates `npm publish`, not `npm dist-tag add`, so a matching
artifact with the wrong tag also stops with a manual-repair diagnostic instead
of adding a long-lived token to the workflow.

### Stable release gate

`0.1.0` is a coordinated release of all three packages. Cut it only when:

- no known P0 or P1 correctness or security finding remains;
- both Bun versions, Node 22 package consumers, every advertised tmux version,
  and the pinned Python differential suite pass from packed artifacts;
- real-tmux cancellation and process ownership pass on each advertised host
  platform, or the platform contract names the narrower set;
- the published declaration graph, examples, and install canaries cover all
  three packages; and
- one release candidate has spent 30 days in production-like use without a new
  P0 or P1 finding.

The three packages keep one release number. A tag names the tested state of the
library, MCP server, and workspace package together.

`test:package` reads the tarball and `test:install` uses it — a clean
directory, `npm install` of the packed file, and a Node 22 process that imports
the package by name and runs something. Nothing there can resolve through the
workspace, which is the point: the two releases this repository shipped broken
both packed and linted clean.

An in-repo consumer resolves `libtmux` to source through `paths` in its own
tsconfig, so a branded class has one type identity rather than one per build
output. Published exports send Bun to the packed TypeScript source and keep
types, Node, and other importers on `dist`. Packed-package canaries require each
runtime to select its intended tree and keep root and subpath imports on one
public runtime identity. The library's real-tmux fixture harness reaches into
unpublished internals, so in-repo consumers still import that harness directly
by path.

Never create tags and never push them. See
[Release commits](WRITING.md#release-commits).

## Benchmarks

Three, run by hand rather than as gates: `package.json` lists the gates, and a
number that varies with the machine is not one.

Grid the transports against batching and concurrency:

```console
$ bun packages/libtmux/scripts/bench-modes.ts
```

Measure whole-server acquisition and repeated deep local queries as the server
grows:

```console
$ bun packages/libtmux/scripts/bench-snapshot.ts
```

It reports the acquisition command count, which the design holds flat, against
the bytes and wall clock, which grow with the server. The local query column
must add no tmux invocation.

Exercise sustained pane output, a slow subscriber, reconnect loops, and daemon
replacement:

```console
$ bun packages/libtmux/scripts/bench-control.ts
```

That benchmark requires bounded buffers, complete lifecycle transitions,
daemon-bound handle retirement, and attached-client cleanup. It reports wall
clock but does not compare it to a pass threshold.

## Pull requests

One subject per pull request. Unrelated cleanup found along the way belongs in
its own commit, and usually in its own pull request.

Commit format is in [WRITING.md](WRITING.md#commits).

## Security

Please do not open a public issue for a vulnerability. See
[SECURITY.md](../SECURITY.md).
