# paperclip-plugin-sandbox-boat

A [Paperclip](https://github.com/paperclipai/paperclip) sandbox-provider plugin that runs agent work on [boat.dev](https://boat.dev) VMs. A VM exists for one card and runs only while a run on that card needs it.

It started as a copy of Paperclip's bundled `exe-dev` provider. All boat calls go through the official TypeScript SDK, [`@boatdev/sdk`](https://docs.boat.dev/sdks/typescript) (pinned to 1.10.0). There is no hand-written REST client.

## What it does

| Paperclip hook | boat action |
| - | - |
| AcquireLease | The card already has a VM: resume it if it is stopped, or share it if it is running. Otherwise create a VM, from `templateSnapshot` when that is set. Every start passes the budget guard first and uses fail-fast. |
| Execute | SSH as boat's non-root `user`, with the host key pinned from `POST /sandboxes/{id}/sshkey`. The run env goes over stdin into a 0600 file in a fresh 0700 directory under `/tmp`, never in argv. The command script sources the file and removes it before the command starts. A reverse tunnel makes `127.0.0.1:8317` inside the VM reach the model proxy. |
| ReleaseLease | Stop the VM at once, which stops billing. A VM keyed to a single run has nothing worth keeping, so it is deleted instead. |
| StopLease | Stop the VM, keep its disk, and confirm the stop or throw. |
| DestroyLease | Delete the VM and forget the card mapping. |
| ResumeLease | Resume the lease's VM, or report the lease expired. |
| RealizeWorkspace | `mkdir -p` the workspace inside the VM (`$HOME/paperclip-workspace` by default). |
| Probe | Read `GET /limits`, check the `ssh` client and the tunnel target. It never starts a VM. |
| CaptureTemplate / DeleteTemplate | Save or delete a boat named snapshot. Capture refuses to go past the 10 free snapshots unless `allowPaidNamedSnapshots` is set. |

### Cost rules

* **One VM per card.** The key is the execution workspace, else the issue, else the run. The mapping lives in plugin state and in the VM's name, `<namePrefix>-<16 hex>`, so a lost state does not lose the VM. The checkout and build dirs stay on the stopped disk. boat keeps a stopped disk free for 14 days.
* **Stop on release.** Billing stops at the stop ([docs](https://docs.boat.dev/snapshots/stop)). In our trial a resume within 10 minutes of a stop got the same machine back and did not count as a start.
* **One lock per card.** Acquire, release, destroy and the sweep's stop take the same per-card lock, so a new run never reads the VM as running while the previous run's release stops it. A new run that finds the VM still stopping (`archiving`) waits up to `stopConfirmTimeoutMs` for the save to end, then resumes it, or fails with `BOAT_STOP_PENDING` without starting anything.
* **Auto-stop is a deadline, not idle detection.** It counts from the start or resume ([docs](https://docs.boat.dev/long-running-tasks/auto-stop)). The plugin sets it to `autoStopMinutes` (120, the trial maximum) as a safety net. It extends the deadline only while a command is running and less than half of it is left. An idle VM is never extended.
* **Idle sweep, every 5 minutes.** A VM with no active run is stopped after `idleStopMinutes` (15) idle. A VM whose lease is held but sent no command for `staleLeaseMinutes` (60) is stopped too. A stopped VM is deleted when its card is done or cancelled, or after `deleteAfterDays` (7) untouched. The sweep only touches sandboxes named with our prefix.
* **Budget guard.** Before every create or resume, the plugin reads `GET /limits` once. It refuses the start, fast and with a clear error, when any of these is true:
  * `maxActive` (2) VMs already run;
  * `maxStartsPerDay` (70) starts happened in the last 24 hours;
  * boat's hour or minute start window is full;
  * fewer than `minComputeHoursLeft` (1.0) compute hours are left;
  * the size is not allowed on the plan.

  A warning log line names the limit. If the limits cannot be read, nothing is started.
* **Fail-fast starts.** A start that finds no ready machine gets `503 no_ready_machine` at once. Nothing is started or billed. The plugin retries twice, 5 s apart, then fails with `BOAT_NO_READY_MACHINE`.
* **Retries never double-bill.** Creates send an `Idempotency-Key`. boat documents the key for create and fork only, and the SDK has no key for resume. A resume retry therefore checks the VM state first and treats `sandbox_resuming` as done.

### Usage accounting

* For each run, the plugin records the boat sandbox id, the size, the start kind (create, resume or shared) and the start and stop times.
* At release it reads boat's own meter, `GET /sandboxes/{id}/usage`, for that run's window and for the VM's lifetime.
* `GET /api/plugins/<pluginId>/api/usage?companyId=<id>` (board auth) returns:
  * totals;
  * per card;
  * per VM;
  * per run, in seconds and dollars;
  * the last budget snapshot.
* `refresh=0` skips the live re-read. By default, run windows read right at a stop are read again, because the meter can lag.
* `POST .../api/sweep` runs the sweep now.

### Security

* VMs are created with `noEnv: true` and `monitoring: false`. Use a boat environment marked *safe for third parties*.
* The VM gets nothing of the account except boat's own `BOAT_ID` and `ASCII_TOKEN` (see [boat account settings](#boat-account-settings)). The run env is the only other input.
* The staged env file never sits in the workspace (the git checkout), so `git add -A` cannot commit it. It sits under `/tmp`, which boat snapshots do not save ([What a snapshot saves](https://docs.boat.dev/snapshots/whats-saved)), and it is gone before the command starts. If ssh drops before the script runs, the plugin removes it itself.
* An ephemeral ed25519 key is made per worker process with `ssh-keygen`. It is never stored.
* The host key comes from the API, and SSH uses `StrictHostKeyChecking=yes` with `HostKeyAlias=<sandbox id>`.
* The tunnel binds to `127.0.0.1` inside the VM only. Nothing is published.

## Configuration

Set these on the Paperclip sandbox environment, driver `boat`. Only `apiKey` is required.

| Key | Default | Notes |
| - | - | - |
| `apiKey` | - | A boat key with the `ci` preset: `boat api-key create <name> --preset ci --ttl 30d`. Falls back to `BOAT_API_KEY` on the host. |
| `size` | `default` | `small` costs $0.018/h and `default` $0.036/h. The trial allows only these two. |
| `templateSnapshot` | none | A named snapshot to create new card VMs from. |
| `autoStopMinutes` | 120 | The trial allows at most 120. |
| `idleStopMinutes` | 15 | |
| `staleLeaseMinutes` | 60 | |
| `deleteAfterDays` | 7 | 1 to 13. |
| `maxActive` / `maxStartsPerDay` / `minComputeHoursLeft` | 2 / 70 / 1.0 | Matches the trial: 2 at once, 75 starts a day, 25 h. |
| `failFast` / `noReadyMachineRetries` | true / 2 | |
| `cliproxyTunnel` | true | |
| `tunnelRemotePort` | 8317 | |
| `tunnelTargetHost` | `127.0.0.1` | **Inside the Paperclip container, set this to `cliproxy`**: the container's 127.0.0.1 is not the CLIProxy. |
| `tunnelTargetPort` | 8317 | |
| `noEnv` | true | |
| `boatEnvironment` | account default | |
| `remoteWorkspaceDir` | `$HOME/paperclip-workspace` | |
| `namePrefix` | `paperclip` | |
| `costApiKey` | main key | An optional read-only key for usage reads. |
| `timeoutMs` / `stopConfirmTimeoutMs` / `sshConnectTimeoutSec` | 300000 / 120000 / 15 | |

## Install on a Paperclip host

The worker must resolve `@paperclipai/plugin-sdk` from the host's own SDK. That is what the bundled providers do.

Stage the package with `scripts/stage-package.sh`. It builds from one pushed commit, never from the working tree:

```sh
git clone https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat && cd paperclip-plugin-sandbox-boat
git fetch origin
scripts/stage-package.sh <commit> <plugin packages root>   # prints <root>/sandbox-boat-<version>-<short sha>
```

The script:

* exports the commit with `git archive`, then runs `npm ci` and `npm run check` (typecheck, tests, build) on that copy;
* copies `dist`, `package.json`, `README.md`, `LICENSE` and `@boatdev/sdk` into the package, links `node_modules/@paperclipai/plugin-sdk` to `/app/packages/plugins/sdk` (the SDK path inside the Paperclip container; a third argument changes it), and writes the full sha to `.source-commit`;
* makes the package read-only, and uses `sudo` only for the final move when the root is not writable.

It refuses:

* a commit that is not on `origin/main`;
* a commit older than `0721a3a`. Before it, the run env file sat in the workspace, so `git add -A` or a boat snapshot could pick up the tokens in it;
* a destination that already exists.

Then install it as an instance admin. `packageName` is the path as the server sees it:

```sh
curl -X POST "$PAPERCLIP/api/plugins/install" -H 'content-type: application/json' \
  -d '{"packageName":"/paperclip/plugin-packages-root/sandbox-boat-0.1.0-<sha>","isLocalPath":true}'
```

The capabilities are:

* `environment.drivers.register`;
* `plugin.state.read` and `plugin.state.write`;
* `jobs.schedule`;
* `api.routes.register`;
* `issues.read`, used to see whether a card is done.

After the install, create a sandbox environment with provider `boat` and the config above. Run *Probe*, which starts no VM, and then point one pilot agent at it.

To undo, uninstall the plugin from the Plugins page and delete any `paperclip-*` VMs with `boat delete <id> --yes`.

## boat account settings

These are the settings the plugin expects, with the docs (docs.boat.dev) that back them. Check yours with `boat env info <env>`, `boat data-retention status` and `boat limits`. The AI-proxy and auto-refill switches need an admin key or the dashboard to read.

* **Sign in with Google or email, not GitHub.** Then boat has no GitHub token of yours to pass into a VM ([docs](https://docs.boat.dev/environments/access#what-a-normal-sandbox-receives)).
* **Environment: safe for third parties ON.** The raw toggles still read `true`; the `effective` `passGithub`, `passSecrets`, `passSandboxCredentials` and `passAgentsCredentials` must all be false ([docs](https://docs.boat.dev/environments/access)). Keep `proxyAiCredentials` off.
* **AI credentials proxy OFF.** It costs $1 a day, and on the trial one day uses the whole 25 h allowance ([docs](https://docs.boat.dev/free-trial)).
* **Zero data retention OFF.** It deletes a VM's data at every stop, so resume would never work ([docs](https://docs.boat.dev/data-retention/zero-data-retention)).
* **Snapshots off: OFF.** With it on, a stop erases the VM ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off)).
* **Monitoring off: per VM.** The plugin creates every VM with `monitoring: false`, so boat keeps no command output, process list or CPU/RAM samples for it. That works whether the account-wide *Monitoring off* switch is on or off: with the switch on, boat refuses only `monitoring: true` (`409 monitoring_off_for_account`). Turning the switch on as well also covers VMs made by hand, for example `boat new` without `--no-monitoring`. Either way, these VMs get no disk-full alerts ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off#monitoring-off)).
* **Auto-refill OFF.** It needs a paid plan and does not work during the trial. With it off, spend stops at the balance ([docs](https://docs.boat.dev/billing#control-your-spend)).
* **Keys:** a scoped `ci` key for the plugin and a `read-only` key for cost reads. Never use an admin key in the plugin.

Even with safe for third parties on, every VM gets `BOAT_ID` and `ASCII_TOKEN`. `ASCII_TOKEN` can publish a port of that one VM on a public URL and nothing else ([docs](https://docs.boat.dev/security#boat-credentials-inside-a-sandbox)).

## Live smoke test

`scripts/live-smoke.mjs` runs the plugin's own code against the real API. It does create, SSH, env, tunnel, stop, resume, stop and delete. It costs about $0.001.

```sh
npm run build
read -rs BOAT_API_KEY; export BOAT_API_KEY
SMOKE_TUNNEL_HOST=127.0.0.1 node scripts/live-smoke.mjs
```

## Development

```sh
npm ci
npm run typecheck
npm test        # vitest, mocked boat API + scripted ssh; plus an SDK wire test
npm run build
```

## License

MIT
