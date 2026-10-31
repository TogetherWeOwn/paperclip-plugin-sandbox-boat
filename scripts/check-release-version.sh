#!/bin/sh
# Check that a release tag, package.json `version` and the manifest's
# PLUGIN_VERSION agree at the tagged commit. The release workflow runs it
# before it builds anything, so a release can only be named after the version
# its package reports.
#
# Usage: scripts/check-release-version.sh <tag>
#   <tag> is vX.Y.Z (or vX.Y.Z-pre) and must exist in the repository.
set -eu

tag=${1:?usage: scripts/check-release-version.sh <tag>}

case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "check-release-version: $tag is not a vX.Y.Z tag" >&2
    exit 1
    ;;
esac

sha=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}") || {
  echo "check-release-version: unknown tag: $tag" >&2
  exit 1
}

pkg_version=$(git show "$sha:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version ?? ""))')
manifest_version=$(git show "$sha:src/manifest.ts" | sed -n 's/^export const PLUGIN_VERSION = "\([^"]*\)";$/\1/p')
tag_version=${tag#v}

if [ -z "$manifest_version" ]; then
  echo "check-release-version: no PLUGIN_VERSION in src/manifest.ts at $tag" >&2
  exit 1
fi
if [ "$pkg_version" != "$tag_version" ] || [ "$manifest_version" != "$tag_version" ]; then
  echo "check-release-version: versions disagree at $tag: tag $tag_version, package.json $pkg_version, PLUGIN_VERSION $manifest_version" >&2
  exit 1
fi
echo "$tag_version"
