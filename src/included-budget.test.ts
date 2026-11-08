import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLedger } from "./account-ledger.js";
import type { AdmissionRequest } from "./account-ledger.js";
import type { BoatApiLike } from "./boat-client.js";
import { checkBudget, readBudget } from "./budget.js";
import { OffloadPoolStore } from "./offload-pool.js";
import { EPOCH, JsonState, advance, command, fixture, noDispatch, safeRefusal, starts } from "./test-support/account-admission.fixture.js";

const END = EPOCH + 30 * 86_400_000;
const included = (seconds = 90_000, periodEnd = END) => ({ vmHours: 25, vmHoursRemaining: seconds / 3600, periodEnd: new Date(periodEnd) });
function modern(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, planIncluded: included(), nextStartDollars: 0, canStart: true,
    activeSandboxes: 0, maxActiveSandboxes: 100, starts: starts(),
    machineTypes: [{ type: "default", available: true }, { type: "large", available: true }], ...overrides };
}
const request: AdmissionRequest = { operation: "create", size: "default", jobSeconds: 150,
  tailSeconds: 15, maxActive: 100, maxStartsPerDay: 70, minComputeHoursLeft: 0 };

beforeEach(() => { vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("authoritative included-only budget", () => {
  it("reads modern-only limits and ignores wallet, trial and deprecated credit counters", () => {
    const raw = modern({ planIncluded: included(7200), creditBalanceSeconds: 0,
      creditUsedSeconds: 2_000_000, trialComputeCapSeconds: 1, walletDollars: 999, grace: true });
    expect(readBudget(raw)).toMatchObject({ computeHoursLeft: 2, includedPeriodEndMs: END, nextStartDollars: 0 });
    expect(checkBudget(readBudget(raw), request, "default")).toBeNull();
    expect(readBudget({ ok: true, upgradeEffects: modern({ planIncluded: included(7200) }) }).computeHoursLeft).toBe(2);
    expect(readBudget({ ok: true, _package: modern({ planIncluded: included(7200) }) }).computeHoursLeft).toBe(2);
  });

  it.each([
    { planIncluded: undefined }, { planIncluded: null },
    { planIncluded: { vmHours: 25, vmHoursRemaining: "25", periodEnd: new Date(END) } },
    { planIncluded: { vmHours: 25, vmHoursRemaining: -1, periodEnd: new Date(END) } },
    { planIncluded: { vmHours: 25, vmHoursRemaining: 26, periodEnd: new Date(END) } },
    { planIncluded: { vmHours: 25, vmHoursRemaining: 25, periodEnd: 12 } },
    { planIncluded: included(90_000, EPOCH) },
    { nextStartDollars: undefined }, { nextStartDollars: null },
    { nextStartDollars: 0.01 }, { nextStartDollars: -1 }, { nextStartDollars: "0" },
    { canStart: undefined },
  ])("refuses missing/malformed or paid capacity despite legacy balance: %j", (overrides) => {
    const raw = modern({ creditBalanceSeconds: 2_000_000, ...overrides });
    expect(checkBudget(readBudget(raw), request, "default")).not.toBeNull();
  });

  it("does not repair explicit invalid modern fields with nested capacity", () => {
    const raw = modern({ planIncluded: null, upgradeEffects: modern() });
    expect(checkBudget(readBudget(raw), request, "default")).not.toBeNull();
  });

  it("zero allowance is a refusal even when canStart is true and reserve is zero", () => {
    expect(checkBudget(readBudget(modern({ planIncluded: included(0) })), request, "default")).not.toBeNull();
  });
});

describe("included account reservations", () => {
  function setup(raw = modern()) {
    const state = new JsonState();
    const api = { limits: async () => raw } as unknown as BoatApiLike;
    const ledger = new AccountLedger(state, "included-budget-test", Date.now);
    return { state, api, ledger, set: (next: Record<string, unknown>) => { raw = next; } };
  }

  it("admits exactly one concurrent size-weighted preparation + command + tail envelope", async () => {
    const { ledger, api } = setup(modern({ planIncluded: included(659) }));
    const req = { ...request, size: "large" as const }; // (150 + 15) * 2 = 330 seconds
    const results = await Promise.allSettled([ledger.reserve(api, req), ledger.reserve(api, req)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it.each(["minute", "hour", "day"] as const)("retains the shared last %s start window", async (window) => {
    const windows = starts(); windows[window] = { limit: 1, used: 0, remaining: 1 };
    const { ledger, api } = setup(modern({ starts: windows }));
    const results = await Promise.allSettled([ledger.reserve(api, request), ledger.reserve(api, request)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it.each(["create", "resume", "warm"] as const)("requires a modern allowance before %s", async (operation) => {
    const { ledger, api } = setup(modern({ planIncluded: undefined, creditBalanceSeconds: 2_000_000 }));
    await expect(ledger.reserve(api, { ...request, operation })).rejects.toThrow();
  });

  it.each(["create", "resume"] as const)("requires a zero-cost %s, not just canStart", async (operation) => {
    const { ledger, api } = setup(modern({ nextStartDollars: 0.01 }));
    await expect(ledger.reserve(api, { ...request, operation })).rejects.toThrow();
  });

  it("never reflects a reservation using a decrease across different billing periods", async () => {
    const s = setup(modern({ planIncluded: included(500) }));
    const first = await s.ledger.reserve(s.api, request);
    await s.ledger.started(s.api, first, "synthetic-vm");
    await advance(100_000);
    // A lower allowance in a different period is NOT consumption of this hold.
    s.set(modern({ planIncluded: included(300, END + 30 * 86_400_000) }));
    const recovered = new AccountLedger(s.state, "included-budget-test", Date.now);
    await expect(recovered.reserve(s.api, request)).rejects.toThrow();
  });

  it("reflects actual included consumption only within the same period", async () => {
    const s = setup(modern({ planIncluded: included(500) }));
    const first = await s.ledger.reserve(s.api, request);
    await s.ledger.started(s.api, first, "synthetic-vm");
    await advance(100_000);
    s.set(modern({ planIncluded: included(300) }));
    await expect(s.ledger.reserve(s.api, request)).resolves.toHaveProperty("id");
  });

  it("does not reuse a legacy cached observation without included provenance", async () => {
    const s = setup();
    await s.ledger.reserve(s.api, request);
    for (const [key, json] of s.state.rows) {
      const doc = JSON.parse(json); delete doc.observation.periodEndMs;
      s.state.rows.set(key, JSON.stringify(doc));
    }
    s.set(modern({ planIncluded: undefined }));
    await expect(s.ledger.reserve(s.api, { ...request, allowCachedLimits: true })).rejects.toThrow();
  });

  it.each([200, 276])("checks prospective replay lifetime separately from elapsed exposure at t=%s", async (elapsed) => {
    const s = setup(modern({ planIncluded: included(90_000, EPOCH + 500_000) }));
    const req = { ...request, jobSeconds: 210 };
    const reservation = await s.ledger.reserve(s.api, req);
    await s.ledger.failed(reservation, false);
    await advance(elapsed * 1000);
    const recovered = new AccountLedger(s.state, "included-budget-test", Date.now);
    const replay = recovered.revalidateReplay(s.api, reservation, req, 225);
    if (elapsed === 200) {
      await expect(replay).resolves.toBeUndefined();
      const doc = JSON.parse([...s.state.rows.values()][0]!);
      expect(doc.intents[0]).toMatchObject({ ttlSeconds: 425, compute: 425, jobSeconds: 410 });
    } else {
      await expect(replay).rejects.toThrow();
      const doc = JSON.parse([...s.state.rows.values()][0]!);
      expect(doc.intents[0]).toMatchObject({ ttlSeconds: 225, compute: 225 });
    }
  });

  it("renews the durable envelope when reservation persistence itself is slow", async () => {
    const s = setup();
    let delayed = false;
    s.state.beforeWrite = async () => { if (!delayed) { delayed = true; await advance(830_000); } };
    const reservation = await s.ledger.reserve(s.api, { ...request, jobSeconds: 210 });
    await s.ledger.failed(reservation, false);
    expect(JSON.parse([...s.state.rows.values()][0]!).intents[0])
      .toMatchObject({ ttlSeconds: 1055, jobSeconds: 1040, compute: 1055 });
    await expect(s.ledger.recoverCreate(reservation)).resolves.toEqual({ status: "pending" });
  });

  it("renews the durable dispatch envelope after caller persistence, including restart", async () => {
    const s = setup();
    const req = { ...request, jobSeconds: 210 };
    const reservation = await s.ledger.reserve(s.api, req);
    await advance(830_000);
    await s.ledger.revalidate(s.api, reservation, req);
    await s.ledger.failed(reservation, false);
    const recovered = new AccountLedger(s.state, "included-budget-test", Date.now);
    await expect(recovered.recoverCreate(reservation)).resolves.toEqual({ status: "pending" });
    const doc = JSON.parse([...s.state.rows.values()][0]!);
    expect(doc.intents[0]).toMatchObject({ ttlSeconds: 1055, compute: 1055 });
  });

  it.each(["freshness", "period"] as const)("rolls back a never-attempted replay extension after %s refusal", async (failure) => {
    const s = setup(modern({ planIncluded: included(90_000, failure === "period" ? EPOCH + 500_000 : END) }));
    const req = { ...request, jobSeconds: 210 };
    const reservation = await s.ledger.reserve(s.api, req);
    await s.ledger.failed(reservation, false);
    const before = JSON.parse([...s.state.rows.values()][0]!).intents[0];
    await advance(failure === "period" ? 274_000 : 200_000);
    let delayed = false;
    s.state.beforeWrite = async () => { if (!delayed) { delayed = true; await advance(6_000); } };
    await expect(s.ledger.revalidateReplay(s.api, reservation, req, 225)).rejects.toThrow();
    const intent = JSON.parse([...s.state.rows.values()][0]!).intents[0];
    expect(intent).toEqual(before);
  });

  it("retains renewed replay holds after an actually attempted lost reply", async () => {
    const s = setup();
    const req = { ...request, jobSeconds: 210 };
    const reservation = await s.ledger.reserve(s.api, req);
    await s.ledger.failed(reservation, false);
    await advance(200_000);
    await s.ledger.revalidateReplay(s.api, reservation, req, 225);
    await s.ledger.failed(reservation, false);
    expect(JSON.parse([...s.state.rows.values()][0]!).intents[0])
      .toMatchObject({ status: "ambiguous", ttlSeconds: 425, jobSeconds: 410, compute: 425 });
  });

  it("keeps conservative saved replay holds when rollback persistence fails", async () => {
    const s = setup();
    const req = { ...request, jobSeconds: 210 };
    const reservation = await s.ledger.reserve(s.api, req);
    await s.ledger.failed(reservation, false);
    await advance(200_000);
    s.state.beforeWrite = async () => {
      await advance(6_000);
      s.state.failWrites = true;
    };
    await expect(s.ledger.revalidateReplay(s.api, reservation, req, 225)).rejects.toThrow();
    expect(JSON.parse([...s.state.rows.values()][0]!).intents[0])
      .toMatchObject({ status: "ambiguous", ttlSeconds: 425, jobSeconds: 410, compute: 425 });
  });

  it("restores a predecessor tail on definitive pre-effect warm refusal", async () => {
    const s = setup();
    const req = { ...request, poolId: "warm-pool", command: { commandId: "first", runId: "r", cardId: "c", repoId: "repo" } };
    const first = await s.ledger.reserve(s.api, req);
    await s.ledger.started(s.api, first, "synthetic-vm");
    await s.ledger.finished(first, false);
    const before = JSON.parse([...s.state.rows.values()][0]!);
    await advance(2_000);
    const next = await s.ledger.reserve(s.api, { ...req, operation: "warm", sandboxId: "synthetic-vm", command: { ...req.command, commandId: "next" } });
    await s.ledger.failed(next, true);
    const after = JSON.parse([...s.state.rows.values()][0]!);
    expect(after.intents[0]).toEqual(before.intents[0]);
    expect(after.usage[0]).toEqual(before.usage[0]);
  });

  it("retains cumulative replay exposure when checking included capacity", async () => {
    const s = setup(modern({ planIncluded: included(400, EPOCH + 500_000) }));
    const req = { ...request, jobSeconds: 210 };
    const reservation = await s.ledger.reserve(s.api, req);
    await s.ledger.failed(reservation, false);
    await advance(200_000);
    await expect(s.ledger.revalidateReplay(s.api, reservation, req, 225)).rejects.toThrow();
  });

  it("keeps the original tail when a metered resume cannot fit the included period", async () => {
    const s = setup(modern({ planIncluded: included(90_000, EPOCH + 200_000) }));
    const reservation = await s.ledger.reserve(s.api, { ...request, operation: "resume", poolId: "resume-pool" });
    s.set(modern({ planIncluded: included(90_000, EPOCH + 200_000), starts: starts(1) }));
    expect(await s.ledger.started(s.api, reservation, "synthetic-vm")).toBe(15);
  });

  it("refuses if persistence consumes the remaining lifetime headroom", async () => {
    const s = setup(modern({ planIncluded: included(90_000, EPOCH + 166_000) }));
    s.state.beforeWrite = async () => { await advance(2_000); };
    await expect(s.ledger.reserve(s.api, request)).rejects.toThrow();
    const doc = JSON.parse([...s.state.rows.values()][0]!);
    expect(doc.intents).toHaveLength(0);
  });

  it("refuses dispatch when caller persistence consumes lifetime headroom", async () => {
    const { ledger, api } = setup(modern({ planIncluded: included(90_000, EPOCH + 166_000) }));
    const reservation = await ledger.reserve(api, request);
    await advance(2_000);
    expect(() => ledger.assertDispatchable(reservation, 165)).toThrow();
  });

  it("does not fund work beyond the known included period, including cached limits", async () => {
    const { ledger, api } = setup(modern({ planIncluded: included(90_000, EPOCH + 168_000) }));
    await ledger.reserve(api, request);
    await advance(4_000);
    await expect(ledger.reserve(api, { ...request, allowCachedLimits: true })).rejects.toThrow();
  });
});

describe("post-admission persistence boundaries", () => {
  it.each([false, true])("keeps a newly effective lost create fenced after an 830-second pool save (restart=%s)", async (reload) => {
    const f = fixture();
    try {
      f.boat.limitsResponse = modern();
      const set = f.state.set.bind(f.state);
      let delayed = false;
      f.state.set = async (key, value) => {
        if (!delayed && key.namespace === "boat-offload-pool") {
          delayed = true;
          await advance(830_000);
        }
        await set(key, value);
      };
      const p = f.pool("pool-a", { maxOffloadVms: 1, maxActive: 3 });
      (p as unknown as { poolStore: OffloadPoolStore }).poolStore = new OffloadPoolStore(f.state, f.accountId, "pool-a");
      const create = f.boat.create.bind(f.boat);
      f.boat.create = async (args) => { await create(args); throw new Error("lost reply after effect"); };
      safeRefusal(await p.execute(command("aged-create", { timeoutMs: 120_000, executionWorkspaceId: "workspace-a" })));
      f.boat.create = create;
      const next = reload ? f.pool("pool-a", { maxOffloadVms: 1, maxActive: 3 }) : p;
      if (reload) (next as unknown as { poolStore: OffloadPoolStore }).poolStore = new OffloadPoolStore(f.state, f.accountId, "pool-a");
      safeRefusal(await next.execute(command("other-workspace", { executionWorkspaceId: "workspace-b" })));
      expect(f.boat.callsOf("create")).toHaveLength(1);
      expect(f.boat.boxes.size).toBe(1);
      const doc = JSON.parse([...f.state.rows].find(([key]) => key.includes("boat-account"))![1]);
      expect(doc.intents[0]).toMatchObject({ status: "ambiguous", active: true, ttlSeconds: 1055 });
    } finally { await f.close(); }
  });

  it.each([
    ["exhausted", { planIncluded: included(0) }],
    ["paid", { nextStartDollars: 0.01 }],
    ["active-full", { activeSandboxes: 100 }],
    ["size-unavailable", { machineTypes: [{ type: "default", available: false }] }],
    ["funded", {}],
  ] as const)("revalidates %s capacity after slow caller pool persistence", async (name, overrides) => {
    const f = fixture();
    try {
      f.boat.limitsResponse = modern();
      const set = f.state.set.bind(f.state);
      let delayed = false;
      f.state.set = async (key, value) => {
        if (!delayed && key.namespace === "boat-offload-pool") {
          delayed = true;
          await advance(6000);
          f.boat.limitsResponse = modern(overrides);
        }
        await set(key, value);
      };
      const p = f.pool();
      (p as unknown as { poolStore: OffloadPoolStore }).poolStore = new OffloadPoolStore(f.state, f.accountId, "pool-a");
      const result = await p.execute(command(`slow-save-${name}`));
      expect(delayed).toBe(true);
      if (name === "funded") {
        expect(result).toMatchObject({ status: "completed" });
        expect(f.boat.callsOf("create")).toHaveLength(1);
      } else {
        safeRefusal(result);
        noDispatch(f);
        expect(f.boat.callsOf("fork")).toHaveLength(0);
        expect(f.boat.callsOf("update")).toHaveLength(0);
        const doc = JSON.parse([...f.state.rows].find(([key]) => key.includes("boat-account"))![1]);
        expect(doc.intents).toHaveLength(1);
        expect(doc.intents[0]).toMatchObject({ status: "rejected", active: false });
      }
    } finally { await f.close(); }
  });

  it("keeps the funded command when persistence consumes optional resume-tail headroom", async () => {
    const f = fixture();
    try {
      const p = f.pool();
      await p.execute(command("seed"));
      await advance(15_000);
      const periodEnd = Date.now() + 451_000;
      f.boat.limitsResponse = modern({ planIncluded: included(90_000, periodEnd), starts: starts(1) });
      const resume = f.boat.resume.bind(f.boat);
      f.boat.resume = async (args) => {
        const result = await resume(args);
        f.boat.limitsResponse = modern({ planIncluded: included(90_000, periodEnd), starts: starts(2) });
        f.state.beforeWrite = async () => { f.state.beforeWrite = undefined; await advance(2_000); };
        return result;
      };
      expect(await p.execute(command("short-tail-resume"))).toMatchObject({ status: "completed" });
      expect(f.executions).toEqual(["seed", "short-tail-resume"]);
      expect(f.boat.callsOf("update")).toHaveLength(0);
      await advance(15_000);
      expect(f.boat.callsOf("stop")).toHaveLength(2);
      const doc = JSON.parse([...f.state.rows.values()][0]!);
      expect(doc.intents.find((i: { operation: string }) => i.operation === "resume").tailSeconds).toBe(15);
    } finally { await f.close(); }
  });
});

describe("never-started fallback contract", () => {
  it.each([modern({ planIncluded: included(0) }), modern({ planIncluded: undefined }), modern({ nextStartDollars: 0.01 })])(
    "returns a verified never-started refusal, not execution uncertainty", async (raw) => {
      const f = fixture();
      try {
        f.boat.limitsResponse = raw;
        safeRefusal(await f.pool().execute(command("included-refused")));
        noDispatch(f);
      } finally { await f.close(); }
    });
});
