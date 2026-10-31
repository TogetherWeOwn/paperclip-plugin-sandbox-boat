#!/bin/sh
# Point a shim directory's `cargo` at a staged package's boat-offload-cargo.
# Put that directory first on PATH only for runs that should offload (with
# BOAT_OFFLOAD=1); the shim falls back to the next `cargo` on PATH.
#
# Usage: scripts/install-offload-shims.sh <staged package dir> <shim dir>
#   Creates <shim dir> if needed and replaces <shim dir>/cargo in one rename,
#   so a run never sees it missing. Run it again after staging a new package.
#
# It refuses:
#   - a package without bin/boat-offload-cargo and its dist;
#   - a <shim dir>/cargo that is not a symlink (it never replaces a real file).
set -eu

usage='usage: scripts/install-offload-shims.sh <staged package dir> <shim dir>'
pkg=${1:?$usage}
shims=${2:?$usage}

case "$pkg" in
  /*) ;;
  *)
    echo "install-offload-shims: package dir must be absolute: $pkg" >&2
    exit 1
    ;;
esac
target="$pkg/bin/boat-offload-cargo"
if [ ! -f "$target" ] || [ ! -f "$pkg/dist/offload/shim-main.js" ]; then
  echo "install-offload-shims: $pkg has no bin/boat-offload-cargo with its dist; stage a package built with the shims." >&2
  exit 1
fi
if [ -e "$shims/cargo" ] && [ ! -L "$shims/cargo" ]; then
  echo "install-offload-shims: $shims/cargo exists and is not a symlink; refusing to replace it." >&2
  exit 1
fi

mkdir -p "$shims"
tmp="$shims/.cargo.$$"
ln -s "$target" "$tmp"
mv -T "$tmp" "$shims/cargo"
echo "$shims/cargo -> $target"
