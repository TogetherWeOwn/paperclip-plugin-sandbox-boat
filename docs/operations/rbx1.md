# rbx1: install, configure and roll back heavy-command offload

This is the procedure for one host, rbx1, and one pilot repository, two-bot-next. It covers installing the plugin, the TWO company plugin config, giving two-bot-next runs the Cargo shim, and rollback. Agents stay on rbx1. Only eligible Cargo commands go to boat.

Writing this procedure installed nothing. Run it only after the owner has:

* renewed the boat plan (named snapshots need a paid plan);
* stored the scoped keys as company secrets `BOAT_CI_API_KEY` and `BOAT_READONLY_API_KEY`, with the account settings in the README's [boat account settings](../../README.md#boat-account-settings);
* approved the install with the capabilities below, and the spend caps.

## The host

rbx1 runs Paperclip as a native npm install, not the container. The server runs from `~/.paperclip/cli/current`, a link to `~/.paperclip/cli/installs/npm/<version>`. `paperclipai update` installs the new version next to the old one, then renames `current` in one step. It keeps the two previous installs and deletes older ones. `paperclipai update --rollback` flips `current` back.

So the plugin must reach the host SDK through `current`:

```
~/.paperclip/cli/current/node_modules/@paperclipai/plugin-sdk
```

A link to `installs/npm/<version>/...` would keep the old SDK after an upgrade, and break when that install is pruned. `stage-package.sh` and `stage-release.sh` refuse such a path. Node resolves the link each time the worker starts, so after a Paperclip upgrade and restart the worker loads the new SDK with no restaging.

`PAPERCLIP_HOME` is `/home/ubuntu/.paperclip`. Paperclip agent runs get a different `HOME`. Run the steps below as `ubuntu` in a normal login shell, not from an agent run.

Paths used below:

| What | Path |
|---|---|
| Plugin packages root | `/home/ubuntu/.paperclip/plugin-packages` |
| Shim dir | `/home/ubuntu/.paperclip/boat-offload/bin` |
| Artifact root (`offloadArtifactRoot`) | `/home/ubuntu/.paperclip/boat-offload/artifacts` |
| Guest cgroup parent (`offloadCgroupParent`) | `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service` (the delegated guest template) |

## 1. Which release

Install the first release that has all of these:

