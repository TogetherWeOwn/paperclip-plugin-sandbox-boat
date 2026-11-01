#!/bin/sh
# Stage a downloaded GitHub Release tarball, read-only, in a plugin packages
# root. The package is self-contained (its node_modules holds real copies of
# the pinned @paperclipai/plugin-sdk and the other runtime dependencies), so
# there is nothing host-specific to adjust on the way in: this script only
# verifies the tarball and lands it read-only. Plain `tar -xzf` into the root
# works too; the script adds the checks below. (Tarballs before 0.2.6 are
# refused here: they carry an absolute plugin-sdk symlink to the build host's
# SDK. Stage those with the stage-release.sh of their own tag.)
#
# Usage: scripts/stage-release.sh <tarball> <plugin packages root>
#   <tarball> is sandbox-boat-<version>-<short sha>.tgz, with its .sha256 file
#   next to it (gh release download fetches both).
#   The package lands in <root>/sandbox-boat-<version>-<short sha>.
#   sudo is used only for the final move when <root> is not writable.
#
# It refuses:
#   - a tarball whose .sha256 is missing or does not match;
#   - a tarball that is not one sandbox-boat-<version>-<sha> directory, holds
#     anything but files and directories (no links: one parked the SDK on the
#     build host's path until 0.2.6), has no bundled plugin-sdk package, or
#     whose package.json version or .source-commit disagree with its name;
#   - a destination that already exists.
set -eu

usage='usage: scripts/stage-release.sh <tarball> <plugin packages root>'
tarball=${1:?$usage}
root=${2:?$usage}
if [ $# -gt 2 ]; then
  echo "stage-release: unexpected argument: $3 (the package bundles its pinned plugin-sdk; there is no host SDK path to give)" >&2
  exit 1
fi

file=$(basename "$tarball")
name=${file%.tgz}
case "$name" in
  sandbox-boat-*-*) ;;
  *)
    echo "stage-release: $file is not a sandbox-boat-<version>-<sha>.tgz release asset" >&2
    exit 1
    ;;
esac
if [ ! -f "$tarball.sha256" ]; then
  echo "stage-release: $tarball.sha256 is missing" >&2
  exit 1
fi
# Compare the hash itself: `sha256sum -c` would check whichever file the
# .sha256 names, which need not be this tarball.
want=$(cat "$tarball.sha256")
got=$(cd "$(dirname "$tarball")" && sha256sum "$file")
if [ "$want" != "$got" ]; then
  echo "stage-release: $file does not match $file.sha256" >&2
  exit 1
fi

dest="$root/$name"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "stage-release: $dest already exists" >&2
  exit 1
fi

SUDO=
[ -w "$root" ] || SUDO=sudo
partial=
work=$(mktemp -d "${TMPDIR:-/tmp}/stage-release-XXXXXX")
cleanup() {
  chmod -R u+w "$work" 2>/dev/null || true
  rm -rf "$work"
  if [ -n "$partial" ] && [ -e "$partial" ]; then $SUDO rm -rf "$partial"; fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Links are checked on the listing first: a hardlink unpacks as a plain file,
# so the find check on the unpacked tree below cannot see it. tar -t verbose
# mode strings start with the member type: l for a symlink, h for a hardlink
# (the same test as scripts/check-tarball-links.sh).
links=$(tar -tvzf "$tarball" | awk '$1 ~ /^[lh]/')
if [ -n "$links" ]; then
  echo "stage-release: $file holds a link; the package must be plain files and directories" >&2
  printf '%s\n' "$links" >&2
  exit 1
fi

# GNU tar refuses members with .. and strips a leading /; what it unpacks is
# then checked before anything reaches the root.
tar -xzf "$tarball" -C "$work" --no-same-owner --no-same-permissions
top=$(find "$work" -mindepth 1 -maxdepth 1)
if [ "$top" != "$work/$name" ] || [ ! -d "$work/$name" ] || [ -L "$work/$name" ]; then
  echo "stage-release: $file must hold exactly one directory, $name" >&2
  exit 1
fi
pkg="$work/$name"
chmod -R u+w "$pkg"
if [ -n "$(find "$pkg" ! -type f ! -type d)" ]; then
  echo "stage-release: $file holds a link or special file; the package must be plain files and directories" >&2
  find "$pkg" ! -type f ! -type d >&2
  exit 1
fi
sdk_pkg="$pkg/node_modules/@paperclipai/plugin-sdk/package.json"
sdk_name=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)}catch{}' "$sdk_pkg")
if [ "$sdk_name" != "@paperclipai/plugin-sdk" ]; then
  echo "stage-release: $file carries no bundled @paperclipai/plugin-sdk under node_modules; it cannot load as a local-path install" >&2
  exit 1
fi
version=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$pkg/package.json")
short=${name#"sandbox-boat-$version-"}
if [ "$short" = "$name" ] || [ ! -f "$pkg/.source-commit" ]; then
  echo "stage-release: $name does not match its package.json version $version" >&2
  exit 1
fi
case "$(cat "$pkg/.source-commit")" in
  "$short"*) ;;
  *)
    echo "stage-release: .source-commit does not start with $short" >&2
    exit 1
    ;;
esac
if [ ! -f "$pkg/dist/worker.js" ]; then
  echo "stage-release: $name has no dist/worker.js" >&2
  exit 1
fi
if [ ! -d "$pkg/bin" ]; then
  echo "stage-release: warning: $name has no bin/ (built before stage-package.sh shipped the offload shims); it cannot serve as a shim dir." >&2
fi

# Same order as stage-package.sh: copy next to the destination, rename in one
# step, make it read-only last. mktemp gives the partial copy a name nobody can
# plant first, and mv -T never moves it into a $dest that appeared meanwhile.
partial=$($SUDO mktemp -d "$root/.$name.partial.XXXXXX")
$SUDO cp -R -P "$pkg/." "$partial"
$SUDO chmod 755 "$partial"
if [ -n "$SUDO" ]; then $SUDO chown -R -h "$(id -u):$(id -g)" "$partial"; fi
$SUDO mv -T "$partial" "$dest"
$SUDO chmod -R a-w "$dest"
echo "$dest"
