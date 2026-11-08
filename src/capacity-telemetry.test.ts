import { describe, expect, it } from "vitest";
import {
  CapacityTelemetry, MAX_ACCOUNTS, STALE_AFTER_MS, MAX_SAMPLES, parseLimits, startPressureReasons,
} from "./capacity-telemetry.js";
import type { StateClientLike } from "./state.js";

const MIN = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const END = T0 + 22 * DAY; // 15 days left at T0 + 7d
const CO = "co-1", ACCT = "acct-secret-key";

type MemState = StateClientLike & { rows: Map<string, unknown>; failSet: boolean; failGet: boolean };
function memState(): MemState {
  const rows = new Map<string, unknown>();
  const key = (i: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) =>
    JSON.stringify([i.scopeKind, i.scopeId ?? null, i.namespace ?? null, i.stateKey]);
  const s: MemState = {
    rows, failSet: false, failGet: false,
    get: async (i: Parameters<StateClientLike["get"]>[0]) => {
      if (s.failGet) throw new Error("get down");
      return structuredClone(rows.get(key(i)) ?? null);
    },
    set: async (i: Parameters<StateClientLike["set"]>[0], v: unknown) => {
      if (s.failSet) throw new Error("set down");
      rows.set(key(i), structuredClone(v));
    },
    delete: async (i: Parameters<StateClientLike["delete"]>[0]) => { rows.delete(key(i)); },
  };
  return s;
}

interface Over {
  end?: number; total?: number; rem?: number; day?: [number, number]; hour?: [number, number]; minute?: [number, number];
  active?: number; max?: number; canStart?: boolean; unlimited?: boolean;
}
function win([used, limit]: [number, number]) { return { used, limit, remaining: Math.max(0, limit - used) }; }
function payload(o: Over = {}) {
  return {
    ok: true,
    planIncluded: { periodEnd: new Date(o.end ?? END).toISOString(), vmHours: o.total ?? 555.56, vmHoursRemaining: o.rem ?? 552 },
    starts: { unlimited: o.unlimited ?? false, minute: win(o.minute ?? [0, 12]), hour: win(o.hour ?? [0, 60]), day: win(o.day ?? [23, 200]) },
    activeSandboxes: o.active ?? 0, maxActiveSandboxes: o.max ?? 100, canStart: o.canStart ?? true, nextStartDollars: 0,
  };
}

/** Sample at T0 (rem 500), T0+6d (400), T0+7d (cur): 24h burn 20, 7d avg (500-cur)/7. */
async function seeded(t: CapacityTelemetry, cur: number, end = END) {
  await t.sample(CO, ACCT, payload({ rem: 500, end }), T0);
  await t.sample(CO, ACCT, payload({ rem: 400, end }), T0 + 6 * DAY);
  return t.sample(CO, ACCT, payload({ rem: cur, end }), T0 + 7 * DAY);
}

