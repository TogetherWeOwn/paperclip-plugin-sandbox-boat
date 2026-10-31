import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLedger } from "./account-ledger.js";
import type { StateClientLike } from "./state.js";
import { EPOCH, advance, command, fixture, providerMeter, reconcile, usage } from "./test-support/account-admission.fixture.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });

function memState(): StateClientLike & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  const key = (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) =>
    JSON.stringify([input.scopeKind, input.scopeId ?? null, input.namespace ?? null, input.stateKey]);
  const state: StateClientLike & { rows: Map<string, unknown> } = {
    rows,
    get: async (input) => structuredClone(rows.get(key(input)) ?? null),
    set: async (input, value) => { rows.set(key(input), structuredClone(value)); },
    delete: async (input) => { rows.delete(key(input)); },
  };
  return state;
}

describe("monthVmSeconds", () => {
  it("sums only this company's intervals in the current UTC month", async () => {
    const state = memState();
    const ledger = new AccountLedger(state, "acct", () => EPOCH);
    const monthStart = Date.UTC(2026, 9, 1); // October 2026
    const doc = {
      version: 1,
      observation: null,
      intents: [],
      countedResumeUntil: null,
      usage: [
        {
          usageRecordId: "a", poolId: "p", kind: "command", commandId: "a", runId: "r", cardId: "c",
          repoId: "repo", sandboxId: "vm-1", seconds: 0, dollars: 0, meterProvenance: "provider",
          observedStartsDelta: null, intervals: [
            { since: new Date(monthStart - 3_600_000).toISOString(), until: new Date(monthStart + 3_600_000).toISOString(), phase: "command" },
          ],
          tailSince: null,
          companyId: "co-1",
        },
        {
          usageRecordId: "b", poolId: "p", kind: "command", commandId: "b", runId: "r", cardId: "c",
          repoId: "repo", sandboxId: "vm-2", seconds: 0, dollars: 0, meterProvenance: "provider",
          observedStartsDelta: null, intervals: [
            { since: new Date(monthStart + 7_200_000).toISOString(), until: new Date(monthStart + 10_800_000).toISOString(), phase: "command" },
          ],
          tailSince: monthStart + 10_800_000,
          companyId: "co-1",
        },
        {
          usageRecordId: "c", poolId: "p", kind: "command", commandId: "c", runId: "r", cardId: "c",
          repoId: "repo", sandboxId: "vm-3", seconds: 0, dollars: 0, meterProvenance: "provider",
          observedStartsDelta: null, intervals: [],
          tailSince: null,
          companyId: "other",
        },
      ],
    };
    // The ledger keys state by sha256(accountId).
    const hashed = (await import("node:crypto")).createHash("sha256").update("acct").digest("hex");
    await state.set({ scopeKind: "instance", namespace: "boat-account", stateKey: hashed }, doc);
    // EPOCH is 2026-10-23, inside the same month; the open tail counts to now.
    const seconds = await ledger.monthVmSeconds("co-1", EPOCH);
    // Interval 1 clamps to the month (1h) + interval 2 (1h) + open tail (EPOCH - (monthStart+3h)).
    expect(seconds).toBeCloseTo(7_200 + (EPOCH - (monthStart + 10_800_000)) / 1000, 3);
    expect(await ledger.monthVmSeconds("other", EPOCH)).toBe(0);
  });

  it("fails closed when the journal is unreadable", async () => {
    const state = memState();
    const hashed = (await import("node:crypto")).createHash("sha256").update("acct").digest("hex");
    await state.set({ scopeKind: "instance", namespace: "boat-account", stateKey: hashed }, { version: 999 });
    const ledger = new AccountLedger(state, "acct", () => EPOCH);
    await expect(ledger.monthVmSeconds("co-1", EPOCH)).rejects.toThrow();
  });

  it("refuses admission atomically when the monthly cap is reached", async () => {
    const state = memState();
    const hashed = (await import("node:crypto")).createHash("sha256").update("acct").digest("hex");
    const monthStart = Date.UTC(2026, 9, 1);
    await state.set({ scopeKind: "instance", namespace: "boat-account", stateKey: hashed }, {
      version: 1, observation: null, intents: [], countedResumeUntil: null,
      usage: [{ usageRecordId: "a", poolId: "p", kind: "command", commandId: "a", runId: "r", cardId: "c",
        repoId: "repo", sandboxId: "vm-1", seconds: 0, dollars: 0, meterProvenance: "provider",
        observedStartsDelta: null, intervals: [
          { since: new Date(monthStart).toISOString(), until: new Date(monthStart + 3_600_000).toISOString(), phase: "command" },
        ], tailSince: null, companyId: "co-1" }],
    });
    const ledger = new AccountLedger(state, "acct", () => EPOCH);
    const api = { limits: async () => { throw new Error("no provider in unit test"); } } as never;
    await expect(ledger.reserve(api, { operation: "create", size: "default", jobSeconds: 60, tailSeconds: 0,
      maxActive: 10, maxStartsPerDay: 100, minComputeHoursLeft: 0,
      monthlyCap: { companyId: "co-1", nowMs: EPOCH, capHours: 0.5 } })).rejects.toThrow(/monthly offload VM-hour cap/);
  });
});

