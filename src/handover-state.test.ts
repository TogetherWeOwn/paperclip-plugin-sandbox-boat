import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBoat, includedPlan, trialLimits } from "./test-support/fake-boat.js";
import { openHandoverSources } from "./test-support/handover-sources.js";
import type { StateClientLike } from "./state.js";

// JSON round trips and new source roots model persistence/process boundaries.
// These are synthetic account IDs, never exports of protected installed state.
class JsonState implements StateClientLike {
  rows = new Map<string, string>();
  failWrites = false;
  key(input: unknown) { return JSON.stringify(input); }
  async get(input: Parameters<StateClientLike["get"]>[0]) { return JSON.parse(this.rows.get(this.key(input)) ?? "null"); }
  async set(input: Parameters<StateClientLike["set"]>[0], value: unknown) {
    if (this.failWrites) throw new Error("synthetic durable failure");
    this.rows.set(this.key(input), JSON.stringify(value));
  }
  async delete(input: Parameters<StateClientLike["delete"]>[0]) { this.rows.delete(this.key(input)); }
  restart() { const next = new JsonState(); next.rows = new Map(this.rows); return next; }
  doc(): any { return JSON.parse([...this.rows.values()][0]!); }
}
const EPOCH = Date.parse("2026-10-23T10:00:00Z");
const command = (id: string) => ({ commandId: id, companyId: "synthetic-company", runId: "synthetic-run",
  cardId: "synthetic-card", repoId: "synthetic-repo", profileId: "secret-free", argv: ["test", "--locked"] });
const request = (id: string, extra = {}) => ({ operation: "create", size: "default", jobSeconds: 600,
  tailSeconds: 60, maxActive: 4, maxStartsPerDay: 70, minComputeHoursLeft: 0, poolId: "synthetic-pool",
  command: command(id), ...extra });

let sources: Awaited<ReturnType<typeof openHandoverSources>>;
let state: JsonState, clock: number, boat: FakeBoat;
beforeEach(async () => {
  sources = await openHandoverSources(); state = new JsonState(); clock = EPOCH;
  boat = new FakeBoat({ now: () => clock });
});
afterEach(async () => { await sources.close(); });
async function ledger(version: "old" | "candidate", scope?: string) {
  const { AccountLedger } = await sources[version].load("src/account-ledger.ts");
  return new AccountLedger(state, "synthetic-account", () => clock, scope);
}
async function boundary() {
  state = state.restart();
  await sources.close();
  sources = await openHandoverSources();
}
const pairs = [["old", "candidate"], ["candidate", "old"]] as const;

