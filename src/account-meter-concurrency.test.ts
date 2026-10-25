import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLedger } from "./account-ledger.js";
import type { AdmissionRequest } from "./account-ledger.js";
import type { BoatApiLike } from "./boat-client.js";
import { EPOCH, fixture, flush, providerMeter } from "./test-support/account-admission.fixture.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });
const request: AdmissionRequest = { operation: "create", size: "default", jobSeconds: 2, tailSeconds: 1,
  maxActive: 2, maxStartsPerDay: 70, minComputeHoursLeft: 0, poolId: "meter-pool" };
const identity = (id: string) => ({ commandId: id, runId: `run-${id}`, cardId: `card-${id}`, repoId: "public-source" });

async function history(count: number) {
  const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
  const api = f.boat as unknown as BoatApiLike;
  const id = (await f.boat.create()).sandbox.id as string;
  for (let n = 0; n < count; n++) {
    const reservation = await ledger.reserve(api, { ...request, operation: n ? "warm" : "create", sandboxId: id, command: identity(`history-${n}`) });
    await ledger.started(api, reservation, id);
    vi.setSystemTime(Date.now() + 1_000);
    await ledger.finished(reservation, false);
    vi.setSystemTime(Date.now() + 1_000);
  }
  await ledger.stopped(id);
  f.boat.boxes.get(id)!.state = "archived";
  providerMeter(f, count * 2, count * 0.00002, { until: Date.now() });
  return { ledger, api, id };
}

function blockFirstUsage() {
  const gate = f.gate();
  const entered = f.gate();
  const read = f.boat.usage.bind(f.boat);
  let blocked = false;
  f.boat.usage = async (args) => {
    if (!blocked) { blocked = true; entered.resolve(); await gate.promise; }
    return read(args);
  };
  return { gate, entered };
}

describe("meter IO outside admission transactions", () => {
  it("admits new work while a 300-row historical bill is waiting on provider IO", async () => {
    const { ledger, api } = await history(300);
    const { gate, entered } = blockFirstUsage();
    const sweep = ledger.reconcile(api);
    await entered.promise;
    let admitted = false;
    const next = new AccountLedger(f.state, f.accountId, () => Date.now()).reserve(api, request).then(() => { admitted = true; });
    await flush();
    const progressedBeforeMeterReply = admitted;
    gate.resolve();
    await Promise.all([sweep, next]);
    expect(progressedBeforeMeterReply, "billing IO must not own the account admission mutex").toBe(true);
    expect(ledger.usage("meter-pool").filter((r) => r.meterProvenance === "provider")).toHaveLength(300);
    // The accounting transaction still reconciles every interval; it no longer
    // holds admission hostage to this historical work.
    expect(f.boat.callsOf("usage")).toHaveLength(601);
  });

  it("preserves a converged provider bill when a later interval correction fails partway", async () => {
    const { ledger, api } = await history(2);
    await ledger.reconcile(api);
    const confirmed = ledger.usage("meter-pool");
    expect(confirmed.every((r) => r.meterProvenance === "provider")).toBe(true);
    const read = f.boat.usage.bind(f.boat);
    let intervals = 0;
    f.boat.usage = async (args) => {
      if (args.since && ++intervals === 2) throw new Error("synthetic interval outage");
      const result = await read(args);
      return { ...result, seconds: result.seconds * 2, dollars: result.dollars * 2 };
    };
    await ledger.reconcile(api);
    expect(ledger.usage("meter-pool")).toEqual(confirmed);
  });

  it("discards a stale billing projection without overwriting a concurrent warm handoff", async () => {
    const { ledger, api, id } = await history(2);
    const { gate, entered } = blockFirstUsage();
    const sweep = ledger.reconcile(api);
    await entered.promise;
    let committedUsage: unknown;
    let handedOff = false;
    const handoff = (async () => {
      const reservation = await ledger.reserve(api, { ...request, operation: "warm", sandboxId: id, command: identity("concurrent") });
      await ledger.started(api, reservation, id);
      vi.setSystemTime(Date.now() + 1_000);
      await ledger.finished(reservation, false);
      committedUsage = ledger.usage("meter-pool");
      handedOff = true;
    })();
    await flush();
    const progressedBeforeMeterReply = handedOff;
    gate.resolve();
    await Promise.all([sweep, handoff]);
    expect(progressedBeforeMeterReply).toBe(true);
    expect(ledger.usage("meter-pool")).toEqual(committedUsage);
    expect(ledger.usage("meter-pool").find((r) => r.commandId === "concurrent")).toMatchObject({ meterProvenance: "pending", seconds: 1 });
    const entry = f.state.snapshot().find(([key]) => key.includes("boat-account"));
    expect((JSON.parse(entry![1]) as { usage: unknown }).usage).toEqual(committedUsage);
  });
});
