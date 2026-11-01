# Operations

Enabling, smoke procedures, rollback, budget and caps. Install steps are in the [README](../README.md#install-on-a-paperclip-host); every config key is in [Configuration](configuration.md). The host-specific install, config, shim and rollback runbook for rbx1 is [operations/rbx1.md](operations/rbx1.md).

## Enabling the executor bridge

There are independent gates; none enables another automatically:

1. **Native binding:** the worker must receive a host-authored
   `onEnvironmentRealizeWorkspace` payload containing the SDK's
   `workspace.metadata.workspaceRealizationRequest` and matching local source.
   Company, current run, workspace, repository and environment are bound from
   those params, never from the offload request body or an SDK workspace lookup.
   The driver config from that invocation supplies the scoped Boat credential
   in memory only. After a worker restart, a fresh native realization is required
   before new dispatch; unresolved old commands remain quarantined, never replayed.
   A local-only run for which the host never realizes this plugin's workspace
   remains local; a flag does not manufacture a trusted binding.
2. **Company plugin configuration:** explicitly approve only public, secret-free
   repositories and supply the guest delegation and host artifact root:

   ```json
   {
     "offloadExecutorEnabled": true,
     "offloadGuestTransportEnabled": true,
     "offloadAllowedRepos": ["repo:https://github.com/example/public-rust"],
     "offloadCgroupParent": "/sys/fs/cgroup/your-existing-delegated-parent",
     "offloadArtifactRoot": "/var/lib/paperclip/boat-offload-artifacts"
   }
   ```

   These are **company plugin** settings, not environment driver settings.
   Both flags default to false and the allowlist defaults to empty (deny all).
   Only literal boolean `true` opts in. Repository IDs use the route's canonical
   form (lowercase repository URL, no trailing slash or `.git`). The guest path
   must be an existing delegation, writable by the Boat SSH user, with functional
   `cgroup.procs`, `cgroup.events` and recursive `cgroup.kill`. The plugin never
   changes systemd, mounts, cgroup delegation or host services. The host artifact
   directory must be operator-owned, private, persistent and outside live source.
   All gates are rechecked for each new command; turning one off does not discard
   existing handles, receipts or uncertain holds. A custom host integration can
   still supply `ManagerDeps.offloadExecutor` instead of the stock transport.
3. **Client shim:** opt in the selected run with `BOAT_OFFLOAD=1`, as in the [Cargo offload shim](offload.md#cargo-offload-shim-binboat-offload-cargo).
   Keep secret-bearing/private-service commands local. The stock transport
   rejects all Cargo path overrides (`--manifest-path`, `--target-dir`, etc.)
   rather than guessing how to translate host paths.

Workspace authority comes from Paperclip's native `environmentRealizeWorkspace`
payload (whole-run leases) or, for local runs, from run/issue records plus
operator-configured source roots and the checkout's own on-disk identity
(below), never from the offload request body. Paperclip's
`server/src/services/environment-run-orchestrator.ts` supplies
`workspace.metadata.workspaceRealizationRequest`, built by
`server/src/services/workspace-realization.ts`: its `heartbeatRunId`,
`executionWorkspaceId` and `source` identify the run, repository and **local**
source root. The provider persists only the required source fields in its
existing company-scoped plugin state, keyed by run and execution workspace;
the VM's remote cwd and runtime-overlay commands are not source authority.
Bindings survive worker restart and cannot authorize another run or company.
**Local runs (agent stays on the Paperclip host).** Paperclip calls
`environmentRealizeWorkspace` only for runs on a plugin sandbox lease, so a local
run gets no realization payload. With `offloadLocalRunsEnabled: true` the plugin
builds the same payload as follows:

1. the `agent.run.started` domain event gives the run id and its issue id;
2. `ctx.issues.get` gives the issue's `executionWorkspaceId`;
3. `ctx.executionWorkspaces.get` gives that workspace's local `path`, repository
   and project — or, when the live issue shape leaves the execution workspace
   id null, `ctx.projects.getWorkspaceForIssue` gives the issue's project
   workspace instead, whose id is what the shim reports;
4. `offloadLocalApiKeySecretRef` (a Paperclip secret) gives the scoped boat key,
   resolved per binding and never stored; `offloadLocalEnvironmentId` and
   `offloadLocalDriverConfig` give the pool identity and settings.

The workspace row in step 3 is **not** authority: an agent with runtime access
can rewrite its `cwd`/`repoUrl`, so the row only nominates a candidate source.
The bind stands only when operator-owned facts prove it: `realpath(path)` lies
inside an `offloadLocalSourceRoots` entry (required — empty refuses every
local-run bind; list the managed workspaces directory), and the checkout's own
on-disk `remote.origin.url`, parsed from its git config without executing git,
canonicalizes to the same repo id as the row's `repoUrl` — the payload then
carries the canonical path and the on-disk URL. Both facts are re-checked on
every executor resolve, so re-pointing the row, the path or the origin after
the bind stops dispatch (commands fall back locally). The offload request body
supplies nothing, and the secret in step 4 is resolved last, after every
check: a bind retried from an offload request runs only for a run with no
existing binding and only for the workspace that request named, so probing
with random workspace ids never spends secret resolutions. The started event usually
arrives before Paperclip prepares the run's workspace, so the bind is retried when
that run's first offload request arrives. A binding never replaces a whole-run
realization for the same run and workspace. `agent.run.finished`, `failed` and
`cancelled` drop the executor binding and the persisted workspace record, and fence
the run: a late or slow start handler cannot bind it again. A missing or refused
host fact (no execution workspace, no local path, no source root, an origin that
does not match, no secret) leaves the run unbound, and its
own commands fall back locally (503) before dispatch; other-agent runs keep the
403. This adds five capabilities to the 0.2.2
set: `events.subscribe`, `execution.workspaces.read`, `secrets.read-ref`,
`projects.read` and `project.workspaces.read`; the
upgrade needs board approval of that capability change.

A custom host integration can still call
`BoatVmManager.rememberOffloadWorkspace(params)` with a host-authored
`PluginEnvironmentRealizeWorkspaceParams` payload instead. It performs no
provider work and is not exposed as an agent route. Older hosts without the
native realization metadata must keep the shim off, not supply a root in the
request body. This binding does not replace the executor resolver's source
confinement or enable dispatch. Failed optional binding persistence does not
break whole-run workspace realization.

## Rollback

Set company `offloadExecutorEnabled` to `false` for new admissions,
then use `BOAT_OFFLOAD=0` for future local commands. Do not re-run an already
uncertain command locally. Broker restart still holds unresolved commands for
reconciliation; the [executor backend adapter](design/offload-internals.md#executor-backend-adapter) does not
automatically reattach lost handles.
The stock lifecycle executor uses the existing native sweep/recovery/shutdown
integration. Loopback SSH acceptance tests exercise actual kernel enforcement;
no deployment, live Boat call or live Boat enforcement claim is part of them.

The shim's own rollback and the native network-policy rollback rules are in [Cargo offload shim](offload.md#cargo-offload-shim-binboat-offload-cargo) and [Native task network-policy admission](security.md#native-task-network-policy-admission-not-network-isolation).

## Delegated guest template (required for remote offload)

The stock boat image has no cgroup v2 delegation for SSH sessions: session
scopes sit under `user-1000.slice`, systemd ignores `Delegate=` on slices,
and the guest preflight therefore returns false. Build a template once, on one
default VM:

1. Add `/etc/systemd/system/user@.service.d/10-delegate.conf` containing
   `[Service]` and `Delegate=cpu memory pids`, then run `daemon-reload` and
   `loginctl enable-linger user`.
2. Install `scripts/guest/paperclip-delegated-ssh` as
   `/usr/local/sbin/paperclip-delegated-ssh`. Add
   `/etc/ssh/sshd_config.d/60-paperclip-delegated.conf` with
   `Match User user` and `ForceCommand /usr/local/sbin/paperclip-delegated-ssh`.
   Every SSH command then runs in `systemd-run --user --scope -p Delegate=yes`,
   with stdio and exit status unchanged.
3. Link the real stable `cargo`/`rustc` into `/usr/local/bin`, because the
   guest PATH is fixed and has no `RUSTUP_HOME`.
4. Install `rsync` on the template VM. Delta push shells out to the worker
   host's `rsync` over the pinned SSH transport, and the guest side needs the
   `rsync` binary too; without either end the push fails and the command stays
   local. The worker host needs `rsync` installed as well.
5. Reboot, then run the preflight with `offloadCgroupParent`
   `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service`. It must print
   `true`.
6. Save the VM as a named snapshot (not available during the boat free trial)
   and set the driver `templateSnapshot` to that name. Offload pool VMs then
   boot from it, as whole-run leases do; a missing snapshot is a refused start
   and the command stays local. The pool identity does not include the
   snapshot, so VMs recorded before a template change stay owned. They are
   never reused: VM reuse is keyed on the template name, and an idle VM from the old
   image is retired through the normal stop path. Adding `rsync` to an existing
   template therefore means saving under a NEW snapshot name and updating
   `templateSnapshot`, so pre-rsync VMs are retired instead of served.

   On the free trial named snapshots are blocked, so stop the template VM
   (archived, never deleted) and set the driver `templateSourceSandboxId` to
   its sandbox id instead. Offload pool VMs then fork from it, with the same
   refusal semantics: a missing source is a refused start and the command
   stays local. VM reuse is keyed on the source id apart from snapshot and
   stock keys, and `templateSnapshot` wins when both are set.

   A cargo `--offline` command (or `--frozen`, which implies offline) cannot
   download missing crates, so the guest primes its cargo cache with
   `cargo fetch --locked` (plus the profile's validated `+toolchain` selector
   when the invocation carries one) before the command's supervisor exists; a
   failing fetch fails the prepare and the command runs locally instead. The
   fetch never invokes registry credential providers: cargo merges
   array-valued config, so a CLI override cannot clear an inherited
   provider, and the guest instead refuses to prime at all when any config
   cargo would load names one (the prepare then fails and the command runs
   locally). It also runs in its own session so a hung fetch is group-killed
   at its fence. A source tree whose
   cargo config points at a private registry, a source replacement, or stored
   credentials stays local too, because the guest fetch could not satisfy it.

## Smoke procedures

### Deferred one-VM operator smoke (after install, maximum 30 VM-minutes)

Run later on the **Boat Pilot Builder** agent, after the reviewed package is
installed. This is not a deployment or fleet-enable instruction. Never use
production data, private dependencies, production credentials or real workspaces.

1. Use a disposable public Rust canary with no external dependencies and an
   installed supported toolchain. Keep the agent/model local and release any
   whole-run pilot VM first. The host must supply this plugin's native realization
   binding for the canary run. If it cannot, stop: do not forge a binding through
   the agent API or reintroduce a workspace capability.
2. Record start time, baseline provider usage and a hard cutoff. Set native driver
   config `maxOffloadVms: 1`, `maxActive: 1`, `offloadIdleStopSeconds: 15`; retain
   budget admission and provider auto-stop. Use a scoped operations key, never a
   master key. Permit **one VM total and at most 30 aggregate billed VM-minutes**,
   including starts, idle tail and stop lag. Do not create replacement VMs.
3. Verify an existing guest delegation and a private persistent host artifact
   directory. Missing delegation means expected local fallback, not permission
   for a process-group-only workaround. Leave fleet gates off and report the
   guest-image prerequisite.
4. Apply both company flags and an allowlist containing only this canary's repo
   ID; set `BOAT_OFFLOAD=1` only on that run. Execute
   `boat-offload-cargo -- test --locked`. Observe incremental streams, an exit-0
   receipt, real boot/cgroup identity and no second VM. A changed `Cargo.lock`
   must yield a staged artifact/exit 74, with live source unchanged.
5. Cancel a 60-second sleeping canary test via the shim's SIGINT path. Confirm
   exit 130 and an empty cgroup after TERM/KILL grace. Separately test a short
   command timeout (exit 124), then stop only the canary client's heartbeats to
   verify guest interest expiry within 30 s. Do not restart a production worker
   for testing. Inspect uncertain receipts without local replay.
6. Set both company flags false and future clients to `BOAT_OFFLOAD=0`. Confirm
   the sole VM becomes stopped/archived after the idle tail; use native pool stop
   reconciliation if it does not. Confirm billed usage stayed within 30 VM-minutes,
   preserve receipts/staged artifacts for review, then remove the canary/artifacts
   through normal ownership controls. Failed ownership or cleanup is a stop
   condition, never a reason for broader rollout.

### Live smoke test

`scripts/live-smoke.mjs` runs the plugin's own code against the real API. It does create, SSH, env (an allowlisted key arrives, denied keys and `ASCII_TOKEN` do not), tunnel, stop, resume, stop and delete. It also checks that boat's `ASCII_TOKEN`/`BOAT_*` names are in neither `/proc/$PPID/environ` (nor any readable ancestor's), `/etc/environment` nor `~/.bashrc`; that `.paperclip-runtime` is a real directory that passes Paperclip's own check and `~/.boatignore` has the rule, so a stand-in run MCP config written there is in no snapshot tree (per-minute or stop) and is gone after the resume; that Paperclip's workspace extract of a host tar with a `.paperclip-runtime/` member, run through Execute with the VM's own tar, keeps the directory and the stand-in and unpacks none of the host's runtime files (it also prints the VM's tar version and what that tar does without the exclude); and that a command killed by SIGTERM exits 143. It costs about $0.001.

```sh
npm run build
read -rs BOAT_API_KEY; export BOAT_API_KEY
SMOKE_TUNNEL_HOST=127.0.0.1 node scripts/live-smoke.mjs
```

### Native sync smoke

After exact-head CI/review, an authorized operator can run `node scripts/native-sync-smoke.mjs` on the built package with the existing scoped `BOAT_API_KEY` and run-owned `PAPERCLIP_RUN_SCRATCH_DIR`. It creates one isolated trial VM, sends 46.4 MB in and 36.9 MB out through the real hooks, verifies hashes, logs CLI/lease boundaries, stops and deletes only its fresh smoke VM. It conservatively counts the entire acquired-lease-to-release interval minus the measured remote CLI duration as combined staging, and separately reports acquisition-inclusive timing. It fails acceptance unless combined staging is below 30 seconds. **The script is a measurement procedure, not a claimed live timing result.** Do not activate a package or change a running environment just to run it.

## Budget and caps

### Cost rules

* **One VM per card.** The key is the execution workspace, else the issue, else the run. The mapping lives in plugin state and in the VM's name, `<namePrefix>-<16 hex>`, so a lost state does not lose the VM. The checkout and build dirs stay on the stopped disk. boat keeps a stopped disk free for 14 days.
* **Stop on release.** Billing stops at the stop ([docs](https://docs.boat.dev/snapshots/stop)). In our trial a resume within 10 minutes of a stop got the same machine back and did not count as a start.
* **One lock per card.** Acquire, ResumeLease, release, destroy, capture and the sweep's stop, stop confirmation (including usage closure) and delete take the same per-card lock, so a new run never reads the VM as running while the previous run's release stops it, and the sweep never stops or deletes a VM that a run is taking: under the lock it reads boat, plugin state and its own activity again and leaves the VM alone if anything changed. A VM of ours with no record (an orphan, after plugin state was lost) has no known card, so acquire and ResumeLease also take a lock on the VM's name, which the sweep takes for an orphan. A new run, a resumed lease or a command that finds the VM still stopping (`archiving`) waits up to `stopConfirmTimeoutMs` for the save to end, then resumes it, or fails with `BOAT_STOP_PENDING` without starting anything.
* **Auto-stop is a deadline, not idle detection.** It counts from the start or resume ([docs](https://docs.boat.dev/long-running-tasks/auto-stop)). The plugin sets it to `autoStopMinutes` (120, the trial maximum) as a safety net. It extends the deadline only while a command is running and less than half of it is left. An idle VM is never extended.
* **Idle sweep, every 5 minutes.** It runs outside any host request (`src/proactive.ts`), because the host refuses plugin state in a scheduled job's company-less request and in a request that already ended. A VM with no active run is stopped after `idleStopMinutes` (5) idle. A VM whose lease is held but sent no command for `staleLeaseMinutes` (20) is stopped too. Before each of these stops the sweep removes the run MCP config, the same as release, opening an SSH session when this worker has none; a VM where that fails is deleted instead, unless a run still holds it (an active run, or a resumed lease's open run window), which keeps its disk. A scrub that found nothing left but could not search the whole disk stops the VM with its disk kept. A stopped VM is deleted when its card is done or cancelled, or after `deleteAfterDays` (7) untouched. The sweep only touches sandboxes named with our prefix. While a company's plugin state cannot be read, a VM with no record may be that company's (with an active lease), so the sweep neither stops nor deletes such a VM until the state can be read again; companies whose state it reads are swept as usual.
* **Budget guard.** Before every create or resume, the plugin reads `GET /limits` once. It refuses the start, fast and with a clear error, when any of these is true:
  * `maxActive` (2) VMs already run;
  * `maxStartsPerDay` (70) starts happened in the last 24 hours;
  * boat's hour or minute start window is full;
  * fewer than `minComputeHoursLeft` (1.0) compute hours are left;
  * the size is not allowed on the plan.

  A warning log line names the limit. If the limits cannot be read, nothing is started.
* **Fail-fast starts.** A start that finds no ready machine gets `503 no_ready_machine` at once. Nothing is started or billed. The plugin retries twice, 5 s apart, then fails with `BOAT_NO_READY_MACHINE`.
* **Retries never double-bill.** Creates send an `Idempotency-Key`. boat documents the key for create and fork only, and the SDK has no key for resume. A resume retry therefore checks the VM state first and treats `sandbox_resuming` as done.

### Offload VM-hour cap

`offloadMonthlyVmHourCap` (default 0, disabled) caps the month's tracked
offload VM-hours per company against the existing account-ledger usage rows;
once reached, new commands run local until next month.

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

## Worker topology and command activity

Run **one lifecycle worker per plugin state/account**. Card/name locks and company-document updates are serialized in that worker, not distributed compare-and-swap locks; active-active acquire/release/destroy is not supported. Use the native plugin job for sweeps, not independent host sweep scripts.

Execute and native sync publish a separate per-VM activity timestamp before admission, every 15 seconds while in flight, and on completion. A replacement/overlapping manager's sweep reads that shared heartbeat both before selecting an idle stop and again under its card lock. A silent command therefore remains active past the 20-minute stale threshold; after a crash, heartbeats cease and normal idle/stale reclamation resumes. Heartbeats contain **only timestamps**, never command text, env values or output. An unreadable/invalid heartbeat skips the stop, and a failed initial write refuses command admission. These heartbeats protect overlapping sweeps; they do not turn the lifecycle store into an active-active coordinator. Boat's auto-stop remains the independent deadline safety net.

## Weekly refresh from the pilot cost log

The offline refresh utility consumes one JSON object per completed or failed job. Use the same workload definition and timing boundary for every size within a class. Log complete jobs, including build/setup time and retries required to finish; do not log a failed attempt as a fast success. `hourlyRate` is the price in effect for that sample. CPU and peak-RSS fields may be kept alongside these required fields; they are not substituted for wall duration.

```jsonl
{"taskClass":"rust-build-test-clippy","size":"default","status":"completed","durationSeconds":316,"hourlyRate":0.036,"measuredAt":"2026-10-23T07:20:59.605Z"}
{"taskClass":"rust-build-test-clippy","size":"large","status":"completed","durationSeconds":182,"hourlyRate":0.072,"measuredAt":"2026-10-23T07:20:59.605Z"}
{"taskClass":"rust-build-test-clippy","size":"small","status":"failed"}
```

Run both commands from a repository source checkout; staged and published plugin packages do not include `scripts/recompute-size-cost-table.mjs`.

```sh
npm run build
node scripts/recompute-size-cost-table.mjs /path/to/pilot.jsonl > /path/to/size-policy-patch.json
# Reproduce a historical weekly window:
node scripts/recompute-size-cost-table.mjs /path/to/pilot.jsonl --now 2026-10-23T08:00:00Z
```

Output is `{ "sizeCostTable": { ... } }`. It uses completed samples in the trailing seven days, skips failures and older samples, and fails on malformed or future-dated completed rows rather than silently selecting a cheap bad measurement or clearing the table after a clock error. It averages per-job cost for each class/size; a duration-weighted effective hourly rate preserves that average if prices changed. Measurement age and sample count remain visible in the table.

**Operator procedure, once per week:** run the utility on the pilot log, inspect the resulting patch, and replace only `sizeCostTable` on the environment (preserve API-key references and other settings). An empty result clears the measurements and restores the configured fallback. Save through environment config validation. The plugin keeps the last saved table until replaced; it does not silently expire data or mutate environment settings. This utility has no network calls, starts no VMs, and installs no cron or routine. Scheduling and applying weekly updates belong to the environment operator.
