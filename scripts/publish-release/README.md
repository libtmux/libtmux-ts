# publish-release

Coordinates a release from a tag, which is the one thing the `publish` workflow
does after its gates pass. It checks the tag against the manifests and the root
changelog, packs each release package, publishes the tarballs that are not yet in
the registry under the dist-tag the version selects, and afterwards checks that the registry
holds each version and dist-tag. A package already published at the same
integrity is skipped, so a failed release can be run again.

The publish workflow runs it on a tag, and a maintainer can run it as a dry run,
which a `workflow_dispatch` event selects:

```console
$ GITHUB_EVENT_NAME=workflow_dispatch bun scripts/publish-release/publish-release.ts
```

A dist-tag the registry has not caught up on is a warning, not a failure: the
packages are published by then. The rules live in
[`release_policy`](../release_policy/README.md), and the registry and npm are
behind an interface, so its tests run the whole sequence against a fake:

```console
$ bun test scripts/publish-release
```
