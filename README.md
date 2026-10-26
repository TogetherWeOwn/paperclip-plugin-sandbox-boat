# paperclip-plugin-sandbox-boat

A [Paperclip](https://github.com/paperclipai/paperclip) sandbox-provider plugin that runs agent work on [boat.dev](https://boat.dev) VMs. A VM exists for one card and runs only while a run on that card needs it.

It started as a copy of Paperclip's bundled `exe-dev` provider. All boat calls go through the official TypeScript SDK, [`@boatdev/sdk`](https://docs.boat.dev/sdks/typescript) (pinned to 1.10.0). There is no hand-written REST client.

## What it does

| Paperclip hook | boat action |
| - | - |
| AcquireLease | The card already has a VM: resume it if it is stopped, or share it if it is running. Otherwise create a VM, from `templateSnapshot` when that is set. Every start passes the budget guard first and uses fail-fast. Before the lease goes back to Paperclip, the workspace's `.paperclip-runtime` is made a real directory that [`~/.boatignore` leaves out of every snapshot](#the-runtime-directory-is-left-out-of-snapshots). A start that fails is stopped. A VM that this start created is deleted instead when its disk cannot be checked; the card's resumed VM is always stopped with its disk kept, because that disk holds the card's work. |
| Execute | SSH as boat's non-root `user`, with the host key pinned from `POST /sandboxes/{id}/sshkey`. Only the run env keys the [env allowlist](#run-env-allowlist) names reach the VM; the rest is dropped and logged by name. The kept env goes over stdin into a 0600 file in a fresh 0700 directory under `/tmp`, never in argv. sshd's login shell runs `exec env -u ASCII_TOKEN -u BOAT_ID sh -c <script>`, so the shell above the command never had boat's tokens in its environment. The script sources the profiles and the env file, removes the file, clears the tokens again (a profile may export them), and runs the command; it exits with the command's status, 128+n for a command killed by signal n. A reverse tunnel makes `127.0.0.1:8317` inside the VM reach the model proxy. |
| ReleaseLease | Remove [Paperclip's run MCP config](#the-run-mcp-config-exception) from the VM, then ask boat to stop and return a stopped receipt once the VM is observed leaving UP; the idle sweep confirms the snapshot save. If the VM stays up or its status cannot be read within the bounded 10 s poll, release returns no receipt and the sweep retries the stop. Waiting for the save (4-65 s) would keep the Paperclip lease active past its run, and Paperclip's orphan-lease sweep would destroy the warm VM. When that removal fails, the VM is deleted instead of stopped, unless [its disk must be kept](#when-the-scrub-fails) (`stop_and_retain`, or another run still holds the VM). A VM keyed to a single run has nothing worth keeping, so it is deleted, except on `stop_and_retain`, which stops it. A VM that another run on the card still uses stays up, untouched, until the last release. |
| (reuse) | The driver declares `sandboxCapabilities.reusableLeases`. With `reuseLease: true` and `runnerLifecycleMode: "per_turn"` on the environment, Paperclip stops the card's VM after each run and resumes it for the card's next run, so the checkout and build output stay on its disk. Without reuse, Paperclip destroys the VM after every run (DestroyLease) and the next run starts a fresh one from `templateSnapshot`. Never set `runnerLifecycleMode: "warm"`: it keeps the VM running between runs. |
| StopLease | Remove the run MCP config, ask boat to stop, keep its disk, and return a stopped receipt once the VM is observed leaving UP (the sweep confirms the save); throw `BOAT_STOP_UNCONFIRMED` when the stop is refused, the VM stays up, or its status remains unreadable after the bounded poll. When the removal fails, the VM is still stopped and its disk kept, with an error log: Paperclip sends StopLease to keep unexported work, and never accepts a delete in its place. |
| DestroyLease | Remove the run MCP config (in case the delete fails), delete the VM and forget the card mapping. |
| ResumeLease | Under the card lock, as acquire: wait for a stop that boat is still saving (up to `stopConfirmTimeoutMs`, else `BOAT_STOP_PENDING`), resume the lease's VM and prepare its `.paperclip-runtime` again, or report the lease expired. |
| RealizeWorkspace | `mkdir -p` the workspace inside the VM (`$HOME/paperclip-workspace` by default) and prepare its `.paperclip-runtime` (an existing directory stays). |
| Probe | Read `GET /limits`, check the `ssh` client and the tunnel target. It never starts a VM. |
| CaptureTemplate / DeleteTemplate | Save or delete a boat named snapshot. Capture refuses to go past the 10 free snapshots unless `allowPaidNamedSnapshots` is set. Before the save it removes the run MCP config and refuses the capture (`BOAT_RUNTIME_SCRUB_FAILED`) when it cannot verify that; a stopped VM is resumed for that, budget-guarded. |

### Command-level guest lifecycle (opt-in executor slice)

The stock worker now has a concrete Linux guest transport over the existing
API-authorized, pinned-host-key Boat SSH connection. The agent/model stays on
the server; only an eligible heavy command and a frozen, secret-free source
snapshot go to a pool VM. **Everything remains default OFF**: both company
flags, an explicit repository allowlist, native workspace realization metadata,
a delegated cgroup parent and a private artifact directory are required. The
separate Cargo shim opt-in is still required. See the enabling and smoke
procedures below. No new Paperclip capability is needed.

The existing identity-only runner remains compatible, but is not a safe HTTP
offload integration. Custom integrations can still supply `OffloadLifecycleDeps`
and override `ManagerDeps.offloadExecutor`; the stock worker uses
`SshOffloadRuntime`, `SshOffloadGuest` and `SshOffloadSync` when no override exists.

* Preflight requires positive delegated-cgroup-v2 and independent-watchdog
  evidence. The full boot/process-group/cgroup/generation identity and both
  deadlines are committed before arming the watchdog and invoking the runner.
* Guest controller operations and transport admission must atomically fence
  their effects against the supplied boot/ownership identity and deadlines,
  not merely trust the host's earlier inspection. A cancelled reservation must
  reject delayed transport delivery, including after worker death. Preparation
  must allocate a fresh, canonical, non-root delegated subtree. This worker
  never recycles a prepared path in the same VM boot: elapsed time alone does
  not prove a previous watchdog callback ran or was revoked. Guest replies
  cannot replace host-authored command, company or sandbox bindings.
* Cancellation inspects ownership, sends TERM, allows five seconds, rechecks
  ownership, kills the cgroup and verifies it empty before reuse. Descendants
  that escaped the leader's process group still belong to that subtree.
  Cleanup also runs when transport or its output consumer rejects, and worker
  timers are removed on every exit. Unknown ownership or failed cleanup
  quarantines capacity; it never permits local replay of possibly started work.
  Nonterminal lifecycle records stay quarantined even with a matching leader
  result receipt: receipt-only replay cannot attest descendant cleanup. Recovery
  inspects the pinned guest identity without replaying or signaling the command;
  it does not release a nonterminal hold just because the original call settled.
* `start(command)` acknowledges durable admission without waiting for exit.
  `execute(command)` waits for the same execution. `heartbeatCommand` renews
  thirty-second client interest; clients should call it every five seconds.
  Reads do not renew interest. Expiry is checked synchronously before transport,
  including after asynchronous watchdog arming; cancellation cannot be lost
  between the durable starting commit and transport registration. The independent
  guest watchdog retains the absolute execution deadline after worker death.
  Timeouts return exit 124;
  confirmed cancellation returns exit 130, always with unsafe local fallback
  after possible execution.
* `readOutput(companyId, runId, commandId, after, limitBytes)` returns immutable
  numbered stdout/stderr events as base64, preserving arbitrary bytes. Events
  are at most 1 KiB and each page contains at most 64 KiB of decoded bytes.
  `nextCursor` is the last included event number. If a requested limit is
  smaller than the next event, `OFFLOAD_OUTPUT_READ_TOO_SMALL` leaves the cursor
  and retained bytes unchanged. Retention is capped at **1 MiB and 16,384 events
  per command** (tiny writes also consume metadata). A write exceeding either
  total rejects with `OFFLOAD_OUTPUT_LIMIT`, without silently dropping bytes.
  Runners must await/propagate output errors; rejection
  triggers guest cleanup and leaves execution uncertain, never safe to replay.
  Output expires with the journal's 24-hour result retention. `cancelCommand`
  requires a nonblank reason of at most 256 characters. It and `heartbeatCommand`
  accept an optional journal generation; stale generations cannot signal or renew
  current work.
* ID-only `read`, `cancel` and `heartbeat` helpers apply only to commands this
  executor admitted and reject ambiguous IDs. External routes must use the
  run/company-scoped methods and supply authenticated bindings.

Lifecycle-enabled executors persist pool ownership, funded idle tails, absolute
stop deadlines, stop requests and guest identities in instance-scoped plugin
state, keyed by account and pool. Call `recover()` before reconciliation (new
submissions do this automatically) and `sweep()` from the native plugin job
integration. Recovery loads saved idle settings/deadlines, remembers journaled
watchdog paths and quarantines busy, unobservable or mismatched ownership. An
idle VM is swept only after its durable deadline; sweep never creates a
replacement. Admission may stop an idle incompatible VM earlier to reclaim a
full pool slot, but only replaces it after confirmed termination and durable
stop accounting. The API is ready for job integration, but this slice does not wire
or schedule that job or enable command-level HTTP routes.

Stop acceptance and termination are distinct. While Boat is archiving, capacity
remains unavailable for reuse, and usage has integer epoch-ms `stopRequestedAt`
with `stoppedAt` and `stopLagMs` set to `null`. A terminal observation fills those
fields; earlier durable evidence bound to the exact reservation can correct a
later reconciliation timestamp. `stopLagMs` measures observation time minus the
original idle deadline, including worker outage and sweep delay, not just provider
RPC time. Accepted asynchronous stops are observed automatically by the idle
worker. Unreadable pending stops and pool-state write failures keep
generation-fenced observation retries with exponential backoff capped at thirty
seconds; detached callback failures are handled without dropping ownership or
claiming termination. Retrying shutdown reconciles pending stops before deciding
whether another stop is safe.
The existing five-minute native sweep cadence is the intended crash backstop,
**not a fifteen-second stop guarantee after worker death**. A healthy worker
still uses the short generation-fenced idle timer. Storage loss during an idle
stop does not prevent stopping a known-empty VM, but missing telemetry stays
pending until durable evidence converges. One authoritative worker is required;
these records do not fence simultaneous workers or external account writers.

Sync-inclusive reservations and staged results are part of this opt-in executor:

* `sync.collect(sandboxId, command)` returns adapter-owned collected data;
  `sync.stage(sandboxId, command, collected)` receives that same payload and
  returns `{state: "clean"|"staged"|"conflict", changedPaths, conflictPaths,
  artifactId}`. The staging receipt is snapshotted into the durable result and
  returned by execution, reads and replay. Existing void-returning sync adapters
  remain supported. Staging must preserve returned changes separately for review,
  never write them into the live workspace; the executor does not apply files.
* A company-scoped execution workspace holds one reservation from before push
  through execution, collection, staging and durable settlement. Cancellation
  cannot release it or its VM while an asynchronous phase is still pending.
  Lifecycle callers without `executionWorkspaceId` conservatively reserve their
  card; legacy identity-only callers without a workspace retain their old behavior.
  Eligible waiters remain FIFO, while an unrelated permitted workspace can progress
  past a waiter blocked on another workspace.
* Every warm selection, stopped-VM resume and queued dispatch requires matching
  company, repository, profile and trust-domain bindings. An omitted trust domain
  does not match an explicit one. These bindings and workspace holds survive
  worker restart. Old VMs without compatibility bindings cannot authorize reuse;
  idle incompatible slots are stopped and retired before admitting replacements.
  Busy, quarantined and pending-stop allocations are never evicted. Uncertain
  recovered reservations without workspace ownership fail closed, and a known
  quarantined workspace is refused immediately even when queueing is enabled.
* Push failure or pre-start cancellation is durably never-started and permits
  local fallback only after the pending push settles. Collection/staging failure
  retains execution as unknown and quarantines both the VM and workspace, even
  if another VM is free. Cancellation after execution retains unsafe fallback
  and staged changes, returning exit 130 unless an execution timeout already won.

The acceptance tests model process trees, transfers and timer ownership; they
are not proof of a real guest's cgroup enforcement or a real sync adapter's path
confinement. Real adapters, HTTP route activation and native job scheduling are
separate integration work. No live VM use or deployment is part of this change.

### Native workspace transfers

The driver declares both `sandboxCapabilities.nativeSyncIn` and `nativeSyncOut`, and defines both hooks. Paperclip can use them as a pair instead of base64-over-exec staging. Transfers reuse the existing pinned SSH connection; they do not acquire another VM or open another trust path.

The worker and VM both need **Python 3 on Linux**, in addition to the existing OpenSSH client. A standard-library helper streams GNU-format tar in each direction, without buffering whole files. There is no rsync or additional npm dependency. It creates regular files with the requested mode before writing bytes, including files inside directories. Without an override, source permission bits are preserved (not setuid/setgid bits). A single-file mapping uses an exclusive, random `.paperclip-upload.*` scratch file beside the target and atomic rename; it never overwrites a pre-existing scratch file. Directory mappings destroy the old tree and are not transactional. Operations run in order and return counts of regular files and their content bytes, excluding archive padding, directories and links.

Directory mappings honor excludes and `followSymlinks` (false preserves links; true copies their target bytes and refuses cycles). Inbound preflight uses the sender's same exclude matcher, so omitted subtrees are not scanned or dereferenced. As with the existing GNU tar guard, nested `.paperclip-runtime` members are omitted. An explicitly mapped runtime asset root still transfers its own ordinary contents. Replacing the active workspace recreates its real 0700 runtime directory before later uploads or commands. Inbound paths, directory members and post-upload commands are checked for the existing ACP process-session refusal before that operation sends any payload.

Outbound extraction walks target parents with directory descriptors and `O_NOFOLLOW`; sandbox archive members cannot write through a host symlink ancestor. It rejects absolute/traversing member paths, hardlinks, sparse/PAX records and oversized GNU extension metadata. Preserved leaf symlinks are never followed as extraction parents. Both transfer directions fail loudly on process/pipe errors and timeouts. The helper unwinds catchable termination signals to remove its single-file scratch; an uncatchable kill or machine loss cannot guarantee that cleanup. Inline control output and diagnostics are capped at 256 KiB; file bytes are backpressured streams, not inline output.

Inbound `postUploadCommands` run only after their files, in order, with an explicit, confined, no-symlink cwd (default: the resolved remote workspace). Their shell argument is passed unchanged; the environment retains the existing tar runtime exclusion and strips boat's VM tokens before starting either the supervisor or payload. Nonzero status or timeout aborts later commands/operations. Outbound post-upload commands are refused rather than silently ignored.

Every streamed command has a caller-known random cancellation identity. A locked 0600 record in the VM's `/tmp` registers its separate process group before payload exec. Cleanup uses a fresh channel on the same pinned master on **every** outcome, including thrown consumer/output-cap failures; it does not depend on receiving a stderr marker. Cancellation revokes admission even if SSH has not delivered the command yet, or sends TERM then KILL to already-started work. The original stream error/timeout is preserved; an unreachable VM or failed cleanup is reported rather than treated as confirmed cancellation. Normal records are removed by cleanup. Cancellation before delivery leaves a small admission tombstone until the delayed invocation consumes it or the VM is deleted; expiring it early could resurrect late work. These records contain process identity only, no credentials, and `/tmp` is not snapshotted.

After exact-head CI/review, an authorized operator can run `node scripts/native-sync-smoke.mjs` on the built package with the existing scoped `BOAT_API_KEY` and run-owned `PAPERCLIP_RUN_SCRATCH_DIR`. It creates one isolated trial VM, sends 46.4 MB in and 36.9 MB out through the real hooks, verifies hashes, logs CLI/lease boundaries, stops and deletes only its fresh smoke VM. It conservatively counts the entire acquired-lease-to-release interval minus the measured remote CLI duration as combined staging, and separately reports acquisition-inclusive timing. It fails acceptance unless combined staging is below 30 seconds. **The script is a measurement procedure, not a claimed live timing result.** Do not activate a package or change a running environment just to run it.

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

#### Worker topology and command activity

Run **one lifecycle worker per plugin state/account**. Card/name locks and company-document updates are serialized in that worker, not distributed compare-and-swap locks; active-active acquire/release/destroy is not supported. Use the native plugin job for sweeps, not independent host sweep scripts.

Execute and native sync publish a separate per-VM activity timestamp before admission, every 15 seconds while in flight, and on completion. A replacement/overlapping manager's sweep reads that shared heartbeat both before selecting an idle stop and again under its card lock. A silent command therefore remains active past the 20-minute stale threshold; after a crash, heartbeats cease and normal idle/stale reclamation resumes. Heartbeats contain **only timestamps**, never command text, env values or output. An unreadable/invalid heartbeat skips the stop, and a failed initial write refuses command admission. These heartbeats protect overlapping sweeps; they do not turn the lifecycle store into an active-active coordinator. Boat's auto-stop remains the independent deadline safety net.

## Security

* VMs are created with `noEnv: true` and, by default, `monitoring: true`. Monitoring stays **ON by owner decision**; deployments can explicitly set `monitoring: false` for new credential-bearing VMs. Use a boat environment marked *safe for third parties*. See [monitoring retention](#monitoring-retention-and-privacy).
* **Default-deny run env.** Paperclip passes a sandbox provider the whole run env, with every secret resolved, and filters nothing for sandboxes. The plugin sends the VM only what the [env allowlist](#run-env-allowlist) names and drops the rest.
* The VM gets nothing of the account except boat's own `BOAT_ID` and `ASCII_TOKEN` (see [boat account settings](#boat-account-settings)). The plugin removes both from every command's environment, starts the shell above the command through `env -u` so no parent keeps them in its `/proc/<pid>/environ`, and deletes the `export ASCII_TOKEN=...` line from `~/.bashrc`, so the agent cannot casually publish a port on a public URL.
* Besides the allowlisted run env, one more secret reaches the VM, as a file that Paperclip writes itself: the [run MCP config](#the-run-mcp-config-exception) with the run JWT. The plugin cannot keep it out of the VM. It keeps it out of boat's snapshots: `~/.boatignore` leaves the directory it lands in out of every snapshot, and it is deleted before every stop, delete and template capture as well.
* The staged env file never sits in the workspace (the git checkout), so `git add -A` cannot commit it. It sits under `/tmp`, which boat snapshots do not save ([What a snapshot saves](https://docs.boat.dev/snapshots/whats-saved)), and it is gone before the command starts. If ssh drops before the script runs, the plugin removes it itself.
* An ephemeral ed25519 key is made per worker process with `ssh-keygen`. It is never stored.
* The host key comes from the API, and SSH uses `StrictHostKeyChecking=yes` with `HostKeyAlias=<sandbox id>`.
* The tunnel binds to `127.0.0.1` inside the VM only. Nothing is published.

### The run MCP config exception

The env allowlist covers the run env only. Paperclip also syncs files into the VM, and one of them holds a credential: claude_local writes the run's MCP config, `{"mcpServers": {...: {"headers": {"Authorization": "Bearer <token>"}}}}`, where the "Paperclip projects" server carries the **run JWT**. That JWT is valid for up to 48 hours and the Paperclip API that accepts it is reachable from the internet. Paperclip syncs the file as the `mcp-config` runtime asset to `<remoteCwd>/.paperclip-runtime/<adapter>/mcp-config/mcp-config.json` and never removes it (tog.22: server `heartbeat.ts` ~25853; claude-local `claude-config.ts` ~175 and `execute.ts` ~658-713; adapter-utils `sandbox-managed-runtime.ts` ~1531 and ~1690). `<remoteCwd>` is under `/home/user`.

boat saves `/home/user` in a snapshot every minute while a VM runs and once more at each stop. Resume and fork use only the newest snapshot, and a stopped VM's newest snapshot is kept for 14 days. The older per-minute snapshots are not used by resume or fork, but they stay in the VM's snapshot list for a short time, usually less than a day, and `boat snapshot pull <snapshotId>` can download files from them with the account's API key. Deleting the VM erases all of them ([How long boat keeps data](https://docs.boat.dev/data-retention#how-long-boat-keeps-data), [Restore an older snapshot](https://docs.boat.dev/snapshots/resume-and-fork#restore-an-older-snapshot-roll-back)). None of them saves `/tmp`, nor any path that a `.boatignore` names ([What a snapshot saves](https://docs.boat.dev/snapshots/whats-saved)).

#### The runtime directory is left out of snapshots

So the plugin puts the rule `.paperclip-runtime/` into `~/.boatignore` and makes `<root>/.paperclip-runtime` a real 0700 directory (lease metadata `runtimeDir` names it). boat reads a `.boatignore` with .gitignore rules, and one in the home folder applies to the whole sandbox ([Leave files out with .boatignore](https://docs.boat.dev/snapshots/whats-saved#leave-files-out-with-boatignore)); with no slash before the name, the rule matches a `.paperclip-runtime` at any depth. Measured on boat on 2026-10-23: with the rule, the per-minute and the stop snapshot trees hold each `.paperclip-runtime` as an empty directory, nothing below it. The plugin does this at acquire, at a resumed lease and at RealizeWorkspace, before Paperclip syncs anything, and again for every known root after it resumes a VM that stopped mid-lease. Everything Paperclip puts there for a run (the MCP config, skills, config, the bridge queue, GitHub launchers, upload tarballs) stays out of every snapshot. Paperclip syncs these files again for every run, so a resume on a new machine, which restores an empty directory, loses nothing it needs.

**It must be a real directory.** Before each run of an agent with an instructions bundle, Paperclip runs its own `node -e` program through Execute to write `.paperclip-runtime/.gitignore`, and that program refuses a `.paperclip-runtime` that is a symlink ("Unsafe runtime exclusion directory"; tog.22 `agent-instruction-files.ts`, `instructionGitExcludeProgram`), which fails the run with "Could not exclude agent files from task Git staging". Version 0.2.0 linked the directory into `/tmp`, and every run failed there. A bind mount from `/tmp` is no way out: boat's snapshots save what a bind mount shows under `/home/user` (measured the same day).

Paperclip's inbound workspace tar carries the host workspace's own `.paperclip-runtime/` (tog.22: neither `workspaceArchiveExclude` nor the git overlay copy leaves it out; repository clones, detached repositories), and Paperclip runs `tar -xf <tar> -C <root>`. So **every command the plugin runs exports `TAR_OPTIONS="--exclude=.paperclip-runtime ..."`** (after the run env, and ahead of any `TAR_OPTIONS` already set). GNU tar then skips every member with a path component of that name when it extracts, creates or lists: the host's runtime files are not unpacked over the run's, and an archive an agent packs never holds the run MCP config, even with `-h`. The exclude is not anchored and adds no position-sensitive option, so a command line's own `--exclude`s and member names match as before. A tar that ignores `TAR_OPTIONS` (busybox, bsdtar) is not covered; boat's image ships GNU tar. The fix that belongs in Paperclip is to add `.paperclip-runtime` to the inbound workspace excludes, as its restore and its SSH lane already do.

* An existing real directory is kept with its files, so a second run on a running VM keeps the first run's files. The run MCP config among them is already gone after a stop: the scrub removed it.
* A symlink (left by 0.2.0) or a file is replaced by a fresh directory. A link's target is left alone.
* Existing `~/.boatignore` lines stay; the rule is added once.
* The workspace root must be a plain absolute path under `$HOME` (no `.` or `..` components), where the home `.boatignore` applies. When the rule cannot be written or the directory cannot be made, acquire fails with `BOAT_RUNTIME_DIR_FAILED` and nothing of the run reaches the VM. A VM that this start created is deleted when that failed on the VM itself (a fresh VM holds nothing yet); ssh losing the command only stops it. The card's resumed VM is stopped with its disk kept (`keep: resumed_disk`): its disk holds the card's checkout and caches, and possibly a failed run's unexported work, so the error surfaces at its next start instead of the work being destroyed.

The agent can edit `~/.boatignore` (it is root in its VM). The plugin writes the rule again at every acquire, resumed lease and realize, and the scrub below covers the gap.

#### The scrub before every stop, delete and capture

The plugin still deletes the MCP config before every stop (release, StopLease, the idle sweep, and a failed start), every delete (DestroyLease, release of a per-run VM) and every template capture, as defense in depth: a VM whose `~/.boatignore` lost the rule would keep it in its snapshots. Over SSH it deletes:

* `<dir>/<adapter>/mcp-config` and `<dir>/<adapter>/mcp-config-upload.tar*` (the upload tarball and its partial-upload files), where `<dir>` is the `.paperclip-runtime` of every workspace root it knows of: the lease's `remoteCwd`, the roots it set up or realized on that VM (kept in plugin state, so another worker, and a failed start in a new worker, knows them too), `remoteWorkspaceDir` and `$HOME/paperclip-workspace`;
* the same paths in every `.paperclip-runtime` under `$HOME`, down to 4 levels (so the asset is at most 6 deep), skipping `node_modules`, `.git` and `target`.

`<adapter>` is exactly one path component: a skill's own `mcp-config` deeper down (`.paperclip-runtime/claude/skills/mcp-config/`) is not the run's asset and stays. The scrub then looks again and logs the result. Nothing else is removed: the checkout, `skills`, `config` and the bridge stay. Each match goes to `rm` as one argument and is never read back as a line of text, so a name with a newline in it (from repo content or an agent) cannot add delete targets. A VM that a second run on the same card still uses is left alone until the last release.

The scrub is verified only when its last look searched everything. `find`'s status and errors are checked, never discarded, and each runtime and adapter directory must be listable; a path that is missing only because a directory above it cannot be searched counts too (EACCES is not ENOENT). Anything unreadable makes the result `walk=incomplete` (exit 3): nothing left that it could see, but not verified.

#### When the scrub fails

When the cleanup fails (something is left, the script gives no result, or SSH to the running VM fails), the plugin does not stop the VM, because the stop snapshot could keep the token for 14 days (wherever it sits on the saved disk), and does not leave it running, because it would bill and keep the token live. It **deletes the VM instead** (an ordinary release, the sweep, a failed start of a VM that start created), which also erases its older snapshots, and logs why (`deleting the VM instead of stopping it (<trigger>)`). The card's next run starts a fresh VM, from `templateSnapshot` when that is set: one start, and a cold build cache. If the delete itself fails, the VM is stopped after all, with an error log. A template capture is refused instead (`BOAT_RUNTIME_SCRUB_FAILED`).

The one exception: a VM whose disk may hold work that Paperclip still needs is **stopped and its disk kept**, with an error log (`stopping the VM and keeping its disk although ...`, `keep` says why). That is:

* StopLease, and a release with `resourceDisposition: "stop_and_retain"`. Paperclip sends these to keep a run's unexported work (a failed run, a failed native finalize), and its export-resume recovery needs the `stopped` receipt. The plugin SDK forbids a delete as their fallback. The scrub fails most often exactly then: a wedged or out-of-memory VM. A VM keyed to a single run is stopped too.
* A forced release (`cancelActiveWork`) of a VM that another run on the card still holds.
* A sweep stop of a VM that a run still holds: an active run whose lease went stale, or a resumed lease (it never joins the active runs; its open run window counts).
* A failed start of the card's resumed VM (`keep: resumed_disk`); only a VM that the failed start created is deleted.
* A scrub whose walk was incomplete (`keep: incomplete_scan`): it found nothing left, but could not search part of the disk (a directory the SSH user cannot read, for example one a container made). That is not verified, so a template capture is refused, but it is no evidence of a left-over JWT either, so the card's work is not destroyed on it. A VM keyed to a single run is still deleted on release.

With the `~/.boatignore` rule in place, the stop snapshot of such a VM does not get the MCP config. A VM whose `~/.boatignore` lost the rule can keep the run JWT there for up to 14 days; that residual risk is accepted.

What this does not cover: per-minute snapshots taken before a VM first got the rule (a VM set up by 0.1.0) can hold the JWT until boat drops them, usually within a day, or the VM is deleted. A VM that boat's auto-stop stops, or one the plugin cannot reach, is not scrubbed by that stop; with the rule its snapshots have nothing to scrub, but boat keeps its machine and disk for 10 minutes, so a resume in that time finds the file again until the next scrub. Inside a running VM the agent can read the file, as it can read its own env. The real fix belongs in Paperclip: give sandbox MCP servers a bridge-scoped, short-lived token instead of the host run JWT.

## Configuration

Set these on the Paperclip sandbox environment, driver `boat`. Only `apiKey` is required.

| Key | Default | Notes |
| - | - | - |
| `apiKey` | - | A boat key with the `ci` preset: `boat api-key create <name> --preset ci --ttl 30d`. Falls back to `BOAT_API_KEY` on the host. |
| `size` | `small` | Fallback when this task class has no measurements. Existing explicitly configured sizes remain the fallback (set `default` for heavy builds); measured data takes precedence. |
| `taskClass` | `default` | Class to look up in `sizeCostTable`. Acquire can override with `executionWorkspaceSettings.boatTaskClass`. |
| `sizeCostTable` | `{}` | Completed-job measurements by class and size; cheapest computed cost wins. Refresh weekly as below. |
| `templateSnapshot` | none | A named snapshot to create new card VMs from. |
| `autoStopMinutes` | 120 | The trial allows at most 120. |
| `idleStopMinutes` | 5 | |
| `staleLeaseMinutes` | 20 | |
| `deleteAfterDays` | 7 | 1 to 13. |
| `maxActive` / `maxStartsPerDay` / `minComputeHoursLeft` | 2 / 70 / 1.0 | Matches the trial: 2 at once, 75 starts a day, 25 h. |
| `failFast` / `noReadyMachineRetries` | true / 2 | |
| `cliproxyTunnel` | true | |
| `tunnelRemotePort` | 8317 | |
| `tunnelTargetHost` | `127.0.0.1` | **Inside the Paperclip container, set this to `cliproxy`**: the container's 127.0.0.1 is not the CLIProxy. |
| `tunnelTargetPort` | 8317 | |
| `envAllowlist` | built-in list | Run env names that may reach the VM. See [Run env allowlist](#run-env-allowlist). A list you set replaces the built-in one; an empty list (`[]`) sends nothing. |
| `noEnv` | true | |
| `monitoring` | true | Explicit opt-out: `false` for **new** VMs. Existing VMs keep their creation policy. Never changes an account-wide switch; see [monitoring privacy](#monitoring-retention-and-privacy). |
| `boatEnvironment` | account default | |
| `remoteWorkspaceDir` | `$HOME/paperclip-workspace` | A plain absolute path below `/home/user`, used as typed (no `~` or `$HOME`). Anything else is a config error (`BOAT_CONFIG_INVALID` at acquire, before any start): the home `.boatignore` applies only there. |
| `namePrefix` | `paperclip` | |
| `costApiKey` | main key | An optional read-only key for usage reads. |
| `timeoutMs` / `stopConfirmTimeoutMs` / `sshConnectTimeoutSec` | 300000 / 120000 / 15 | |

## Measured size policy

A lower hourly price is not necessarily a cheaper completed job. On each AcquireLease and reusable ResumeLease, the plugin selects the size with the lowest **`hourlyRate * durationSeconds / 3600`** for the task class. Equal costs prefer the shorter measured duration. Prices in the measurements are USD per **whole VM-hour**, not per vCPU-hour. Only sizes with successful measurements participate; failed starts and out-of-memory attempts are not cheap completed jobs.

Configure measurements on the sandbox environment, for example:

```json
{
  "taskClass": "rust-build-test-clippy",
  "sizeCostTable": {
    "rust-build-test-clippy": {
      "default": { "durationSeconds": 316, "hourlyRate": 0.036, "measuredAt": "2026-10-23T07:20:59.605Z", "sampleCount": 1 },
      "large": { "durationSeconds": 182, "hourlyRate": 0.072, "measuredAt": "2026-10-23T07:20:59.605Z", "sampleCount": 1 }
    }
  }
}
```

These are the reported 2026-10-23 Rust benchmark totals (build all test binaries, edit plus core unit tests, clippy all targets). Expected cost is **$0.00316 on default** against **$0.00364 on large**: default wins despite large being faster. Small failed both attempts; it has no completed-job measurement. This measures that Rust job, **not** a whole agent run or a model-wait task. Benchmark unrelated task classes separately; do not copy the Rust timing into them.

Class names are 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit. Durations and hourly rates must be positive finite numbers, `measuredAt` an ISO timestamp with timezone, and `sampleCount` a positive integer (omitted: 1). Invalid policy config is refused with `BOAT_SIZE_POLICY_INVALID` before any VM starts; config validation returns the error to the caller.

- **No measurements for the class:** use `size`, which defaults to `small`; expected cost is `null`, never a fabricated zero. Small is the light-work fallback (model-wait, editing and modest scripts), **not** a safe default for unmeasured heavy builds. Pin `"size": "default"` for Rust compilation/test/clippy and similarly memory-intensive builds, or supply successful measurements for that class. The benchmark above failed on small twice: its lower hourly price is not evidence of lower completed-job cost. The plugin warns when an unmeasured class falls back to small; it does not guess the class from an issue title, command or adapter type. Use environment `taskClass` or workspace setting `boatTaskClass`. The class is retained in lease metadata for reusable resumes.
- **Already running:** share the actual VM without stopping or resizing it. Metadata and per-run usage retain its real size; an unrecognized or missing running size fails closed with `BOAT_SIZE_UNKNOWN` instead of guessing. A stopped (`archived`) card VM can change size on its next lease without losing its disk. Automatic mid-lease command reconnects retain the current size.
- **Plan limits remain authoritative:** every create/resume still passes `GET /limits`, daily/hourly/minute start guards, active-VM and compute limits. The policy never tries a different size to bypass a failed guard. No extra benchmark VMs are launched by selection.
- **Audit:** structured `boat: size choice for lease` logs and lease `sizeChoice` metadata contain class, size, source (`measured`, `fallback`, `running_vm`), expected cost, duration, measurement timestamp and sample count. These are predictions, not a replacement for Boat's usage meter. A shared VM without a matching measurement has `null` expected cost.

### Weekly refresh from the pilot cost log

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

Heavy-command-only offload is a separate execution mode and is not implemented by the size selector.

## Cargo offload shim (`bin/boat-offload-cargo`)

Design: `docs/adr/0001-heavy-command-offload.md`. Status: routes, broker, shim, executor adapter and concrete SSH guest lifecycle are implemented. Command dispatch is **default OFF**. Without all company and native-binding prerequisites below, each accepted submit journals `not_started` and the shim falls back to the existing bounded local path.

Install the shim as `cargo` ahead of the real executable for opted-in runs (`BOAT_OFFLOAD=1`); anything else, including unset and `0`, runs local cargo with no broker calls. Eligible subcommands are `build`, `test`, `check`, `clippy`, `nextest run` and `llvm-cov` compilation/test modes on an installed profile toolchain. Everything else (`fmt`, `add`, `update`, `metadata`, help/version, install, custom aliases, `--config`/`-Z`, compound shell text, `RUSTFLAGS` builds) stays local. Only an explicit nonsecret env (`CARGO_TERM_COLOR`, `RUST_BACKTRACE`) reaches the request; the run token travels in HTTP headers only.

Diagnostics never collide with cargo flags:

```sh
boat-offload-cargo --dry-run -- test --locked        # classify, no VM/sync/journal effect
boat-offload-cargo --dry-run --json -- test --locked # versioned envelope on stdout
boat-offload-cargo --json -- test --locked           # run; result envelope on stderr
```

Semantics the shim guarantees: incremental stdout/stderr with exit/signal passthrough (`128+N`); cancel kills the remote process group; a durable never-started receipt falls back locally exactly once; an ambiguous submit reconciles the same command ID for 10 s, then exits 75 with that ID and no replay; staged/conflicting remote outputs exit 74 with an artifact to apply explicitly; submit errors map to 64 (request), 77 (auth) or 75 (unknown/expired). Rollback is `BOAT_OFFLOAD=0`, which restores exactly the pre-existing local path.

### Enabling the executor bridge

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
3. **Client shim:** opt in the selected run with `BOAT_OFFLOAD=1`, as above.
   Keep secret-bearing/private-service commands local. The stock transport
   rejects all Cargo path overrides (`--manifest-path`, `--target-dir`, etc.)
   rather than guessing how to translate host paths.

Workspace authority comes from Paperclip's native `environmentRealizeWorkspace`
payload (whole-run leases) or from host-owned run, issue and workspace records
(local runs, below), never from the offload request body. Paperclip's
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
builds the same payload from host-owned data only:

1. the `agent.run.started` domain event gives the run id and its issue id;
2. `ctx.issues.get` gives the issue's `executionWorkspaceId`;
3. `ctx.executionWorkspaces.get` gives that workspace's local `path`, repository
   and project;
4. `offloadLocalApiKeySecretRef` (a Paperclip secret) gives the scoped boat key,
   resolved per binding and never stored; `offloadLocalEnvironmentId` and
   `offloadLocalDriverConfig` give the pool identity and settings.

### Node and Python offload (`bin/boat-offload-node`, `bin/boat-offload-python`)

Rust offload above extends to long Node and Python commands on two more server
profiles: `node-public-1` (npm/pnpm/yarn scripts and test binaries such as
`vitest run`, `jest`, `playwright test`, `next build`) and `python-public-1`
(`pytest` and `python -m pytest|unittest` suites). Install the shim as
`npm`/`pytest`/etc. ahead of the real executable for opted-in runs
(`BOAT_OFFLOAD=1`); anything else runs locally. Diagnostics work the same:
`boat-offload-node --dry-run -- run test`. Only profile `rust-public-1` is
enabled by default; add profiles explicitly:

```json
{
  "offloadProfiles": ["rust-public-1", "node-public-1", "python-public-1"]
}
```

Only LONG commands go remote. The plugin keeps per company + repository +
profile + normalized-command-signature duration history (last 20 runs,
30-day TTL) in its existing company-scoped state. A Node/Python command is a
remote candidate only when its recorded median meets
`offloadMinExpectedSeconds` (default 120); unknown signatures run local first
and record, so the second identical long run can go remote. Recordings come
from completed remote runs (server-side) and from shim-reported local runs
(`POST /offload/report`, agent-authed, bounded samples). Rust keeps its
existing behaviour and is never gated by this setting.

Short commands must stay local: sync plus VM overhead (~30 s) makes anything
shorter slower remotely. Watch modes, single-file filters, lint/typecheck/
format, install/ci, dev servers, inline `python -c`, deploy/publish/release-like
scripts (any name containing deploy, publish, release, push, upload, prod or
ship) and anything unrecognized stay local. Only exact `build` plus an
allowlisted build suffix stays remote. Frozen source sync excludes `node_modules`, `.venv`/`venv`,
caches and build outputs; the guest installs dependencies from the lockfile
(`npm ci`, `pnpm/yarn --frozen-lockfile`, `uv sync --frozen`, hash-pinned
`requirements.txt` via `pip install --require-hashes -r`, where every
requirement is `name[extras]==version` with `--hash=sha256:` and no pip
option lines) into a per-VM cache keyed by lockfile hash. Global pip installs reuse the cache across runs;
checkout-local installs (`node_modules`, `.venv`) reinstall per command so a
warm VM never reuses a stale checkout. Python commands from a `uv.lock` plan
run from the checkout `.venv` interpreter (`.venv/bin/<runner>`) with
`VIRTUAL_ENV=<checkout>/.venv` and `<checkout>/.venv/bin` prepended to the
guest `PATH` for that command only (every other env key stays empty), so
console scripts and bare `python` subprocesses cannot resolve the system
interpreter. No lockfile
(or competing lockfiles for the same tool) means the command stays local: the
plugin never installs from an unlocked manifest, and an unpinned
`requirements.txt` stays local.
Package lockfiles at the repo root are return-eligible like `Cargo.lock`.
Registry credential files (`.npmrc`, `.yarnrc*`, `.pypirc`, `pip.conf`,
`.netrc`) at any depth, plus `uv.toml` and `pyproject.toml` uv auth config,
are never synced and keep commands local. Symlinked config is never followed:
a symlinked `pyproject.toml` stays local without reading its target, and
regular `pyproject.toml` files are read bounded at 256 KiB. Only an empty env
travels with Node/Python requests except `VIRTUAL_ENV` for `uv.lock` venv
commands; secret-free env policy, public allow-listed
repositories and cwd/argv confinement apply unchanged.

`offloadMonthlyVmHourCap` (default 0, disabled) caps the month's tracked
offload VM-hours per company against the existing account-ledger usage rows;
once reached, new commands run local until next month.

The agent and the offload request body supply nothing. The started event usually
arrives before Paperclip prepares the run's workspace, so the bind is retried when
that run's first offload request arrives. A binding never replaces a whole-run
realization for the same run and workspace. `agent.run.finished`, `failed` and
`cancelled` drop the executor binding and the persisted workspace record, and fence
the run: a late or slow start handler cannot bind it again. A missing host fact (no
execution workspace, no local path, no secret) leaves the run unbound, and its
commands get 403 before dispatch. This adds three capabilities to the 0.2.2
set: `events.subscribe`, `execution.workspaces.read` and `secrets.read-ref`; the
upgrade needs board approval of that capability change.

A custom host integration can still call
`BoatVmManager.rememberOffloadWorkspace(params)` with a host-authored
`PluginEnvironmentRealizeWorkspaceParams` payload instead. It performs no
provider work and is not exposed as an agent route. Older hosts without the
native realization metadata must keep the shim off, not supply a root in the
request body. This binding does not replace the executor resolver's source
confinement or enable dispatch. Failed optional binding persistence does not
break whole-run workspace realization.

`src/offload/executor-backend.ts` adapts `start`, scoped `readOutput`,
`heartbeatCommand` and `cancelCommand`. Output is polled incrementally (250 ms
by default), preserving bytes and stream order, including all terminal pages.
Client heartbeats, not the output poller, renew guest interest. Cancellation
waits for the executor's cleanup and settled sync receipt, preserving staged or
conflicting changes and draining shutdown output before publishing the terminal
receipt; it cannot grant fallback while sync-in still reads source. A live
command held as `unknown` after a heartbeat failure remains cancellable and
subject to expiry; missing handles after restart still require reconciliation.
A rejected/lost start acknowledgement, uncertain execution, unreadable output
or unverified cancellation becomes an `unknown` hold with **no local replay**.
Only an authoritative never-started receipt (or a binding refusal before calling
`start`) permits local fallback. This includes explicit admission refusals that
allocate no executor journal row. A starting acknowledgement is already evidence
against fallback, even if a later read contradicts it. No blind dispatch retries
are added.

Rollback: set company `offloadExecutorEnabled` to `false` for new admissions,
then use `BOAT_OFFLOAD=0` for future local commands. Do not re-run an already
uncertain command locally. Broker restart still holds unresolved commands for
reconciliation; this adapter does not automatically reattach lost handles.
The stock lifecycle executor uses the existing native sweep/recovery/shutdown
integration. Loopback SSH acceptance tests exercise actual kernel enforcement;
no deployment, live Boat call or live Boat enforcement claim is part of them.

### Concrete transport and fallback

`src/offload-ssh.ts` and `src/offload-ssh-script.ts` implement preflight, prepare,
arm, inspect, TERM, recursive KILL and empty verification over `SshManager`.
Native binary sync and its shell supervisor are reused, including pinned host
keys, managed channel cancellation and bounded control output. Each reservation
refreshes the API-authorized SSH endpoint/key before transfer, including resumes.

Preparation creates a fresh cgroup and a gated process group. A separate detached
watchdog remains outside that subtree and the SSH channel. Boot ID, process
start time, cgroup inode and generation fence controls; the one-use start gate
follows durable host intent. The watchdog kills the subtree on execution deadline,
expired client interest or supervisor loss. Heartbeats renew the guest watchdog
and host timer; reads renew neither. Losing a result/output channel is uncertain,
not permission to replay. Output is capped at 1 MiB; overflow fails closed rather
than returning truncated success. New pool VMs keep monitoring on. The existing
native sweep job owns stop retry/reconciliation; no host pacer is added.

**Fallback:** without functional cgroup-v2 delegation and a verified outside
watchdog, the command never starts and the existing bounded local path remains
available. A process group cannot contain `setsid` descendants, so the stock
transport does **not** advertise the shell supervisor as equivalent containment.
Use an already delegated guest image; the plugin never changes systemd, mounts,
delegation or services. This is lifecycle containment within a trusted pool,
not a security boundary against hostile code sharing its UID/delegation authority.

Source is frozen with the existing manifest/exclusion checks and sent through
native sync. This first concrete adapter sends fresh command-scoped checkouts
(no delta/cache preservation yet). Return inspection hashes files in bounded
chunks and fetches at most 4 MiB into private staged artifacts, never live source.
Only approved public, secret-free inputs belong here: exclusions are defense in
depth, not a secret scanner. Successful collection removes the disposable guest
checkout. Artifacts remain in the configured persistent host root for explicit
review/removal. Failed or uncertain collection retains the reservation and files.
A restart does not reattach old handles or reconstruct interrupted in-memory
sync manifests; those commands remain held for inspection.

### Real-SSH acceptance tests (no Boat calls)

Tests use the isolated loopback `sshd` harness, throwaway keys and an unprivileged
daemon, without host SSH/service changes. `PAPERCLIP_TEST_SSHD` selects an isolated
OpenSSH executable if needed. Execution assertions need Linux cgroup delegation;
without it the ordinary suite verifies real-SSH refusal/local fallback instead.
`PAPERCLIP_TEST_CGROUP_REQUIRED=1` makes absent delegation an explicit failure,
never a skipped execution proof. On a Linux development machine with delegation,
this **one-shot test scope** is not an installed service, timer or automation:

```sh
scratch=$(mktemp -d)
# From the repository root, after npm ci --ignore-scripts:
systemd-run --user --scope --quiet --property=Delegate=yes \
  env VITEST_MAX_WORKERS=1 PAPERCLIP_RUN_SCRATCH_DIR="$scratch" \
  PAPERCLIP_TEST_CGROUP_REQUIRED=1 \
  nice -n 15 python3 -I src/test-support/run-loopback-ssh-tests.py --check
rm -rf "$scratch"
```

The launcher runs typecheck, full Vitest suite and build under one child-subreaper
boundary, then reaps only its own descendants. `PAPERCLIP_TEST_CGROUP_PARENT` can
select an existing test delegation. Provider calls are fake; SSH, file transfer,
watchdogs, cgroups, cancellation and staging are real. No live Boat VM is used.

### Delegated guest template (required for remote offload)

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
4. Reboot, then run the preflight with `offloadCgroupParent`
   `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service`. It must print
   `true`.
5. Save the VM as a named snapshot (not available during the boat free trial)
   and set the driver `templateSnapshot` to that name. Offload pool VMs then
   boot from it, as whole-run leases do; a missing snapshot is a refused start
   and the command stays local. The snapshot name is part of the pool identity,
   so changing it never reuses VMs that booted from the old image.

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

## Run env allowlist

### Why

On 2026-10-22 the first pilot run on a boat VM (TOG-37420) received the TWO Bot Next project env, including four PlanetScale production secret references, which Paperclip resolves to their values before a run starts. Paperclip merges project, routine and environment env into every run and filters nothing for a sandbox, and plugin versions before 0.2.0 sent every string entry to the VM. The claude-local adapter also passes `{ ...process.env, ...env }` (the Paperclip server's own environment) to the command-resolution probe it runs in the sandbox. Since 0.2.0 no run env key reaches a VM unless an allowlist names it. That covers env only: the run JWT still reaches the VM in a file Paperclip writes, which `~/.boatignore` keeps out of every boat snapshot, and which the plugin deletes before every stop (see [The run MCP config exception](#the-run-mcp-config-exception)).

### Rules

For each `NAME=value` that Paperclip passes to Execute:

1. The name must match the allowlist: an exact `NAME`, or a `NAME_*` prefix. Anything else is dropped.
2. These are never sent, even when the allowlist names them exactly:
   * names starting with `PLANETSCALE_`, `CLOUDFLARE_`, `CF_`, `DISCORD_`, `GH_`, `GITHUB_`, `BOAT_` or `ASCII_`;
   * a value with a JWT anywhere in it (`eyJ...` header, `.`, `eyJ...` payload, `.`), bare, behind `Bearer `, or inside JSON or a header, for example Paperclip's run token (`PAPERCLIP_API_KEY` before the sandbox bridge starts);
   * a value with anything URL-like in it (`scheme://`, also JSON-escaped as `:\/\/` or percent-encoded, or a `user:password@`) that is not, as a whole, one URL in unambiguous characters (no space, quote, backslash or control character; one `@` at most, in the authority; nothing URL-like in its path, query or fragment), or JSON whose every URL-like string is one. A URL that parses is never taken as proof that the text around it is safe: the old check parsed only `https://o/` out of `https://o/'reilly:pw@github.com/o/r`;
   * a database URL, or a URL with credentials (a user, a password or a credential query parameter such as `access_token`), unless its effective destination is the VM itself: the literal host `localhost`, `127.0.0.1` or `[::1]`, an empty host or a unix socket path, and no query parameter that names another endpoint (libpq's `host`, `hostaddr`, `service`, and anything like them; a `host` or `socket` of absolute paths is a socket). No other IP spelling (`0xc0000214` is 192.0.2.20 to the resolver) and no one-label name (a DNS search domain can resolve it off the VM) counts. Such a VM-local URL is allowed only by an exact entry. A `..._DATABASE_URL` or `..._DB_URL` name (also `_URI`, `_DSN`) counts as a database URL whatever its value, so it must be one such URL.
3. A name with `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `PRIVATE_KEY`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `CREDENTIAL`, `COOKIE`, `SIGNING`, `HMAC` or `SALT` in it, or ending in `_KEY` (or named just `KEY`), `_AUTH` or `_PAT`, is sent only when the allowlist names it exactly, never through a prefix. So `PAPERCLIP_BRIDGE_SIGNING_KEY` and `LC_SESSION_KEY` are dropped although `PAPERCLIP_BRIDGE_*` and `LC_*` are on the built-in list. A `..._TOKENS` name with a whole-number value is a token budget, not a credential.

Dropped keys are logged once per run as a warning, by name and reason (`not_allowlisted`, `denied_family`, `jwt`, `remote_database_or_credential_url`, `secret_name_needs_exact_entry`, `invalid_name`). Values are never logged.

The plugin also refuses every command of Paperclip's ACP process-session launcher, because that launcher starts the agent from a base64 envelope of its command and its whole launch env (project secrets included) that no env filter sees. An envelope up to 64 KiB rides the launch inline as `PAPERCLIP_PROCESS_SESSION_COMMAND_B64`. A larger one is uploaded through Execute as a file, `<runtime root>/process-sessions/<uuid>/command.b64`, in `printf '%s' <base64 chunk> >> ...` commands, and the launch then carries only `PAPERCLIP_PROCESS_SESSION_DIR`. So Execute refuses a command whose command or arguments name a `/process-sessions` directory or a `command.b64` file, or contain `PAPERCLIP_PROCESS_SESSION_COMMAND_B64=` or `PAPERCLIP_PROCESS_SESSION_DIR=`, and a command whose env holds either variable. Every ACP step names that directory, starting with the wrapper-script sync, so an ACP run fails at its first step, before any envelope reaches the VM (error `BOAT_ACP_PROCESS_SESSION_REFUSED`). claude_local uses ACP unless its engine is set, so set `engine` to `cli` for agents on boat environments.

### The built-in list

It covers a Claude Code run through the model-proxy tunnel and Paperclip's sandbox callback bridge. Each `PAPERCLIP_*` name was checked in Paperclip's claude-local adapter and adapter-utils: ids, modes and paths, plus the bridge's per-run credentials.

| Group | Names |
| - | - |
| Model proxy | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (the environment's dedicated model-proxy key), `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_*` |
| Claude Code | `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, `API_TIMEOUT_MS`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `MAX_THINKING_TOKENS`, `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `DISABLE_AUTOUPDATER`, `DISABLE_ERROR_REPORTING`, `DISABLE_TELEMETRY`, `DISABLE_NON_ESSENTIAL_MODEL_CALLS`, `IS_SANDBOX` |
| Paperclip run context | `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_ISSUE_WORK_MODE`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`, `PAPERCLIP_WORKSPACE_CWD`, `PAPERCLIP_WORKSPACE_SOURCE`, `PAPERCLIP_WORKSPACE_STRATEGY`, `PAPERCLIP_WORKSPACE_ID`, `PAPERCLIP_WORKSPACE_REPO_URL`, `PAPERCLIP_WORKSPACE_REPO_REF`, `PAPERCLIP_WORKSPACE_BRANCH`, `PAPERCLIP_WORKSPACE_WORKTREE_PATH`, `PAPERCLIP_WORKSPACES_JSON`, `AGENT_HOME` |
| Paperclip sandbox bridge | `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_API_BRIDGE_MODE`, `PAPERCLIP_BRIDGE_TOKEN`, `PAPERCLIP_BRIDGE_*`, `PAPERCLIP_SANDBOX_EXEC_CHANNEL` |
| Shell | `PATH`, `HOME`, `TERM`, `LANG`, `LC_*`, `TZ` |

In a sandbox run, `PAPERCLIP_API_KEY` and `PAPERCLIP_BRIDGE_TOKEN` hold the bridge token: a random per-run value that only the bridge inside this VM accepts, and the host forwards each bridged call with the real run token. When `PAPERCLIP_API_KEY` holds the run JWT itself (the commands Paperclip runs before the bridge starts), the JWT rule drops it.

Not on the list, on purpose: `ANTHROPIC_API_KEY` and any other model key (the Paperclip server's own key reaches the probe otherwise), `PAPERCLIP_RUNTIME_SERVICES_JSON` and its siblings (host services a VM cannot reach), `PAPERCLIP_PROCESS_SESSION_COMMAND_B64` and `PAPERCLIP_PROCESS_SESSION_DIR` (the ACP launcher, refused anyway), git and GitHub credentials (Paperclip restores the workspace and its git history to the host after each run).

### Adding names

A list you set replaces the built-in one, so start from the table above and add what the work needs. An empty list (`envAllowlist: []`) sends no run env at all; validation keeps it and warns, since a Claude run cannot work without the model-proxy and bridge keys. A blank string counts as unset. Validation fails on an entry that is not `NAME` or `NAME_*`, and warns when the list no longer delivers `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` or `PAPERCLIP_BRIDGE_TOKEN`, or names a family that is never sent. For a Rust card with a test database in a container on the VM, add for example `CARGO_*`, `RUSTUP_HOME` and `TWO_TEST_DATABASE_URL` (an exact entry, and its URL must point at the VM).

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
* a build without the run env allowlist (0.2.0). Before it, every env key Paperclip passed, project secrets included, reached the VM;
* a build that does not delete Paperclip's run MCP config before a stop, delete or capture. Without it the run JWT stays in boat snapshots;
* a build that does not put the `.paperclip-runtime/` rule into `~/.boatignore`, or that does not tell every command's tar to skip `.paperclip-runtime`. Without the rule, the run JWT is in boat's per-minute snapshots while a run holds the VM. Without the tar exclude, Paperclip's workspace extract unpacks the host's runtime files over the run's;
* a build that still links `.paperclip-runtime` into `/tmp` (0.2.0). Paperclip refuses that link and fails every run;
* a destination that already exists.

Then install it as an instance admin. `packageName` is the path as the server sees it:

```sh
curl -X POST "$PAPERCLIP/api/plugins/install" -H 'content-type: application/json' \
  -d '{"packageName":"/paperclip/plugin-packages-root/sandbox-boat-0.2.1-<sha>","isLocalPath":true}'
```

The capabilities are:

* `environment.drivers.register`;
* `plugin.state.read` and `plugin.state.write`;
* `jobs.schedule`;
* `api.routes.register`;
* `issues.read`, used to see whether a card is done.

After the install, save a plugin config for every company that uses the plugin. It can be empty:

```sh
curl -X POST "$PAPERCLIP/api/plugins/<pluginId>/config" -H 'content-type: application/json' \
  -d '{"companyId":"<companyId>","configJson":{}}'
```

The host lets a plugin's background work (the idle sweep, and the sweep that starts after an acquire or release) touch only the state of companies the plugin is configured for. Without that row, the sweep logs `state <companyId>: ... company context is required` and skips the company; release still stops each VM, and boat's auto-stop stays the backstop.

Then create a sandbox environment with provider `boat` and the config above. Run *Probe*, which starts no VM, and then point one pilot agent at it.

To undo, uninstall the plugin from the Plugins page and delete any `paperclip-*` VMs with `boat delete <id> --yes`.

## boat account settings

These are the settings the plugin expects, with the docs (docs.boat.dev) that back them. Check yours with `boat env info <env>`, `boat data-retention status` and `boat limits`. The AI-proxy and auto-refill switches need an admin key or the dashboard to read.

* **Sign in with Google or email, not GitHub.** Then boat has no GitHub token of yours to pass into a VM ([docs](https://docs.boat.dev/environments/access#what-a-normal-sandbox-receives)).
* **Environment: safe for third parties ON.** The raw toggles still read `true`; the `effective` `passGithub`, `passSecrets`, `passSandboxCredentials` and `passAgentsCredentials` must all be false ([docs](https://docs.boat.dev/environments/access)). Keep `proxyAiCredentials` off.
* **AI credentials proxy OFF.** It costs $1 a day, and on the trial one day uses the whole 25 h allowance ([docs](https://docs.boat.dev/free-trial)).
* **Zero data retention OFF.** It deletes a VM's data at every stop, so resume would never work ([docs](https://docs.boat.dev/data-retention/zero-data-retention)).
* **Snapshots off: OFF.** With it on, a stop erases the VM ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off)).
* **Monitoring on: per VM, with an explicit opt-out.** The default remains `monitoring: true` by owner decision. Set `"monitoring": false` on the sandbox environment for new VMs when retained command/process telemetry is inappropriate. If the account-wide *Monitoring off* switch is on, a monitored create is refused (`409 monitoring_off_for_account`, surfaced as `BOAT_MONITORING_OFF_FOR_ACCOUNT`). The plugin never enables monitoring account-wide, changes that switch on an account/key change, or silently retries with a different policy ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off#monitoring-off)).
* **Auto-refill OFF.** It needs a paid plan and does not work during the trial. With it off, spend stops at the balance ([docs](https://docs.boat.dev/billing#control-your-spend)).
* **Keys:** a scoped `ci` key for the plugin and a `read-only` key for cost reads. Never use an admin key in the plugin.

Even with safe for third parties on, every VM gets `BOAT_ID` and `ASCII_TOKEN`. `ASCII_TOKEN` can publish a port of that one VM on a public URL and nothing else ([docs](https://docs.boat.dev/security#boat-credentials-inside-a-sandbox)). boat sets it in the exec environment and in an `export ASCII_TOKEN=...` line near the top of `~/.bashrc`, above the interactive guard, so any shell that reads `~/.bashrc` exports it. The plugin:

* runs every command script as `exec env -u ASCII_TOKEN -u BOAT_ID sh -c <script>`: sshd's login shell, which started with the tokens, becomes a `sh` that never had them, so no process between sshd and the command keeps them in its `/proc/<pid>/environ` (`unset` hides a variable from children, but `/proc/<pid>/environ` keeps a process's startup environment). That `sh` stays the command's parent and exits with its status, so a command killed by a signal reports 128+n; when the command itself replaced every shell, sshd reported the signal and ssh exited 255, which reads as a lost VM. The script unsets both again after the profiles and the env file are sourced, before the command starts;
* deletes the `export ASCII_TOKEN=` line from `~/.bashrc` when it sets up a VM (acquire, resumed lease) and when it resumes one for a command, so a shell the agent starts (Claude Code's Bash tool sources the user's shell rc file) does not get it back.

This stops casual use, not a determined agent: `user` has passwordless `sudo` and is root in its VM. boat documents no switch to leave the token out: it stays even with safe for third parties.

### Monitoring retention and privacy

Monitoring is provider-side capture, not just a CPU/RAM counter. Boat SDK 1.10.0 documents command history retained for 90 days and other processes' stdout/stderr for 72 hours, readable while a VM is stopped (`docs/BoatApi.md`, `commandHistory`). An agent that prints a credential or places it in argv can expose it to that capture even over SSH. **`noEnv`, `.boatignore`, and the pre-stop/pre-template disk scrub do not redact or erase already captured provider telemetry.** The SDK exposes no monitoring-output redaction/deletion guarantee; this plugin does not promise one.

The plugin deliberately does not request history, command logs or process samples, and projects lifecycle responses onto metadata-only fields: captured output is never copied into plugin state or logs. The same no-secret-output boundary applies to snapshot scrub diagnostics: only counts, status and fixed failure reasons are logged, never raw guest stdout/stderr. Existing runtime-directory exclusions and the scrub before stop/delete/template capture remain mandatory with monitoring on **or** off. These protect the disk, not the provider's telemetry store.

To opt out, set `"monitoring": false` in the environment config **before creating** a VM. This does not change or purge an existing VM's monitoring history; the SDK's update/resume requests do not support changing that creation policy. Keep existing work, export it through the normal Paperclip lifecycle, then use a newly created lease with the opted-out config if required. Never auto-delete a working VM or override an account's privacy setting to make a create succeed. With the default on, do not print credentials or put them in command arguments; if that cannot be assured, use the explicit opt-out.

## Live smoke test

`scripts/live-smoke.mjs` runs the plugin's own code against the real API. It does create, SSH, env (an allowlisted key arrives, denied keys and `ASCII_TOKEN` do not), tunnel, stop, resume, stop and delete. It also checks that boat's `ASCII_TOKEN`/`BOAT_*` names are in neither `/proc/$PPID/environ` (nor any readable ancestor's), `/etc/environment` nor `~/.bashrc`; that `.paperclip-runtime` is a real directory that passes Paperclip's own check and `~/.boatignore` has the rule, so a stand-in run MCP config written there is in no snapshot tree (per-minute or stop) and is gone after the resume; that Paperclip's workspace extract of a host tar with a `.paperclip-runtime/` member, run through Execute with the VM's own tar, keeps the directory and the stand-in and unpacks none of the host's runtime files (it also prints the VM's tar version and what that tar does without the exclude); and that a command killed by SIGTERM exits 143. It costs about $0.001.

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
