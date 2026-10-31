# paperclip-plugin-sandbox-boat

A [Paperclip](https://github.com/paperclipai/paperclip) sandbox-provider plugin that runs agent work on [boat.dev](https://boat.dev) VMs. A VM exists for one card and runs only while a run on that card needs it.

It started as a copy of Paperclip's bundled `exe-dev` provider. All boat calls go through the official TypeScript SDK, [`@boatdev/sdk`](https://docs.boat.dev/sdks/typescript) (pinned to 1.10.0). There is no hand-written REST client.

## Overview

* **One VM per card.** A card's VM is created or resumed when a run needs it and stopped on release, so the checkout and build output stay on its disk between runs. See [Lease lifecycle](docs/design/lifecycle.md).
* **Budget guard on every start.** Each create or resume checks boat's limits first and fails fast; an idle sweep and boat's auto-stop deadline stop forgotten VMs. See [Budget and caps](docs/operations.md#budget-and-caps).
* **Per-run cost accounting** from boat's own usage meter, through a board-authenticated route. See [Usage accounting](docs/operations.md#usage-accounting).
* **Optional heavy-command offload** (Cargo, Node, Python) to a shared VM pool while the agent stays on the host. Default OFF. See [Offload](docs/offload.md).

## Safety defaults

* **Default-deny run env.** Only names on the [env allowlist](docs/security.md#run-env-allowlist) reach the VM. Secret families (`PLANETSCALE_`, `CLOUDFLARE_`, `GITHUB_`, `BOAT_`...), values holding a JWT and database URLs that leave the VM are never sent. Dropped keys are logged by name, never by value.
* **boat's own tokens are stripped.** `ASCII_TOKEN` and `BOAT_ID` are removed from every command's environment and from `~/.bashrc`.
* **The run MCP config stays out of snapshots.** `~/.boatignore` excludes `.paperclip-runtime/`, and the run JWT file is scrubbed before every stop, delete and template capture. A failed scrub deletes the VM instead of stopping it, unless its disk must be kept. See [Security](docs/security.md#the-run-mcp-config-exception).
* **Starts are capped.** Defaults: `maxActive` 2, `maxStartsPerDay` 70, `minComputeHoursLeft` 1.0, `autoStopMinutes` 120, `idleStopMinutes` 5. Unreadable limits start nothing.
* **Monitoring is on by owner decision.** Set `"monitoring": false` for new VMs to opt out. See [Monitoring retention and privacy](docs/security.md#monitoring-retention-and-privacy).
* **No network isolation.** Boat VMs have outbound internet. A task that asks for a network egress policy is refused, never run unrestricted. See [Native task network-policy admission](docs/security.md#native-task-network-policy-admission-not-network-isolation).
* **ACP process sessions are refused.** Set `engine` to `cli` for claude_local agents on boat environments.
* **Offload is default OFF** behind company flags, a repository allowlist and a per-run shim opt-in.

## Minimal config

Set this on a Paperclip sandbox environment with driver `boat`. Only `apiKey` is required; it falls back to `BOAT_API_KEY` on the host. Use a scoped `ci` key (`boat api-key create <name> --preset ci --ttl 30d`), never an admin key.

```json
{
  "apiKey": "<scoped boat ci key>",
  "tunnelTargetHost": "cliproxy"
}
```

`tunnelTargetHost: "cliproxy"` is for a Paperclip server running in its container, where `127.0.0.1` is not the model proxy. Leave it out otherwise. To keep a card's VM between runs, set `reuseLease: true` and `runnerLifecycleMode: "per_turn"` on the environment; never `"warm"`, which keeps the VM running. Every key is in [Configuration](docs/configuration.md), and the boat account settings the plugin expects are in [Security](docs/security.md#boat-account-settings).

## Install on a Paperclip host

The worker must resolve `@paperclipai/plugin-sdk` from the host's own SDK. That is what the bundled providers do.

Each tagged release has this staged package attached to its GitHub Release, with a `.sha256` file. To install one, or to cut a release, see [docs/releasing.md](docs/releasing.md).

Stage the package with `scripts/stage-package.sh`. It builds from one pushed commit, never from the working tree:

```sh
git clone https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat && cd paperclip-plugin-sandbox-boat
git fetch origin
scripts/stage-package.sh <commit> <plugin packages root>   # prints <root>/sandbox-boat-<version>-<short sha>
```

The script:

* exports the commit with `git archive`, then runs `npm ci` and `npm run check` (typecheck, tests, build) on that copy;
* copies `dist`, `bin` (the offload shims), `package.json`, `README.md`, `docs`, `LICENSE` and `@boatdev/sdk` into the package, links `node_modules/@paperclipai/plugin-sdk` to `/app/packages/plugins/sdk` (the SDK path inside the Paperclip container; a third argument changes it), and writes the full sha to `.source-commit`;
* makes the package read-only, and uses `sudo` only for the final move when the root is not writable.

It refuses:

* a commit that is not on `origin/main`;
* a commit older than `0721a3a`. Before it, the run env file sat in the workspace, so `git add -A` or a boat snapshot could pick up the tokens in it;
* a build without the run env allowlist (0.2.0). Before it, every env key Paperclip passed, project secrets included, reached the VM;
* a build that does not delete Paperclip's run MCP config before a stop, delete or capture. Without it the run JWT stays in boat snapshots;
* a build that does not put the `.paperclip-runtime/` rule into `~/.boatignore`, or that does not tell every command's tar to skip `.paperclip-runtime`. Without the rule, the run JWT is in boat's per-minute snapshots while a run holds the VM. Without the tar exclude, Paperclip's workspace extract unpacks the host's runtime files over the run's;
* a build that still links `.paperclip-runtime` into `/tmp` (0.2.0). Paperclip refuses that link and fails every run;
* a host SDK path inside one versioned Paperclip install (`cli/installs/`). The next upgrade prunes it;
* a destination that already exists.

On a native npm install (no container), the SDK is at `~/.paperclip/cli/current/node_modules/@paperclipai/plugin-sdk`. Pass that path, through `current`, as the third argument. To stage a downloaded release tarball instead of building, use `scripts/stage-release.sh <tarball> <root>`: it checks the `.sha256` and re-points the tarball's `/app` SDK link at this host's SDK. [docs/operations/rbx1.md](docs/operations/rbx1.md) is the full install, config, shim and rollback runbook for rbx1.

Then install it as an instance admin. `packageName` is the path as the server sees it:

```sh
curl -X POST "$PAPERCLIP/api/plugins/install" -H 'content-type: application/json' \
  -d '{"packageName":"/paperclip/plugin-packages-root/sandbox-boat-<version>-<short sha>","isLocalPath":true}'
```

The capabilities are:

* `environment.drivers.register`;
* `plugin.state.read` and `plugin.state.write`;
* `jobs.schedule`;
* `api.routes.register`;
* `issues.read`, used to see whether a card is done;
* `events.subscribe` and `execution.workspaces.read`, used to bind a local run to offload on `agent.run.started`;
* `secrets.read-ref`, used to resolve `offloadLocalApiKeySecretRef`.

After the install, save a plugin config for every company that uses the plugin. It can be empty:

```sh
curl -X POST "$PAPERCLIP/api/plugins/<pluginId>/config" -H 'content-type: application/json' \
  -d '{"companyId":"<companyId>","configJson":{}}'
```

The host lets a plugin's background work (the idle sweep, and the sweep that starts after an acquire or release) touch only the state of companies the plugin is configured for. Without that row, the sweep logs `state <companyId>: ... company context is required` and skips the company; release still stops each VM, and boat's auto-stop stays the backstop.

Then create a sandbox environment with provider `boat` and the config above. Run *Probe*, which starts no VM, and then point one pilot agent at it.

To undo, uninstall the plugin from the Plugins page and delete any `paperclip-*` VMs with `boat delete <id> --yes`.

## Documentation

| Doc | What is in it |
| - | - |
| [Configuration](docs/configuration.md) | Every driver config key, company offload settings, measured size policy |
| [Operations](docs/operations.md) | Enabling offload, delegated guest template, smoke procedures, rollback, budget and caps, usage, weekly size refresh |
| [Security](docs/security.md) | Env allowlist, run MCP config, runtime dir and scrub model, network policy, boat account settings, monitoring |
| [Offload](docs/offload.md) | Cargo, Node and Python offload shims |
| [Releasing](docs/releasing.md) | Cutting and installing a tagged release |
| [Development](docs/development.md) | Tests, real-SSH acceptance tests |
| [Design](docs/design/) | [Lease lifecycle](docs/design/lifecycle.md), [offload internals](docs/design/offload-internals.md), [account admission](docs/design/account-admission.md), [ADR 0001](docs/design/adr/0001-heavy-command-offload.md) |

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
```

More in [Development](docs/development.md).

## License

MIT