describe("parseLimits", () => {
  it("parses the real flat payload and ignores legacy credit fields", () => {
    const r = parseLimits({ ...payload(), credits: 20, creditsRemaining: 0, upgradeCredits: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.limits.vmHoursRemaining).toBe(552);
      expect(r.limits.starts?.day).toEqual({ used: 23, limit: 200, remaining: 177 });
      expect(r.limits.periodEndMs).toBe(END);
    }
  });

  it("accepts a Date periodEnd as decoded by the SDK, and rejects an invalid Date", () => {
    const withEnd = (periodEnd: unknown) => ({ ...payload(), planIncluded: { ...payload().planIncluded, periodEnd } });
    const ok = parseLimits(withEnd(new Date(END)));
    expect(ok.ok && ok.limits.periodEndMs).toBe(END);
    expect(parseLimits(withEnd(new Date(NaN))).ok).toBe(false);
  });

  it("accepts legacy _package and upgradeEffects nesting", () => {
    expect(parseLimits({ _package: payload() }).ok).toBe(true);
    expect(parseLimits({ upgradeEffects: payload() }).ok).toBe(true);
  });

  it("resolves fields independently across flat, upgradeEffects and _package like budget/account-ledger", () => {
    const p = payload();
    const mixed = parseLimits({
      ok: true,
      planIncluded: p.planIncluded,
      upgradeEffects: { starts: p.starts },
      _package: { activeSandboxes: 3, maxActiveSandboxes: 100, canStart: false },
    });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.limits.starts?.day.limit).toBe(200);
      expect(mixed.limits.activeSandboxes).toBe(3);
      expect(mixed.limits.canStart).toBe(false);
    }
    const pkgOnly = parseLimits({ ok: true, upgradeEffects: { planIncluded: p.planIncluded }, _package: { starts: p.starts, activeSandboxes: 0, maxActiveSandboxes: 1 } });
    expect(pkgOnly.ok).toBe(true);
  });

  it("a present invalid higher-precedence field is not replaced by a lower valid one", () => {
    const p = payload();
    expect(parseLimits({ ...p, planIncluded: "bad", upgradeEffects: { planIncluded: p.planIncluded } }).ok).toBe(false);
    expect(parseLimits({ ...p, activeSandboxes: "x", upgradeEffects: { activeSandboxes: 0 } }).ok).toBe(false);
    expect(parseLimits({ ...p, canStart: "yes", _package: { canStart: true } }).ok).toBe(false);
    expect(parseLimits({ ...p, starts: "bad", upgradeEffects: { starts: p.starts } }).ok).toBe(false);
  });

  it("accepts unlimited starts without windows", () => {
    const p = payload({ unlimited: true }) as Record<string, unknown>;
    p.starts = { unlimited: true };
    const r = parseLimits(p);
    expect(r.ok && r.limits.starts).toBe(null);
  });

  it.each([
    ["null", null], ["array", []], ["string", "x"], ["ok false", { ...payload(), ok: false }],
    ["no plan", { ok: true, starts: payload().starts }],
    ["NaN hours", payload({ rem: NaN })], ["Infinity", payload({ total: Infinity })],
    ["negative", payload({ rem: -1 })], ["remaining > total", payload({ rem: 600 })],
    ["huge", payload({ total: 1e12, rem: 1 })],
    ["bad date", { ...payload(), planIncluded: { ...payload().planIncluded, periodEnd: "soon" } }],
    ["numeric date", { ...payload(), planIncluded: { ...payload().planIncluded, periodEnd: 5 } }],
    ["string hours", { ...payload(), planIncluded: { ...payload().planIncluded, vmHours: "555" } }],
    ["no starts", { ...payload(), starts: undefined }],
    ["missing window", { ...payload(), starts: { unlimited: false, minute: win([0, 1]) } }],
    ["bad window", { ...payload(), starts: { ...payload().starts, hour: { used: "x", limit: 1, remaining: 1 } } }],
    ["no active", { ...payload(), activeSandboxes: undefined }],
    ["bad canStart", { ...payload(), canStart: "yes" }],
  ])("rejects %s", (_n, raw) => {
    expect(parseLimits(raw).ok).toBe(false);
  });
});

describe("startPressureReasons", () => {
  const reasons = (o: Over) => {
    const r = parseLimits(payload(o));
    if (!r.ok) throw new Error("bad fixture");
    return startPressureReasons(r.limits);
  };
  it("flags exactly 80% and above, not below", () => {
    expect(reasons({ day: [160, 200] })).toEqual(["start_day_pressure"]);
    expect(reasons({ day: [159, 200] })).toEqual([]);
    expect(reasons({ minute: [10, 12], hour: [48, 60] })).toEqual(["start_minute_pressure", "start_hour_pressure"]);
    expect(reasons({ active: 80 })).toEqual(["active_sandboxes_pressure"]);
    expect(reasons({ active: 79 })).toEqual([]);
  });
  it("handles zero caps without NaN and reports blocked starts", () => {
    expect(reasons({ day: [0, 0], active: 0, max: 0 })).toEqual([]);
    expect(reasons({ canStart: false })).toEqual(["cannot_start"]);
  });
  it("ignores starts when unlimited", () => {
    const r = parseLimits({ ...payload(), starts: { unlimited: true } });
    expect(r.ok && startPressureReasons(r.limits)).toEqual([]);
  });
});

