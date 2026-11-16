# check-source-maps

Checks the source maps of a built package against the tarball that would be
published. Each emitted `.js` and `.d.ts` file in `dist` must end with a reference
to its map. Each map must name its artifact, have an empty `sourceRoot`, keep its
sources inside the package, carry no `sourcesContent`, and map only to sources
the tarball holds. A packed file whose map is not packed fails.

Run it from a package directory after `bun run build`. The `test:package` script
of `libtmux`, `@libtmux/mcp` and `@libtmux/workspace` runs it:

```console
$ bun ../../scripts/check-source-maps/check-source-maps.ts
```

It prints the first problem to standard error and exits 1. On success it prints
one JSON line with `"status":"passed"`. Its tests build a package with each fault
in turn:

```console
$ bun test scripts/check-source-maps
```
