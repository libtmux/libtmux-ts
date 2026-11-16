# api_surface

Reads the public surface of the handle classes out of their source: each
member's signature, its prose and its example. The API reference and both example
gates read the same thing, so a reference and the examples that check it cannot
disagree. It reads the source rather than running a documentation generator,
because typedoc bundles a TypeScript that cannot parse this one's.

`readApiSurface()` returns the members of `Server`, `Session`, `Window`, `Pane`,
`Program`, `Client` and `Selection`, and `readRootApiSurface()` the root
functions and aliases. `requireSymbolExamples` and `requireRootExamples` refuse a
surface with a member that has no example. It is a module with no command of its
own. `generate-api-docs.ts` and the `doc-examples` checks call it:

```console
$ bun run docs:api:check
```

Its tests check that every handle class the package exports is read, that a
public member or root declaration with no example is rejected, and that root
overloads are kept without their implementation:

```console
$ bun test ./scripts/api_surface
```

Run from `packages/libtmux`.
