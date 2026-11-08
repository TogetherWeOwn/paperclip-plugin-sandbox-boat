// Lost-create placeholder sweep, receipt-to-pool failure ordering, and warm
// pre-effect refusal restoring the predecessor.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountReservation } from "./account-ledger.js";
import type { OffloadExecutor } from "./offload.js";
import { command, DiskState, EPOCH, fixture, type Fixture } from "./test-support/offload-lifecycle-contract.js";
import { includedPlan, trialLimits } from "./test-support/fake-boat.js";

let s: Fixture;
beforeEach(async () => { s = await fixture(); });
afterEach(async () => { await s.dispose(); });

type SavedVm = { sandboxId: string; quarantined: boolean; deletePending?: boolean; stopDueAt: number | null;
  accountReservation?: AccountReservation };
async function savedVms(): Promise<SavedVm[]> {
  const row = Object.entries(await s.state.all()).find(([key]) => JSON.parse(key).namespace === "boat-offload-pool");
  return row ? (row[1] as { vms: SavedVm[] }).vms : [];
}
const config = { maxOffloadVms: 3, maxActive: 3 };
const restart = () => s.make(config, new DiskState(s.state.path));
type Ledger = { started(api: unknown, r: AccountReservation, id: string): Promise<number>;
  failed(r: AccountReservation, definitive: boolean): Promise<void>; assertDispatchable(...args: unknown[]): void };
const ledgerOf = (ex: OffloadExecutor) => (ex as unknown as { ledger: Ledger }).ledger;
const poolOf = (ex: OffloadExecutor) => (ex as unknown as { pool: Array<Record<string, unknown>> }).pool;

/** Lose a create per workspace; the provider call is always recorded by FakeBoat. */
async function loseCreates(ex: OffloadExecutor, workspaces: string[], effect: boolean) {
  s.boat.limitsResponse = trialLimits({ maxActiveSandboxes: 3 });
  for (const id of workspaces) {
    s.boat.failNext("create", effect ? (args) => s.boat.loseCreateReply(args) : new Error("create reply lost"));
    expect(await s.execute(command(`lost-${id}`, { executionWorkspaceId: id }), ex))
      .toMatchObject({ status: "unavailable", remoteStarted: false });
  }
}

describe("lost-create placeholder sweep", () => {
  it.each([false, true])("sweeps terminal empty-ID placeholders of every workspace without a POST (restart=%s)", async (reload) => {
    const ex = s.make(config);
    await loseCreates(ex, ["workspace-a", "workspace-b"], false);
    const placeholders = await savedVms();
    expect(placeholders.map((vm) => vm.sandboxId)).toEqual(["", ""]);
    for (const vm of placeholders) await ledgerOf(ex).failed(vm.accountReservation!, true);
    const sweeper = reload ? restart() : ex;
    s.clock.crashWorker();
    await sweeper.sweep();
    expect(await savedVms()).toEqual([]);
    expect(s.boat.callsOf("create")).toHaveLength(2);
    expect(s.boat.callsOf("stop")).toHaveLength(0);
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(0);
  });

  it("keeps a placeholder whose retained create intent is still pending", async () => {
    const ex = s.make(config);
    await loseCreates(ex, ["workspace-a", "workspace-b"], false);
    const [done, pending] = await savedVms();
    await ledgerOf(ex).failed(done!.accountReservation!, true);
    await restart().sweep();
    expect((await savedVms()).map((vm) => vm.accountReservation!.id)).toEqual([pending!.accountReservation!.id]);
    expect(s.boat.callsOf("create")).toHaveLength(2);
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(0);
  });

  it("retains deletion ownership of a terminal placeholder with a known ID until the delete succeeds", async () => {
    const ex = s.make(config);
    await loseCreates(ex, ["workspace-a"], true);
    const [placeholder] = await savedVms();
    const [id] = [...s.boat.boxes.keys()];
    await ledgerOf(ex).started(s.boat, placeholder!.accountReservation!, id!);
    await ledgerOf(ex).failed(placeholder!.accountReservation!, true);
    const sweeper = restart();
    s.boat.failNext("deleteSandbox", new Error("delete transport failure"));
    await sweeper.sweep();
    // Not forgotten: the identity and delete duty are durable.
    expect(await savedVms()).toMatchObject([{ sandboxId: id, quarantined: true, deletePending: true }]);
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(1);
    await sweeper.sweep();
    expect(s.boat.callsOf("deleteSandbox")).toHaveLength(2);
    expect(s.boat.callsOf("deleteSandbox")[1]!.args).toMatchObject({ sandboxId: id });
    expect(await savedVms()).toEqual([]);
    expect(s.boat.callsOf("create")).toHaveLength(1);
  });
});

