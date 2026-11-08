#!/bin/sh
# Point a shim directory's command names at a staged package's offload bins.
# Put that directory first on PATH only for runs that should offload (with
# BOAT_OFFLOAD=1); each shim falls back to the next real command on PATH.
#
# Usage: scripts/install-offload-shims.sh <staged package dir> <shim dir>
#   Aliases:
#     cargo                  -> bin/boat-offload-cargo
#     npm pnpm yarn npx      -> bin/boat-offload-node
#     pytest python python3  -> bin/boat-offload-python
#   Creates <shim dir> if needed and replaces each alias in one rename, so a run
#   never sees one missing. Run it again after staging a new package.
#
# It validates everything before changing any link, and refuses:
#   - a package missing any of the three bins or their dist files;
#   - a <shim dir>/<alias> that exists and is not a symlink (it never replaces
#     a real file or directory);
#   - a missing, relative or extra argument.
set -eu

usage='usage: scripts/install-offload-shims.sh <staged package dir> <shim dir>'
if [ "$#" -ne 2 ]; then
  echo "install-offload-shims: $usage" >&2
  exit 2
fi
pkg=$1
shims=$2
if [ -z "$pkg" ] || [ -z "$shims" ]; then
  echo "install-offload-shims: $usage" >&2
  exit 2
fi

case "$pkg" in
  /*) ;;
  *)
    echo "install-offload-shims: package dir must be absolute: $pkg" >&2
    exit 1
    ;;
esac

# alias:bin pairs
pairs='cargo:boat-offload-cargo
npm:boat-offload-node
pnpm:boat-offload-node
yarn:boat-offload-node
npx:boat-offload-node
pytest:boat-offload-python
python:boat-offload-python
python3:boat-offload-python'

# Preflight: every package file and every destination, before any mutation.
for f in bin/boat-offload-cargo bin/boat-offload-node bin/boat-offload-python \
  dist/offload/shim-main.js dist/offload/shim-node.js; do
  if [ ! -f "$pkg/$f" ]; then
    echo "install-offload-shims: $pkg has no $f; stage a package built with the shims." >&2
    exit 1
  fi
done
if [ -e "$shims" ] && [ ! -d "$shims" ]; then
  echo "install-offload-shims: $shims exists and is not a directory." >&2
  exit 1
fi
for pair in $pairs; do
  name=${pair%%:*}
  if { [ -e "$shims/$name" ] || [ -L "$shims/$name" ]; } && [ ! -L "$shims/$name" ]; then
    echo "install-offload-shims: $shims/$name exists and is not a symlink; refusing to replace it." >&2
    exit 1
  fi
done

mkdir -p "$shims"
# An unpredictable staging directory inside the shim dir (same filesystem, so
# the final renames are atomic). It is always removed, on success or failure.
stage=
trap 'if [ -n "$stage" ]; then rm -rf "$stage"; fi' EXIT
stage=$(mktemp -d "$shims/.install.XXXXXX")

# Build every link first; a failure here leaves the shim dir untouched.
for pair in $pairs; do
  ln -s "$pkg/bin/${pair#*:}" "$stage/${pair%%:*}"
done
# Then swap each into place with one rename.
for pair in $pairs; do
  name=${pair%%:*}
  mv -T "$stage/$name" "$shims/$name"
  echo "$shims/$name -> $pkg/bin/${pair#*:}"
done