describe("CapacityTelemetry forecast", () => {
  it("first sample is insufficient, never an all-clear claim", async () => {
    const t = new CapacityTelemetry(memState());
    const r = await t.sample(CO, ACCT, payload(), T0);
    expect(r.status).toBe("insufficient");
    expect(r.reasons).toContain("insufficient_history");
    expect(r.warning).toBe(false);
    expect(r.forecast).toMatchObject({ status: "insufficient_history", burn24hHours: null, avg7dDailyHours: null, exceeds: null, projectedHours: null });
    expect(r.observedAt).toBe(new Date(T0).toISOString());
    expect(r.coverageMs).toBe(0);
    expect(r.plan?.vmHoursRemaining).toBe(552);
  });

  it("24h-only history may warn but stays insufficient", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 400 }), T0);
    const r = await t.sample(CO, ACCT, payload({ rem: 300 }), T0 + DAY);
    expect(r.status).toBe("insufficient");
    expect(r.forecast).toMatchObject({ burn24hHours: 100, avg7dDailyHours: null });
    expect(r.warningReasons).toEqual(["vm_hours_forecast"]);
    expect(r.coverageMs).toBe(DAY);
  });

  it("24h-only history that fits does not claim healthy", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 400 }), T0);
    const r = await t.sample(CO, ACCT, payload({ rem: 399 }), T0 + DAY);
    expect(r.warning).toBe(false);
    expect(r.status).toBe("insufficient");
  });

  it("full history is fresh and uses the max of 24h burn and 7d average", async () => {
    const t = new CapacityTelemetry(memState());
    const r = await seeded(t, 380);
    expect(r.status).toBe("fresh");
    expect(r.forecast?.burn24hHours).toBe(20);
    expect(r.forecast?.avg7dDailyHours).toBeCloseTo(120 / 7, 9);
    expect(r.forecast?.daysRemaining).toBe(15);
    expect(r.forecast?.thresholdHours).toBe(375);
    expect(r.forecast?.projectedHours).toBe(375);
    expect(r.coverageMs).toBe(7 * DAY);
  });

  it("equality is not a warning; strictly greater is", async () => {
    const eq = await seeded(new CapacityTelemetry(memState()), 380);
    expect(eq.forecast?.exceeds).toBe(false);
    expect(eq.warning).toBe(false);
    // One more hour of remaining time pushes the projection past the threshold.
    const gt = await seeded(new CapacityTelemetry(memState()), 380, END + HOUR);
    expect(gt.forecast?.exceeds).toBe(true);
    expect(gt.warningReasons).toEqual(["vm_hours_forecast"]);
  });

  it("uses the 7d average when it exceeds the 24h burn", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 500 }), T0);
    await t.sample(CO, ACCT, payload({ rem: 100 }), T0 + 6 * DAY);
    const r = await t.sample(CO, ACCT, payload({ rem: 99 }), T0 + 7 * DAY);
    expect(r.forecast?.burn24hHours).toBe(1);
    expect(r.forecast?.projectedHours).toBeCloseTo(1.25 * (401 / 7) * 15, 9);
    expect(r.warning).toBe(true); // 1.25*57.29*15 = 1074 > 94
  });

  it("low remaining hours warn on the very first sample, without burn history", async () => {
    const t = new CapacityTelemetry(memState());
    const r = await t.sample(CO, ACCT, payload({ rem: 4 }), T0);
    expect(r.status).toBe("insufficient");
    expect(r.forecast).toMatchObject({ thresholdHours: -1, projectedHours: null });
    expect(r.warningReasons).toEqual(["vm_hours_forecast"]);
    expect(r.warning).toBe(true);
    expect(r.shouldNotify).toBe(true);
    // Exactly at the reserve is not below it.
    const eq = await new CapacityTelemetry(memState()).sample(CO, ACCT, payload({ rem: 5 }), T0);
    expect(eq.warning).toBe(false);
  });

  it("low remaining hours warn with genuinely zero burn history", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 4 }), T0);
    const r = await t.sample(CO, ACCT, payload({ rem: 4 }), T0 + DAY);
    expect(r.forecast).toMatchObject({ burn24hHours: 0, thresholdHours: -1 });
    expect(r.warning).toBe(true);
  });

  it("a 7d-only rate can prove the forecast exceeds the threshold without a 24h baseline", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 500 }), T0);
    // No sample near T0+6d, so no 24h baseline at T0+7d.
    const r = await t.sample(CO, ACCT, payload({ rem: 100 }), T0 + 7 * DAY);
    expect(r.status).toBe("insufficient");
    expect(r.reasons).toContain("insufficient_history");
    expect(r.forecast).toMatchObject({ status: "insufficient_history", burn24hHours: null, exceeds: true });
    expect(r.forecast?.projectedHours).toBeCloseTo(1.25 * (400 / 7) * 15, 9);
    expect(r.warningReasons).toEqual(["vm_hours_forecast"]);
  });

  it("a 7d-only rate that fits does not claim healthy", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 500 }), T0);
    const r = await t.sample(CO, ACCT, payload({ rem: 499 }), T0 + 7 * DAY);
    expect(r.forecast?.exceeds).toBe(null);
    expect(r.warning).toBe(false);
    expect(r.status).toBe("insufficient");
  });

  it("does not use a baseline outside the 15 minute tolerance", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 400 }), T0 - 16 * MIN);
    const stale = await t.sample(CO, ACCT, payload({ rem: 300 }), T0 + DAY);
    expect(stale.forecast?.burn24hHours).toBe(null);
    const t2 = new CapacityTelemetry(memState());
    await t2.sample(CO, ACCT, payload({ rem: 400 }), T0 - 15 * MIN);
    const ok = await t2.sample(CO, ACCT, payload({ rem: 300 }), T0 + DAY);
    expect(ok.forecast?.burn24hHours).toBe(100);
  });

  it("does not use a baseline after the target (no extrapolation)", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 400 }), T0 + 10 * MIN);
    const r = await t.sample(CO, ACCT, payload({ rem: 300 }), T0 + DAY);
    expect(r.forecast?.burn24hHours).toBe(null);
  });

  it("resets history on plan renewal", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 400 }), T0);
    const r = await t.sample(CO, ACCT, payload({ rem: 555, end: END + 30 * DAY }), T0 + DAY);
    expect(r.status).toBe("insufficient");
    expect(r.forecast?.burn24hHours).toBe(null);
    expect(r.coverageMs).toBe(0);
  });

  it("resets on a different total vmHours", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 400 }), T0);
    const r = await t.sample(CO, ACCT, payload({ rem: 399, total: 1000 }), T0 + DAY);
    expect(r.forecast?.burn24hHours).toBe(null);
  });

  it("resets when the balance increases (top-up or correction)", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 300 }), T0);
    const up = await t.sample(CO, ACCT, payload({ rem: 400 }), T0 + DAY);
    expect(up.forecast?.burn24hHours).toBe(null); // no negative or zero claim
    expect(up.coverageMs).toBe(0);
    const next = await t.sample(CO, ACCT, payload({ rem: 390 }), T0 + 2 * DAY);
    expect(next.forecast?.burn24hHours).toBe(10); // measured only from the post-reset reading
  });

  it("drops history older than 8 days", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    await t.sample(CO, ACCT, payload({ rem: 500 }), T0);
    const r = await t.sample(CO, ACCT, payload({ rem: 400 }), T0 + 9 * DAY);
    expect(r.coverageMs).toBe(0);
    expect(r.forecast?.avg7dDailyHours).toBe(null);
  });

  it("spaced samples under the minimum spacing are reported but not stored", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    await t.sample(CO, ACCT, payload(), T0);
    const r = await t.sample(CO, ACCT, payload(), T0 + MIN);
    expect(r.status).toBe("insufficient");
    expect(storedSamples(state)).toBe(1);
  });

  it("sees a 7 day baseline at 5 minute cadence", async () => {
    const t = new CapacityTelemetry(memState());
    let last;
    for (let i = 0; i < 2100; i++) last = await t.sample(CO, ACCT, payload({ rem: 552 - i * 0.01 }), T0 + i * 5 * MIN);
    expect(last?.status).toBe("fresh");
    expect(last?.forecast?.burn24hHours).toBeCloseTo(2.88, 6);
  }, 60_000);

  it("retains at most MAX_SAMPLES (covers 8 days at the minimum spacing)", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    await t.sample(CO, ACCT, payload({ rem: 552 }), T0);
    const doc = [...state.rows.values()][0] as { accounts: Record<string, { samples: number[][] }> };
    const acct = Object.values(doc.accounts)[0];
    acct.samples = Array.from({ length: MAX_SAMPLES }, (_v, i) =>
      [T0 - (MAX_SAMPLES - i) * 3 * MIN, END, 555.56, 560 - i * 0.001]);
    await state.set({ scopeKind: "company", scopeId: CO, namespace: "capacity", stateKey: "samples" }, doc);
    await t.sample(CO, ACCT, payload({ rem: 549 }), T0 + 5 * MIN);
    expect(storedSamples(state)).toBe(MAX_SAMPLES);
  });
});

