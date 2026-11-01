# Releasing

Releases are git tags with a GitHub Release. Each release has the staged package attached as a tarball, with its `.sha256` file. Nothing is published to npm.

## Cut a release

1. In one PR, set the new version in `package.json` (and `package-lock.json`, with `npm version --no-git-tag-version X.Y.Z`) and in `PLUGIN_VERSION` in `src/manifest.ts`. Add a `## X.Y.Z` section to `CHANGELOG.md`. Merge it to `main`.
2. Get the owner's approval for the tag and name the exact commit. Then tag that merge commit on `main` and push the tag:

   ```sh
   git fetch origin
   git tag -a vX.Y.Z <commit> -m vX.Y.Z
   git push origin vX.Y.Z
   ```

3. The tag push runs the [release workflow](https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat/blob/main/.github/workflows/release.yml), which uses only `GITHUB_TOKEN`. The workflow:
   * fails unless the tag, `package.json` `version` and `PLUGIN_VERSION` agree at the tagged commit (`scripts/check-release-version.sh`), and unless `CHANGELOG.md` has a section for the version (`scripts/release-notes.sh`);
   * builds the commit with `scripts/stage-package.sh`, which refuses a commit that is not on `main`, runs `npm run check`, and stages a self-contained package (real copies of the runtime dependencies, the pinned `@paperclipai/plugin-sdk` included; no symlinks);
   * fails if the built tarball holds any symlink or hardlink (`scripts/check-tarball-links.sh`). Before 0.2.6 the tarball carried the SDK as an absolute symlink to the build host's path and could not load anywhere else;
   * attaches `sandbox-boat-X.Y.Z-<short sha>.tgz` and `.tgz.sha256` to a new GitHub Release, with that `CHANGELOG.md` section as its notes. A release that already exists is never overwritten.

A tag push runs the workflow file at the tagged commit. To release a tag whose commit predates the workflow (as with the `v0.2.3` backfill), push the tag and then run the workflow from `main` by hand: `gh workflow run release.yml -f tag=vX.Y.Z`.

## Install a release

```sh
gh release download vX.Y.Z -R TogetherWeOwn/paperclip-plugin-sandbox-boat
sha256sum -c sandbox-boat-X.Y.Z-*.tgz.sha256
tar -xzf sandbox-boat-X.Y.Z-*.tgz -C <plugin packages root>
```

The tarball holds the same read-only directory that `stage-package.sh` stages, and it is self-contained: `node_modules/@paperclipai/plugin-sdk` is a real copy of the pinned SDK (see the README's [Install on a Paperclip host](../README.md#install-on-a-paperclip-host) for why a local-path install needs that), so the plain `tar -xzf` above is the whole install preparation on any host. `scripts/stage-release.sh <tarball> <plugin packages root>` does the same landing with checks: the `.sha256`, one package directory holding only files and directories, a bundled plugin-sdk, and the name against `package.json` and `.source-commit`. Tarballs before 0.2.6 carry an absolute plugin-sdk symlink instead and are refused by it; stage those with the `stage-release.sh` of their own tag. Then install the staged directory with `POST /api/plugins/install` and `isLocalPath: true`, as the README describes. No step on the host touches the SDK.
