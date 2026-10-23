# paperclip-plugin-sandbox-boat

A [Paperclip](https://github.com/paperclipai/paperclip) sandbox-provider plugin that runs agent work on [boat.dev](https://boat.dev) VMs. A VM exists for one card and runs only while a run on that card needs it.

It started as a copy of Paperclip's bundled `exe-dev` provider. All boat calls go through the official TypeScript SDK, [`@boatdev/sdk`](https://docs.boat.dev/sdks/typescript) (pinned to 1.10.0). There is no hand-written REST client.

## What it does

| Paperclip hook | boat action |
| - | - |
| AcquireLease | The card already has a VM: resume it if it is stopped, or share it if it is running. Otherwise create a VM, from `templateSnapshot` when that is set. Every start passes the budget guard first and uses fail-fast. Before the lease goes back to Paperclip, the workspace's `.paperclip-runtime` is made a real directory that [`~/.boatignore` leaves out of every snapshot](#the-runtime-directory-is-left-out-of-snapshots). A start that fails is stopped. A VM that this start created is deleted instead when its disk cannot be checked; the card's resumed VM is always stopped with its disk kept, because that disk holds the card's work. |
| Execute | SSH as boat's non-root `user`, with the host key pinned from `POST /sandboxes/{id}/sshkey`. Only the run env keys the [env allowlist](#run-env-allowlist) names reach the VM; the rest is dropped and logged by name. The kept env goes over stdin into a 0600 file in a fresh 0700 directory under `/tmp`, never in argv. sshd's login shell runs `exec env -u ASCII_TOKEN -u BOAT_ID sh -c <script>`, so the shell above the command never had boat's tokens in its environment. The script sources the profiles and the env file, removes the file, clears the tokens again (a profile may export them), and runs the command; it exits with the command's status, 128+n for a command killed by signal n. A reverse tunnel makes `127.0.0.1:8317` inside the VM reach the model proxy. |
| ReleaseLease | Remove [Paperclip's run MCP config](#the-run-mcp-config-exception) from the VM, then stop the VM at once, which stops billing. When that removal fails, the VM is deleted instead of stopped, unless [its disk must be kept](#when-the-scrub-fails) (`stop_and_retain`, or another run still holds the VM). A VM keyed to a single run has nothing worth keeping, so it is deleted, except on `stop_and_retain`, which stops it. A VM that another run on the card still uses stays up, untouched, until the last release. |
| (reuse) | The driver declares `sandboxCapabilities.reusableLeases`. With `reuseLease: true` and `runnerLifecycleMode: "per_turn"` on the environment, Paperclip stops the card's VM after each run and resumes it for the card's next run, so the checkout and build output stay on its disk. Without reuse, Paperclip destroys the VM after every run (DestroyLease) and the next run starts a fresh one from `templateSnapshot`. Never set `runnerLifecycleMode: "warm"`: it keeps the VM running between runs. |
| StopLease | Remove the run MCP config, stop the VM, keep its disk, and confirm the stop or throw. When the removal fails, the VM is still stopped and its disk kept, with an error log: Paperclip sends StopLease to keep unexported work, and never accepts a delete in its place. |
| DestroyLease | Remove the run MCP config (in case the delete fails), delete the VM and forget the card mapping. |
| ResumeLease | Under the card lock, as acquire: wait for a stop that boat is still saving (up to `stopConfirmTimeoutMs`, else `BOAT_STOP_PENDING`), resume the lease's VM and prepare its `.paperclip-runtime` again, or report the lease expired. |
| RealizeWorkspace | `mkdir -p` the workspace inside the VM (`$HOME/paperclip-workspace` by default) and prepare its `.paperclip-runtime` (an existing directory stays). |
| Probe | Read `GET /limits`, check the `ssh` client and the tunnel target. It never starts a VM. |
| CaptureTemplate / DeleteTemplate | Save or delete a boat named snapshot. Capture refuses to go past the 10 free snapshots unless `allowPaidNamedSnapshots` is set. Before the save it removes the run MCP config and refuses the capture (`BOAT_RUNTIME_SCRUB_FAILED`) when it cannot verify that; a stopped VM is resumed for that, budget-guarded. |

### Cost rules

* **One VM per card.** The key is the execution workspace, else the issue, else the run. The mapping lives in plugin state and in the VM's name, `<namePrefix>-<16 hex>`, so a lost state does not lose the VM. The checkout and build dirs stay on the stopped disk. boat keeps a stopped disk free for 14 days.
* **Stop on release.** Billing stops at the stop ([docs](https://docs.boat.dev/snapshots/stop)). In our trial a resume within 10 minutes of a stop got the same machine back and did not count as a start.
* **One lock per card.** Acquire, ResumeLease, release, destroy, capture and the sweep's stop and delete take the same per-card lock, so a new run never reads the VM as running while the previous run's release stops it, and the sweep never stops or deletes a VM that a run is taking: under the lock it reads boat, plugin state and its own activity again and leaves the VM alone if anything changed. A VM of ours with no record (an orphan, after plugin state was lost) has no known card, so acquire and ResumeLease also take a lock on the VM's name, which the sweep takes for an orphan. A new run, a resumed lease or a command that finds the VM still stopping (`archiving`) waits up to `stopConfirmTimeoutMs` for the save to end, then resumes it, or fails with `BOAT_STOP_PENDING` without starting anything.
* **Auto-stop is a deadline, not idle detection.** It counts from the start or resume ([docs](https://docs.boat.dev/long-running-tasks/auto-stop)). The plugin sets it to `autoStopMinutes` (120, the trial maximum) as a safety net. It extends the deadline only while a command is running and less than half of it is left. An idle VM is never extended.
* **Idle sweep, every 5 minutes.** It runs outside any host request (`src/proactive.ts`), because the host refuses plugin state in a scheduled job's company-less request and in a request that already ended. A VM with no active run is stopped after `idleStopMinutes` (15) idle. A VM whose lease is held but sent no command for `staleLeaseMinutes` (60) is stopped too. Before each of these stops the sweep removes the run MCP config, the same as release, opening an SSH session when this worker has none; a VM where that fails is deleted instead, unless a run still holds it (an active run, or a resumed lease's open run window), which keeps its disk. A scrub that found nothing left but could not search the whole disk stops the VM with its disk kept. A stopped VM is deleted when its card is done or cancelled, or after `deleteAfterDays` (7) untouched. The sweep only touches sandboxes named with our prefix. While a company's plugin state cannot be read, a VM with no record may be that company's (with an active lease), so the sweep neither stops nor deletes such a VM until the state can be read again; companies whose state it reads are swept as usual.
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
| `size` | `default` | Fallback when this task class has no measurements. Existing explicitly configured sizes remain the fallback; measured data takes precedence. |
| `taskClass` | `default` | Class to look up in `sizeCostTable`. Acquire can override with `executionWorkspaceSettings.boatTaskClass`. |
| `sizeCostTable` | `{}` | Completed-job measurements by class and size; cheapest computed cost wins. Refresh weekly as below. |
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
| `envAllowlist` | built-in list | Run env names that may reach the VM. See [Run env allowlist](#run-env-allowlist). A list you set replaces the built-in one; an empty list (`[]`) sends nothing. |
| `noEnv` | true | |
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

- **No measurements for the class:** use `size`, which defaults to `default`; expected cost is `null`, never a fabricated zero. The plugin does not guess the class from an issue title, command or adapter type. Use environment `taskClass` or workspace setting `boatTaskClass`. The class is retained in lease metadata for reusable resumes.
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

Design: `docs/adr/0001-heavy-command-offload.md`. Status: routes, broker and shim are implemented; remote execution wires in when the executor grows start/cancel, so today every submit journals `not_started` and the shim falls back to the existing bounded local path.

Install the shim as `cargo` ahead of the real executable for opted-in runs (`BOAT_OFFLOAD=1`); anything else, including unset and `0`, runs local cargo with no broker calls. Eligible subcommands are `build`, `test`, `check`, `clippy`, `nextest run` and `llvm-cov` compilation/test modes on an installed profile toolchain. Everything else (`fmt`, `add`, `update`, `metadata`, help/version, install, custom aliases, `--config`/`-Z`, compound shell text, `RUSTFLAGS` builds) stays local. Only an explicit nonsecret env (`CARGO_TERM_COLOR`, `RUST_BACKTRACE`) reaches the request; the run token travels in HTTP headers only.

Diagnostics never collide with cargo flags:

```sh
boat-offload-cargo --dry-run -- test --locked        # classify, no VM/sync/journal effect
boat-offload-cargo --dry-run --json -- test --locked # versioned envelope on stdout
boat-offload-cargo --json -- test --locked           # run; result envelope on stderr
```

Semantics the shim guarantees: incremental stdout/stderr with exit/signal passthrough (`128+N`); cancel kills the remote process group; a durable never-started receipt falls back locally exactly once; an ambiguous submit reconciles the same command ID for 10 s, then exits 75 with that ID and no replay; staged/conflicting remote outputs exit 74 with an artifact to apply explicitly; submit errors map to 64 (request), 77 (auth) or 75 (unknown/expired). Rollback is `BOAT_OFFLOAD=0`, which restores exactly the pre-existing local path.

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
* **Monitoring off: per VM.** The plugin creates every VM with `monitoring: false`, so boat keeps no command output, process list or CPU/RAM samples for it. That works whether the account-wide *Monitoring off* switch is on or off: with the switch on, boat refuses only `monitoring: true` (`409 monitoring_off_for_account`). Turning the switch on as well also covers VMs made by hand, for example `boat new` without `--no-monitoring`. Either way, these VMs get no disk-full alerts ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off#monitoring-off)).
* **Auto-refill OFF.** It needs a paid plan and does not work during the trial. With it off, spend stops at the balance ([docs](https://docs.boat.dev/billing#control-your-spend)).
* **Keys:** a scoped `ci` key for the plugin and a `read-only` key for cost reads. Never use an admin key in the plugin.

Even with safe for third parties on, every VM gets `BOAT_ID` and `ASCII_TOKEN`. `ASCII_TOKEN` can publish a port of that one VM on a public URL and nothing else ([docs](https://docs.boat.dev/security#boat-credentials-inside-a-sandbox)). boat sets it in the exec environment and in an `export ASCII_TOKEN=...` line near the top of `~/.bashrc`, above the interactive guard, so any shell that reads `~/.bashrc` exports it. The plugin:

* runs every command script as `exec env -u ASCII_TOKEN -u BOAT_ID sh -c <script>`: sshd's login shell, which started with the tokens, becomes a `sh` that never had them, so no process between sshd and the command keeps them in its `/proc/<pid>/environ` (`unset` hides a variable from children, but `/proc/<pid>/environ` keeps a process's startup environment). That `sh` stays the command's parent and exits with its status, so a command killed by a signal reports 128+n; when the command itself replaced every shell, sshd reported the signal and ssh exited 255, which reads as a lost VM. The script unsets both again after the profiles and the env file are sourced, before the command starts;
* deletes the `export ASCII_TOKEN=` line from `~/.bashrc` when it sets up a VM (acquire, resumed lease) and when it resumes one for a command, so a shell the agent starts (Claude Code's Bash tool sources the user's shell rc file) does not get it back.

This stops casual use, not a determined agent: `user` has passwordless `sudo` and is root in its VM. boat documents no switch to leave the token out: it stays even with safe for third parties.

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