function storedSamples(state: MemState, account = 0): number {
  const doc = [...state.rows.values()][0] as { accounts: Record<string, { samples: unknown[] }> };
  return Object.values(doc.accounts)[account].samples.length;
}

describe("CapacityTelemetry unavailable and failures", () => {
  it("reports explicit unavailable for bad payloads and keeps history", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ rem: 400 }), T0);
    for (const bad of [null, "x", { ok: true }, payload({ rem: NaN })]) {
      const r = await t.sample(CO, ACCT, bad, T0 + HOUR);
      expect(r.status).toBe("unavailable");
      expect(r.warning).toBe(false);
      expect(r.forecast).toBe(null);
      expect(r.reasons).toHaveLength(1);
    }
    const ok = await t.sample(CO, ACCT, payload({ rem: 300 }), T0 + DAY);
    expect(ok.forecast?.burn24hHours).toBe(100);
  });

  it("prunes expired samples during a continuing provider outage", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    await t.sample(CO, ACCT, payload(), T0);
    await t.sample(CO, ACCT, null, T0 + 7 * DAY);
    await t.sample(CO, ACCT, null, T0 + 9 * DAY);
    expect(storedSamples(state)).toBe(0);
    expect((await t.latest(CO, T0 + 9 * DAY))[0].status).toBe("unavailable");
  });

  it("maintenance removes accounts whose telemetry source disappeared", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    await t.sample(CO, ACCT, payload(), T0);
    await t.maintain(CO, T0 + 9 * DAY);
    expect(await t.latest(CO, T0 + 9 * DAY)).toEqual([]);
    expect(JSON.stringify([...state.rows.values()])).not.toContain(String(T0));
  });

  it("rejects an ended plan period, a bad clock and clock regression", async () => {
    const t = new CapacityTelemetry(memState());
    expect((await t.sample(CO, ACCT, payload({ end: T0 }), T0)).reasons).toEqual(["plan_period_ended"]);
    for (const bad of [NaN, Infinity, -1, "5" as unknown as number]) {
      const r = await t.sample(CO, ACCT, payload(), bad);
      expect(r.status).toBe("unavailable");
      expect(r.observedAt).toBe(null);
    }
    await t.sample(CO, ACCT, payload(), T0 + HOUR);
    expect((await t.sample(CO, ACCT, payload(), T0)).reasons).toEqual(["clock_regression"]);
  });

  it("an ended period keeps the forecast unavailable but reports known start pressure with dedup", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    const ended = (extra: Over = {}) => payload({ end: T0, day: [180, 200], canStart: false, ...extra });
    const r = await t.sample(CO, ACCT, ended(), T0);
    expect(r.status).toBe("unavailable");
    expect(r.forecast).toBe(null);
    expect(r.reasons).toEqual(["plan_period_ended", "start_day_pressure", "cannot_start"]);
    expect(r.warning).toBe(true);
    expect(r.warningReasons).toEqual(["start_day_pressure", "cannot_start"]);
    expect(r.startPressure?.pressure).toBe(true);
    expect(r.shouldNotify).toBe(true);
    expect(storedSamples(state)).toBe(0);
    const again = await t.sample(CO, ACCT, ended(), T0 + 5 * MIN);
    expect(again.shouldNotify).toBe(false);
    const [latest] = await t.latest(CO, T0 + 6 * MIN);
    expect(latest.warningReasons).toEqual(["start_day_pressure", "cannot_start"]);
  });

  it("write failure yields unavailable without a dedup hint and persists nothing", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    state.failSet = true;
    const r = await t.sample(CO, ACCT, payload({ day: [180, 200] }), T0);
    expect(r.status).toBe("unavailable");
    expect(r.reasons).toEqual(["state_write_failed"]);
    expect(r.shouldNotify).toBe(false);
    expect(state.rows.size).toBe(0);
    state.failSet = false;
    const again = await t.sample(CO, ACCT, payload({ day: [180, 200] }), T0 + 10 * MIN);
    expect(again.shouldNotify).toBe(true); // marker was never recorded
  });

  it("read failure and unreadable state become unavailable, not an overwrite", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    state.failGet = true;
    expect((await t.sample(CO, ACCT, payload(), T0)).reasons).toEqual(["state_unavailable"]);
    state.failGet = false;
    await state.set({ scopeKind: "company", scopeId: CO, namespace: "capacity", stateKey: "samples" }, { version: 9 });
    expect((await t.sample(CO, ACCT, payload(), T0)).reasons).toEqual(["state_unavailable"]);
    expect(state.rows.size).toBe(1);
    expect(JSON.stringify([...state.rows.values()])).toBe('[{"version":9}]');
  });

  it("a failed write does not poison later samples", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    state.failSet = true;
    await t.sample(CO, ACCT, payload(), T0);
    state.failSet = false;
    expect((await t.sample(CO, ACCT, payload(), T0 + 5 * MIN)).status).toBe("insufficient");
  });

  it("tolerates malformed stored samples", async () => {
    const state = memState();
    await state.set({ scopeKind: "company", scopeId: CO, namespace: "capacity", stateKey: "samples" }, {
      version: 1,
      accounts: { x: { seenAt: T0, samples: [[1, 2], "bad", [T0, END, 555.56, NaN], [T0, END, 555.56, 500]], marker: null, report: null } },
    });
    const r = await new CapacityTelemetry(state).sample(CO, "other", payload(), T0 + MIN);
    expect(r.status).toBe("insufficient");
  });
});

