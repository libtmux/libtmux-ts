# npm_pack

Packs a workspace package into a tarball with `npm pack --json` and returns what
npm reports: the tarball path, its integrity hash, and the entries it holds. The
source-map gate, the package analysis, and the install checks all inspect the
artifact that would be published rather than the directory it comes from.

`npmPack(packageRoot, destination)` runs npm under
[`bounded_process`](../bounded_process/README.md) and refuses output it cannot
read as one pack record. It is a module with no command of its own.

```console
$ bun test scripts/npm_pack
```
