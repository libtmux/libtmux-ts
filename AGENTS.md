# AGENTS.md

Rules for this repository: `libtmux` for Bun and TypeScript, a port of the
Python library of the same name. Nothing here is Python — a convention you
recognise from that project (uv, ruff, mypy, pytest, doctests, NumPy
docstrings) does not apply unless a file here says so.

Follow the conventions already in the tree, and keep a change scoped to what
was asked for.

## What is here

A Bun workspace. Every package declares its own dependencies — one the root
happens to install is not one a package may use.

| Path                 | Package              | What it is                                                                                                                      |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/libtmux`   | `libtmux`            | The library. Server, sessions, windows, panes, clients, formats, selections, snapshots, and engines. Zero runtime dependencies. |
| `packages/mcp`       | `@libtmux/mcp`       | Serves one tmux server to Model Context Protocol clients.                                                                       |
| `packages/workspace` | `@libtmux/workspace` | Builds tmux sessions from declarative YAML.                                                                                     |
| `examples`           | —                    | Runnable examples, used as tests. The only `private` package.                                                                   |

The three published packages ship together under one version, from one tag.
`attic/` is where reference material goes to rest; `packages/libtmux/parity` is
not that — it is a gate input, read by `check-parity.ts`,
`generate-formats.ts` and five unit tests, and it lives beside its readers.

## Which policy applies

- Documentation, user-facing text, `CHANGELOG.md`, release notes, commit
  messages, TSDoc, and source comments:
  [.github/WRITING.md](.github/WRITING.md)
- Building, testing, the gates, real tmux, releases, and pull requests:
  [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)
- Anything under `packages/mcp`:
  [packages/mcp/AGENTS.md](packages/mcp/AGENTS.md)
- Reporting or assessing a vulnerability: [SECURITY.md](SECURITY.md)

Each of those is the single home for its subject. Where a rule seems to be
stated twice, the file listed above is the one that governs.

## Change discipline

- Make the smallest coherent change that solves the verified problem; keep
  unrelated cleanup out of it.
- Reuse an existing file, helper, API, or test before adding a new one.
- Add a file only for a durable boundary — a distinct responsibility,
  independent reuse, or splitting an oversized module — not for a single-use
  helper or a one-line re-export.
- Zero runtime dependencies is a property under test, not an aspiration.
  Anything new belongs in `devDependencies` or nowhere.
- A passing gate is evidence only once it has been shown capable of failing.
  Pair a new test with a deliberate break that proves it bites.
- **Reaching past a layer to set a test up is a finding about that layer.**
  If a fixture needs `tmux` directly, or the MCP's test needs `libtmux`, write
  down what was unreachable before carrying on — a fixture needs whatever the
  real workload needs, so the setup step probes the surface honestly where
  reading the API does not. This found window-scope options and window size,
  two gaps that reasoning about the tool list had missed.

## References

- [API reference](packages/libtmux/docs/api.md) — generated from the doc
  comments that implement it
- [Changelog](packages/libtmux/CHANGELOG.md)
- Python library, which this ports: https://libtmux.git-pull.com/
- tmux manual: http://man.openbsd.org/OpenBSD-current/man1/tmux.1
- TSDoc, the doc-comment syntax: https://tsdoc.org/
