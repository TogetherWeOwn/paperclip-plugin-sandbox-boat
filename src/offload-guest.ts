import type { OffloadCommand } from "./offload.js";
import { commandDigest, guestReceiptKey, matchingReceipt, offloadError, validIdentity,
  type OffloadIdentity, type OffloadReceipt, type OffloadStore } from "./offload-journal.js";

export interface OffloadGuestDeps {
  store: OffloadStore;
  now(): number;
  // The adapter must supply delegated-cgroup/watchdog enforcement and must
  // verify the actual guest boot against identity before invoking this runner.
  spawn(command: OffloadCommand, identity: OffloadIdentity): Promise<{ exitCode: number; seconds: number }>;
}

export class OffloadGuestRunner {
  constructor(private readonly deps: OffloadGuestDeps) {}

  async run(identity: OffloadIdentity, command: OffloadCommand) {
    if (!validIdentity(identity) || identity.guestBootId.startsWith("unverified:")
      || identity.companyId !== command.companyId || identity.runId !== command.runId
      || identity.commandId !== command.commandId || identity.digest !== commandDigest(command)) {
      throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
    }
    try {
      const key = guestReceiptKey(identity, "marker");
      const marker = await this.deps.store.get(key);
      if (marker !== null) return await this.replay(identity, marker);
      // Check orphan receipts too: absence of a marker is not proof of no start.
      for (const kind of ["started", "result", "not_started"] as const) {
        if (await this.deps.store.get(guestReceiptKey(identity, kind)) !== null) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      }
      const receipt = (kind: OffloadReceipt["kind"]): OffloadReceipt => ({ version: 1, kind, identity });
      if (!await this.deps.store.create(key, receipt("marker"))) return await this.replay(identity, await this.deps.store.get(key));
      // A crash anywhere after claiming retains the marker forever. Neither a
      // missing started acknowledgement nor a lost terminal write grants spawn.
      await this.deps.store.set(guestReceiptKey(identity, "started"), receipt("started"));
      const result = await this.deps.spawn(command, identity);
      const terminal: OffloadReceipt = { ...receipt("result"), result };
      if (!matchingReceipt(terminal, identity)) throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      await this.deps.store.set(guestReceiptKey(identity, "result"), terminal);
      return this.completed(result);
    } catch (error) {
      // Includes partially written exclusive files observed by a racing runner.
      // Filesystem/transport errors are uncertainty, never public parse errors.
      if ((error as { code?: string }).code === "OFFLOAD_IDEMPOTENCY_CONFLICT") throw error;
      throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
    }
  }

  private completed(result: { exitCode: number; seconds: number }) {
    return { status: "completed" as const, ...result, remoteStarted: true, fallbackSafe: false };
  }

  private async replay(identity: OffloadIdentity, marker: unknown) {
    if (marker && typeof marker === "object" && "identity" in marker && validIdentity(marker.identity)
      && marker.identity.companyId === identity.companyId && marker.identity.runId === identity.runId
      && marker.identity.commandId === identity.commandId && marker.identity.digest !== identity.digest) {
      throw offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT");
    }
    if (!matchingReceipt(marker, identity) || marker.kind !== "marker") throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
    const result = await this.deps.store.get(guestReceiptKey(identity, "result"));
    const neverStarted = await this.deps.store.get(guestReceiptKey(identity, "not_started"));
    const started = await this.deps.store.get(guestReceiptKey(identity, "started"));
    if (neverStarted !== null) {
      if (result !== null || started !== null || !matchingReceipt(neverStarted, identity) || neverStarted.kind !== "not_started") {
        throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
      }
      return { status: "not_started" as const, remoteStarted: false, fallbackSafe: true };
    }
    if (result !== null && matchingReceipt(result, identity) && result.kind === "result") return this.completed(result.result!);
    throw offloadError("OFFLOAD_EXECUTION_UNKNOWN");
  }
}