describe("CapacityTelemetry notify dedup", () => {
  const hot = (extra: Over = {}) => payload({ day: [180, 200], ...extra });

  it("notifies on first warning, then only on transitions or after 24h", async () => {
    const t = new CapacityTelemetry(memState());
    expect((await t.sample(CO, ACCT, payload(), T0)).shouldNotify).toBe(false);
    expect((await t.sample(CO, ACCT, hot(), T0 + 5 * MIN)).shouldNotify).toBe(true);
    expect((await t.sample(CO, ACCT, hot(), T0 + 10 * MIN)).shouldNotify).toBe(false);
    // New reason added: transition.
    expect((await t.sample(CO, ACCT, hot({ active: 90 }), T0 + 15 * MIN)).shouldNotify).toBe(true);
    expect((await t.sample(CO, ACCT, hot({ active: 90 }), T0 + 20 * MIN)).shouldNotify).toBe(false);
    // 24h after the last hint, same warning.
    expect((await t.sample(CO, ACCT, hot({ active: 90 }), T0 + 15 * MIN + DAY - MIN)).shouldNotify).toBe(false);
    expect((await t.sample(CO, ACCT, hot({ active: 90 }), T0 + 15 * MIN + DAY)).shouldNotify).toBe(true);
  });

  it("clearing then re-warning notifies again; unavailable does not clear the marker", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, hot(), T0);
    await t.sample(CO, ACCT, null, T0 + 5 * MIN);
    expect((await t.sample(CO, ACCT, hot(), T0 + 10 * MIN)).shouldNotify).toBe(false);
    await t.sample(CO, ACCT, payload(), T0 + 15 * MIN);
    expect((await t.sample(CO, ACCT, hot(), T0 + 20 * MIN)).shouldNotify).toBe(true);
  });

  it("marker survives a new instance (durable)", async () => {
    const state = memState();
    await new CapacityTelemetry(state).sample(CO, ACCT, hot(), T0);
    expect((await new CapacityTelemetry(state).sample(CO, ACCT, hot(), T0 + 5 * MIN)).shouldNotify).toBe(false);
  });

  it("concurrent samples are serialized: all persisted, one notify hint", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    const reports = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => t.sample(CO, ACCT, hot(), T0 + i * 5 * MIN)));
    expect(reports.filter((r) => r.shouldNotify)).toHaveLength(1);
    expect(storedSamples(state)).toBe(6);
  });
});

