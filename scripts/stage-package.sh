#!/bin/sh
# Build the plugin package from one pushed commit and stage it, read-only, in a
# plugin packages root. It never builds from the working tree, so a stale or
# uncommitted dist cannot end up on a host.
#
# Usage: scripts/stage-package.sh <commit> <plugin packages root>
#   The package lands in <root>/sandbox-boat-<version>-<short sha>.
#   The package is self-contained: it carries real copies of its runtime
#   dependencies (@boatdev/sdk, @paperclipai/plugin-sdk, @paperclipai/shared
#   and zod) under node_modules. A local-path install runs the package in
#   place and installs nothing for it, so the worker resolves those copies by
#   the usual node_modules walk. The plugin-sdk copy is the pinned version in
#   package.json `dependencies`, the one the build and the host-contract
#   tests ran against. No host SDK path is baked in and nothing is symlinked:
#   an absolute link made every tarball before 0.2.6 unloadable off the host
#   that built it.
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
#   - a build that does not leave the workspace's .paperclip-runtime out of
#     boat's snapshots (~/.boatignore) before Paperclip syncs the run's files,
#     a build that links it into /tmp (Paperclip refuses that link and fails
#     every run), or one that does not make every command's tar skip
#     .paperclip-runtime members;
#   - a package that holds a symlink, or whose dist/index.js does not import
#     cleanly from the staged node_modules alone;
#   - a destination that already exists.
set -eu

ENV_FILE_FIX=0721a3af3f7f417f2cebafb30d3212d5c1182656

commit=${1:?usage: scripts/stage-package.sh <commit> <plugin packages root>}
root=${2:?usage: scripts/stage-package.sh <commit> <plugin packages root>}
if [ $# -gt 2 ]; then
  echo "stage-package: unexpected argument: $3 (the package bundles its pinned plugin-sdk; there is no host SDK path to give)" >&2
  exit 1
fi

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
# The offload shims (package.json "files"); commits before them have no bin.
if [ -d "$work/src/bin" ]; then cp -R "$work/src/bin" "$pkg/"; fi
# docs/ is absent on the oldest supported commits.
if [ -d "$work/src/docs" ]; then cp -R "$work/src/docs" "$pkg/"; fi
mkdir -p "$pkg/node_modules/@boatdev" "$pkg/node_modules/@paperclipai"
cp -R "$work/src/node_modules/@boatdev/sdk" "$pkg/node_modules/@boatdev/sdk"
# The plugin-sdk is a pinned runtime dependency now, not a peer the host has
# to supply: copy the real package the build used, with the runtime
# dependencies its entry point loads (@paperclipai/shared, zod). @boatdev/sdk
# has none. The import check below runs the whole dist graph against only
# these copies, so a missing transitive dep refuses the package instead of
# failing on the host at worker start.
cp -R "$work/src/node_modules/@paperclipai/plugin-sdk" "$pkg/node_modules/@paperclipai/plugin-sdk"
# Present at the top level unless npm nested them under the SDK (the SDK copy
# above carries its nested deps with it); the import check is the arbiter.
if [ -d "$work/src/node_modules/@paperclipai/shared" ]; then cp -R "$work/src/node_modules/@paperclipai/shared" "$pkg/node_modules/@paperclipai/shared"; fi
if [ -d "$work/src/node_modules/zod" ]; then cp -R "$work/src/node_modules/zod" "$pkg/node_modules/zod"; fi
echo "$sha" > "$pkg/.source-commit"

# No link may leave the package: a tarball of it has to load on any host.
# There is no reason for a link at all, so refuse any.
if [ -n "$(find "$pkg" -type l -print -quit)" ]; then
  echo "stage-package: the staged package holds a symlink; refusing." >&2
  find "$pkg" -type l >&2
  exit 1
fi
# The worker's module graph must resolve from the staged node_modules alone.
# dist/index.js pulls in the plugin, the SDK and @boatdev/sdk without
# starting the worker host, so importing it here (pkg has no node_modules
# ancestor in the work dir) proves the copies above are the whole runtime set.
if ! node --input-type=module -e 'await import(process.argv[1])' "$pkg/dist/index.js"; then
  echo "stage-package: dist/index.js does not import from the staged node_modules alone; refusing." >&2
  exit 1
fi

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
# Acquire, resumed leases and realize must leave <root>/.paperclip-runtime out
# of boat's snapshots with a ~/.boatignore rule, before Paperclip syncs the
# run's files, and keep it a real directory: Paperclip refuses a symlink there
# before every run (0.2.0 linked it into /tmp, and every run failed).
if ! grep -qF 'runtimeDirScript(' "$pkg/dist/vm-manager.js" || ! grep -qF '.boatignore' "$pkg/dist/shell.js"; then
  echo "stage-package: dist does not leave Paperclip's runtime directory out of boat snapshots (~/.boatignore); refusing (the run JWT would be in boat's per-minute snapshots)." >&2
  exit 1
fi
if grep -qF '/tmp/paperclip-boat-runtime-' "$pkg/dist/shell.js"; then
  echo "stage-package: dist links .paperclip-runtime into /tmp; refusing (Paperclip refuses a symlinked runtime directory and fails every run)." >&2
  exit 1
fi
# Every command script must tell GNU tar to skip .paperclip-runtime members:
# Paperclip's inbound workspace tar carries one from the host, and its extract
# would unpack the host's runtime files over the run's.
if ! grep -qF 'TAR_OPTIONS="--exclude=.paperclip-runtime' "$pkg/dist/shell.js"; then
  echo "stage-package: dist does not keep Paperclip's workspace extract off the runtime directory; refusing." >&2
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
