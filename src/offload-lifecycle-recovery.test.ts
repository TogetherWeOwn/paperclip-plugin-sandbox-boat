import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandKey } from "./offload-journal.js";
import { OffloadPoolStore, type PoolVm } from "./offload-pool.js";
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

  // slice b: persisted pool recovery and sweep.
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
    // A stop is neither a replay nor a release: the fenced VM is stopped to
    // halt billing while its slot stays fenced (the unrelated command still
    // reads unavailable, and only one VM was ever created).
    expect.soft(s.boat.callsOf("stop").map((v) => v.args.sandboxId)).toEqual([s.starts[0]!.sandboxId]);
    expect(s.boat.callsOf("create")).toHaveLength(1);
  });

  // slice b: persisted pool recovery and sweep.
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

  // slice b: persisted pool recovery and sweep.
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

  // slice b: persisted pool recovery and sweep.
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

  // slice b: persisted pool recovery and sweep.
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

// Quarantine reconciliation after a restart: a gone guest (archived TTL box)
// releases its slot instead of fencing it forever, while its old command
// still reads unknown with fallbackSafe=false and is never replayed.
describe("offload lifecycle: quarantine reconciles after a restart", () => {
  it("crash in the idle tail, archive, restart and sweep frees the slot for a new command", async () => {
    const first = await s.execute(command("tail"));
    expect(first).toMatchObject({ status: "completed" });
    const sandboxId = s.starts[0]!.sandboxId;
    s.clock.crashWorker();
    s.boat.boxes.get(sandboxId)!.state = "archived";
    await s.clock.advance(60_000);
    const restarted = s.make({}, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    await s.api(restarted).sweep?.();
    const next = await s.execute(command("next-tail", { cardId: "card-b", executionWorkspaceId: "workspace-b" }), restarted);
    expect(next).toMatchObject({ status: "completed" });
  });

  it("an archived quarantined VM releases its slot on sweep while its command still reads unknown", async () => {
    s.fail.add("exec:doomed");
    const cmd = command("doomed");
    const original = await s.execute(cmd);
    expect(original).toMatchObject({ status: "unknown", fallbackSafe: false });
    const sandboxId = s.starts[0]!.sandboxId;
    s.clock.crashWorker();
    s.fail.clear();
    s.boat.boxes.get(sandboxId)!.state = "archived";
    const restarted = s.make({ queueLimit: 0 }, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    await s.api(restarted).sweep?.();
    // The old command is preserved byte-for-byte and never replays.
    const replay = await s.execute(cmd, restarted);
    expect(replay).toEqual(original);
    expect(replay).toMatchObject({ status: "unknown", fallbackSafe: false });
    const next = await s.execute(command("next", { cardId: "card-b", executionWorkspaceId: "workspace-b" }), restarted);
    expect(next).toMatchObject({ status: "completed" });
  });

  // SDK 1.13.0 GET passes `state` through unchanged, and its SandboxStateEnum
  // has no `stopped`: only stop.status=completed is defined ("the sandbox is
  // archived"). A literal `stopped` therefore proves no process-tree end and
  // stays indeterminate: fenced, unsettled, never reused or replayed.
  it("a quarantined VM whose provider reads a literal stopped stays fenced", async () => {
    s.fail.add("exec:doomed");
    const cmd = command("doomed");
    const original = await s.execute(cmd);
    expect(original).toMatchObject({ status: "unknown", fallbackSafe: false });
    const sandboxId = s.starts[0]!.sandboxId;
    s.clock.crashWorker();
    s.fail.clear();
    s.boat.boxes.get(sandboxId)!.state = "stopped";
    const disk = new DiskState(s.state.path);
    const restarted = s.make({ queueLimit: 0 }, disk);
    await s.api(restarted).recover?.();
    await s.api(restarted).sweep?.();
    expect(await new OffloadPoolStore(disk, `guest-test:${s.root}`, "guest-test-pool").load()).toMatchObject([{ sandboxId, quarantined: true }]);
    expect(await s.execute(cmd, restarted)).toEqual(original);
    const next = await s.execute(command("next", { cardId: "card-b", executionWorkspaceId: "workspace-b" }), restarted);
    expect(next).toMatchObject({ status: "unavailable" });
    expect(s.boat.callsOf("create")).toHaveLength(1);
  });
});

// slice b: persisted stop-observation telemetry and worker-death sweep.
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

// Review fixes: recovery-time reconciliation must never lose pool ownership,
// must retry an unconfirmed quarantined stop, must not free a slot whose
// terminal settlement failed, and must not rejoin a clean-observed VM while
// its command receipt is still unresolved.
describe("offload lifecycle: recovery reconciliation keeps its stop duties", () => {
  const poolOf = (disk: DiskState) => new OffloadPoolStore(disk, `guest-test:${s.root}`, "guest-test-pool");
  const seedQuarantined = (boxId: string, patch: Partial<PoolVm> = {}) => poolOf(s.state).save(
    { maxOffloadVms: 1, offloadIdleStopSeconds: 15 },
    [{ sandboxId: boxId, busy: false, stopped: false, stopping: false, quarantined: true,
      lastActiveAt: EPOCH - 60_000, generation: 1, idleHandle: null,
      stopDueAt: null, stopRequestedAt: null, stopAttempts: 0, identity: null, ...patch }]);

  it("reconcile-during-recovery never leaves the persisted pool doc emptied", async () => {
    const box = s.boat.addSandbox({ id: "bx_recoverempty01", state: "archived" });
    await seedQuarantined(box.id);
    const restarted = s.make({}, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    // A crash right after recovery still finds the VM and its stop duty.
    const crashed = s.make({}, new DiskState(s.state.path));
    await s.api(crashed).recover?.();
    const doc = await poolOf(new DiskState(s.state.path)).load();
    expect(doc.map((vm) => vm.sandboxId)).toEqual([box.id]);
    expect(doc[0]).toMatchObject({ stopped: true, quarantined: false });
  });

  it("retries the stop of a quarantined identity-less VM that is still running", async () => {
    s.boat.stopMode = "stays_up";
    const box = s.boat.addSandbox({ id: "bx_quarstopretry01", state: "ready" });
    await seedQuarantined(box.id, { stopDueAt: EPOCH - 1_000 });
    const restarted = s.make({}, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    expect(s.boat.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([box.id]);
    await s.api(restarted).sweep?.();
    expect(s.boat.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([box.id, box.id]);
  });

  it("keeps the slot fenced while terminal settlement fails, and frees it once settlement succeeds", async () => {
    s.fail.add("exec:doomed");
    const cmd = command("doomed");
    await s.execute(cmd);
    const sandboxId = s.starts[0]!.sandboxId;
    s.clock.crashWorker();
    s.fail.clear();
    s.boat.boxes.get(sandboxId)!.state = "archived";
    const disk = new DiskState(s.state.path);
    let failJournal = true;
    const journal = disk.store();
    disk.store = () => ({ ...journal,
      set: async (id: string, value: unknown) => {
        if (failJournal) throw new Error("injected journal failure");
        return journal.set(id, value);
      } });
    const restarted = s.make({}, disk);
    await s.api(restarted).recover?.();
    await s.api(restarted).sweep?.();
    // Still fenced: the pool doc lists the VM quarantined, and its receipt is still pending.
    expect(await poolOf(disk).load()).toMatchObject([{ sandboxId, quarantined: true }]);
    expect((await journal.get(commandKey(cmd)) as { resultAt: unknown }).resultAt).toBeNull();
    failJournal = false;
    await s.api(restarted).sweep?.();
    expect(await poolOf(disk).load()).toMatchObject([{ sandboxId, quarantined: false, stopped: true }]);
    expect((await journal.get(commandKey(cmd)) as { resultAt: unknown }).resultAt).not.toBeNull();
  });

  it("a clean-observed running VM with an unresolved receipt stays fenced until the provider archives it", async () => {
    s.fail.add("exec:doomed");
    const cmd = command("doomed");
    await s.execute(cmd);
    const sandboxId = s.starts[0]!.sandboxId;
    // The stop is accepted but never takes effect, so the fence can be
    // observed while the provider still reports running.
    s.boat.stopMode = "stays_up";
    s.clock.crashWorker();
    s.fail.clear();
    // The guest is gone-clean but the provider still reports running: the
    // receipt is unresolved, so recovery and sweep must keep the slot fenced
    // while still stopping the VM to halt billing.
    const restarted = s.make({}, new DiskState(s.state.path));
    await s.api(restarted).recover?.();
    await s.api(restarted).sweep?.();
    expect(await poolOf(new DiskState(s.state.path)).load())
      .toMatchObject([{ sandboxId, quarantined: true }]);
    expect(s.boat.callsOf("stop").map((call) => call.args.sandboxId)).toContain(sandboxId);
    // Once the provider archives it, the terminal branch settles and frees it.
    s.boat.boxes.get(sandboxId)!.state = "archived";
    await s.api(restarted).sweep?.();
    expect(await poolOf(new DiskState(s.state.path)).load())
      .toMatchObject([{ sandboxId, quarantined: false, stopped: true }]);
  });
});
