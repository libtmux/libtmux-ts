# declaration-closure

Checks that the declaration files a package exports are the ones its tarball
carries. A consumer's `tsc` resolves a `types` condition through the export map,
so an exported declaration that the tarball omits, or a packed declaration that
no export names, compiles on the machine that built it and nowhere else.

`packageDeclarationExports(exports)` returns every file a `types` condition
names. `declarationClosureErrors(packed, exported, resolved)` compares the packed
declarations, the exported ones and the ones TypeScript resolved, and returns one
message per disagreement. `check-package.ts` calls them on the packed library,
and runs in CI as part of the package gate:

```console
$ bun run test:package
```

It is a module with no command of its own. Its tests cover each kind of
disagreement, and a manifest with no declaration exports:

```console
$ bun test packages/libtmux/scripts/declaration-closure
```

Run the `bun run` commands from `packages/libtmux` and the tests from the repository root.