describe("CapacityTelemetry isolation and storage", () => {
  it("isolates companies and accounts", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample("co-a", "k1", payload({ rem: 400 }), T0);
    await t.sample("co-b", "k1", payload({ rem: 100 }), T0);
    const a = await t.sample("co-a", "k1", payload({ rem: 300 }), T0 + DAY);
    const other = await t.sample("co-a", "k2", payload({ rem: 300 }), T0 + DAY);
    expect(a.forecast?.burn24hHours).toBe(100);
    expect(other.forecast?.burn24hHours).toBe(null);
    expect(a.accountId).not.toBe(other.accountId);
    expect(await t.latest("co-a", T0 + DAY)).toHaveLength(2);
    expect(await t.latest("co-b", T0 + DAY)).toHaveLength(1);
    expect(await t.latest("co-none", T0)).toEqual([]);
  });

  it("stores no credential or raw payload", async () => {
    const state = memState();
    const t = new CapacityTelemetry(state);
    const raw = { ...payload(), secretField: "sk-live-123", nextStartDollars: 77.77 };
    const r = await t.sample(CO, "sk-account-key", raw, T0);
    const dump = JSON.stringify([...state.rows.values()]) + JSON.stringify(r);
    expect(dump).not.toContain("sk-account-key");
    expect(dump).not.toContain("sk-live-123");
    expect(dump).not.toContain("77.77");
  });

  it("caps accounts at MAX_ACCOUNTS, evicting the least recently seen", async () => {
    const t = new CapacityTelemetry(memState());
    for (let i = 0; i <= MAX_ACCOUNTS; i++) await t.sample(CO, `k${i}`, payload(), T0 + i * 5 * MIN);
    const latest = await t.latest(CO, T0 + 60 * MIN);
    expect(latest).toHaveLength(MAX_ACCOUNTS);
    expect(latest.map((r) => r.observedAtMs)).not.toContain(T0);
  });

  it("latest marks readings older than 15 minutes stale but keeps the evidence", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload({ day: [180, 200] }), T0);
    const [fresh] = await t.latest(CO, T0 + STALE_AFTER_MS);
    expect(fresh.status).toBe("insufficient");
    const [stale] = await t.latest(CO, T0 + STALE_AFTER_MS + 1);
    expect(stale.status).toBe("unavailable");
    expect(stale.reasons[0]).toBe("stale_observation");
    expect(stale.shouldNotify).toBe(false);
    expect(stale.observedAtMs).toBe(T0);
    expect(stale.plan?.vmHoursRemaining).toBe(552);
    expect(stale.warningReasons).toEqual(["start_day_pressure"]);
    const [nan] = await t.latest(CO, NaN);
    expect(nan.status).toBe("unavailable");
  });

  it("latest returns the last report including unavailable", async () => {
    const t = new CapacityTelemetry(memState());
    await t.sample(CO, ACCT, payload(), T0);
    await t.sample(CO, ACCT, { ok: false }, T0 + 5 * MIN);
    const [r] = await t.latest(CO, T0 + 6 * MIN);
    expect(r.status).toBe("unavailable");
    expect(r.reasons).toEqual(["payload_not_ok"]);
  });
});