describe("pinned account-state operations, not version acceptance", () => {
  it.each(pairs)("%s → %s retains ambiguous holds, expires once, and accepts a delayed terminal receipt", async (from, to) => {
    const first = await ledger(from, "scope-a");
    const reservation = await first.reserve(boat, request("lost"));
    await first.failed(reservation, false);
    const before = state.doc();
    await boundary();
    const next = await ledger(to, "scope-a");
    await expect(next.reserve(boat, request("refused", { maxActive: 1 }))).rejects.toThrow(/capacity|maxActive/);
    expect(state.doc()).toEqual(before);
    clock += 1_321_000; // 660 s TTL plus 600 s stale margin, then 61 s.
    await next.reconcile(boat);
    const expired = state.doc().intents.find((row: any) => row.id === reservation.id);
    expect(expired).toMatchObject({ status: "stopped", active: false, compute: 0, providerScope: "scope-a" });
    await next.reconcile(boat, [{ id: "unrelated-vm", state: "archived" }]);
    expect(state.doc().intents.find((row: any) => row.id === reservation.id)).toEqual(expired);
    const replacement = await next.reserve(boat, request("after-expiry", { maxActive: 1 }));
    expect(replacement.id).not.toBe(reservation.id);
    expect(next.usage("synthetic-pool").filter((row: any) => row.usageRecordId === reservation.id)).toHaveLength(1);
    expect(boat.callsOf("create")).toHaveLength(0);
  });

  it.each(pairs)("%s → %s restores a failed warm/resume handoff without double billing", async (from, to) => {
    const first = await ledger(from, "scope-a");
    const reservation = await first.reserve(boat, request("predecessor"));
    await first.started(boat, reservation, "vm-synthetic");
    clock += 30_000;
    await first.finished(reservation, false);
    const prior = state.doc();
    await boundary();
    const next = await ledger(to, "scope-a");
    for (const operation of ["warm", "resume"]) {
      const handoff = await next.reserve(boat, request(`handoff-${operation}`, { operation, sandboxId: "vm-synthetic" }));
      await next.failed(handoff, true);
      const doc = state.doc();
      expect(doc.intents.find((row: any) => row.id === reservation.id)).toEqual(prior.intents[0]);
      expect(doc.usage.find((row: any) => row.usageRecordId === reservation.id)).toEqual(prior.usage[0]);
      expect(doc.intents.find((row: any) => row.id === handoff.id)).toMatchObject({ status: "rejected", active: false, compute: 0 });
    }
    await next.stopped("vm-synthetic", clock + 60_000);
    await next.load();
    expect(await next.poolAccountingSettled("synthetic-pool")).toBe(true);
    expect(next.usage("synthetic-pool").filter((row: any) => row.usageRecordId === reservation.id)).toHaveLength(1);
    expect(boat.callsOf("resume")).toHaveLength(0);
  });

  it.each(pairs)("%s → %s preserves a failed reservation write and does not transfer another scope's hold", async (from, to) => {
    const first = await ledger(from, "scope-a");
    await first.reserve(boat, request("scope-a-pending"));
    const before = [...state.rows];
    state.failWrites = true;
    await expect(first.reserve(boat, request("failed-write"))).rejects.toThrow("synthetic durable failure");
    expect([...state.rows]).toEqual(before);
    state.failWrites = false;
    await boundary();
    const foreign = await ledger(to, "scope-b");
    await expect(foreign.reserve(boat, request("scope-b-refused", { maxActive: 1 }))).rejects.toThrow(/capacity|maxActive/);
    await foreign.reconcile(boat, [{ id: "vm-synthetic", state: "archived" }]);
    expect(state.doc().intents[0]).toMatchObject({ providerScope: "scope-a", status: "intent", active: true, compute: 660 });
    expect(boat.callsOf("create")).toHaveLength(0);
  });

  it("old → candidate does not refund old wallet observations as included allowance consumption", async () => {
    const first = await ledger("old", "scope-a");
    const reservation = await first.reserve(boat, request("legacy-observation"));
    await first.started(boat, reservation, "vm-synthetic");
    clock += 30_000;
    const before = state.doc().intents[0].computeReflected;
    await boundary();
    boat.limitsResponse = trialLimits({ planIncluded: includedPlan(1000) });
    const next = await ledger("candidate", "scope-a");
    await next.reconcile(boat, [{ id: "vm-synthetic", state: "running" }]);
    expect(state.doc().intents[0].computeReflected).toBe(before);
    expect(state.doc().intents[0].id).toBe(reservation.id);
    expect(state.doc().providerObservations["scope-a"].periodEndMs).toBeGreaterThan(clock);
  });

  it("candidate rollover retains unreflected holds; a repeated observation cannot refund twice", async () => {
    const first = await ledger("candidate", "scope-a");
    const reservation = await first.reserve(boat, request("rollover"));
    await first.started(boat, reservation, "vm-synthetic");
    clock += 30_000;
    await boundary();
    const next = await ledger("candidate", "scope-a");
    boat.limitsResponse = trialLimits({ planIncluded: {
      vmHours: 25, vmHoursRemaining: 0.3, periodEnd: new Date(clock + 7 * 86_400_000),
    } });
    await next.reconcile(boat, [{ id: "vm-synthetic", state: "running" }]);
    expect(state.doc().intents[0].computeReflected).toBe(0);
    const once = state.doc().intents[0];
    await next.reconcile(boat, [{ id: "vm-synthetic", state: "running" }]);
    expect(state.doc().intents[0]).toEqual(once);
  });

  it("requires downgrade REFUSAL: old admits an expired included period that the candidate refuses", async () => {
    const first = await ledger("candidate");
    const reservation = await first.reserve(boat, request("candidate-produced"));
    await first.failed(reservation, true);
    await boundary();
    boat.limitsResponse = trialLimits({ planIncluded: { vmHours: 25, vmHoursRemaining: 25, periodEnd: new Date(clock - 1) } });
    const before = [...state.rows];
    await expect((await ledger("candidate")).reserve(boat, request("candidate-refused"))).rejects.toThrow();
    expect([...state.rows]).toEqual(before);
    // Characterization of the old source, NOT a runtime downgrade gate.
    const unsafe = await (await ledger("old")).reserve(boat, request("old-would-admit"));
    expect(unsafe.id).toEqual(expect.any(String));
    expect(boat.callsOf("create")).toHaveLength(0);
    expect(boat.callsOf("resume")).toHaveLength(0);
  });

  it("candidate refuses a lifetime crossing rollover and a cached allowance after expiry", async () => {
    boat.limitsResponse = trialLimits({ planIncluded: { vmHours: 25, vmHoursRemaining: 25, periodEnd: new Date(clock + 661_000) } });
    const first = await ledger("candidate");
    await first.reserve(boat, request("funded"));
    await boundary();
    clock += 2_000;
    const next = await ledger("candidate");
    await expect(next.reserve(boat, request("crosses-period", { allowCachedLimits: true }))).rejects.toThrow(/period|lifetime/);
    clock += 660_000;
    await expect(next.reserve(boat, request("expired", { allowCachedLimits: true }))).rejects.toThrow();
    expect(boat.callsOf("create")).toHaveLength(0);
  });
});

