---
status: accepted
---

# Borrow a Boat VM for a heavy command, not for model waiting

Keep the agent and its lightweight tools on the local execution host. Opted-in Cargo invocations borrow a VM from a bounded repository pool through the plugin, then release it to a 15-second idle countdown. The requester accepted the complete design on 2026-10-23 after the design grill. This records a design decision, not an implemented capability: exact-head CI and independent review must pass and this ADR must merge before implementation starts.

## Evidence and objective

The [2026-10-23 efficiency report](https://boat-efficiency.kofra.io/) ([source](https://boat-efficiency.kofra.io/?view=source)) publishes the measurements and replay methodology. Original report: `ops/analysis/boat-dev-20261022/EFFICIENCY.md`; replay inputs/scripts/results: `ops/analysis/boat-dev-20261022/efficiency/`, including `simulate.py`, `results.json`, `pool_sim.py`, `pool_results.json`, `size_bench.sh`, and `cost_table.md`. Lifecycle probes are in `ops/analysis/boat-lifecycle-20261023/`. These are evidence references, not files shipped by this plugin.

- **Measured:** 400 agent runs averaged 645 seconds, including about 462 seconds of model time and 63 seconds of heavy commands. Parallel tool intervals overlap; the components are not additive. One successful whole-run VM billed 340 seconds for 160 seconds of agent activity, including workspace staging.
- **Measured:** stopped VMs freeze. Warm resumes within ten minutes took 0.34–0.65 seconds and consumed zero observed starts; that accounting is undocumented, not an entitlement. Cold resumes took about 2.5 seconds plus lazy file streaming.
- **Measured:** default completed the representative Rust job in 316 seconds at about $0.0032; large took 182 seconds at about $0.0036. Small lost its control channel twice; visible RAM was about 3 GB versus 4.0–4.4 GB compiler peaks. Default is the initial capable, cheapest measured size for this workload, not a universal size rule.
- **Projected, not a new pilot result:** replaying 5,297 commands across two days with at most four default VMs and a 15-second tail gives 18.9 VM-hours/day, 76 cold starts/day, and mean queue wait of 0.4 seconds. Per-card machines would require 369 starts/day. Heavy-only billing is projected at 115 default-seconds/run versus 797 for whole-run leases; at five-times-slower model replies, 131 versus 2,337.
- **Budget caveat:** 18.9 hours/day is about 567 hours per 30 days, slightly above the cited $20 plan's 555 hours/month. The replay is close to the allowance, not proof the fleet fits it. No credits or plan purchases are authorized. Live limits, reserves, existing caps, and local fallback win over the projection.

Success is lower measured **total billed cost per completed command/card**, including resume, sync, idle tails, retries, and failures—not merely faster compilation. Model waits must not keep offload VMs running.

## Decisions and rejected alternatives

| Boundary | Proposed decision | Why not the alternative? |
| --- | --- | --- |
| Interception | A `cargo` PATH shim, enabled only by `BOAT_OFFLOAD=1` | A shell prefix offloads whole compound commands and risks moving waits/secrets. A repository-specific cache-wrapper hook couples the service to one consumer. |
| Broker | Plugin API plus an in-plugin executor | Reuse the official Boat SDK, host-key pinning, budget evaluation, state and sweep infrastructure. A separate host daemon duplicates lifecycle and installation policy. |
| Machines | Pool keyed by company, canonical repository ID, environment/profile and trust domain; one job per VM | Per-card VMs exceed the replay's daily start allowance. Never share across companies, untrusted forks, or incompatible profiles. |
| Source copies | One workspace per card and execution workspace on each VM; stable guest paths | Unrelated cards must not race on source. A card moving between pool VMs may pay a cold source/cache cost. |
| Size | Default for the initial measured Rust profile; use the existing measured-cost selector for eligible future profiles | Small did not complete this job; large was faster but cost more. No new benchmarking spend or size entitlement is implied. |

The shim is **inside**, not a replacement for, existing local admission/build-cache policy. Activation must prove that `scripts/cargo_cache.py run -- cargo …` and real host Cargo dispatch actually reach the shim. An absolute toolchain executable that bypasses PATH is not offloaded by assertion; keep that invocation local and record the integration gap. On local fallback, re-enter the existing bounded local path exactly once, never create a private target directory or bypass a busy-pool refusal.

Existing whole-run leases remain unchanged and separately named. Their release, cleanup, size selection and usage contracts must keep passing. Pool records must not be mistaken for finished per-card leases by the old sweeper.

**Verified baseline at `0c73b94`:** [`src/manifest.ts`](../../src/manifest.ts) declares only board-authenticated usage/sweep routes; [`src/plugin.ts`](../../src/plugin.ts) returns materialized responses. [`src/ssh.ts`](../../src/ssh.ts) buffers process output and implements the whole-run tunnel. [`src/state.ts`](../../src/state.ts) persists VM/run records, not a command journal; [`src/vm-manager.ts`](../../src/vm-manager.ts) uses process-local lifecycle locks and host-supplied workspace data. Agent-route auth/context, incremental transport and host source-root resolution are prerequisites to verify, not capabilities already supplied by these files. A workspace mutation lease is relevant only to deferred automatic application, not a v1 prerequisite. SDK-wide streaming support was not established by reading this repository.

## Resolved design choices

The requester settled the design grill and subsequently confirmed the complete design on 2026-10-23. These choices narrow v1; implementation still requires the reviewed, merged ADR:

- **Narrow workloads:** public-source, secret-free builds/tests only. Commands needing host services, DB/Redis, private registries or provider credentials remain local. Disposable guest fixtures require a separate follow-up, not an addition to this pilot.
- **Stage first:** every returned workspace change is staged for explicit application using normal local editing/review tools. V1 never automatically overwrites or deletes a local file, even when its baseline is unchanged or a mutation lease is available. Broader generated paths and automatic application are future scope.
- **Bounded uncertainty:** reconcile an ambiguous submit for at most ten seconds using the same command ID, then return exit 75 with that ID if still unresolved. Never replay locally without a durable never-started receipt. A definitive running receipt resumes ordinary output/heartbeat handling; ten seconds is a recovery limit, not a command runtime limit.

The frontier is now empty: the dependent choices below use these answers, without adding fixtures, automatic application or a longer recovery mode. Shared-understanding confirmation against the complete design was accepted on 2026-10-23 at 10:15:53Z; the decisions below are unchanged.

## Command lifecycle and concurrency

A host-side durable journal records a client-generated `commandId` before any external effect:

`accepted → queued → syncing_in → starting → running → syncing_out → completed`

Terminal alternatives are `not_started`, `cancelled`, `failed`, and `unknown`. `unknown` is a reconciliation hold, not permission to replay. Store the payload digest with the ID; same ID/same digest returns the same command, while a different digest is `OFFLOAD_IDEMPOTENCY_CONFLICT`. Keep terminal output/results for at least 24 hours, then retain a compact `{commandId, runId, digest, outcome}` tombstone until 30 days after the run becomes permanently terminal and all its tokens expire. Never expire an unresolved/unknown command. Reject submission from terminal runs before journal lookup, so tombstone GC cannot revive an old ID. Bound the journal to 512 accepted command IDs per run; refuse new admissions rather than evict deduplication evidence. Expired results return `OFFLOAD_RESULT_EXPIRED`; the shim never remints an ID to replay an uncertain or expired command.

The executor selects a compatible running idle VM first, then the most recently stopped compatible VM, then creates another within the effective cap. Prefer existing card/cache affinity only within that ordering. Otherwise use a bounded FIFO queue: default 32 pending commands per pool and 30 seconds admission wait. Serialize commands for a card/workspace even if more VMs are free. Hold the VM reservation from sync-in through sync-out, not only during Cargo.

Queue expiry and dispatch compare-and-transition the same command generation under the command/queue lock. Only one wins. The executor persists terminal `not_started` before releasing a queue slot or advertising `fallbackSafe=true`; cancellation before spawn also ends in `not_started`. A client-side timer never authorizes local execution. On an uncertain submit the shim spends at most ten seconds reading/cancelling that same ID; only a durable never-started receipt permits local fallback. A running/completed receipt yields its real result, and unresolved recovery exits 75 without replay.

`maxOffloadVms=4` is an upper bound, not four additional active machines. Effective admission also honors the existing configured active cap (currently default 2), Boat's account-wide cap, and other leases/pools. Starts and compute reservations are serialized account-wide in the single authoritative plugin worker. Do not raise an existing limit automatically. Multi-worker active/active operation is unsupported until a host CAS/lock service can fence workers; process-local locks alone do not make a distributed queue safe.

Persist intent before spawning; the guest runner also uses an exclusive command-ID marker and durable started/result receipts. A lost SSH reply must not permit a second spawn. Persist `{heartbeatDeadline, guestDeadline, processGroupId, guestBootId, cgroupPath, journalGeneration}`; a restarting worker reconciles the guest receipt/process before making the slot reusable. The plugin worker owns heartbeat/queue expiry while healthy; sweep is only the slower crash backstop. Uncertain ownership quarantines that VM. Do not depend on a PID alone (PID reuse), or claim exactly-once execution across an unobservable failure.

The secret-free toolchain profile must supply an existing delegated cgroup-v2 subtree: the guest runner puts the complete command subtree there and an outside watchdog enforces the absolute guest deadline. Cancellation verifies identity, signals TERM, then uses cgroup kill after the grace period and verifies the subtree is empty before reuse. An unavailable delegation/watchdog makes that profile ineligible; do not acquire root or substitute an unverified process-group-only guarantee. Host `onRunEnded(runId)` integration, if available, expedites cancellation; v1 correctness must work without it via client-heartbeat expiry and the independent guest deadline. State that weaker termination latency in pilot evidence.

## Proposed API v1

Routes below are **new**, under `/api/plugins/togetherweown.sandbox-boat/api`. Confirm the installed plugin manifest ID when implementing; consumers must discover the registered base rather than invent it.

Host authentication verifies the active run token. The handler must additionally bind the principal to the company, run, card and execution workspace via host-owned context. Client identifiers are consistency checks, not authority. Required host interface: `resolveOffloadWorkspace(authenticatedRun, executionWorkspaceId) → {companyId, runId, cardId, canonicalRepoId, trustDomainId, profileId, confinedRootHandle}`. This is a proposed capability interface, not an existing SDK method. It checks the run is active and authorized, returns 403 on an identity mismatch, and returns `OFFLOAD_UNAVAILABLE` before acceptance when confinement/context resolution is unsupported. No caller-selected local root, SSH endpoint, VM ID, shell program, output destination or unrestricted environment is accepted. If the SDK cannot provide the required run/workspace authorization, that is a prerequisite host interface—not a reason to trust a body field or broaden board authentication.

### Submit

`POST /offload/exec` accepts JSON (unknown keys rejected):

```json
{
  "version": 1,
  "commandId": "7d82278c-2ba7-4e68-96ab-a2cc10b697af",
  "executionWorkspaceId": "b9d0e6ac-a14e-4440-a324-7dcdd758be08",
  "cwdRelative": ".",
  "argv": ["test", "--locked", "--lib"],
  "env": {"CARGO_TERM_COLOR": "never", "RUST_BACKTRACE": "1"},
  "queueTimeoutMs": 30000,
  "timeoutMs": 1200000,
  "dryRun": false
}
```

`argv` omits the executable: the broker selects the profile's pinned Cargo. Resolve `cwdRelative` and path-bearing options inside the authenticated workspace; reject traversal and symlink escapes. Bounds: 256 arguments, 32 KiB encoded argv, 4 KiB env, 64 KiB request body; queue timeout 0–30 seconds; command timeout 1 second–30 minutes. Dry run validates/classifies and returns `200 {version, commandId, mode, reason, profileId}` without a VM, sync, budget reservation or command journal effect. `mode` is `remote_candidate` or `local`; a remote candidate is not a capacity promise.

Acceptance is `202`:

```json
{
  "version": 1,
  "commandId": "7d82278c-2ba7-4e68-96ab-a2cc10b697af",
  "state": "queued",
  "remoteStarted": false,
  "fallbackSafe": false,
  "eventsCursor": 0
}
```

**Queued does not mean safe to fall back:** the command could start immediately after this response. Safety requires a terminal `not_started` receipt that prevents future dispatch.

### Output, result, heartbeat and cancellation

- `GET /offload/commands/:commandId?after=0&limitBytes=65536` returns ordered, cursor-addressed output batches, bounded to 64 KiB per response. Each event is `{seq, stream: "stdout"|"stderr", dataBase64}`; preserve raw bytes, per-stream ordering and terminal exit metadata. Response envelope: `{version, commandId, state, remoteStarted, fallbackSafe, events, nextCursor, result}`; `result` is null until terminal. Duplicate reads have no execution effects.
- The shim renders batches incrementally to the original stdout/stderr descriptors. Use short bounded reads during an active command, not heartbeat-run CI polling. Do not assume the current SDK can send SSE or an unbounded HTTP response. Validate the output API/latency before implementation; a host streaming extension is optional, not the correctness path.
- `POST /offload/commands/:commandId/heartbeat` renews client interest; heartbeat every 5 seconds, expiry after 30 seconds without one. Status reads alone do not renew. An HTTP disconnect alone neither proves cancellation nor triggers local replay. Bound and persist output (64 MiB/command); on exhaustion cancel and report `OFFLOAD_OUTPUT_LIMIT`, never silently truncate success.
- `POST /offload/commands/:commandId/cancel` with `{"reason":"client_signal"}` is idempotent. Cancel queued jobs before dispatch; for running jobs terminate the entire guest process group (TERM, 5-second grace, KILL), verify descendants are gone, collect permitted outputs, then release the slot. Heartbeat expiry, run termination and execution timeout use the same cancellation path. The guest enforces the command deadline if the broker dies. VM auto-stop is a further bounded-spend backstop after that deadline, not a substitute for process cancellation.

A terminal `result` contains `{exitCode, signal, timedOut, cancelled, syncBack, usageRecordId}`. Normal remote exit codes pass through unchanged; a Unix signal maps to `128 + signalNumber` in the shim. V1 `syncBack` contains `{state: "clean"|"staged"|"conflict", changedPaths, conflictPaths, artifactId}`; there is no `applied` state or automatic apply endpoint. `clean` has no returned changes and a null artifact ID; otherwise return a principal-scoped artifact containing the baseline/returned hashes and proposed changes. `conflict` means the observed local content/existence differs from the uploaded baseline; `staged` never promises that local files remained unchanged after observation. A successful Cargo exit with staged changes maps to `OFFLOAD_SYNC_STAGED`/exit 74; divergent local content maps to `OFFLOAD_SYNC_CONFLICT`/exit 74. Preserve a nonzero Cargo exit or signal while still exposing the staged artifact and sync state. The client explicitly inspects/applies changes using normal local tools; the broker never applies them and never replays Cargo to avoid a staged result.

### Errors and local fallback

Errors use an RFC-9457-style object: `{type, title, status, code, detail, retryable, next_action, commandId, remoteStarted, fallbackSafe}`. `remoteStarted` is `true`, `false`, or `null` (unknown). Error details/logs contain no credentials or full unfiltered argv/env.

| Code | HTTP | Meaning and next action |
| --- | --- | --- |
| `OFFLOAD_UNAVAILABLE` | 503 | Provider down, limits unreadable/exhausted, incompatible workload, or queue deadline/full. Local fallback only with a durable terminal never-started guarantee (`remoteStarted=false`, `fallbackSafe=true`). |
| `OFFLOAD_INVALID_REQUEST` | 400 | Invalid args, paths, environment or bounds; correct the request, exit 64. |
| `OFFLOAD_UNAUTHORIZED` / `OFFLOAD_FORBIDDEN` | 401/403 | Fix the sanctioned authentication/workspace binding, exit 77; never switch credentials or mask denial with fallback. |
| `OFFLOAD_IDEMPOTENCY_CONFLICT` | 409 | Same ID, different payload; correct client bookkeeping, exit 64. |
| `OFFLOAD_SYNC_STAGED` | 409 | Cargo returned workspace changes; inspect/apply the principal-scoped artifact explicitly with local tools, exit 74 if Cargo itself succeeded. No automatic replay. |
| `OFFLOAD_SYNC_CONFLICT` | 409 | Keep divergent local edits and staged remote outputs; reconcile the artifact, exit 74 if Cargo itself succeeded. No automatic replay. |
| `OFFLOAD_EXECUTION_UNKNOWN` | 503 | Receipt/process state is uncertain; reconcile the same command ID, exit 75. No automatic local replay. |
| `OFFLOAD_RESULT_EXPIRED` | 410 | Receipt retention elapsed; inspect evidence, never resubmit as if known not started, exit 75. |
| `OFFLOAD_OUTPUT_LIMIT` | 413 | Cancelled on bounded-output exhaustion; inspect the retained output, exit 74. |

A submit timeout or an unstructured 503 is **not** proof of non-execution. Query/cancel by the same ID. If the broker cannot establish `not_started`, return the explicit uncertainty error. Cancellation after a process ran does not erase its side effects and is not safe fallback. Product/test failures are real results, never a trigger to rerun locally. This narrows the informal “fallback on any timeout/503” requirement to avoid duplicate tests and build-script effects.

## Shim contract

`bin/boat-offload-cargo` is installed as `cargo` ahead of the existing local executable only for opted-in runs. An explicit `boat-offload-cargo [--dry-run] [--json] -- <cargo argv...>` diagnostic entrypoint avoids colliding with Cargo flags. `--json` emits the versioned routing/result envelope for tooling; ordinary PATH invocation preserves Cargo's stdout, stderr and exit status. `--help` lists discovery and recovery examples without making a network call.

Configuration: `BOAT_OFFLOAD=1` opts in; absent/`0` means direct local execution with no broker calls. `BOAT_OFFLOAD_QUEUE_TIMEOUT_MS` defaults to 30000 and may only lower the cap; `BOAT_OFFLOAD_TIMEOUT_MS` defaults to 1200000 and cannot exceed 1800000. Resolve and pin the real local executable before prepending the shim, outside agent-controlled workspace paths; remove the shim from fallback PATH/mark re-entry to prevent recursion. There is no agent-controlled “require remote” switch, VM-size flag, credential flag or arbitrary shell mode.

Eligible subcommands are `build`, `test`, `check`, `clippy`, `nextest run`, and `llvm-cov`'s supported compilation/test modes. Parse supported Cargo global options and optional `+toolchain` without string-splitting; only installed profile toolchains are remote-eligible. `fmt`, `add`, `update`, `metadata`, help/version, installation, custom aliases, unknown commands/modes, unrecognized configuration overrides and interactive/stdin-dependent commands stay local. Mixed shell text (`&&`, pipes, redirects, `cd`) is never sent as a command: the surrounding shell remains local.

Host target/cache paths are not portable. The broker supplies a guest-local cache keyed by toolchain/target/profile and a card/workspace-specific target namespace; it does not sync host `target/` or forward a host `CARGO_TARGET_DIR`. Package source caches may be shared within the trust domain, but mutable compilation directories cannot be concurrently written. The shim must retain the local wrapper's resource admission on fallback and must not remotely import host-only policy/env paths.

## Sync and returned writes

Before each command, the broker captures an immutable, command-scoped source snapshot through the confined root handle: open files relative to that handle without following substituted symlinks, copy/hash from the same opened handles, and compare the authorized manifest before/after capture. Retry capture at most once on a concurrent source edit; then return never-started local fallback. Do not hash one pathname and later rsync a different live file at that pathname. Use rsync from that immutable snapshot over the plugin's pinned SSH transport into the card workspace. Preserve file modes and mtimes (`--times`); inspect content hashes so same-size/same-mtime edits cannot be skipped. Transfer unchanged content zero times. Remove obsolete inputs only from the **disposable guest mirror** using the previous manifest; never delete host files or evidence, and never run an unrestricted deletion against a guest parent/cache.

Default exclusions include `.git/`, `target/`, `node_modules/`, `.paperclip-runtime/`, `.claude/`, local offload result directories, `.env`/`.env.*`, credential files and private Cargo registry configuration. Git-tracked public source plus explicitly reviewed untracked inputs are eligible; do not tar an arbitrary agent home or blindly follow symlinks. Resolve symlinks within the source root only; reject escaping links, special files and excessive source size. A profile preflight must reject secret-bearing source/configuration rather than claim an environment allowlist alone protects source files.

Guest writes are compared to the uploaded manifest even on a nonzero Cargo exit. Return `Cargo.lock`, `**/*.snap`, and `**/*.snap.new`, plus generated paths explicitly allowlisted in the server-owned repository profile. No generic “copy everything changed”, source deletion propagation, secret-bearing output, or copying compilation caches back. Other changed source files are reported as unsupported writes and retained as a bounded result artifact; the invocation reports incomplete sync rather than silently discarding them. New files and remote deletions are represented explicitly; deletions become proposed changes, never automatic local deletion.

V1 always downloads to a command-scoped local staging directory, with baseline and returned hashes, operation types (create/modify/proposed-delete), and the remote versions/conflict manifest. Never write returned changes into the live workspace, including new files or an unchanged-baseline file. Verify artifact paths and every parent against symlink escapes; preserve both local and remote versions. The explicit application interface is artifact inspection followed by normal local editing/review tools, not a new shim flag or broker mutation route. Initial `--locked` read-only builds avoid most writeback. The server-owned generated-path allowlist starts empty; adding a generated path requires separate profile review. Cargo.lock and snapshot returns remain supported as staged artifacts.

Automatic application is deliberately deferred, not a v1 fallback branch. Hash-then-rename can race with a local writer; a future automatic-apply design would require an enforceable mutation lease honored by every writer plus baseline validation and its own review. Finding that primitive during implementation does not expand this approved stage-first scope.

## Stop countdown and account budget

Set `offloadIdleStopSeconds=15`. Countdown starts only after execution, cancellation cleanup and sync-out complete. A new reservation cancels the timer under the same VM lock. The timer checks the stored activity generation and no active reservation before stop; a stale callback cannot stop a newly reserved job. A warm idle tail is allowed, but model waits do not renew it.

Use the existing sweep as crash/restart backstop, extended to load persisted pool config and reconcile command state; its existing five-minute cadence does **not** promise a 15-second stop after worker death. Record actual stop lag. Guest command deadlines and Boat auto-stop bound orphan spend. Never stop an active healthy command merely because an idle timer elapsed.

Read fresh `GET /limits` before each create/resume (at most 5 seconds old under the account admission lock), and refresh during sustained activity. A three-second limits-fetch timeout is unreadable, not a successful cached admission. The account ledger holds a single mutex, timestamped limits and unreflected start/active/compute reservations shared by every offload pool and whole-run admission in this worker. Let `activeCeiling=min(configuredActiveCap, providerActiveCap)` and `startCeiling=min(configuredDailyStarts, providerDailyStarts)` where both limits exist. A new active reservation is allowed only if observed active plus unreflected reservations plus one fits `activeCeiling`, the pool's active/reserved count fits `maxOffloadVms`, observed starts plus unreflected start reservations plus one fits every applicable start window, and remaining compute minus outstanding compute reservations covers the worst-case job+tail plus the configured reserve. Use the SDK's size/rate units for that conversion, not raw seconds across different sizes.

Persist reservations before releasing the mutex for external calls; retain them across ambiguous replies and release only after definitive reconciliation. A running-idle VM needs no new start/active reservation, but still needs a compute reservation. The provider is authoritative for external account consumers; this in-worker mutex does not fence unrelated account writers. A provider limit rejection becomes safe local fallback only after proving no remote command started. Treat every resume as potentially consuming a start; zero-count warm resumes are an observation to record, not a way around a limit. Keep the existing daily start cap and compute reserve; do not auto-raise them to match the plan ceiling.

Proposed adaptive policy: use C=300 seconds after daily starts reach 80% of the effective configured/provider ceiling or metering shows warm resumes consuming starts. Stay conservative for the provider's remaining limit window. With unreadable/exhausted limits or insufficient compute for the job plus C and reserve, return safe local fallback before dispatch. Increasing C spends compute to save starts, so it is never applied past the compute reserve. The replay's roughly 128 starts/day at C=300 is a forecast under its four-VM traffic, not a guarantee or permission to exceed the existing 70/day configured default.

The 24-hour pilot measures C=10/15/30/60 within approved headroom and includes a 300-second accounting-change simulation. Use observed limits reset metadata, not an assumed UTC midnight. No plan purchase, VM-size expansion or entitlement change is part of this design.

## Secret and dependency boundary

Only source, validated argv and an explicit nonsecret environment reach the VM. The run token is used solely in host API headers. No Paperclip JWT/API key, provider key, GitHub credential, secret registry token, SSH agent forwarding, runtime MCP bundle or host credential directory goes to the guest. Reuse SSH host-key/authorization primitives, **not** the whole-run reverse tunnel to the Paperclip API. Pool snapshots must be secret-free toolchain templates, never captured agent runtimes.

Initial client env allowlist: `CARGO_TERM_COLOR` (`auto|always|never`), `RUST_BACKTRACE` (`0|1|full`), and bounded `RUSTFLAGS`/`RUSTDOCFLAGS` only after profile validation. Guest `PATH`, `HOME`, `CARGO_HOME`, `CARGO_TARGET_DIR`, temp paths, locale and toolchain come from the profile, not the host environment. Reject unlisted keys; unknown keys are not silently stripped and claimed compatible. No full env/argv dumps in usage or error records.

V1 admits only public-source, secret-free commands with no host-service dependency. Tests requiring a host database/Redis, private package access, provider API, production/staging data, host filesystem or network tunnel stay local. `localhost` on the guest is not the host. This design does not create disposable fixtures, add a database service, or forward `DATABASE_URL`/`REDIS_URL`; guest fixtures require a separate reviewed follow-up before any expansion. A server-owned profile positively identifies eligible command/workload variants; an unclassified or dependency-uncertain invocation stays local, not optimistically remote. Report eligible/total heavy commands and false-local routing in the pilot; do not extrapolate the full replay savings to this narrower subset.

## Observability and cost attribution

Persist one upsertable `boat.offload.command.v1` record per command: `commandId`, company/repository/profile/workspace IDs, card/run IDs (host-derived), VM ID/size, payload digest, enqueue/start/finish times, queue/resume/sync-in/exec/sync-out seconds, warm/cold/none/unknown resume class, observed starts delta, state, exit metadata, fallback reason, expected cost, attributed billed seconds/USD, and meter provenance (`estimate|provider|pending`). Keep identity/internal metadata in private telemetry, not public logs or PR text.

Allocate each VM's paid interval once: resume+sync+execution belongs to that command; an idle tail belongs to the preceding command and ends at the next reservation or stop. This deliberately charges the prior caller for the grace it left behind; it is the selected attribution policy, not a claim that each command caused its entire bill. Finalize the preceding tail before assigning the next interval. Never sum overlapping whole-run lease windows for pool work. The plugin's five-minute usage/sweep reconciler owns pending estimates and provider late adjustments, updating the same record; unavailable provider readings remain explicitly pending, never fabricated final values. Failed/aborted starts and unattributed pool overhead get explicit reconciliation rows, not hidden in successful jobs. Sum command allocations plus overhead against provider totals before declaring savings. An expected-cost line is sanitized JSON, not a copy of the command environment.

Export versioned JSONL compatible with an adapter in `ops/boat-pilot/cost_tracker.py`; implementation must verify that consumer's actual schema rather than claim direct compatibility here. Report per-card/run billed seconds, total $, starts/day, resume classes, queue p50/p95, fallback/error rate, actual stop lag and host heavy-command wall time/load. Pilot targets remain: at most 150 default-seconds/run, no offload-caused failed runs, plan/configured limits respected. Results outside those targets stop expansion and restore local execution; they never trigger purchasing credits.

Bounded recovery is an explicit safety trade-off, not an exemption from the zero-failure goal. Record each unresolved invocation as `OFFLOAD_EXECUTION_UNKNOWN` with exit 75 and its command ID; count it as an offload-caused invocation failure even if the run later recovers, and report failed runs separately. Any unresolved execution uncertainty stops expansion and initiates rollback/draining; do not automatically rerun the uncertain command when disabling opt-in. Staged/conflicting outputs are reported separately as incomplete results, never as clean successes; include their exit 74 and manual-application cost in the go/no-go. Product/test nonzero exits remain product results rather than hidden remote-success claims. The cost denominator includes all pilot runs and local fallbacks, with eligible commands/subset cost shown separately; do not select only successful remote commands to meet the savings target.

## Implementation slices and test contracts

These are contracts for existing implementation cards, **not authorization to start them**. Each slice is a separate PR, Test Author acceptance tests remain untouched by the implementer, and exact-head CI plus independent review remain required. Use fakes/temp directories before any authorized live smoke.

### Executor and budget

Expose internal `executeOffload(validatedCommand)`, `cancelOffload(commandId, reason)`, `readOffload(commandId, cursor)` and a sync adapter with `push/collect/stage` phases (no v1 `apply`). Own the journal, account reservations, VM locks, bounded queue, activity generations, idle timer, recovery and usage rows. Routes do not create/stop VMs independently.

Tests: compatible warmest pick; running-idle before resume/create; cold/start reservations under concurrent admission; max pool and global caps; FIFO/queue timeout; one command/workspace and VM; timer at 15 seconds and cancellation by a new reservation; no stop during sync/exec; C=300 threshold/compute tradeoff; unreadable limits fail closed; journal persisted before spawn; same-ID no double execution; restart between intent/spawn/result; ambiguous resume quarantine; client expiry and descendant cancellation; cost-tail allocation/late provider reconciliation; existing whole-run lease/sweep behavior unchanged.

### Route and Cargo shim

Implement the API/shim contracts above, including host authorization and incremental output transport. Test every routing class, `+toolchain`/global options/unknown aliases, compound-shell locality, actual cache-wrapper interception, no-recursion fallback through bounded local policy, arbitrary binary output, exit/signal forwarding, cancellation, output bounds, idempotency and expired IDs, cross-run/company/workspace denial, body/path/env limits, dry-run zero effects, secret canaries absent from body/guest/logs, and no reverse tunnel. Test 503/timeout **before** versus **after** remote start separately; no unsafe automatic replay. With fake time, test unresolved recovery ends at ten seconds with the original ID/exit 75, a running receipt returns to normal heartbeat/output handling, and a never-started receipt permits exactly one bounded local fallback. Test stage-first success maps to `OFFLOAD_SYNC_STAGED`/74, divergent baseline to `OFFLOAD_SYNC_CONFLICT`/74, nonzero Cargo/signal preservation with an artifact, and service-dependent or unclassified workloads remaining local. The host SDK route/context feasibility test is first and must fail clearly if the necessary principal binding is unavailable.

### Delta sync and conflict-safe results

Implement manifest/delta transfer and staged result artifacts with the server-owned write allowlist. Tests on two temporary trees: unchanged content transfers zero files; one edit transfers one; mode/mtime retention; same-size/mtime content edit; removed input cleaned only in the guest mirror; Cargo.lock/snapshot/new-file return; failed command still returns permitted writes; unchanged baseline stages without live writes; divergent local edit returns a conflict artifact; concurrent local edits survive collection/staging; all changes stage even if a mutation lease exists; default-empty generated allowlist and unsupported-write reporting; remote deletion never deletes local data; excluded secret and runtime files; escaping/symlink-swapped paths; partial transfer recovery. Measure unchanged two-bot-next warm sync at no more than one second; record bytes/files/clock conditions, not just a wall-time assertion.

### Independent whole-run native sync hooks

Native `onEnvironmentSyncIn/Out` remains a separate optimization for run leases, not the offload interface or a prerequisite to this pool. Follow Paperclip's native sync-hook contract: atomic replacement, modes including 0600 files/directories, symlinks, excludes and fail-loud behavior, then an authorized one-VM smoke measuring under-30-second staging. Sharing low-level SSH transport must not change offload credential exclusions or introduce the whole-run reverse tunnel.

### Pilot and integration

After executor, routes and sync are merged/installed and the grill is closed, an authorized operator enables one existing local pilot with the shim opt-in; no model or host permission changes. Test first with synthetic limits, interrupted commands, sync conflicts, secret canaries, stop races and slow client/model gaps. Then measure 24 hours with provider usage reconciliation, eligible/total heavy-command and fallback counts, staged/incomplete results, every ambiguous-recovery failure, per-run total bills, starts, host wall time/load and the countdown choices. Prove synthetic exit-75 uncertainty stops expansion without duplicate execution; prove fixture-dependent commands remain local and unchanged-baseline returns still stage. Confirm default is still cheapest for the measured completed workload. Publish a go/no-go; adding fixture services or broader generated outputs requires an explicit follow-up scope, not an unreviewed pilot shortcut.

## Grill gate and rollback

The three frontier decisions are resolved as recorded above. Their consequences are narrow service-free eligibility, an empty initial generated-path allowlist and artifact-only explicit application, and ten-second recovery with visible failure accounting. No further requester-owned choice is open; host/guest capability feasibility remains implementation verification, never a question to answer by assumption. The requester accepted shared understanding of complete plan revision 2 on 2026-10-23 at 10:15:53Z, separately from the question answers. Acceptance clears the design-confirmation hold, not the exact-head CI and independent-review merge gates. Existing implementation cards retain their design blockers until this ADR is merged; the independent whole-run sync slice remains outside this gate.

**Rollback:** unset `BOAT_OFFLOAD` (or set it to `0`) and Cargo takes exactly the pre-existing local execution path, with its admission/cache limits unchanged. The agent remains local; do not switch it back to a whole-run VM as the default rollback. Existing accepted commands are cancelled/reconciled and drained by the broker with their outputs/receipts preserved; then the pool's idle countdown/sweep stops unused machines. Disabling opt-in must not delete workspaces, command evidence or data. Removing the shim from PATH is an optional equivalent follow-up, not required for rollback.
