# bun_version_pins

Checks that every place this repository writes down a Bun version agrees: the CI
gates matrix, the `packageManager` pin, the `engines.bun` floor in each manifest,
and the version prose in CONTRIBUTING.md. Nothing else ties them together, so a
change to one drifts from the rest until a build off an untested Bun ships.

`checkBunVersionAgreement` takes the versions gathered from those places and
returns one message per disagreement. `check-doc-claims.ts` gathers them and
reports the messages, and runs in CI as:

```console
$ bun run docs:claims
```

It is a module with no command of its own. Its tests cover agreement and each
kind of drift:

```console
$ bun test scripts/bun_version_pins
```
