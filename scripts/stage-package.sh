#!/bin/sh
# Build the plugin package from one pushed commit and stage it, read-only, in a
# plugin packages root. It never builds from the working tree, so a stale or
# uncommitted dist cannot end up on a host.
#
# Usage: scripts/stage-package.sh <commit> <plugin packages root> [<host plugin-sdk path>]
#   The package lands in <root>/sandbox-boat-<version>-<short sha>.
#   <host plugin-sdk path> is where the Paperclip server sees its own SDK
#   (default /app/packages/plugins/sdk, as in the Paperclip container).
#   sudo is used only for the final move when <root> is not writable.
#
# It refuses:
#   - a commit that is not on origin/main (run `git fetch origin` first);
#   - a commit older than the env-file fix (0721a3a): before it, the run env
#     file sat in the workspace, where `git add -A` and boat snapshots could
#     pick up the tokens in it;
#   - a build without the run env allowlist (0.2.0): before it, every env key
#     Paperclip passed, project secrets included, reached the VM;
#   - a build that does not delete Paperclip's run MCP config (run JWT) before
#     it stops, deletes or snapshots a VM;
#   - a build that does not link the workspace's .paperclip-runtime into /tmp
#     (which boat never snapshots) before Paperclip syncs the run's files, or
#     that does not make every command's tar skip .paperclip-runtime members
#     (Paperclip's workspace extract would replace the link);
#   - a destination that already exists.
set -eu

ENV_FILE_FIX=0721a3af3f7f417f2cebafb30d3212d5c1182656

commit=${1:?usage: scripts/stage-package.sh <commit> <plugin packages root> [<host plugin-sdk path>]}
root=${2:?usage: scripts/stage-package.sh <commit> <plugin packages root> [<host plugin-sdk path>]}
host_sdk=${3:-/app/packages/plugins/sdk}

repo=$(git rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse --verify --quiet "$commit^{commit}") || {
  echo "stage-package: unknown commit: $commit" >&2
  exit 1
}
short=$(git -C "$repo" rev-parse --short=7 "$sha")

if ! git -C "$repo" merge-base --is-ancestor "$sha" refs/remotes/origin/main 2>/dev/null; then
  echo "stage-package: $short is not on origin/main. Push it (or git fetch origin) first." >&2
  exit 1
fi
if ! git -C "$repo" merge-base --is-ancestor "$ENV_FILE_FIX" "$sha" 2>/dev/null; then
  echo "stage-package: $short predates the env-file fix 0721a3a; refusing to stage it." >&2
  exit 1
fi

version=$(git -C "$repo" show "$sha:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
dest="$root/sandbox-boat-$version-$short"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "stage-package: $dest already exists" >&2
  exit 1
fi

SUDO=
[ -w "$root" ] || SUDO=sudo
partial="$dest.partial.$$"
work=$(mktemp -d "${TMPDIR:-/tmp}/stage-sandbox-boat-XXXXXX")
cleanup() {
  rm -rf "$work"
  if [ -e "$partial" ]; then $SUDO rm -rf "$partial"; fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

mkdir "$work/src" "$work/pkg"
git -C "$repo" archive "$sha" | tar -x -C "$work/src"
(
  cd "$work/src"
  npm ci --no-audit --no-fund
  npm run check # typecheck + tests + build
)

pkg="$work/pkg"
cp -R "$work/src/dist" "$work/src/package.json" "$work/src/README.md" "$work/src/LICENSE" "$pkg/"
mkdir -p "$pkg/node_modules/@boatdev" "$pkg/node_modules/@paperclipai"
cp -R "$work/src/node_modules/@boatdev/sdk" "$pkg/node_modules/@boatdev/sdk"
# Resolve the SDK the server itself runs, like the bundled providers do.
ln -s "$host_sdk" "$pkg/node_modules/@paperclipai/plugin-sdk"
echo "$sha" > "$pkg/.source-commit"

# The env file must never be named inside the workspace again.
if grep -rqF '.paperclip-boat-env-' "$pkg/dist"; then
  echo "stage-package: dist still stages the env file in the workspace; refusing." >&2
  exit 1
fi
# Execute must filter the run env through the allowlist (src/env-policy.ts).
if [ ! -f "$pkg/dist/env-policy.js" ] || ! grep -qF 'filterRunEnv(params.env' "$pkg/dist/vm-manager.js"; then
  echo "stage-package: dist has no run env allowlist; refusing (every env key would reach the VM)." >&2
  exit 1
fi
# Execute must refuse every ACP process-session step, including the command.b64
# upload of a large envelope (the old inline-only check missed it).
if ! grep -qF 'isAcpProcessSessionCommand(params.command' "$pkg/dist/vm-manager.js" || ! grep -qF 'process-sessions' "$pkg/dist/env-policy.js"; then
  echo "stage-package: dist does not refuse Paperclip's ACP process-session commands; refusing (its envelope carries the unfiltered env)." >&2
  exit 1
fi

# Release, stop, destroy, the sweep and template capture must delete Paperclip's
# run MCP config (it holds the run JWT) before boat saves the VM disk.
if ! grep -qF 'scrubRuntimeSecretsScript(' "$pkg/dist/vm-manager.js" || ! grep -qF 'mcp-config' "$pkg/dist/shell.js"; then
  echo "stage-package: dist does not remove Paperclip's run MCP config before stops; refusing (the run JWT would stay in boat snapshots)." >&2
  exit 1
fi
# Acquire, resumed leases and realize must link <root>/.paperclip-runtime into
# /tmp, which boat never snapshots, before Paperclip syncs the run's files.
if ! grep -qF 'linkRuntimeDirScript(' "$pkg/dist/vm-manager.js" || ! grep -qF '/tmp/paperclip-boat-runtime-' "$pkg/dist/shell.js"; then
  echo "stage-package: dist does not keep Paperclip's runtime directory under /tmp; refusing (the run JWT would be in boat's per-minute snapshots)." >&2
  exit 1
fi
# Every command script must tell GNU tar to skip .paperclip-runtime members:
# Paperclip's inbound workspace tar carries one from the host, and its extract
# would replace the link with a real directory on the saved disk.
if ! grep -qF 'TAR_OPTIONS="--exclude=.paperclip-runtime' "$pkg/dist/shell.js"; then
  echo "stage-package: dist does not keep Paperclip's workspace extract off the runtime link; refusing (the run JWT could land on the saved disk)." >&2
  exit 1
fi

# Copy next to the destination first (the work dir may be on another
# filesystem), then rename in one step, so a failed copy never leaves a
# half-written package under the final name. Read-only comes last: a directory
# without write permission cannot be renamed into another directory.
$SUDO cp -R -P "$pkg" "$partial"
if [ -n "$SUDO" ]; then $SUDO chown -R -h "$(id -u):$(id -g)" "$partial"; fi
$SUDO mv "$partial" "$dest"
$SUDO chmod -R a-w "$dest"
echo "$dest"