describe("monthly cap counts pending reservations", () => {
  it("refuses when settled usage is under the cap but an unsettled reservation would cross it", async () => {
    const state = memState();
    const hashed = (await import("node:crypto")).createHash("sha256").update("acct").digest("hex");
    const monthStart = Date.UTC(2026, 9, 1);
    await state.set({ scopeKind: "instance", namespace: "boat-account", stateKey: hashed }, {
      version: 1, observation: null, countedResumeUntil: null,
      intents: [{ intentId: "pending-1", status: "reserved", settledAt: null, usageId: "pending-1", jobSeconds: 3_000, tailSeconds: 600,
        operation: "create", size: "default", createdAt: new Date(EPOCH).toISOString() }],
      usage: [{ usageRecordId: "a", poolId: "p", kind: "command", commandId: "a", runId: "r", cardId: "c",
        repoId: "repo", sandboxId: "vm-1", seconds: 0, dollars: 0, meterProvenance: "provider",
        observedStartsDelta: null, intervals: [
          { since: new Date(monthStart).toISOString(), until: new Date(monthStart + 1_800_000).toISOString(), phase: "command" },
        ], tailSince: null, companyId: "co-1" },
      { usageRecordId: "pending-1", poolId: "p", kind: "command", commandId: "pending-1", runId: "r", cardId: "c",
        repoId: "repo", sandboxId: null, seconds: 0, dollars: 0, meterProvenance: "pending",
        observedStartsDelta: null, intervals: [], tailSince: null, companyId: "co-1" }],
    });
    const ledger = new AccountLedger(state, "acct", () => EPOCH);
    const api = { limits: async () => { throw new Error("no provider in unit test"); } } as never;
    // 0.5 h settled + 1 h pending >= 1 h cap. Without the pending count the call passes the cap and fails on the provider read instead.
    await expect(ledger.reserve(api, { operation: "create", size: "default", jobSeconds: 60, tailSeconds: 0,
      maxActive: 10, maxStartsPerDay: 100, minComputeHoursLeft: 0,
      monthlyCap: { companyId: "co-1", nowMs: EPOCH, capHours: 1 } })).rejects.toThrow(/monthly offload VM-hour cap/);
  });
});

describe("monthly cap counts running commands", () => {
  it("refuses a second command while the first is running near the cap, and counts it once after it finishes", async () => {
    const ledger = new AccountLedger(f.state, f.accountId, () => Date.now());
    const api = f.boat as never;
    const request = (id: string, jobSeconds: number) => ({ operation: "create" as const, size: "default" as const, jobSeconds, tailSeconds: 600,
      maxActive: 10, maxStartsPerDay: 70, minComputeHoursLeft: 0, poolId: "cap-running",
      command: { commandId: id, runId: `run-${id}`, cardId: "card", repoId: "repo", companyId: "co-1" },
      monthlyCap: { companyId: "co-1", nowMs: Date.now(), capHours: 1 } });
    // 3000 s job + 600 s tail: the first command's envelope reaches the 1 h cap.
    const first = await ledger.reserve(api, request("first", 3_000));
    await ledger.started(api, first, "vm-running");
    await expect(ledger.reserve(api, request("second", 60))).rejects.toThrow(/monthly offload VM-hour cap/);
    await advance(60_000);
    await ledger.finished(first, false);
    // Finished: only the recorded interval and open tail count, not the envelope as well.
    await expect(ledger.reserve(api, { ...request("third", 60), monthlyCap: { companyId: "co-1", nowMs: Date.now(), capHours: 1 } }))
      .resolves.toMatchObject({ id: expect.any(String) });
  });
});

describe("offloadMonthlyVmHourCap", () => {
  it("keeps commands local once the month's tracked VM-hours reach the cap", async () => {
    const p = f.pool("cap-a", {}, async () => ({ exitCode: 0, seconds: 60 }));
    providerMeter(f, 3_600, 0.036, { running: true });
    await p.execute(command("seed"));
    await reconcile(p);
    const rows = usage(p).filter((r) => r.kind === "command");
    expect(rows.length).toBeGreaterThan(0);
    // Let an hour of VM time accumulate on the open tail before capping.
    await advance(3_600_000);
    // A new pool on the same account sees the same month-to-date usage.
    const capped = f.pool("cap-b", { offloadMonthlyVmHourCap: 0.002 }, async () => ({ exitCode: 0, seconds: 60 }));
    const result = await capped.execute(command("blocked"));
    expect(result.status).toBe("unavailable");
    expect(f.executions).not.toContain("blocked");
    // Without the cap the same command dispatches.
    const open = f.pool("cap-c", {}, async () => ({ exitCode: 0, seconds: 1 }));
    const ok = await open.execute(command("allowed"));
    expect(ok.status).toBe("completed");
    expect(f.executions).toContain("allowed");
  });

  it("normalizes the cap setting", async () => {
    const { normalizeOffloadSettings } = await import("./offload/routes.js");
    expect(normalizeOffloadSettings({ offloadMonthlyVmHourCap: 5 }).offloadMonthlyVmHourCap).toBe(5);
    expect(normalizeOffloadSettings({ offloadMonthlyVmHourCap: -1 }).offloadMonthlyVmHourCap).toBe(0);
    expect(normalizeOffloadSettings({}).offloadMonthlyVmHourCap).toBe(0);
  });
});
