// Instance-scoped pool ownership, separate from command execution evidence and
// account admission. One authoritative worker; this is not a multi-worker lock.
import { createHash } from "node:crypto";
import type { AccountReservation } from "./account-ledger.js";
import type { BoatSize } from "./size-policy.js";
import { validIdentity, type OffloadIdentity } from "./offload-journal.js";
import type { OffloadExecutorConfig } from "./offload.js";
import type { StateClientLike } from "./state.js";

export interface PoolVm {
  sandboxId: string;
  busy: boolean;
  stopped: boolean;
  stopping: boolean;
  quarantined: boolean;
  // Persisted before sync can start receivers/installers outside the command
  // cgroup. A crash or failure requires a terminal provider fence before reuse.
  syncInFlight?: boolean;
  // Ephemeral VM whose provider delete (or its ledger receipt) failed:
  // quarantined against reuse, retried by sweep and shutdown until retired.
  deletePending?: boolean;
  // Saved before ephemeral source/command execution, so completion-time pool
  // write failure cannot lose the disk's deletion policy across restart.
  deleteOnRelease?: boolean;
  lastActiveAt: number;
  generation: number;
  idleHandle: unknown | null;
  stopDueAt: number | null;
  stopRequestedAt: number | null;
  // Optional for pools persisted before observed stop timestamps were stored.
  stopObservedAt?: number | null;
  stopAttempts: number;
  identity: OffloadIdentity | null;
  // Missing legacy bindings cannot authorize reuse or erase an uncertain hold.
  compatibilityKey?: string;
  workspaceKey?: string | null;
  accountReservation?: AccountReservation;
  tailSeconds?: number;
  // Exact provider body of an unconfirmed create (or fork), so a same-key
  // replay resends the identical body instead of rebuilding it from the
  // current command. Cleared once the sandbox id is recorded.
  pendingCreate?: {
    kind: "create" | "fork";
    type: BoatSize;
    ttlSeconds: number;
    monitoring: boolean;
    failFast: boolean;
    noEnv: boolean;
    from?: string;
    sourceSandboxId?: string;
  };
}
type StoredVm = Omit<PoolVm, "idleHandle">;
interface PoolDoc { version: 1; config: OffloadExecutorConfig; vms: StoredVm[] }
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown) => value === null || Number.isSafeInteger(value) && finite(value);

