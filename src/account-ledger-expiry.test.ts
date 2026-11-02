import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLedger } from "./account-ledger.js";
import { COMPANY, EPOCH, advance, command, fixture, limits, starts } from "./test-support/account-admission.fixture.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });

// jobSeconds + tailSeconds = 660 s funded envelope; the stale-hold margin is
// 10 min, so advancing past 660 + 600 s must retire the hold.
const JOB = 600, TAIL = 60, ENVELOPE = JOB + TAIL, MARGIN = 600;
const request = (id: string) => ({
  operation: "create" as const, size: "default" as const, jobSeconds: JOB, tailSeconds: TAIL,
  maxActive: 1, maxStartsPerDay: 70, minComputeHoursLeft: 0, poolId: "expiry",
  command: command(id),
});

describe("stale start holds expire", () => {
  it("retires an ambiguous start after TTL plus margin, keeping its aborted_start interval", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const api = f.boat as never;
    const first = await ledger.reserve(api, request("exp-1"));
    // The live hold refuses a second start under maxActive=1.
    await expect(ledger.reserve(api, request("exp-2"))).rejects.toThrow(/maxActive/);
    // The create reply was lost: the VM may or may not exist.
    await ledger.failed(first, false);
    await advance((ENVELOPE + MARGIN + 60) * 1000);
    await ledger.reconcile(api);
    // The next start succeeds: no phantom capacity remains.
    const second = await ledger.reserve(api, request("exp-3"));
    expect(second.id).not.toBe(first.id);
    const rows = ledger.usage("expiry");
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.usageRecordId === first.id)!;
    expect(old.kind).toBe("aborted_start");
    expect(old.intervals).toHaveLength(1);
    expect(Date.parse(old.intervals[0]!.since)).toBe(first.at);
    // The interval ends no later than at + ttl.
    expect(Date.parse(old.intervals[0]!.until)).toBeLessThanOrEqual(first.at + ENVELOPE * 1000);
  });

  it("retires a crashed start that never reported started or failed", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const api = f.boat as never;
    await ledger.reserve(api, request("crash-1"));
    // The worker restarts: a fresh ledger over the same durable state sees
    // the intent with no started/failed call and no sandboxId.
    const fresh = new AccountLedger(f.state, f.accountId, () => Date.now());
    await expect(fresh.reserve(api, request("crash-2"))).rejects.toThrow(/maxActive/);
    await advance((ENVELOPE + MARGIN + 60) * 1000);
    await fresh.reconcile(api);
    await expect(fresh.reserve(api, request("crash-3"))).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("keeps a fresh in-flight start held", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const api = f.boat as never;
    await ledger.reserve(api, request("live-1"));
    await advance(60_000);
    await expect(ledger.reserve(api, request("live-2"))).rejects.toThrow(/maxActive/);
  });
});

describe("strict monthly VM-hour cap", () => {
  it("refuses a 30-min job when 0.9 h is used under a 1 h cap", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    // No provider read happens: the cap refuses before limits are fetched.
    const api = { limits: async () => { throw new Error("no provider in unit test"); } } as never;
    const monthStart = Date.UTC(2026, 9, 1);
    const usedMs = 0.9 * 3_600_000;
    const base = (over: Record<string, unknown> = {}) => ({
      operation: "create" as const, size: "default" as const, jobSeconds: 1_800, tailSeconds: 600,
      maxActive: 10, maxStartsPerDay: 70, minComputeHoursLeft: 0, poolId: "cap-strict",
      command: command("cap-job", { companyId: "co-9" }),
      monthlyCap: { companyId: "co-9", nowMs: EPOCH, capHours: 1 }, ...over });
    // Seed 0.9 h of settled in-month usage directly.
    const { createHash } = await import("node:crypto");
    const hashed = createHash("sha256").update(f.accountId).digest("hex");
    await f.state.set({ scopeKind: "instance", namespace: "boat-account", stateKey: hashed }, {
      version: 1, observation: null, intents: [], countedResumeUntil: null,
      usage: [{ usageRecordId: "seed", poolId: "cap-strict", kind: "command", commandId: "seed",
        runId: "r", cardId: "c", repoId: "repo", sandboxId: "vm-0", seconds: usedMs / 1000,
        dollars: 0, meterProvenance: "provider", observedStartsDelta: null,
        intervals: [{ since: new Date(monthStart).toISOString(),
          until: new Date(monthStart + usedMs).toISOString(), phase: "command" }],
        tailSince: null, companyId: "co-9" }],
    });
    // 0.9 h used + 0.5 h envelope crosses the 1 h cap: refused.
    await expect(ledger.reserve(api, base())).rejects.toThrow(/monthly offload VM-hour cap/);
    // An envelope that exactly fits is still admitted (needs a limits read).
    await expect(ledger.reserve(f.boat as never, base({ jobSeconds: 300, tailSeconds: 60 })))
      .resolves.toMatchObject({ id: expect.any(String) });
  });
});

