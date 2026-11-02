# Configuration

## Driver config keys

Set these on the Paperclip sandbox environment, driver `boat`. Only `apiKey` is required.

| Key | Default | Notes |
| - | - | - |
| `apiKey` | - | A boat key with the `ci` preset: `boat api-key create <name> --preset ci --ttl 30d`. Falls back to `BOAT_API_KEY` on the host. |
| `size` | `small` | Fallback when this task class has no measurements. Existing explicitly configured sizes remain the fallback (set `default` for heavy builds); measured data takes precedence. |
| `taskClass` | `default` | Class to look up in `sizeCostTable`. Acquire can override with `executionWorkspaceSettings.boatTaskClass`. |
| `sizeCostTable` | `{}` | Completed-job measurements by class and size; cheapest computed cost wins. Refresh weekly as in [Operations](operations.md#weekly-refresh-from-the-pilot-cost-log). |
| `templateSnapshot` | none | A named snapshot to create new card VMs from. Wins over `templateSourceSandboxId` when both are set. |
| `templateSourceSandboxId` | none | An archived sandbox id whose image new pool VMs fork from when `templateSnapshot` is unset (named snapshots are blocked on the trial). Blank: create from the base environment. |
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
| `modelProxyKeyFingerprint` | none | SHA-256 (64 hex) of the one dedicated, low-limit sandbox model-proxy key. `ANTHROPIC_AUTH_TOKEN` reaches the VM only when it is that key, spent through the tunnel; any other value (a managed AI-connection pool credential included) is dropped. Unset: an on-tunnel token is delivered unverified (validation warns), an off-tunnel one dropped either way. See [Run env allowlist](security.md#run-env-allowlist) rule 4. |
| `managedGithub` | false | Deliver Paperclip's managed-GitHub capability and its `git`/`gh` launcher shells, so the agent can push. Off by default: any VM process can exchange the capability for a GitHub credential with the run's grants while the run is live. Leave off for public repos and PR branches. |
| `envAllowlist` | built-in list | Run env names that may reach the VM. See [Run env allowlist](security.md#run-env-allowlist). A list you set replaces the built-in one; an empty list (`[]`) sends nothing. |
| `noEnv` | true | |
| `monitoring` | true | Explicit opt-out: `false` for **new** VMs. Existing VMs keep their creation policy. Never changes an account-wide switch; see [monitoring privacy](security.md#monitoring-retention-and-privacy). |
| `boatEnvironment` | account default | |
| `remoteWorkspaceDir` | `$HOME/paperclip-workspace` | A plain absolute path below `/home/user`, used as typed (no `~` or `$HOME`), with no `$`, backtick or backslash (bash would expand them in the launcher's `BASH_ENV`). Anything else is a config error (`BOAT_CONFIG_INVALID` at acquire, before any start): the home `.boatignore` applies only there. |
| `namePrefix` | `paperclip` | |
| `costApiKey` | main key | An optional read-only key for usage reads. |
| `timeoutMs` / `stopConfirmTimeoutMs` / `sshConnectTimeoutSec` | 300000 / 120000 / 15 | |
| `syncOutMaxBytes` | 8589934592 (8 GiB) | Host safety: refuse a guest sync-out archive whose files total more than this. Hard bound 32 GiB. See [Sync-out receiver budgets](security.md#sync-out-receiver-budgets). |
| `syncOutMaxFiles` | 200000 | Host safety: refuse a guest sync-out archive with more entries (files, directories, symlinks) than this. Hard bound 1000000. |
| `syncOutDiskReserveBytes` | 10737418240 (10 GiB) | Host safety: refuse a sync-out member that would leave less than this free on the target filesystem (the receiver also always keeps 5% of the filesystem and 8192 inodes free). |
| `maxOffloadVms` | 4 | Offload pool: at most this many shared VMs for heavy commands. Beyond it, commands queue. |
| `offloadIdleStopSeconds` | 15 | Offload pool: stop a VM this many seconds after its last command ends. |
| `allowPaidNamedSnapshots` | false | Allow template capture beyond boat's 10 free named snapshots ($1.70 a month each). |
| `apiBase` | `https://boat.dev/api/v1` | boat API base URL. |

## Company plugin settings (offload)

Heavy-command offload is configured per company in the plugin config, not on the environment driver. Every flag defaults to off and the allowlist to empty. See [Enabling the executor bridge](operations.md#enabling-the-executor-bridge) for how the gates combine.

| Key | Default | Notes |
| - | - | - |
| `offloadExecutorEnabled` | false | Opt in to command-level offload through a lifecycle executor. Does not enable the Cargo shim or change whole-run leases. |
| `offloadGuestTransportEnabled` | false | Enable the stock Linux SSH guest transport for explicitly approved public, secret-free workspaces. Requires `offloadExecutorEnabled`, native realization metadata and verified delegated cgroup v2. |
| `offloadAllowedRepos` | `[]` | Exact canonical repository IDs approved for offload (`repo:https://github.com/example/public`). Empty denies every repository. |
| `offloadEphemeralRepos` | `[]` | Exact canonical repository IDs under the ephemeral VM policy: one freshly created VM per command, deleted at the provider after collect, never warmed or resumed. Must also be in `offloadAllowedRepos`. |
| `offloadCgroupParent` | none | Delegated cgroup v2 parent on the guest, below `/sys/fs/cgroup/`. See [Delegated guest template](operations.md#delegated-guest-template-required-for-remote-offload). |
| `offloadArtifactRoot` | none | Operator-owned persistent host directory for frozen snapshots and staged returns. Required for stock offload. |
| `offloadProfiles` | `["rust-public-1"]` | Server profiles admitted for remote dispatch. Add `node-public-1` and/or `python-public-1`; see [Node and Python offload](offload.md#node-and-python-offload-binboat-offload-node-binboat-offload-python). |
| `offloadMinExpectedSeconds` | 120 | Node/Python commands go remote only when their recorded median meets this. Rust is not gated. |
| `offloadMonthlyVmHourCap` | 0 (off) | Monthly cap on tracked offload VM-hours; see [Offload VM-hour cap](operations.md#offload-vm-hour-cap). |
| `offloadLocalRunsEnabled` | false | Bind otherwise-local runs for offload; see [local runs](operations.md#enabling-the-executor-bridge). |
| `offloadLocalEnvironmentId` | none | Boat environment whose pool settings local-run offload uses. Required with `offloadLocalRunsEnabled`. |
| `offloadLocalApiKeySecretRef` | none | Paperclip secret holding the scoped boat key for local-run offload. Resolved per binding, never stored. |
| `offloadLocalDriverConfig` | `{}` | Driver settings for local-run offload pools (`maxOffloadVms`, `maxActive`, `offloadIdleStopSeconds`, `size`). `apiKey` is ignored here. |

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

Heavy-command-only offload ([offload shims](offload.md)) is a separate execution mode and is not implemented by the size selector.
