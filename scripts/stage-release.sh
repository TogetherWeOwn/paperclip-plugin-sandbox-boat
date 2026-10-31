#!/bin/sh
# Stage a downloaded GitHub Release tarball, read-only, in a plugin packages
# root, with its plugin-sdk link pointed at this host's own SDK. The tarball
# links the SDK to /app/packages/plugins/sdk (the Paperclip container); a
# native npm install keeps it elsewhere.
#
# Usage: scripts/stage-release.sh <tarball> <plugin packages root> [<host plugin-sdk path>]
#   <tarball> is sandbox-boat-<version>-<short sha>.tgz, with its .sha256 file
#   next to it (gh release download fetches both).
#   The package lands in <root>/sandbox-boat-<version>-<short sha>.
#   <host plugin-sdk path> defaults to the first that exists of
#   $PAPERCLIP_HOME/cli/current/node_modules/@paperclipai/plugin-sdk
#   ($PAPERCLIP_HOME defaults to ~/.paperclip) and /app/packages/plugins/sdk.
#   The link keeps the path as given: through cli/current it follows Paperclip
#   upgrades, which re-point `current` and prune old installs/npm/<version>.
#   sudo is used only for the final move when <root> is not writable.
#
# It refuses:
#   - a tarball whose .sha256 is missing or does not match;
#   - a tarball that is not one sandbox-boat-<version>-<sha> directory, holds
#     anything but files, directories and the one plugin-sdk link, or whose
#     package.json version or .source-commit disagree with its name;
#   - a host SDK path that is not a @paperclipai/plugin-sdk package, or that is
#     inside a versioned Paperclip install (cli/installs/);
#   - a destination that already exists.
set -eu

usage='usage: scripts/stage-release.sh <tarball> <plugin packages root> [<host plugin-sdk path>]'
tarball=${1:?$usage}
root=${2:?$usage}

if [ $# -ge 3 ]; then
  host_sdk=$3
else
  home_sdk="${PAPERCLIP_HOME:-$HOME/.paperclip}/cli/current/node_modules/@paperclipai/plugin-sdk"
  if [ -d "$home_sdk" ]; then
    host_sdk=$home_sdk
  elif [ -d /app/packages/plugins/sdk ]; then
    host_sdk=/app/packages/plugins/sdk
  else
    echo "stage-release: no host plugin-sdk at $home_sdk or /app/packages/plugins/sdk; pass its path." >&2
    exit 1
  fi
fi
case "$host_sdk" in
  /*) ;;
  *)
    echo "stage-release: host SDK path must be absolute: $host_sdk" >&2
    exit 1
    ;;
esac
case "$host_sdk" in
  */cli/installs/*)
    echo "stage-release: $host_sdk is inside one versioned Paperclip install; link through cli/current instead (the next upgrade prunes it)." >&2
    exit 1
    ;;
esac
sdk_name=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)}catch{}' "$host_sdk/package.json")
if [ "$sdk_name" != "@paperclipai/plugin-sdk" ]; then
  echo "stage-release: $host_sdk is not a @paperclipai/plugin-sdk package" >&2
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
partial="$dest.partial.$$"
work=$(mktemp -d "${TMPDIR:-/tmp}/stage-release-XXXXXX")
cleanup() {
  chmod -R u+w "$work" 2>/dev/null || true
  rm -rf "$work"
  if [ -e "$partial" ]; then $SUDO rm -rf "$partial"; fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

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
link="$pkg/node_modules/@paperclipai/plugin-sdk"
if [ -n "$(find "$pkg" ! -type f ! -type d ! -path "$link")" ] || [ ! -L "$link" ]; then
  echo "stage-release: $file holds a link or special file other than node_modules/@paperclipai/plugin-sdk" >&2
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

rm "$link"
ln -s "$host_sdk" "$link"

# Same order as stage-package.sh: copy next to the destination, rename in one
# step, make it read-only last.
$SUDO cp -R -P "$pkg" "$partial"
if [ -n "$SUDO" ]; then $SUDO chown -R -h "$(id -u):$(id -g)" "$partial"; fi
$SUDO mv "$partial" "$dest"
$SUDO chmod -R a-w "$dest"
echo "$dest"
