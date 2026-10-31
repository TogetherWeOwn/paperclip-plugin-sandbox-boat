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
   * builds the commit with `scripts/stage-package.sh`, which refuses a commit that is not on `main` and runs `npm run check`;
   * attaches `sandbox-boat-X.Y.Z-<short sha>.tgz` and `.tgz.sha256` to a new GitHub Release, with that `CHANGELOG.md` section as its notes. A release that already exists is never overwritten.

A tag push runs the workflow file at the tagged commit. To release a tag whose commit predates the workflow (as with the `v0.2.3` backfill), push the tag and then run the workflow from `main` by hand: `gh workflow run release.yml -f tag=vX.Y.Z`.

## Install a release

```sh
gh release download vX.Y.Z -R TogetherWeOwn/paperclip-plugin-sandbox-boat
sha256sum -c sandbox-boat-X.Y.Z-*.tgz.sha256
tar -xzf sandbox-boat-X.Y.Z-*.tgz -C <plugin packages root>
```

The tarball holds the same read-only directory that `stage-package.sh` stages. Its `node_modules/@paperclipai/plugin-sdk` links to `/app/packages/plugins/sdk`, the SDK path inside the Paperclip container. Then install it as described in the README's [Install on a Paperclip host](../README.md#install-on-a-paperclip-host).
