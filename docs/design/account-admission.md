# Account admission and usage

This implements the account-budget portion of the [offload ADR](adr/0001-heavy-command-offload.md#stop-countdown-and-account-budget). It does not restore command receipts, purchase compute, or change entitlement.

## Ownership and construction

`AccountLedger` stores one JSON journal at instance scope, partitioned by a hash of a stable, credential-free provider account identity. The account mutex covers reading limits, checking capacity and committing intent. It is shared across company IDs, pool objects and the whole-run manager. Provider mutations and command execution run outside that mutex.

`OffloadExecutor` requires `state`, `accountId` and `poolId`. There is no in-memory/no-state admission fallback. Reconstructing a ledger loads persisted reservations; a module-local cache is not a recovery mechanism. The stock SSH offload runtime gets the same account identity as `BoatVmManager`. The manager's default identity conservatively groups this worker's existing provider clients; it is not a way to discover provider account membership from API keys.

Within that shared journal, the manager persists an opaque credential-group digest on each intent and keeps observations and reconciliation cursors per group. Inventory, fresh GETs (including 404s), counter deltas and stop receipts affect only that group's intents. Because different keys might alias one provider account, one durable observation owner can refund counter deltas; other groups keep their unreflected commitments instead of counting the same cumulative delta twice. The shared admission ceilings remain conservative across groups; credentials are not used to manufacture independent capacity. Unscoped callers still promise that their explicit `accountId` identifies the supplied provider client. Legacy unscoped holds can be reconciled by a manager with one credential group, but require positive terminal evidence: a foreign 404 never proves their ownership. They remain held if multiple groups make ownership unknowable. Key rotation does not automatically transfer old holds or observation ownership to a new group.

The state client must be durable and have one authoritative worker writer. Its get/set API supplies no cross-process compare-and-swap, so the mutex does not fence another worker or unrelated provider account consumers. Provider counters remain authoritative; ambiguous effects are held rather than interpreted as spare capacity.

## Admission

- Offload admission refreshes limits for create, resume and running-idle reuse. A read has a three-second timeout and never falls back to stale data. Whole-run warm leases and opportunistic sweeps may reuse an observation no older than five seconds. Slow intent persistence revalidates freshness before allowing the external effect.
- Incomplete, nonfinite or unreadable capacity fails closed. A partial response can explain a refusal but cannot authorize an admission.
- Start/active ceilings are the minimum configured/provider ceilings. Defaults stay at two active VMs and 70 daily starts. Minute, hour and day windows include unreflected start reservations. Provider reset timestamps are honored; absent metadata means rolling windows, never UTC midnight.
- Create/resume reserve active capacity, a potential start and compute before the external call. Running reuse reserves compute without claiming another start or active slot. Pool capacity remains independent of account capacity.
- Compute covers the command timeout plus its selected idle tail plus the configured account reserve, after subtracting all outstanding unreflected compute from available capacity. Whole-run admission funds its provider TTL; warm leases on the same VM share a future compute envelope instead of summing overlapping lease bills. TTL extensions require funded admission too.
- Size weights come from `@boatdev/sdk` 1.10's `SandboxUsageResponse.billingMultiplier`: small 0.5, default 1, large 2, xlarge 50/9. These are machine-seconds per wall second. Provider usage seconds already include the weight, and provider dollars are not replaced with a static price estimate.
- C=300 is selected under effective daily start pressure or an observed counted resume, only when compute covers the longer tail. A zero-count resume is recorded but does not exempt the next resume from admission.

Definitive provider rejection releases the potential effect. A lost reply, an in-progress idempotency response, a failed reconciliation read, or an empty list does not. Unknown creates without a confirmed VM identity deliberately remain held: timing out a reservation would not prove the provider never created a billing VM. A terminal receipt for a known VM retires its active/future-compute hold, while unreflected consumed compute/start windows remain accounted for.

## Usage and recovery

Each offload command has a stable usage record ID, sanitized identity metadata and a payload digest, never raw argv or environment. Expected command cost is separate from the provider-billed projection. Command intervals include resume/setup time. An idle tail belongs to the preceding command and closes at the next reservation or terminal stop. Failed starts, aborted starts and uncovered provider intervals have explicit rows.

`reconcile()` updates the same rows when provider readings arrive, including after reconstruction. Missing readings stay pending. Historical interval reads run outside the account admission mutex against a detached usage snapshot. A short locked merge commits the complete bill only if that VM's source rows are unchanged; a concurrent command, tail closure or correction leaves the stale projection uncommitted for a later pass. Limits, terminal receipts and durable admission intent remain serialized. A failed multi-read correction does not overwrite an already-converged provider bill. Interval totals are compared with the full provider reading, allowing bounded SDK rounding (USD is rounded to six decimals).

Each reconciliation pass prioritizes live holds and rotates the historical VM subset using a persisted cursor, so old bills cannot starve recent terminal receipts. The existing whole-run worker sweep invokes account reconciliation and reuses its provider inventory. This recovers terminal holds and pending usage. The same sweep also runs each offload pool's executor reconciliation, which restricts receipt checks and usage reads to VM identities persisted under that executor's `poolId`, not every intent in the shared account journal. A fresh pool object recovers this set from durable state rather than its in-memory VM list. The supplied provider client must own that stable pool identity; another pool's or manager credential group's live hold is never probed or retired by this path. The current sweep's cadence is still not a promise of a 15-second crash-recovery stop.

## Verification boundary

The independently authored account admission/usage suites exercise stale limits, the three-second timeout, cross-pool/whole-run races, durable state failure and reconstruction, weighted compute boundaries, ambiguous effects, reset metadata, adaptive tails and disjoint late billing. Legacy executor fixtures now use the same durable dependency seam. All provider calls in local verification use fakes; this is not live provider, pilot, deployment or savings evidence.
