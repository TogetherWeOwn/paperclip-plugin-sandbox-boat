#!/bin/sh
# Fail when a release tarball holds a symlink or hardlink.
#
# The staged package is plain files and directories, so a tarball of it needs
# no link at all. Until 0.2.6 the tarball carried node_modules/@paperclipai/
# plugin-sdk as an absolute symlink to the build host's SDK path, which made
# it unloadable on every other host; the release workflow runs this check on
# the built tarball before it publishes anything, so that shape cannot ship
# again. Any link fails, absolute or not: there is no legitimate one to allow.
#
# Usage: scripts/check-tarball-links.sh <tarball.tgz>
set -eu

tarball=${1:?usage: scripts/check-tarball-links.sh <tarball.tgz>}

# Fail here on an unreadable tarball: in the pipeline below, awk's exit
# status would otherwise mask tar's.
tar -tzf "$tarball" >/dev/null

# tar -t verbose mode strings start with the member type: l for a symlink,
# h for a hardlink.
links=$(tar -tvzf "$tarball" | awk '$1 ~ /^[lh]/')
if [ -n "$links" ]; then
  echo "check-tarball-links: $tarball holds a link; the release package must be plain files and directories:" >&2
  printf '%s\n' "$links" >&2
  exit 1
fi
echo "check-tarball-links: $tarball holds no links"