async function executor(version: "old" | "candidate", executions: string[]) {
  const { OffloadExecutor } = await sources[version].load("src/offload.ts");
  const { OffloadPoolStore } = await sources[version].load("src/offload-pool.ts");
  const instance = new OffloadExecutor({ state, accountId: "synthetic-account", poolId: "synthetic-pool", boat,
    now: () => clock, logger: { info() {}, warn() {}, error() {} },
    timers: { set: () => 1, clear() {} },
    config: { maxOffloadVms: 1, offloadIdleStopSeconds: 15, queueLimit: 0 },
    runCommand: async (_sandbox: string, cmd: { commandId: string }) => { executions.push(cmd.commandId); return { exitCode: 0, seconds: 1 }; },
  });
  instance.poolStore = new OffloadPoolStore(state, "synthetic-account", "synthetic-pool");
  return instance;
}

describe("pinned fake-provider pool handover", () => {
  it.each(pairs)("%s → %s preserves a lost-create key and dispatches only the adopting command", async (from, to) => {
    const executions: string[] = [];
    const first = await executor(from, executions);
    boat.failNext("create", (args) => boat.loseCreateReply(args));
    expect(await first.execute(command("lost-create"))).toMatchObject({ status: "unavailable" });
    const key = boat.callsOf("create")[0]!.args.idempotencyKey;
    expect(executions).toEqual([]);
    await boundary();
    const next = await executor(to, executions);
    expect(await next.execute(command("after-handover"))).toMatchObject({ status: "completed" });
    expect(executions).toEqual(["after-handover"]);
    expect(boat.callsOf("create")[1]!.args.idempotencyKey).toBe(key);
    expect([...boat.boxes.values()].filter((box) => box.state !== "archived")).toHaveLength(1);
    await next.shutdown();
  });

  it("old → candidate keeps a pending create intact when fresh included funding refuses replay", async () => {
    const executions: string[] = [], first = await executor("old", executions);
    boat.failNext("create", () => new Error("synthetic lost before provider effect"));
    expect(await first.execute(command("lost-before-effect"))).toMatchObject({ status: "unavailable" });
    const key = boat.callsOf("create")[0]!.args.idempotencyKey;
    await boundary();
    const next = await executor("candidate", executions);
    boat.limitsResponse = trialLimits({ nextStartDollars: 0.01 });
    expect(await next.execute(command("refused-replay"))).toMatchObject({ status: "unavailable" });
    expect(boat.callsOf("create")).toHaveLength(1);
    expect(executions).toEqual([]);
    boat.limitsResponse = trialLimits();
    expect(await next.execute(command("funded-replay"))).toMatchObject({ status: "completed" });
    expect(boat.callsOf("create")[1]!.args.idempotencyKey).toBe(key);
    expect(executions).toEqual(["funded-replay"]);
    await next.shutdown();
  });
});
