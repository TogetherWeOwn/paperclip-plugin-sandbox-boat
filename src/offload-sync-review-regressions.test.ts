import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolVm } from "./offload-pool.js";
import type { OffloadResult } from "./offload.js";
import { command, DiskState, EPOCH, fixture, flush, until, type Fixture } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });
async function savedPool() {
  return Object.entries(await s.state.all())
    .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")![1] as {
      vms: Array<Omit<PoolVm, "idleHandle">>;
    };
}

describe("sync pool reclamation review regressions", () => {
  it.each([
    { companyId: "company-b" }, { repoId: "repo-b" },
    { profileId: "rust-other" }, { trustDomainId: "untrusted-fork" },
  ])("replaces idle incompatible capacity in a one-VM pool: %j", async (identity) => {
    await s.execute(command("first"));
    const old = s.starts[0]!.sandboxId;
    expect(await s.execute(command("other", identity))).toMatchObject({ status: "completed", warm: "cold" });
    const replacement = s.starts[1]!.sandboxId;
    expect(replacement).not.toBe(old);
    expect(s.boat.boxes.has(old)).toBe(false); // retired VMs are deleted, not left archived
    expect(s.boat.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([old]);
    expect(s.boat.callsOf("resume")).toHaveLength(0);
    expect((await savedPool()).vms.map((vm) => vm.sandboxId)).toEqual([replacement]);
  });

  it.each(["stopped", "legacy"])("reclaims %s incompatible slots rather than permanently consuming capacity", async (mode) => {
    await s.execute(command("first"));
    if (mode === "stopped") await s.clock.advance(15_000);
    s.clock.crashWorker();
    if (mode === "legacy") {
      const [encoded, raw] = Object.entries(await s.state.all())
        .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")!;
      const doc = raw as Awaited<ReturnType<typeof savedPool>>;
      delete doc.vms[0]!.compatibilityKey;
      delete doc.vms[0]!.workspaceKey;
      await s.state.set(JSON.parse(encoded) as Parameters<typeof s.state.set>[0], doc);
    }
    const ex = s.make({}, new DiskState(s.state.path));
    expect(await s.execute(command("replacement", { trustDomainId: "untrusted-fork" }), ex))
      .toMatchObject({ status: "completed", warm: "cold" });
    expect(s.starts[1]!.sandboxId).not.toBe(s.starts[0]!.sandboxId);
    expect(s.boat.callsOf("create")).toHaveLength(2);
    expect(s.boat.callsOf("resume")).toHaveLength(0);
    expect((await savedPool()).vms).toHaveLength(1);
  });

  it("admits a third compatibility after a two-slot pool becomes idle", async () => {
    const ex = s.make({ maxOffloadVms: 2 });
    for (const [id, trustDomainId] of [["a", "trust-a"], ["b", "trust-b"], ["c", "trust-c"]] as const) {
      expect(await s.execute(command(id, { trustDomainId }), ex)).toMatchObject({ status: "completed" });
    }
    expect(s.starts.map((start) => start.commandId)).toEqual(["a", "b", "c"]);
    expect(s.boat.callsOf("create")).toHaveLength(3);
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    expect((await savedPool()).vms).toHaveLength(2);
  });

  it("retains an asynchronously stopping incompatible allocation until terminal observation", async () => {
    await s.execute(command("first"));
    s.boat.stopMode = "never";
    expect(await s.execute(command("pending", { trustDomainId: "untrusted-fork" })))
      .toMatchObject({ status: "unavailable", remoteStarted: false });
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect((await savedPool()).vms).toMatchObject([{ sandboxId: s.starts[0]!.sandboxId, stopping: true }]);
    s.boat.boxes.get(s.starts[0]!.sandboxId)!.state = "archived";
    expect(await s.execute(command("after-stop", { trustDomainId: "untrusted-fork" })))
      .toMatchObject({ status: "completed" });
    expect(s.boat.callsOf("create")).toHaveLength(2);
  });

  it("never reclaims a quarantined incompatible workspace", async () => {
    s.fail.add("collect:uncertain");
    expect(await s.execute(command("uncertain"))).toMatchObject({ status: "unknown" });
    expect(await s.execute(command("other", { executionWorkspaceId: "workspace-b", trustDomainId: "untrusted-fork" })))
      .toMatchObject({ status: "unavailable" });
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.boat.callsOf("stop")).toHaveLength(0);
    expect((await savedPool()).vms).toMatchObject([{ quarantined: true }]);
  });

  it("does not reinstall a retired VM's idle timer when dispatch replaces it", async () => {
    const gate = s.hold("exec:holder");
    const first = s.execute(command("holder"));
    await until(() => s.trace.includes("exec:holder"));
    const next = s.execute(command("waiter", { trustDomainId: "untrusted-fork" }));
    for (let n = 0; n < 20; n += 1) await flush();
    gate.resolve();
    await first;
    expect(await next).toMatchObject({ status: "completed" });
    expect(s.starts.map((start) => start.commandId)).toEqual(["holder", "waiter"]);
    expect((await savedPool()).vms.map((vm) => vm.sandboxId)).toEqual([s.starts[1]!.sandboxId]);
    expect([...s.clock.timers.values()].filter((timer) => timer.owner === "worker")).toHaveLength(1);
  });
});

describe("sync workspace fail-closed review guards", () => {
  it("rejects a recovered legacy quarantine with unknown workspace ownership despite spare capacity", async () => {
    const original = s.make({ maxOffloadVms: 2 });
    await s.execute(command("legacy"), original);
    s.clock.crashWorker();
    const [encoded, raw] = Object.entries(await s.state.all())
      .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")!;
    const doc = raw as Awaited<ReturnType<typeof savedPool>>;
    doc.vms[0]!.quarantined = true;
    delete doc.vms[0]!.workspaceKey;
    delete doc.vms[0]!.compatibilityKey;
    await s.state.set(JSON.parse(encoded) as Parameters<typeof s.state.set>[0], doc);
    const recovered = s.make({ maxOffloadVms: 2 }, new DiskState(s.state.path));
    await recovered.recover();
    expect(await s.execute(command("new-workspace", { executionWorkspaceId: "workspace-b" }), recovered))
      .toMatchObject({ status: "unavailable", reason: "recovered workspace ownership unknown; reconciliation required" });
    expect(s.starts.map((start) => start.commandId)).toEqual(["legacy"]);
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.boat.callsOf("stop")).toHaveLength(0);
  });

  it.each(["collect", "stage"])("rejects a quarantined workspace immediately after failed %s with queueing enabled", async (phase) => {
    s.fail.add(`${phase}:failed`);
    const ex = s.make({ maxOffloadVms: 2 });
    expect(await s.execute(command("failed"), ex)).toMatchObject({ status: "unknown" });
    let settled: OffloadResult | undefined;
    const next = s.execute(command("same-workspace"), ex);
    void next.then((result) => { settled = result; });
    try {
      await until(() => settled !== undefined);
      expect(settled).toMatchObject({ status: "unavailable", reason: "workspace quarantined; guest reconciliation required" });
      expect(s.clock.t).toBe(EPOCH);
      expect([...s.clock.timers.values()].filter((timer) => timer.owner === "worker")).toHaveLength(0);
      expect(s.starts.map((start) => start.commandId)).toEqual(["failed"]);
      expect(s.boat.callsOf("create")).toHaveLength(1);
      expect(await next).toEqual(settled);
    } finally {
      // Also drain the queued mutant without advancing its timeout clock.
      await ex.cancel("same-workspace", "client_signal", 1);
      await next;
    }
  });
});
