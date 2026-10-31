#!/usr/bin/env bash
#
# Build tmux from a release, a tag, a branch or a commit of github.com/tmux/tmux.
#
#   build-tmux.sh resolve REF           print the commit REF names
#   build-tmux.sh build REF PREFIX      build it into PREFIX and print the commit
#
# A release is a tag, and a tag or branch is cloned shallowly by name. A commit
# is fetched by its hash. The commit printed is what a cache key should use:
# a branch name moves, and the same name can name a different tmux tomorrow.
# TMUX_REPOSITORY names another repository, for the tests.

set -euo pipefail

repository=${TMUX_REPOSITORY:-https://github.com/tmux/tmux.git}

die() {
    printf '::error::build-tmux: %s\n' "$*" >&2
    exit 1
}

valid_ref() { [[ $1 =~ ^[A-Za-z0-9._/-]{1,64}$ && $1 != -* ]]; }

# resolve prints the commit a ref names. A tag wins over a branch of the same
# name, and an annotated tag is followed to the commit it tags.
resolve() {
    local ref=$1 listing commit
    valid_ref "$ref" || die "not a tmux ref: $ref"
    if [[ $ref =~ ^[0-9a-f]{40}$ ]]; then
        printf '%s\n' "$ref"
        return
    fi
    listing=$(git ls-remote -- "$repository" "refs/tags/$ref" "refs/tags/$ref^{}" "refs/heads/$ref") ||
        die "could not list $repository"
    for name in "refs/tags/$ref^{}" "refs/tags/$ref" "refs/heads/$ref"; do
        commit=$(awk -v name="$name" '$2 == name { print $1 }' <<< "$listing")
        if [[ -n $commit ]]; then
            printf '%s\n' "$commit"
            return
        fi
    done
    die "$repository has no tag or branch named $ref"
}

build() {
    local ref=$1 prefix=$2 commit source
    [[ -n $prefix ]] || die "build needs a prefix"
    commit=$(resolve "$ref")
    source=$(mktemp -d)
    # shellcheck disable=SC2064 # expand the directory now, not at exit
    trap "rm -rf -- '${source:?}'" EXIT

    if [[ $ref =~ ^[0-9a-f]{40}$ ]]; then
        git -C "$source" init --quiet
        git -C "$source" fetch --quiet --depth 1 -- "$repository" "$commit"
        git -C "$source" checkout --quiet --detach FETCH_HEAD
    else
        git clone --quiet --depth 1 --branch "$ref" -- "$repository" "$source"
        [[ $(git -C "$source" rev-parse HEAD) == "$commit" ]] ||
            die "$ref moved while it was being built"
    fi
    (
        cd "$source"
        sh autogen.sh
        ./configure --prefix="$prefix"
        make -j"$(nproc)"
        make install
    ) >&2
    printf '%s\n' "$commit"
}

case ${1:-} in
    resolve)
        [[ $# -eq 2 ]] || die "usage: build-tmux.sh resolve REF"
        resolve "$2"
        ;;
    build)
        [[ $# -eq 3 ]] || die "usage: build-tmux.sh build REF PREFIX"
        build "$2" "$3"
        ;;
    *) die "usage: build-tmux.sh resolve REF | build REF PREFIX" ;;
esac
