import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, DiskState, EPOCH, fixture, type Fixture } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });
const restart = () => s.make({ queueLimit: 0 }, new DiskState(s.state.path));

describe("guest recovery safety regressions", () => {
  it("retains pending stop ownership and timestamps across a second worker", async () => {
    s.boat.stopMode = "never";
    await s.execute(command("pending"));
    await s.clock.advance(15_000);
    s.clock.crashWorker();
    const ex = restart();
    await ex.recover();
    expect(await s.execute(command("blocked"), ex)).toMatchObject({ status: "unavailable" });
    await ex.sweep();
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    expect(ex.getUsage()).toMatchObject([{ commandId: "pending", stopRequestedAt: EPOCH + 15_000, stoppedAt: null, stopLagMs: null }]);
    await s.clock.advance(7_000);
    s.boat.boxes.get(s.starts[0]!.sandboxId)!.state = "archived";
    await ex.sweep();
    expect(ex.getUsage()).toMatchObject([{ commandId: "pending", stoppedAt: EPOCH + 22_000, stopLagMs: 7_000 }]);
    await s.clock.advance(5_000);
    await ex.sweep();
    expect(ex.getUsage()).toMatchObject([{ stoppedAt: EPOCH + 22_000, stopLagMs: 7_000 }]);
  });

  it.each(["unobservable", "populated", "rebooted"])("never stops or reuses recovered idle ownership that is %s", async (mode) => {
    await s.execute(command("old"));
    s.clock.crashWorker();
    if (mode === "unobservable") s.guest.observable = false;
    if (mode === "populated") s.guest.trees.get("old")!.escapedDescendantAlive = true;
    if (mode === "rebooted") s.guest.trees.get("old")!.identity.guestBootId = "new-boot";
    await s.clock.advance(15_000);
    const ex = restart();
    await ex.recover();
    await ex.sweep();
    expect(await s.execute(command("probe"), ex)).toMatchObject({ status: "unavailable" });
    expect(s.boat.callsOf("stop")).toEqual([]);
    expect(s.starts.map((v) => v.commandId)).toEqual(["old"]);
  });

  it("retains every journaled watchdog path, not only the last pool command", async () => {
    await s.execute(command("older"));
    await s.execute(command("latest"));
    s.clock.crashWorker();
    const prepare = s.guest.prepare;
    s.guest.prepare = async (vm, cmd) => ({ ...await prepare(vm, cmd), cgroupPath: "/delegated/commands/older" });
    const ex = restart();
    expect(await s.execute(command("reuse"), ex)).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    expect(s.starts.map((v) => v.commandId)).toEqual(["older", "latest"]);
  });

  it("does not stamp an earlier caller's cancelled idle tail with a later command's stop", async () => {
    await s.execute(command("old-tail"));
    s.boat.failNext("stop", new Error("stop failed"));
    await s.clock.advance(15_000);
    await s.execute(command("new-tail"));
    await s.clock.advance(15_000);
    expect(s.executor.getUsage().find((v) => v.commandId === "old-tail"))
      .toMatchObject({ stoppedAt: null, stopLagMs: null });
    expect(s.executor.getUsage().find((v) => v.commandId === "new-tail"))
      .toMatchObject({ stoppedAt: EPOCH + 30_000, stopLagMs: 0 });
  });

  it("refuses corrupt pool ownership and retries recovery after storage is repaired", async () => {
    await s.execute(command("persisted"));
    s.clock.crashWorker();
    const [encoded, doc] = Object.entries(await s.state.all())
      .find(([key]) => JSON.parse(key).namespace === "boat-offload-pool")!;
    const key = JSON.parse(encoded) as Parameters<typeof s.state.get>[0];
    await s.state.set(key, { ...doc as object, version: 999 });
    const ex = restart();
    await expect(ex.recover()).rejects.toThrow("OFFLOAD_POOL_UNREADABLE");
    await expect(s.execute(command("refused"), ex)).rejects.toThrow("OFFLOAD_POOL_UNREADABLE");
    expect(s.starts).toHaveLength(1);
    expect(s.boat.callsOf("stop")).toHaveLength(0);
    await s.state.set(key, doc);
    await ex.recover();
    await s.clock.advance(15_000);
    await ex.sweep();
    expect(s.boat.callsOf("stop")).toHaveLength(1);
  });

  it("refreshes accepted stops before choosing resume rather than replacing a now-archived VM", async () => {
    s.boat.stopMode = "never";
    await s.execute(command("first"));
    await s.clock.advance(15_000);
    s.boat.boxes.get(s.starts[0]!.sandboxId)!.state = "archived";
    expect(await s.execute(command("second"))).toMatchObject({ status: "completed", warm: "cold" });
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.boat.callsOf("resume")).toHaveLength(1);
  });
});