export class OffloadPoolStore {
  private readonly key;
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly state: StateClientLike, accountId: string, poolId: string) {
    this.key = { scopeKind: "instance" as const, namespace: "boat-offload-pool",
      stateKey: createHash("sha256").update(JSON.stringify([accountId, poolId])).digest("hex") };
  }
  async load(): Promise<PoolVm[]> {
    try {
      return (await this.loadDoc()).vms;
    } catch (error) {
      if (error instanceof Error && error.message === "OFFLOAD_POOL_ABSENT") return [];
      throw error;
    }
  }
  /** The persisted pool including its config, so an unloaded pool's sweep can
   * save back without losing the settings recovery relies on. */
  async loadDoc(): Promise<{ config: OffloadExecutorConfig; vms: PoolVm[] }> {
    const raw = await this.state.get(this.key);
    if (raw === null) throw new Error("OFFLOAD_POOL_ABSENT");
    const doc = raw as PoolDoc;
    if (!doc || doc.version !== 1 || !Array.isArray(doc.vms) || !doc.config
      || !finite(doc.config.offloadIdleStopSeconds) || !Number.isSafeInteger(doc.config.maxOffloadVms)
      || doc.config.maxOffloadVms < 1) throw new Error("OFFLOAD_POOL_UNREADABLE");
    const ids = new Set<string>();
    const reservations = new Set<string>();
    for (const vm of doc.vms) {
      // A lost create reply has no provider ID yet. Its durable reservation,
      // not the empty placeholder, uniquely owns that unresolved allocation.
      if (!vm || typeof vm.sandboxId !== "string" || (vm.sandboxId !== "" && ids.has(vm.sandboxId))
        || (vm.sandboxId === "" && !vm.accountReservation?.id)
        || ![vm.busy, vm.stopped, vm.stopping, vm.quarantined].every((v) => typeof v === "boolean")
        || (vm.deletePending !== undefined && typeof vm.deletePending !== "boolean")
        || (vm.deleteOnRelease !== undefined && typeof vm.deleteOnRelease !== "boolean")
        || (vm.syncInFlight !== undefined && typeof vm.syncInFlight !== "boolean")
        || !timestamp(vm.lastActiveAt) || vm.lastActiveAt === null || !timestamp(vm.stopDueAt) || !timestamp(vm.stopRequestedAt)
        || (vm.stopObservedAt !== undefined && !timestamp(vm.stopObservedAt))
        || !Number.isSafeInteger(vm.generation) || vm.generation < 0 || !Number.isSafeInteger(vm.stopAttempts) || vm.stopAttempts < 0
        || (vm.tailSeconds !== undefined && !finite(vm.tailSeconds))
        || (vm.pendingCreate !== undefined && (
          !vm.pendingCreate || (vm.pendingCreate.kind !== "create" && vm.pendingCreate.kind !== "fork")
          || typeof vm.pendingCreate.type !== "string" || !vm.pendingCreate.type
          || !finite(vm.pendingCreate.ttlSeconds)
          || typeof vm.pendingCreate.monitoring !== "boolean" || typeof vm.pendingCreate.failFast !== "boolean"
          || typeof vm.pendingCreate.noEnv !== "boolean"
          || (vm.pendingCreate.from !== undefined && typeof vm.pendingCreate.from !== "string")
          || (vm.pendingCreate.sourceSandboxId !== undefined && typeof vm.pendingCreate.sourceSandboxId !== "string")))
        || (vm.compatibilityKey !== undefined && (typeof vm.compatibilityKey !== "string" || !vm.compatibilityKey))
        || (vm.workspaceKey !== undefined && vm.workspaceKey !== null && (typeof vm.workspaceKey !== "string" || !vm.workspaceKey))
        || (vm.identity !== null && (!validIdentity(vm.identity) || vm.identity.sandboxId !== vm.sandboxId))
        || (vm.accountReservation !== undefined && (!vm.accountReservation || typeof vm.accountReservation.id !== "string"
          || !vm.accountReservation.id || reservations.has(vm.accountReservation.id)
          || !finite(vm.accountReservation.at) || !finite(vm.accountReservation.tailSeconds)))) {
        throw new Error("OFFLOAD_POOL_UNREADABLE");
      }
      if (vm.sandboxId) ids.add(vm.sandboxId);
      if (vm.accountReservation) reservations.add(vm.accountReservation.id);
    }
    const vms = structuredClone(doc.vms).map((vm) => ({ ...vm,
      // Recovery uses the funded per-VM tail or its saved pool setting, never
      // the restarting caller's default. The original absolute due time wins.
      tailSeconds: vm.tailSeconds ?? doc.config.offloadIdleStopSeconds, idleHandle: null }));
    return { config: structuredClone(doc.config), vms };
  }
  async save(config: OffloadExecutorConfig, vms: readonly PoolVm[]): Promise<void> {
    const doc: PoolDoc = { version: 1, config: structuredClone(config),
      vms: vms.map(({ idleHandle: _timer, ...vm }) => structuredClone(vm)) };
    // Whole-document saves can originate outside admission (notably sync).
    // Keep invocation snapshots ordered so an older write cannot erase a fence
    // after its save has completed and authorized guest mutation. Never hold
    // admission or this queue across the guest work itself.
    const saved = this.saving.then(() => this.state.set(this.key, doc));
    this.saving = saved.catch(() => undefined); // one failure must not poison later saves
    await saved;
  }
}
