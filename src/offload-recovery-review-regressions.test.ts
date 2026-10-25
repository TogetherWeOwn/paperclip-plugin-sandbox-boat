import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, DiskState, EPOCH, fixture, type Fixture } from "./test-support/offload-lifecycle-contract.js";
import { responseError, trialLimits } from "./test-support/fake-boat.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });
const restart = () => s.make({ queueLimit: 0 }, new DiskState(s.state.path));
async function savedPool() {
  return Object.entries(await s.state.all())
    .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")![1] as {
      vms: Array<{ sandboxId: string; stopObservedAt: number | null; accountReservation: { id: string } }>;
    };
}
function failLedgerWrites() {
  const set = s.state.set.bind(s.state);
  s.state.set = async (key, value) => {
    if (key.namespace === "boat-account") throw new Error("ledger outage");
    await set(key, value);
  };
  return () => { s.state.set = set; };
}

describe("persisted recovery review regressions", () => {
  it("cannot let a retired VM's stale retry durably remove its replacement", async () => {
    await s.execute(command("retired"));
    s.boat.failNext("stop", new Error("stop connection lost"));
    await s.clock.advance(15_000);
    s.boat.boxes.delete(s.starts[0]!.sandboxId);
    expect(await s.execute(command("replacement"))).toMatchObject({ status: "completed" });
    const replacement = s.starts[1]!.sandboxId;
    expect((await savedPool()).vms.map((vm) => vm.sandboxId)).toEqual([replacement]);
    await s.clock.advance(1_000);
    expect((await savedPool()).vms.map((vm) => vm.sandboxId)).toEqual([replacement]);
    expect(s.boat.boxes.get(replacement)?.state).toBe("ready");
    s.clock.crashWorker();
    const ex = restart();
    await ex.recover();
    expect(await s.execute(command("reuse-replacement"), ex)).toMatchObject({ status: "completed", sandboxId: replacement });
    expect(s.boat.callsOf("create")).toHaveLength(2);
  });

  it("reloads distinct ambiguous create reservations without releasing their holds", async () => {
    s.boat.limitsResponse = trialLimits({ maxActiveSandboxes: 3 });
    const ex = s.make({ maxOffloadVms: 3, maxActive: 3 });
    const create = s.boat.create.bind(s.boat);
    s.boat.create = async (args) => {
      await create(args);
      throw new Error("create reply lost");
    };
    for (const id of ["lost-create-a", "lost-create-b"]) {
      expect(await s.execute(command(id), ex)).toMatchObject({ status: "unavailable", remoteStarted: false });
    }
    const saved = await savedPool();
    expect(saved.vms.map((vm) => vm.sandboxId)).toEqual(["", ""]);
    expect(new Set(saved.vms.map((vm) => vm.accountReservation.id)).size).toBe(2);
    expect(s.boat.boxes.size).toBe(2);
    s.clock.crashWorker();
    s.boat.create = create;
    const recovered = s.make({ maxOffloadVms: 3, maxActive: 3 }, new DiskState(s.state.path));
    await expect(recovered.recover()).resolves.toBeUndefined();
    expect(await s.execute(command("remaining-slot"), recovered)).toMatchObject({ status: "completed" });
    expect((await savedPool()).vms.filter((vm) => !vm.sandboxId)).toHaveLength(2);
    expect(s.starts.map((start) => start.commandId)).toEqual(["remaining-slot"]);
    expect(s.boat.callsOf("stop")).toHaveLength(0);
  });

  it.each(["duplicate-provider", "duplicate-reservation", "unidentified"])("rejects corrupt %s allocation ownership", async (mode) => {
    await s.execute(command("persisted"));
    s.clock.crashWorker();
    const [encoded, raw] = Object.entries(await s.state.all())
      .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")!;
    const doc = raw as { vms: Array<Record<string, unknown>> };
    const vm = doc.vms[0]!;
    vm.identity = null;
    if (mode === "duplicate-provider") {
      doc.vms.push({ ...structuredClone(vm), accountReservation: {
        ...vm.accountReservation as object, id: "another-reservation",
      } });
    } else {
      vm.sandboxId = "";
      if (mode === "unidentified") delete vm.accountReservation;
      else doc.vms.push(structuredClone(vm));
    }
    await s.state.set(JSON.parse(encoded) as Parameters<typeof s.state.set>[0], doc);
    await expect(restart().recover()).rejects.toThrow("OFFLOAD_POOL_UNREADABLE");
    expect(s.starts).toHaveLength(1);
    expect(s.boat.callsOf("stop")).toHaveLength(0);
  });

  it("retries an ambiguous lifecycle stop on repeated shutdown", async () => {
    await s.execute(command("shutdown"));
    s.boat.failNext("stop", new Error("transient stop transport failure"));
    await expect(s.executor.shutdown()).rejects.toThrow("OFFLOAD_SHUTDOWN_INCOMPLETE");
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    await expect(s.executor.shutdown()).resolves.toBeUndefined();
    expect(s.boat.callsOf("stop")).toHaveLength(2);
    expect(s.boat.boxes.get(s.starts[0]!.sandboxId)?.state).toBe("archived");
    expect(s.starts).toHaveLength(1);
  });

  it("keeps idle-stop observation retries after a transient status outage", async () => {
    await s.execute(command("status-outage"));
    s.boat.failNext("stop", new Error("stop never reached provider"));
    await s.clock.advance(15_000);
    s.boat.failNext("get", new Error("status temporarily unreadable"));
    await s.clock.advance(1_000);
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    await s.clock.advance(60_000);
    expect(s.boat.callsOf("stop")).toHaveLength(2);
    expect(s.boat.boxes.get(s.starts[0]!.sandboxId)?.state).toBe("archived");
    expect(s.boat.callsOf("get").length).toBeLessThan(10);
  });

  it("retains the earlier durable observation after reconciliation closes a delayed stop", async () => {
    s.boat.stopMode = "never";
    await s.execute(command("delayed-stop"));
    await s.clock.advance(15_000);
    s.clock.crashWorker();
    const restore = failLedgerWrites();
    await s.clock.advance(7_000);
    s.boat.boxes.get(s.starts[0]!.sandboxId)!.state = "archived";
    await expect(s.executor.sweep()).rejects.toThrow("ledger outage");
    expect((await savedPool()).vms[0]!.stopObservedAt).toBe(EPOCH + 22_000);
    restore();
    await s.clock.advance(5_000);
    const ex = restart();
    await ex.recover();
    await ex.reconcile();
    await ex.sweep();
    expect(ex.getUsage().find((row) => row.commandId === "delayed-stop")).toMatchObject({
      stopRequestedAt: EPOCH + 15_000, stoppedAt: EPOCH + 22_000, stopLagMs: 7_000,
    });
  });

  it("repairs the exact reservation's closed tail without stamping an older cancelled tail", async () => {
    await s.execute(command("cancelled-tail"));
    s.boat.failNext("stop", responseError(429, { code: "rate_limited" }));
    await s.clock.advance(15_000);
    expect(await s.execute(command("terminal-tail"))).toMatchObject({ status: "completed", warm: "warm" });
    const restore = failLedgerWrites();
    await s.clock.advance(15_000);
    s.clock.crashWorker();
    restore();
    await s.clock.advance(7_000);
    const ex = restart();
    await ex.recover();
    await ex.reconcile();
    expect(ex.getUsage().find((row) => row.commandId === "terminal-tail")).toMatchObject({ tailSince: null, stoppedAt: null });
    await ex.sweep();
    expect(ex.getUsage().find((row) => row.commandId === "terminal-tail")).toMatchObject({
      stopRequestedAt: EPOCH + 30_000, stoppedAt: EPOCH + 30_000, stopLagMs: 0,
    });
    expect(ex.getUsage().find((row) => row.commandId === "cancelled-tail"))
      .toMatchObject({ stoppedAt: null, stopLagMs: null });
  });
});