* `bin/` in the package. Before this runbook's change, `stage-package.sh` left the shims out, so `v0.2.3` has none;
* the local-run agent guard (PR #34). Without it, another agent in the company could reuse a live run's id;
* the two-bot-next routing parity (PR #35).

`v0.2.3` has none of the three. It only serves as the staging dry run. Cut the next release as [docs/releasing.md](../releasing.md) describes, and use it below as `vX.Y.Z`.

## 2. Stage the package

```sh
mkdir -p /home/ubuntu/.paperclip/plugin-packages
cd "$(mktemp -d)"
gh release download vX.Y.Z -R TogetherWeOwn/paperclip-plugin-sandbox-boat
git clone -q https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat src
src/scripts/stage-release.sh "$PWD"/sandbox-boat-X.Y.Z-*.tgz /home/ubuntu/.paperclip/plugin-packages
# prints /home/ubuntu/.paperclip/plugin-packages/sandbox-boat-X.Y.Z-<sha>
```

`stage-release.sh` checks the `.sha256`, checks that the tarball holds only the one package directory and its one SDK link, and checks `package.json` and `.source-commit` against the file name. It then points the SDK link at the path above, makes the package read-only, and moves it in under its own name. With no third argument it uses `$PAPERCLIP_HOME/cli/current/...`.

To build from source instead, give the SDK path as the third argument:

```sh
git fetch origin
scripts/stage-package.sh <commit on main> /home/ubuntu/.paperclip/plugin-packages \
  /home/ubuntu/.paperclip/cli/current/node_modules/@paperclipai/plugin-sdk
```

Check it before installing:

```sh
PKG=/home/ubuntu/.paperclip/plugin-packages/sandbox-boat-X.Y.Z-<sha>
readlink "$PKG/node_modules/@paperclipai/plugin-sdk"   # the cli/current path
cat "$PKG/.source-commit"                              # the tagged commit
ls "$PKG/bin"                                          # boat-offload-cargo, -node, -python
```

## 3. Install

Use an instance-admin board session. Agent keys cannot install plugins. `packageName` is the staged path. The host resolves it with `realpath`, records it, and runs the worker from it in place.

```sh
PAPERCLIP=https://<paperclip host>
curl -fsS -X POST "$PAPERCLIP/api/plugins/install" \
  -H "Authorization: Bearer $BOARD_TOKEN" -H 'content-type: application/json' \
  -d "{\"packageName\":\"$PKG\",\"isLocalPath\":true}"
# note the returned "id": PLUGIN_ID
```

The board approves these capabilities:

| Capability | Used for |
|---|---|
| `environment.drivers.register` | the `boat` sandbox driver |
| `plugin.state.read`, `plugin.state.write` | VM records, leases, receipts, usage |
| `jobs.schedule` | the idle sweep every 5 minutes |
| `api.routes.register` | `/usage`, `/sweep` (board) and the `offload_*` routes (agent) |
| `issues.read` | seeing whether a card is done, and the run's issue workspace |
| `events.subscribe` | `agent.run.started/finished/failed/cancelled` for local-run binding |
| `execution.workspaces.read` | the local path and repository of the run's workspace |
| `secrets.read-ref` | resolving `BOAT_CI_API_KEY` for each binding, never stored |

Check that it is ready: `curl -fsS -H "Authorization: Bearer $BOARD_TOKEN" "$PAPERCLIP/api/plugins/$PLUGIN_ID/health"`.

## 4. Pool environment

Local-run offload takes its pool identity from a `boat` sandbox environment. In Company settings → Environments, create one with provider `boat` and its `apiKey` set to the `BOAT_CI_API_KEY` secret. Do not assign it to any agent or project: agents stay local. Run *Probe*, which starts no VM. Its id is `ENV_ID` below.

## 5. TWO company plugin config

Look up the secret id. The plugin config needs a secret ref, not the key:

```sh
CID=<TWO company id>
curl -fsS -H "Authorization: Bearer $BOARD_TOKEN" "$PAPERCLIP/api/companies/$CID/secrets"
# the id of the entry named BOAT_CI_API_KEY: SECRET_ID
```

Save the config in two steps. First save it with every flag off. Saving it through this route is what writes the plugin's secret binding, so `secrets.read-ref` can resolve the ref later:

```sh
curl -fsS -X POST "$PAPERCLIP/api/plugins/$PLUGIN_ID/config" \
  -H "Authorization: Bearer $BOARD_TOKEN" -H 'content-type: application/json' -d @- <<EOF
{"companyId":"$CID","configJson":{
  "offloadExecutorEnabled": false,
  "offloadGuestTransportEnabled": false,
  "offloadLocalRunsEnabled": false,
  "offloadLocalEnvironmentId": "$ENV_ID",
  "offloadLocalApiKeySecretRef": {"type": "secret_ref", "secretId": "$SECRET_ID"},
  "offloadLocalDriverConfig": {
    "size": "default",
    "templateSnapshot": "<named snapshot from the guest template>",
    "maxOffloadVms": 2,
    "offloadIdleStopSeconds": 15
  },
  "offloadAllowedRepos": ["repo:https://github.com/togetherweown/two-bot-next"],
  "offloadProfiles": ["rust-public-1"],
  "offloadCgroupParent": "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service",
  "offloadArtifactRoot": "/home/ubuntu/.paperclip/boat-offload/artifacts",
  "offloadMonthlyVmHourCap": 20
}}
EOF
```

Then, when the one-VM smoke starts, save the same config with the three flags `true`. Only literal `true` turns a flag on.

* `offloadAllowedRepos` holds two-bot-next only, in the route's canonical form: lowercase URL, no `.git` and no trailing slash. An empty list denies every repository.
* `maxOffloadVms` and `offloadIdleStopSeconds` are driver settings, so they go in `offloadLocalDriverConfig`. An `apiKey` there is ignored; the key comes from the secret ref.
* `offloadMonthlyVmHourCap: 20` is the pilot's VM-hour cap. When it is reached, commands run locally until the next month.
* Create the artifact root first, private and outside every checkout: `install -d -m 700 /home/ubuntu/.paperclip/boat-offload/artifacts`.

## 6. Shim for two-bot-next runs only

Point the shim dir's `cargo` at the installed package:

```sh
src/scripts/install-offload-shims.sh "$PKG" /home/ubuntu/.paperclip/boat-offload/bin
```

Then set two env entries on the **two-bot-next project**. Paperclip adds a project's env only to runs on that project's issues, so other projects do not get them. Project env replaces `PATH` and does not expand `$PATH`, so write the whole value:

* the shim dir first;
* then `/home/ubuntu/.cargo/bin`. The shim falls back to the next `cargo` on `PATH` after its own dir, and the server's `PATH` has no Cargo. Without it, every fallback fails with `no real cargo on PATH`, exit 127;
* then the server's own `PATH`, read from the running server.

```sh
SERVER_PATH=$(tr '\0' '\n' < "/proc/$(pgrep -f 'paperclipai/dist/index.js run' | head -n 1)/environ" | sed -n 's/^PATH=//p')
PROJECT_ID=<two-bot-next project id>   # GET /api/companies/$CID/projects
curl -fsS -X PATCH "$PAPERCLIP/api/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $BOARD_TOKEN" -H 'content-type: application/json' -d @- <<EOF
{"env":{
  "BOAT_OFFLOAD": {"type": "plain", "value": "1"},
  "PATH": {"type": "plain", "value": "/home/ubuntu/.paperclip/boat-offload/bin:/home/ubuntu/.cargo/bin:$SERVER_PATH"}
}}
EOF
```

`PATCH` replaces the project's whole `env`. If it already has entries, include them. two-bot-next has none today.

Paperclip's managed GitHub launcher still puts its own dir in front of this `PATH`, so `git push` is unchanged. `scripts/cargo_cache.py` finds `cargo` with `shutil.which`, so it reaches the shim. In a fallback, the shim runs the real Cargo once, with its dir removed from `PATH` and `BOAT_OFFLOAD_SHIM_ACTIVE=1`, so the run cannot loop back into the shim.

Check it from a two-bot-next run, and from a run on any other project:

```sh
command -v cargo        # two-bot-next: the shim dir; elsewhere: no shim
echo "$BOAT_OFFLOAD"    # two-bot-next: 1; elsewhere: empty
cargo --version         # both: the real toolchain (ineligible, runs locally)
"$(readlink /home/ubuntu/.paperclip/boat-offload/bin/cargo)" --dry-run --json -- check --locked   # two-bot-next: classification, no VM
```

If the server's `PATH` changes later, or rustup moves, update the project `PATH`.

## 7. After a Paperclip upgrade

Nothing to restage: the SDK link goes through `current`. After the restart:

* check that the plugin's `health` is ready;
* run *Probe* on the pool environment;
* run the dry-run check from step 6.

The plugin's contract tests (`src/host-contract.test.ts`) pin one Paperclip version. Before enabling offload on a new Paperclip version, run them against that version's SDK.

To change the plugin version, stage the new release next to the old one. The host's upgrade route re-reads the path it recorded, so it cannot move the plugin to a new directory. Moving to a new directory is a reinstall. Plan it on its own card, then re-run `install-offload-shims.sh` with the new package. Delete the old package directory only after nothing uses it: `chmod -R u+w <dir> && rm -rf <dir>`.

## 8. Rollback

Each step stands alone and takes effect on the next command. Stop at the first one that is enough.

1. **Shim off:** set the project env `BOAT_OFFLOAD` to `0`, or remove the entry. From the next run, the shim runs local Cargo with no broker call. `cargo_cache.py` and its local path are unchanged.
2. **Flags off:** save the company plugin config with `offloadExecutorEnabled`, `offloadGuestTransportEnabled` and `offloadLocalRunsEnabled` set to `false`. New commands stay local. Commands in flight settle, and their receipts and staged artifacts are kept.
3. **Uninstall:** wait until no offload command is running. Then uninstall from the Plugins page, or call `curl -fsS -X DELETE -H "Authorization: Bearer $BOARD_TOKEN" "$PAPERCLIP/api/plugins/$PLUGIN_ID"`. Add `?purge=true` only to delete the plugin's state too.
4. **Delete VMs:** list the account's VMs with the boat CLI, then delete every `paperclip-*` VM with `boat delete <id> --yes`. List them again to check that none are left. A stopped VM still holds disk.
5. **Clean up the host:** remove `BOAT_OFFLOAD` and `PATH` from the two-bot-next project env, delete the shim dir, and, after reviewing the artifact root, delete it. Delete the package directory as in step 7.

Keep the steps in this order. Turning the shim or flags off first means no new command can start a VM while you delete them.
