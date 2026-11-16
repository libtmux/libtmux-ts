# check-package-analysis

Packs the current package and runs `publint` and `attw` (`--profile esm-only`)
over the tarball, so an export map or declaration that a consumer's tooling
would reject fails here and not after the release.

Run it from a package directory after `bun run build`. The `test:package` script
of `libtmux`, `@libtmux/mcp` and `@libtmux/workspace` runs it:

```console
$ bun ../../scripts/check-package-analysis/check-package-analysis.ts
```

On success it prints one JSON line with the package and `"status":"passed"`.
Each analyzer runs under [`bounded_process`](../bounded_process/README.md), with a
60 second deadline and a 4 MiB output ceiling. Its test shortens the deadline
and checks that a descendant of an analyzer that keeps its output pipes open is
ended with it:

```console
$ bun test scripts/check-package-analysis
```
