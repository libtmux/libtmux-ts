# check-type-performance

Holds the library's type-level cost to a recorded ceiling. It compiles the stress
test in `tests/types` with the installed TypeScript, reads the instantiation
count from `tsc --extendedDiagnostics`, and fails when the count passes the
ceiling in `tests/types/performance-baseline.json`. The baseline also records the
compiler version and a digest of each input, so a new compiler or a changed input
is a deliberate update, not a drift.

```console
$ bun run test:type-performance
```

`--check` compares, and `--update` rewrites the baseline. `test:types` runs the
check after the type tests. On success it prints one JSON line with
`"protocol":"libtmux-type-performance-v1"`.

Its tests run the command against fixtures with a stand-in compiler, so each
refusal is reproduced without a real compile:

```console
$ bun test ./scripts/check-type-performance
```

Run from `packages/libtmux`.
