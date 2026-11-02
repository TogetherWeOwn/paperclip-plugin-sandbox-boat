# Offload internals

How the opt-in command-level executor, its guest transport and its sync work. Design record: [ADR 0001](adr/0001-heavy-command-offload.md); account budget: [Account admission](account-admission.md). User-facing shims: [Offload](../offload.md).

## Command-level guest lifecycle (opt-in executor slice)

The stock worker now has a concrete Linux guest transport over the existing
API-authorized, pinned-host-key Boat SSH connection. The agent/model stays on
the server; only an eligible heavy command and a frozen snapshot of the
workspace's git-tracked files go to a pool VM. **Everything remains default OFF**: both company
flags, an explicit repository allowlist, native workspace realization metadata,
a delegated cgroup parent and a private artifact directory are required. The
separate Cargo shim opt-in is still required. See the enabling and smoke
procedures in [Operations](../operations.md#enabling-the-executor-bridge). No new Paperclip capability is needed.

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
stop accounting.

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
confinement.

## Executor backend adapter

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

## Concrete transport and fallback

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

Source admission is tracked-only: `SshOffloadRuntime.resolve` lists the
index with `git ls-files -z --cached` (fsmonitor/hooks disabled), keeps the
command local when the source is not a git work tree, the index is empty, or
a bounded scan of the tracked syncable files finds a known credential shape
(cloud key ids, private-key headers, provider tokens, JWTs); the push
re-lists and re-scans at capture time (`SYNC_NOT_GIT_WORKTREE`,
`SYNC_SECRET_CONTENT`), and the manifest is the tracked set intersected with
the walk, so untracked or ignored files are never listed, hashed or synced.
Source is frozen with the existing manifest/exclusion checks, then delta-pushed
with rsync over the pinned SSH control master into a persistent per-card mirror
on the pool VM (`paperclip-boat-mirror-*`, keyed by company, repo and execution
workspace). Only content-hash-changed files cross the wire, with mtimes and
modes preserved; an unchanged tree uploads zero files. The host keeps the
previous manifest per mirror and verifies the guest marker on every push; a
missing or disagreeing marker (fresh VM, new machine) fully resyncs, which also
repairs content drift in tracked files. Guest-only extras are retained as
caches; prune removes only host-known deletions. Return inspection hashes files in bounded chunks and
fetches at most 4 MiB into private staged artifacts, never live source. Only
approved public inputs belong here: the tracked-only rule is the boundary,
exclusions and the credential-shape scan are defense in depth, and neither
proves a workspace secret-free. The mirror persists across commands (delta base,
dependencies, cargo caches); VM stop/retirement reclaims it. Artifacts remain
in the configured persistent host root for explicit review/removal. Failed or
uncertain collection retains the reservation and files.
A restart does not reattach old handles or reconstruct interrupted in-memory
sync manifests; those commands remain held for inspection.
