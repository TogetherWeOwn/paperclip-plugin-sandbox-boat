#!/bin/sh
# Print the CHANGELOG.md section of a release tag, as it is at the tagged
# commit, without its "## X.Y.Z" heading. Fails when the section is missing or
# empty, so a release never goes out without notes.
#
# Usage: scripts/release-notes.sh <tag>
set -eu

tag=${1:?usage: scripts/release-notes.sh <tag>}
sha=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}") || {
  echo "release-notes: unknown tag: $tag" >&2
  exit 1
}

notes=$(git show "$sha:CHANGELOG.md" | awk -v v="${tag#v}" '
  /^## / { if (found) exit; found = ($2 == v); next }
  found
')
if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "release-notes: CHANGELOG.md has no ${tag#v} section at $tag" >&2
  exit 1
fi
printf '%s\n' "$notes" | sed '/./,$!d'