describe("review findings", () => {
  it("releases compute on expiry so repeated ambiguous starts cannot exhaust it", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    // Just enough balance for one envelope: with the expired 660 s hold still
    // outstanding, the next 660 s envelope would not fit.
    f.boat.limitsResponse = limits({ creditBalanceSeconds: 1000 });
    const api = f.boat as never;
    const base = { operation: "create" as const, size: "default" as const, jobSeconds: JOB, tailSeconds: TAIL,
      maxActive: 10, maxStartsPerDay: 70, minComputeHoursLeft: 0, poolId: "expiry" };
    const first = await ledger.reserve(api, { ...base, command: command("cmp-1") });
    await ledger.failed(first, false);
    await advance((ENVELOPE + MARGIN + 60) * 1000);
    await ledger.reconcile(api);
    await expect(ledger.reserve(api, { ...base, command: command("cmp-2") }))
      .resolves.toMatchObject({ id: expect.any(String) });
  });

  it("rechecks the monthly cap against the selected tail under start pressure", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    // Day usage at 60/75 trips the 80% pressure rule, so tail() selects 300 s.
    f.boat.limitsResponse = limits({ starts: starts(60, 75) });
    const api = f.boat as never;
    const { createHash } = await import("node:crypto");
    const hashed = createHash("sha256").update(f.accountId).digest("hex");
    const seed = (usedSeconds: number) => f.state.set(
      { scopeKind: "instance", namespace: "boat-account", stateKey: hashed },
      { version: 1, observation: null, intents: [], countedResumeUntil: null,
        usage: [{ usageRecordId: "seed", poolId: "cap-tail", kind: "command", commandId: "seed",
          runId: "r", cardId: "c", repoId: "repo", sandboxId: "vm-0", seconds: usedSeconds,
          dollars: 0, meterProvenance: "provider", observedStartsDelta: null,
          intervals: [{ since: new Date(Date.UTC(2026, 9, 1)).toISOString(),
            until: new Date(Date.UTC(2026, 9, 1) + usedSeconds * 1000).toISOString(), phase: "command" }],
          tailSince: null, companyId: "co-9" }] });
    const base = { operation: "create" as const, size: "default" as const, jobSeconds: 300, tailSeconds: 60,
      maxActive: 10, maxStartsPerDay: 70, minComputeHoursLeft: 0, poolId: "cap-tail",
      command: command("tail-job", { companyId: "co-9" }),
      monthlyCap: { companyId: "co-9", nowMs: EPOCH, capHours: 1 } };
    // 2900 + 300 + 300 fits: admitted with the pressure-selected 300 s tail.
    await seed(2900);
    const ok = await ledger.reserve(api, base);
    expect(ok.tailSeconds).toBe(300);
    // 3200 + 300 + 60 fits the requested tail but not the selected one: refused.
    await seed(3200);
    await expect(ledger.reserve(api, base)).rejects.toThrow(/monthly offload VM-hour cap/);
  });

  it("a terminal receipt after expiry keeps the TTL-clamped interval", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const api = f.boat as never;
    const first = await ledger.reserve(api, { ...request("arc-1"), sandboxId: "vm-archived" });
    await ledger.failed(first, false);
    await advance((ENVELOPE + MARGIN + 60) * 1000);
    // The archived listing arrives after expiry: it must not rewrite the
    // clamped aborted_start interval into a two-hour command.
    await ledger.reconcile(api, [{ id: "vm-archived", state: "archived" }]);
    const rows = ledger.usage("expiry");
    const old = rows.find((r) => r.usageRecordId === first.id)!;
    expect(old.intervals).toHaveLength(1);
    expect(Date.parse(old.intervals[0]!.until)).toBeLessThanOrEqual(first.at + ENVELOPE * 1000);
    expect(await ledger.monthVmSeconds(COMPANY, Date.now())).toBeLessThanOrEqual(ENVELOPE + 1);
  });

  it("an open tail that ended last month charges nothing this month", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const { createHash } = await import("node:crypto");
    const hashed = createHash("sha256").update(f.accountId).digest("hex");
    // 15 s tail opened Oct 31 23:50 UTC: its 315 s bound ends before November.
    const tailSince = Date.UTC(2026, 9, 31, 23, 50, 0);
    await f.state.set({ scopeKind: "instance", namespace: "boat-account", stateKey: hashed }, {
      version: 1, observation: null, countedResumeUntil: null,
      intents: [{ id: "tail-row", providerScope: undefined, poolId: "x", sandboxId: "vm-tail",
        operation: "create", at: tailSince - 60_000, settledAt: tailSince - 60_000, status: "running",
        active: true, activeReflected: false, starts: {}, compute: 75, computeReflected: 0,
        size: "default", jobSeconds: 60, tailSeconds: 15, ttlSeconds: 75,
        reserveSeconds: 0, endedAt: null, usageId: "tail-row" }],
      usage: [{ usageRecordId: "tail-row", poolId: "x", kind: "command", commandId: "t",
        runId: "r", cardId: "c", repoId: "repo", sandboxId: "vm-tail", seconds: 60,
        dollars: 0, meterProvenance: "pending", observedStartsDelta: null, intervals: [],
        tailSince, companyId: COMPANY }],
    });
    expect(await ledger.monthVmSeconds(COMPANY, Date.UTC(2026, 10, 2))).toBe(0);
  });

  it("a retried stop bills its actual minutes within grace", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const api = f.boat as never;
    const reservation = await ledger.reserve(api, { ...request("retry-1"), jobSeconds: 300, tailSeconds: 60 });
    await ledger.started(api, reservation, "vm-retry");
    await advance(30_000);
    await ledger.finished(reservation, false);
    const tailSince = Date.now();
    // The first stop fails; the retry succeeds two minutes past the deadline.
    await ledger.stopRequested("vm-retry", tailSince + 60_000, tailSince, reservation.id);
    await advance(120_000);
    await ledger.stopped("vm-retry", Date.now(), reservation.id);
    const rows = ledger.usage("expiry");
    const tail = rows[0]!.intervals.find((i) => i.phase === "idle_tail")!;
    expect(Date.parse(tail.until)).toBe(tailSince + 120_000);
  });
});

