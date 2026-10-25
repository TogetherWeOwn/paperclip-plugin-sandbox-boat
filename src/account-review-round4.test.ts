import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { OffloadExecutor } from "./offload.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { COMPANY, EPOCH, command, fixture, limits } from "./test-support/account-admission.fixture.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });

function journal(current = f) {
  const entry = current.state.snapshot().find(([key]) => key.includes("boat-account"));
  expect(entry).toBeDefined();
  return JSON.parse(entry![1]) as { intents: Array<{ poolId: string | null; sandboxId: string; status: string; active: boolean; compute: number }> };
}

async function foreignLease() {
  const other = new FakeBoat({ now: () => Date.now() });
  other.limitsResponse = limits();
  // Independent provider accounts have distinct inventories and VM identities.
  await other.create(); other.boxes.clear(); other.calls.length = 0;
  setBoatApiFactoryForTests((options) => (options.apiKey === "synthetic-key-b" ? other : f.boat) as unknown as BoatApiLike);
  const manager = f.manager();
  const lease = await manager.acquire({
    driverKey: "boat", companyId: COMPANY, agentId: "synthetic-principal",
    environmentId: "env-b", issueId: "issue-b", executionWorkspaceId: "workspace-b", runId: "run-b",
    config: { apiKey: "synthetic-key-b", cliproxyTunnel: false },
  } as never);
  const id = lease.providerLeaseId!;
  expect(journal().intents.find((i) => i.sandboxId === id)).toMatchObject({ status: "running", active: true, compute: 7200 });
  return { other, id };
}

describe("pool reconciliation ownership", () => {
  it("does not retire a foreign credential group's live hold through a pool client's 404", async () => {
    const { other, id } = await foreignLease();
    const before = journal().intents;
    await f.pool().reconcile();
    expect(other.boxes.get(id)?.state).toBe("ready");
    expect(journal().intents).toEqual(before);
    expect(f.boat.callsOf("get").filter((call) => call.args.sandboxId === id)).toEqual([]);
    expect(f.boat.callsOf("usage").filter((call) => call.args.sandboxId === id)).toEqual([]);
  });

  it.each(["archived", "missing"])("recovers its own %s VM receipt from durable pool identity without touching foreign holds", async (receipt) => {
    const { other, id: foreignId } = await foreignLease();
    const pool = f.pool();
    const result = await pool.execute(command("own-receipt"));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("synthetic command did not complete");
    const ownId = result.sandboxId;
    expect(ownId).not.toBe(foreignId);
    const before = journal().intents.find((i) => i.sandboxId === foreignId);
    if (receipt === "missing") f.boat.boxes.delete(ownId);
    else f.boat.boxes.get(ownId)!.state = "archived";
    // Reconstruct from committed JSON only: the new pool has no in-memory VMs.
    const recovered = fixture(f.state.snapshot(), f.boat);
    try {
      await recovered.pool().reconcile();
      expect(journal(recovered).intents.find((i) => i.sandboxId === ownId)).toMatchObject({ status: "stopped", active: false, compute: 0 });
      expect(journal(recovered).intents.find((i) => i.sandboxId === foreignId)).toEqual(before);
      expect(other.boxes.get(foreignId)?.state).toBe("ready");
      expect(f.boat.callsOf("get").some((call) => call.args.sandboxId === ownId)).toBe(true);
      expect(f.boat.callsOf("get").filter((call) => call.args.sandboxId === foreignId)).toEqual([]);
    } finally {
      // The original pool still owns its idle timer. Restore the synthetic VM
      // only for teardown; reconciliation above saw the definitive absence.
      if (receipt === "missing") f.boat.addSandbox({ id: ownId, state: "archived" });
      await recovered.close();
    }
  });

  it("does not reconcile a different pool's unscoped holds from the same shared journal", async () => {
    const other = new FakeBoat({ now: () => Date.now() });
    // Share durable state/account identity without sharing provider inventory.
    const poolB = new OffloadExecutor({ boat: other as unknown as BoatApiLike, state: f.state, accountId: f.accountId,
      poolId: "pool-b", now: () => Date.now(), logger: f.logger,
      config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15 }, runCommand: async () => ({ exitCode: 0, seconds: 0 }) });
    try {
      await poolB.execute(command("foreign-pool"));
      const before = journal().intents;
      await f.pool("pool-a").reconcile();
      expect(journal().intents).toEqual(before);
      expect([...other.boxes.values()].every((box) => box.state === "ready")).toBe(true);
      expect(f.boat.callsOf("get")).toEqual([]);
      expect(f.boat.callsOf("usage")).toEqual([]);
    } finally { await poolB.shutdown(); }
  });
});
