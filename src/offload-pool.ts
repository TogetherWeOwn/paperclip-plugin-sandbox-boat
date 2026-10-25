// Instance-scoped pool ownership, separate from command execution evidence and
// account admission. One authoritative worker; this is not a multi-worker lock.
import { createHash } from "node:crypto";
import type { AccountReservation } from "./account-ledger.js";
import { validIdentity, type OffloadIdentity } from "./offload-journal.js";
import type { OffloadExecutorConfig } from "./offload.js";
import type { StateClientLike } from "./state.js";

export interface PoolVm {
  sandboxId: string;
  busy: boolean;
  stopped: boolean;
  stopping: boolean;
  quarantined: boolean;
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
}
type StoredVm = Omit<PoolVm, "idleHandle">;
interface PoolDoc { version: 1; config: OffloadExecutorConfig; vms: StoredVm[] }
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown) => value === null || Number.isSafeInteger(value) && finite(value);

export class OffloadPoolStore {
  private readonly key;
  constructor(private readonly state: StateClientLike, accountId: string, poolId: string) {
    this.key = { scopeKind: "instance" as const, namespace: "boat-offload-pool",
      stateKey: createHash("sha256").update(JSON.stringify([accountId, poolId])).digest("hex") };
  }
  async load(): Promise<PoolVm[]> {
    const raw = await this.state.get(this.key);
    if (raw === null) return [];
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
        || !timestamp(vm.lastActiveAt) || vm.lastActiveAt === null || !timestamp(vm.stopDueAt) || !timestamp(vm.stopRequestedAt)
        || (vm.stopObservedAt !== undefined && !timestamp(vm.stopObservedAt))
        || !Number.isSafeInteger(vm.generation) || vm.generation < 0 || !Number.isSafeInteger(vm.stopAttempts) || vm.stopAttempts < 0
        || (vm.tailSeconds !== undefined && !finite(vm.tailSeconds))
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
    return structuredClone(doc.vms).map((vm) => ({ ...vm,
      // Recovery uses the funded per-VM tail or its saved pool setting, never
      // the restarting caller's default. The original absolute due time wins.
      tailSeconds: vm.tailSeconds ?? doc.config.offloadIdleStopSeconds, idleHandle: null }));
  }
  async save(config: OffloadExecutorConfig, vms: readonly PoolVm[]): Promise<void> {
    const doc: PoolDoc = { version: 1, config: structuredClone(config),
      vms: vms.map(({ idleHandle: _timer, ...vm }) => structuredClone(vm)) };
    await this.state.set(this.key, doc);
  }
}
