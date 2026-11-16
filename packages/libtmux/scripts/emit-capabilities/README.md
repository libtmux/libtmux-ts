# emit-capabilities

Writes `capabilities.json` at the repository root: the machine-readable list of
what the library supports, rendered from `support.capabilities` in the source.
The documentation reads the file, so a capability is declared in one place.

```console
$ bun run capabilities
```

```console
$ bun run capabilities:check
```

`capabilities` writes the file, and `capabilities:check` fails when the committed
file differs from what the source renders; CI runs the check in the library gate.
The command takes exactly one of `--check` or `--write`, and exits 2 otherwise.

Its tests check that the committed manifest is the registry, that ids are unique
and kebab-case, that a refusing capability names its error, and that every API
name resolves to a public symbol read by [`api_surface`](../api_surface/README.md):

```console
$ bun test packages/libtmux/scripts/emit-capabilities
```

Run the `bun run` commands from `packages/libtmux` and the tests from the repository root.
