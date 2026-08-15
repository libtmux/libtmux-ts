# Contributing

Thanks for looking. This is alpha software and the API is still moving, so the
most useful contributions right now are bug reports with a reproduction, and
notes on where the documentation misled you.

## Before you open a pull request

[AGENTS.md](AGENTS.md) is the real contract — the layout, why the parity ledger
exists, how to probe real tmux without tripping over socket path limits, and
why a gate that has never been red is an assumption. This file is the short
version.

```console
$ bun install
```

Then run what CI runs, in the order
[`.github/workflows/typescript.yml`](.github/workflows/typescript.yml) runs it.
From the root:

```console
$ bun run format:check
```

```console
$ bun run lint
```

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

And from `packages/libtmux`, the library's own gates — `typecheck`,
`typecheck:symbols`, `docs:api:check`, `generate:check`, `parity`, `build`,
`test:unit`, `test:integration`, `test:node`. The consumers in `packages/mcp`,
`packages/workspace` and `examples` each run `typecheck` and `test`.

Requires [Bun](https://bun.sh) 1.3.14+, Node 22+, and tmux 3.2a or newer.

The suite creates its own tmux servers on its own sockets and never touches the
one you are attached to. Everything it leaves in the temporary directory is
named `ltx…`, so a sweep can tell this package's servers from another libtmux
port's — `bun run test:namespace` is what keeps that true, and a suite starting
a live server asserts it before sending a key.

## Things that are gates, not preferences

- **Documentation compiles.** Every public symbol carries an example, and every
  example is compiled against the tree. `docs/api.md` is generated — run
  `bun run docs:api` and commit the result rather than editing it.
- **Links resolve.** Every relative link and `#anchor` in every Markdown file
  is checked, as is every path and package named in a ` ```console ` block.
- **Zero runtime dependencies.** A property under test. Anything new belongs in
  `devDependencies` or nowhere.
- **Real tmux.** No mocks stand in for a server.

## Commits

`Scope(type[detail]): concise description`, at most 50 characters, then a blank
line, a `why:` paragraph explaining the necessity, and a `what:` list of the
changes. Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `style`,
`ci`.

## Security

Please do not open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md).
