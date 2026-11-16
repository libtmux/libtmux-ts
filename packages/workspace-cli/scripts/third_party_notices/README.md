# third_party_notices

Keeps `THIRD-PARTY-NOTICES.md` in step with the packages the CLI bundle inlines.
`dist/` copies `cli-truncate`, `commander`, `string-width` and `yaml` into the
published file, so each licence has to travel with it. `libtmux` stays external
and carries its own.

```console
$ bun run notices
```

```console
$ bun run notices:check
```

`notices` rewrites the file from the installed packages. `notices:check` fails
when the file is stale or omits a bundled package, and `build` runs it first. The
tests check that the shipped notices reproduce each bundled package's licence,
and that a package left out is named:

```console
$ bun test packages/workspace-cli/scripts/third_party_notices
```

Run the `bun run` commands from `packages/workspace-cli` and the tests from the repository root.