describe("receipt-to-pool failure ordering", () => {
  /** Fail the next `count` pool writes once the provider create has answered. */
  function failPoolAfterCreate(count: number) {
    let armed = false, left = count;
    const create = s.boat.create.bind(s.boat);
    s.boat.create = async (args) => { const reply = await create(args); armed = true; return reply; };
    const set = s.state.set.bind(s.state);
    s.state.set = async (key, value) => {
      if (armed && left > 0 && key.namespace === "boat-offload-pool") { left -= 1; throw new Error("pool outage"); }
      await set(key, value);
    };
    return () => { s.state.set = set; s.boat.create = create; };
  }

  it("keeps the known ID durably when only the receipt-to-pool save fails", async () => {
    const restore = failPoolAfterCreate(1);
    const ex = s.make(config);
    expect(await s.execute(command("first"), ex)).toMatchObject({ status: "unavailable", remoteStarted: false });
    restore();
    const [id] = [...s.boat.boxes.keys()];
    // The failed(false) fallback save carried the known identity.
    expect(await savedVms()).toMatchObject([{ sandboxId: id, quarantined: true }]);
    await restart().recover();
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.boat.boxes.size).toBe(1);
    expect(await savedVms()).toMatchObject([{ sandboxId: id }]);
  });

  it("adopts the ambiguous known ID after both pool saves fail and the worker restarts", async () => {
    const restore = failPoolAfterCreate(2);
    const ex = s.make(config);
    expect(await s.execute(command("first"), ex)).toMatchObject({ status: "unavailable", remoteStarted: false });
    restore();
    const [id] = [...s.boat.boxes.keys()];
    expect(await savedVms()).toMatchObject([{ sandboxId: "" }]);
    s.clock.crashWorker();
    const next = restart();
    expect(await s.execute(command("second"), next)).toMatchObject({ status: "completed", sandboxId: id });
    expect(s.boat.callsOf("create")).toHaveLength(1);
    expect(s.boat.boxes.size).toBe(1);
  });
});

describe("warm pre-effect refusal", () => {
  it.each(["machine type unavailable", "period ends inside the funded TTL"])("restores the predecessor's idle deadline, timer and quarantine state on a known no-effect refusal (%s)", async (refusal) => {
    const ex = s.make(config);
    expect(await s.execute(command("warm-a"), ex)).toMatchObject({ status: "completed" });
    const vm = poolOf(ex)[0]!;
    const dueAt = vm.stopDueAt as number;
    expect(dueAt).toBe(EPOCH + 15_000);
    await s.clock.advance(5_000);
    // The reservation is committed (reserveVm has run); a slow pool save then
    // ages the limits snapshot past 5 s and the revalidation finds the machine
    // type unavailable: a known refusal before any provider effect.
    const persist = (ex as unknown as { persistPool: () => Promise<void> });
    const inner = persist.persistPool.bind(ex);
    persist.persistPool = async () => {
      persist.persistPool = inner;
      s.clock.t += 6_000;
      // Reserve already passed on the old snapshot; the refreshed one refuses.
      s.boat.limitsResponse = refusal === "machine type unavailable"
        ? trialLimits({ maxActiveSandboxes: 3, machineTypes: [{ type: "default", available: false, reason: "test" }] })
        : trialLimits({ maxActiveSandboxes: 3, planIncluded: { ...includedPlan(), periodEnd: new Date(EPOCH + 11_000 + 30_000) } });
      await inner();
    };
    expect(await s.execute(command("warm-b"), ex)).toMatchObject({ status: "unavailable", remoteStarted: false });
    s.boat.limitsResponse = trialLimits({ maxActiveSandboxes: 3 });
    // A definitive refusal made no effect: the VM is neither fenced nor leaked.
    expect(vm).toMatchObject({ busy: false, quarantined: false, stopDueAt: dueAt });
    expect(vm.idleHandle).not.toBeNull();
    expect([...s.clock.timers.values()].filter((timer) => timer.owner === "worker").map((timer) => timer.at))
      .toEqual([dueAt]);
    expect((await savedVms())[0]).toMatchObject({ quarantined: false, stopDueAt: dueAt });
    expect(s.boat.callsOf("update")).toHaveLength(0);
    // The original absolute deadline still stops the VM and closes its tail.
    await s.clock.advance(10_000 - 1_000);
    expect(s.boat.callsOf("stop")).toHaveLength(1);
    expect(ex.getUsage().find((row) => row.commandId === "warm-a")).toMatchObject({ stoppedAt: dueAt, stopLagMs: 0 });
    // The restored VM is reusable.
    expect(await s.execute(command("warm-c"), ex)).toMatchObject({ status: "completed", sandboxId: s.starts[0]!.sandboxId });
  });
});