describe("stop-lag clamping", () => {
  it("counts at most the funded tail for a tail observed days late", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const api = f.boat as never;
    const req = { ...request("lag-1"), jobSeconds: 300, tailSeconds: 60 };
    const reservation = await ledger.reserve(api, req);
    await ledger.started(api, reservation, "vm-lag");
    await advance(30_000);
    await ledger.finished(reservation, false);
    const tailSince = Date.now();
    await ledger.stopRequested("vm-lag", tailSince + 60_000, tailSince, reservation.id);
    await advance(5 * 86_400_000);
    // Before any terminal receipt, the open tail counts at most tail + grace.
    const openTail = await ledger.monthVmSeconds(COMPANY, Date.now());
    expect(openTail).toBeLessThanOrEqual(30 + 60 + 300 + 1);
    // The late receipt closes the tail at the stop deadline plus grace, not days later.
    await ledger.stopped("vm-lag", Date.now(), reservation.id);
    const rows = ledger.usage("expiry");
    const tail = rows[0]!.intervals.find((i) => i.phase === "idle_tail")!;
    expect(Date.parse(tail.until)).toBeLessThanOrEqual(tailSince + 60_000 + 300_000);
    const closed = await ledger.monthVmSeconds(COMPANY, Date.now());
    expect(closed).toBeLessThanOrEqual(30 + 60 + 300 + 1);
  });
});
