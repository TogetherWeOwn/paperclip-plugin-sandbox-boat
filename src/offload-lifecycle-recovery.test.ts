import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command, DiskState, EPOCH, fixture, until } from "./test-support/offload-lifecycle-contract.js";
import type { Fixture } from "./test-support/offload-lifecycle-contract.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

// Breaks caught: losing quarantine on restart; treating accepted stop as stopped;
// reusing unobserved guest identity; relying on a live worker's idle timer.
// DiskState is just the existing StateClientLike transport, not a second journal.
describe("offload lifecycle: persisted reconciliation", () => {
  it("a never-started fallback is durable before it is advertised to its caller", async () => {
    s.boat.failNext("limits", new Error("unreadable limits"));
    const receipt = await s.execute(command("never-started"));
    expect(receipt).toMatchObject({ remoteStarted: false, fallbackSafe: true });
    const reopened = new DiskState(s.state.path);
    const bytes = JSON.stringify(await reopened.all());
    expect.soft(bytes).toContain("never-started");
    expect.soft(bytes).toContain("not_started");
    expect(s.starts).toEqual([]);
  });

  it("restart after an ambiguous running reply neither replays nor releases its VM", async () => {
    s.fail.add("exec:uncertain");
    const cmd = command("uncertain");
    const original = await s.execute(cmd);
    expect(original).toMatchObject({ status: "unknown", fallbackSafe: false });
    s.clock.crashWorker();
    s.fail.clear();
    const disk = new DiskState(s.state.path);
    const restarted = s.make({ queueLimit: 0 }, disk);
    await s.api(restarted).recover?.();
    const replay = await s.execute(cmd, restarted);
    expect.soft(replay).toEqual(original);
    expect.soft(s.starts.map((v) => v.commandId)).toEqual(["uncertain"]);
    const next = await s.execute(command("unrelated", { executionWorkspaceId: "workspace-b", cardId: "card-b" }), restarted);
    expect.soft(next).toMatchObject({ status: "unavailable" });
    expect.soft(s.boat.callsOf("stop")).toEqual([]);
    expect(s.boat.callsOf("create")).toHaveLength(1);
  });

  it("restart reconciles a healthy active receipt without stopping it or admitting a second command", async () => {
    const gate = s.hold("exec:healthy");
    const active = s.execute(command("healthy"));
    await until(() => s.trace.includes("exec:healthy"));
    s.clock.crashWorker();
    const restarted = s.make({ queueLimit: 0 }, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    await s.api(restarted).sweep?.();
    expect.soft(s.guest.alive("healthy")).toBe(true);
    expect.soft(s.boat.callsOf("stop")).toEqual([]);
    await s.execute(command("probe", { cardId: "card-b", executionWorkspaceId: "workspace-b" }), restarted);
    expect.soft(s.starts.map((v) => v.commandId)).toEqual(["healthy"]);
    expect.soft(s.guest.actions.some((v) => v.kind === "inspect")).toBe(true);
    gate.resolve();
    await active;
  });

  it("recovered unobservable ownership remains quarantined after the original call settles", async () => {
    const gate = s.hold("exec:unobservable");
    const active = s.execute(command("unobservable"));
    await until(() => s.trace.includes("exec:unobservable"));
    s.clock.crashWorker();
    s.guest.observable = false;
    const restarted = s.make({ queueLimit: 0 }, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    gate.resolve();
    await active;
    await s.api(restarted).sweep?.();
    await s.execute(command("probe"), restarted);
    expect.soft(s.starts.map((v) => v.commandId)).toEqual(["unobservable"]);
    expect.soft(s.guest.actions.filter((v) => ["term", "kill"].includes(v.kind))).toEqual([]);
    expect(s.boat.callsOf("stop")).toEqual([]);
  });

  it("restart loads the persisted idle pool and stops it through sweep without creating a replacement", async () => {
    await s.execute(command("idle"));
    s.clock.crashWorker();
    await s.clock.advance(300_000);
    const restarted = s.make({}, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    await s.api(restarted).sweep?.();
    expect.soft(s.boat.callsOf("stop").map((v) => v.args.sandboxId)).toEqual([s.starts[0]!.sandboxId]);
    expect.soft(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.guest.actions.some((v) => v.kind === "inspect")).toBe(true);
  });

  it("sweep uses persisted pool config rather than silently resetting its idle deadline", async () => {
    const original = s.make({ offloadIdleStopSeconds: 60 });
    await s.execute(command("longer-tail"), original);
    s.clock.crashWorker();
    const restarted = s.make({}, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    await s.clock.advance(15_000);
    await s.api(restarted).sweep?.();
    expect(s.boat.callsOf("stop")).toEqual([]);
    await s.clock.advance(45_000);
    await s.api(restarted).sweep?.();
    expect(s.boat.callsOf("stop")).toHaveLength(1);
  });
});

describe("offload lifecycle: stop acceptance is not measured termination", () => {
  it("keeps stoppedAt and actual stop lag pending while the provider is still archiving", async () => {
    s.boat.stopMode = "never";
    await s.execute(command("slow-stop"));
    await s.clock.advance(15_000);
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    expect(s.boat.boxes.get(s.starts[0]!.sandboxId)?.state).toBe("archiving");
    // Selected public telemetry contract: integer epoch-ms timestamps; null is
    // unknown, not fabricated zero-lag success at stop-request acceptance.
    expect(s.executor.getUsage()).toMatchObject([{
      commandId: "slow-stop", stopRequestedAt: EPOCH + 15_000, stoppedAt: null, stopLagMs: null,
    }]);
  });

  it("records measured lag when a later sweep observes provider termination", async () => {
    s.boat.stopMode = "never";
    await s.execute(command("observed-stop"));
    await s.clock.advance(15_000);
    await s.clock.advance(7_000);
    s.boat.boxes.get(s.starts[0]!.sandboxId)!.state = "archived";
    await s.api().sweep?.();
    expect(s.executor.getUsage()).toMatchObject([{
      commandId: "observed-stop", stopRequestedAt: EPOCH + 15_000,
      stoppedAt: EPOCH + 22_000, stopLagMs: 7_000,
    }]);
  });

  it("five-minute worker-death sweep is a slower backstop, never a fifteen-second guarantee", async () => {
    await s.execute(command("crashed-idle"));
    s.clock.crashWorker();
    await s.clock.advance(15_000);
    expect(s.boat.callsOf("stop")).toEqual([]);
    await s.clock.advance(285_000);
    const restarted = s.make({}, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    await s.api(restarted).sweep?.();
    expect.soft(s.boat.callsOf("stop")).toHaveLength(1);
    expect(restarted.getUsage()).toMatchObject([{
      commandId: "crashed-idle", stoppedAt: EPOCH + 300_000, stopLagMs: 285_000,
    }]);
  });
});
