# release_policy

The rules a release has to satisfy, as functions the release coordinator and the
documentation gates call. It holds two modules.

`release_policy.ts` lists the published packages and checks a release against
them: semantic versions, the minimum npm, the dist-tag a version selects, and
that every manifest and every internal dependency field agrees on one version.

`changelog_policy.ts` checks the changelogs. The root `CHANGELOG.md` carries the
release-level notes and the changes that span packages; each published package
keeps its own, which must open with the package's name, have an `Unreleased`
section, and be listed in the manifest's `files`.

`publish-release.ts` and `check-doc-claims.ts` call them; the second runs in CI
as:

```console
$ bun run docs:claims
```

Neither module has a command of its own. The changelog tests run with:

```console
$ bun test scripts/release_policy
```

The release rules are exercised through
[`publish-release`](../publish-release/README.md)'s tests.
