import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { responseError } from "./test-support/fake-boat.js";
import { EPOCH, advance, command, deferred, fixture, flush, limits, noDispatch, reconcile, restart, safeRefusal, starts, usage } from "./test-support/account-admission.fixture.js";

// Tests intentionally precede implementation. See the fixture's minimal public
// seam contract. Each case targets a missing safety behavior, not ledger layout.
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });

async function stoppedPool() {
  const p = f.pool();
  expect(await p.execute(command("seed"))).toMatchObject({ status: "completed" });
  await advance(15_000);
  expect(f.boat.callsOf("stop")).toHaveLength(1);
  return p;
}

describe("limits freshness at account admission", () => {
  it("refreshes during sustained running-idle reuse and refuses exhausted compute before exec", async () => {
    const p = f.pool();
    await p.execute(command("seed"));
    await advance(6_000); // warm, but the limits snapshot has expired
    f.boat.limitsResponse = limits({ creditBalanceSeconds: 3_674 });
    safeRefusal(await p.execute(command("warm-exhausted")));
    expect(f.executions).toEqual(["seed"]);
    expect(f.boat.callsOf("limits").length).toBeGreaterThanOrEqual(2);
  });

  it("never dispatches from a snapshot older than five seconds after waiting for the lock", async () => {
    const writes = f.gate();
    f.state.beforeWrite = () => writes.promise;
    const p = f.pool();
    const pending = p.execute(command("stale-after-lock"));
    await flush();
    await advance(5_001);
    f.boat.limitsResponse = limits({ canStart: false, startBlockedReason: "exhausted" });
    f.state.beforeWrite = undefined;
    writes.resolve();
    safeRefusal(await pending);
    noDispatch(f);
  });

  it.each(["create", "resume", "warm"] as const)("fails closed on unreadable limits before %s", async (path) => {
    const p = path === "resume" ? await stoppedPool() : f.pool();
    if (path === "warm") await p.execute(command("seed"));
    await advance(6_000);
    const before = { create: f.boat.callsOf("create").length, resume: f.boat.callsOf("resume").length, exec: f.executions.length };
    f.boat.limits = async () => { throw new Error("synthetic limits unreadable"); };
    safeRefusal(await p.execute(command(`unreadable-${path}`)));
    expect(f.boat.callsOf("create")).toHaveLength(before.create);
    expect(f.boat.callsOf("resume")).toHaveLength(before.resume);
    expect(f.executions).toHaveLength(before.exec);
  });

  it.each(["create", "resume", "warm"] as const)("times out limits at three seconds before %s, without stale-cache admission", async (path) => {
    const p = path === "resume" ? await stoppedPool() : f.pool();
    if (path === "warm") await p.execute(command("seed"));
    await advance(6_000);
    const fetch = deferred<Record<string, unknown>>();
    const before = { create: f.boat.callsOf("create").length, resume: f.boat.callsOf("resume").length, exec: f.executions.length };
    f.boat.limits = () => fetch.promise;
    let result: unknown;
    const pending = p.execute(command(`timeout-${path}`)).then((r) => { result = r; });
    await flush();
    await advance(2_999);
    expect(result).toBeUndefined();
    await advance(1);
    // Always settle the fake request so a broken timeout does not leak work.
    const atDeadline = result;
    fetch.resolve(limits());
    await pending;
    safeRefusal(atDeadline);
    expect(f.boat.callsOf("create")).toHaveLength(before.create);
    expect(f.boat.callsOf("resume")).toHaveLength(before.resume);
    expect(f.executions).toHaveLength(before.exec);
  });

  it.each([{}, { ok: false }, { ok: true, creditBalanceSeconds: Number.NaN }])("rejects malformed limits rather than inventing unlimited capacity: %j", async (body) => {
    f.boat.limitsResponse = body;
    safeRefusal(await f.pool().execute(command("malformed")));
    noDispatch(f);
  });
});

describe("shared admission: effective caps and unreflected reservations", () => {
  it.each([
    { name: "active", overrides: { activeSandboxes: 1 }, config: {} },
    { name: "daily start", overrides: { starts: starts(69) }, config: {} },
    { name: "minute start", overrides: { starts: { ...starts(4), hour: { limit: 25, used: 4, remaining: 21 }, minute: { limit: 5, used: 4, remaining: 1 } } }, config: {} },
    { name: "hour start", overrides: { starts: { ...starts(24), hour: { limit: 25, used: 24, remaining: 1 } } }, config: {} },
    { name: "compute", overrides: { creditBalanceSeconds: 3_749 }, config: {} },
  ])("allows one winner across two pools racing the last $name budget", async ({ overrides, config }) => {
    f.boat.limitsResponse = limits(overrides);
    const gate = f.gate();
    const run = async () => { await gate.promise; return { exitCode: 0, seconds: 0 }; };
    const a = f.pool("a", config, run), b = f.pool("b", config, run);
    const pa = a.execute(command("race-a")), pb = b.execute(command("race-b"));
    await flush(); await advance(2);
    gate.resolve();
    const results = await Promise.all([pa, pb]);
    expect(results.filter((r) => r.status === "completed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "unavailable")).toHaveLength(1);
    expect(f.executions).toHaveLength(1);
    expect(f.boat.callsOf("create")).toHaveLength(1);
  });

  it.each([
    { name: "active", overrides: { activeSandboxes: 1 } },
    { name: "start", overrides: { starts: starts(69) } },
    // Whole-run TTL is 60s; offload job+tail is 75s. 134s of
    // headroom cannot fund any pair (60+75 or 75+75).
    { name: "compute", overrides: { creditBalanceSeconds: 3_734 } },
  ])("coordinates a whole-run lease and two pools on the same last $name budget", async ({ overrides }) => {
    f.boat.limitsResponse = limits(overrides);
    const g = f.gate();
    const run = async () => { await g.promise; return { exitCode: 0, seconds: 0 }; };
    const a = f.pool("a", {}, run), b = f.pool("b", {}, run);
    const manager = f.manager();
    const pa = a.execute(command("mixed-a")), pb = b.execute(command("mixed-b"));
    const lease = f.acquire(manager, "mixed-whole", { autoStopMinutes: 1 }).then(() => true, () => false);
    await flush(); await advance(2); g.resolve();
    const results = await Promise.all([pa, pb]);
    const whole = await lease;
    expect(results.filter((r) => r.status === "completed").length + Number(whole)).toBe(1);
    expect(f.boat.callsOf("create")).toHaveLength(1);
  });

  it("shares the account lock across company IDs, not just within one company", async () => {
    f.boat.limitsResponse = limits({ activeSandboxes: 1 });
    const gate = f.gate();
    const run = async () => { await gate.promise; return { exitCode: 0, seconds: 0 }; };
    const a = f.pool("a", {}, run), b = f.pool("b", {}, run);
    const first = a.execute(command("company-a"));
    const second = b.execute(command("company-b", { companyId: "55555555-5555-4555-8555-555555555555" }));
    await flush(); await advance(2); gate.resolve();
    const results = await Promise.all([first, second]);
    expect(results.filter((r) => r.status === "completed")).toHaveLength(1);
    expect(f.executions).toHaveLength(1);
  });

  it("serializes limits reads under one account mutex even across independent executor objects", async () => {
    let inFlight = 0, peak = 0;
    const gate = f.gate();
    f.boat.limits = async () => { inFlight++; peak = Math.max(peak, inFlight); await gate.promise; inFlight--; return limits(); };
    const a = f.pool("a"), b = f.pool("b");
    const pa = a.execute(command("read-a")), pb = b.execute(command("read-b"));
    await flush();
    const during = peak;
    gate.resolve();
    await Promise.all([pa, pb]);
    expect(during, "one account mutex must cover fetch, check and durable intent").toBe(1);
  });

  it("keeps maxOffloadVms independent of account spare capacity", async () => {
    f.boat.limitsResponse = limits({ maxActiveSandboxes: 20 });
    const gate = f.gate();
    const p = f.pool("bounded", { maxOffloadVms: 1, maxActive: 10 }, async () => { await gate.promise; return { exitCode: 0, seconds: 0 }; });
    const first = p.execute(command("pool-first")); await flush();
    const second = p.execute(command("pool-full")); await advance(2);
    safeRefusal(await second);
    expect(f.boat.callsOf("create")).toHaveLength(1);
    gate.resolve(); await first;
    expect(await f.pool("other", { maxActive: 10 }).execute(command("other-pool"))).toMatchObject({ status: "completed" });
  });

  it.each([
    { configured: undefined, provider: 20, observed: 2 },
    { configured: 1, provider: 20, observed: 1 },
    { configured: 20, provider: 1, observed: 1 },
  ])("enforces min(configured, provider) active cap: %j", async ({ configured, provider, observed }) => {
    f.boat.limitsResponse = limits({ activeSandboxes: observed, maxActiveSandboxes: provider });
    safeRefusal(await f.pool("cap", configured === undefined ? {} : { maxActive: configured }).execute(command("active-cap")));
    noDispatch(f);
  });

  it.each([
    { configured: undefined, provider: 200, used: 70 },
    { configured: 4, provider: 200, used: 4 },
    { configured: 200, provider: 3, used: 3 },
  ])("enforces min(configured, provider) daily starts without raising default 70: %j", async ({ configured, provider, used }) => {
    f.boat.limitsResponse = limits({ starts: starts(used, provider) });
    safeRefusal(await f.pool("cap", configured === undefined ? {} : { maxStartsPerDay: configured }).execute(command("start-cap")));
    noDispatch(f);
  });

  it.each(["minute", "hour", "day"] as const)("checks exhausted %s starts even when other windows have room", async (window) => {
    const s = starts(5);
    if (window === "minute") s.hour = { limit: 25, used: 5, remaining: 20 };
    s[window] = { limit: 5, used: 5, remaining: 0 };
    f.boat.limitsResponse = limits({ starts: s });
    safeRefusal(await f.pool().execute(command(`window-${window}`)));
    noDispatch(f);
  });

  it("does not turn null/unlimited provider windows into a zero-start cap", async () => {
    f.boat.limitsResponse = limits({ starts: { unlimited: true, minute: null, hour: null, day: null } });
    expect(await f.pool().execute(command("unlimited-provider"))).toMatchObject({ status: "completed" });
  });

  it("does not treat a running-idle reuse as a new active slot or start", async () => {
    const p = f.pool(); await p.execute(command("seed"));
    await advance(6_000);
    f.boat.limitsResponse = limits({ activeSandboxes: 2, starts: starts(70), canStart: false });
    expect(await p.execute(command("running-reuse"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("create")).toHaveLength(1);
    expect(f.boat.callsOf("resume")).toHaveLength(0);
  });

  it("reserves a potential start for resume even after a previous resume was observed free", async () => {
    const p = await stoppedPool();
    await p.execute(command("free-resume")); await advance(15_000);
    f.boat.limitsResponse = limits({ starts: starts(70) });
    safeRefusal(await p.execute(command("exhausted-resume")));
    expect(f.boat.callsOf("resume")).toHaveLength(1);
    expect(f.executions).toEqual(["seed", "free-resume"]);
  });

  it("does not reset local reservations at UTC midnight before the provider reset", async () => {
    const s = starts(69); Object.assign(s.day, { resetAt: new Date(EPOCH + 3_600_000) });
    f.boat.limitsResponse = limits({ starts: s });
    const p = f.pool(); await p.execute(command("last-before-midnight"));
    await advance(20_000); // crosses midnight; provider still reports 69
    safeRefusal(await f.pool("after-midnight").execute(command("too-early")));
    expect(f.boat.callsOf("create")).toHaveLength(1);
  });
});

describe("provider window reset metadata", () => {
  it("uses the provider's non-midnight reset to retire a completed start reservation", async () => {
    const resetAt = EPOCH + 3_600_000;
    const s = starts(69); Object.assign(s.day, { resetAt: new Date(resetAt) });
    f.boat.limitsResponse = limits({ starts: s });
    const p = f.pool(); await p.execute(command("before-reset"));
    // At this start pressure, the first tail is 300s, then the VM is stopped.
    await advance(3_600_001);
    const reset = starts(0); Object.assign(reset.day, { resetAt: new Date(resetAt + 86_400_000) });
    f.boat.limitsResponse = limits({ starts: reset });
    await reconcile(p);
    expect(await f.pool("after-reset").execute(command("after-reset"))).toMatchObject({ status: "completed" });
    expect(f.boat.callsOf("create")).toHaveLength(2);
  });

  it("does not infer midnight reset when the provider supplies only rolling windows", async () => {
    f.boat.limitsResponse = limits({ starts: starts(69) });
    await f.pool().execute(command("rolling-last"));
    await advance(20_000);
    safeRefusal(await f.pool("rolling-next").execute(command("rolling-denied")));
    expect(f.boat.callsOf("create")).toHaveLength(1);
  });
});

describe("size-weighted job plus tail plus reserve", () => {
  it.each([
    { size: "default" as const, available: 3_674, allowed: false },
    { size: "default" as const, available: 3_675, allowed: true },
    { size: "small" as const, available: 3_637, allowed: false },
    { size: "small" as const, available: 3_637.5, allowed: true },
  ])("uses SDK machine seconds for $size: $available remaining => $allowed", async ({ size, available, allowed }) => {
    // 60s command + 15s tail, at SDK multipliers 1 / 0.5; reserve = 3600 base seconds.
    f.boat.limitsResponse = limits({ creditBalanceSeconds: available });
    const result = await f.pool("weighted", { size }).execute(command("weighted"));
    if (allowed) expect(result).toMatchObject({ status: "completed" });
    else { safeRefusal(result); noDispatch(f); }
  });

  it("uses the command timeout, not the optimistic observed duration, for admission", async () => {
    f.boat.limitsResponse = limits({ creditBalanceSeconds: 3_690 });
    safeRefusal(await f.pool().execute(command("long-worst-case", { timeoutMs: 120_000 })));
    noDispatch(f);
  });

  it("preserves configured compute reserve instead of spending it on the job", async () => {
    f.boat.limitsResponse = limits({ creditBalanceSeconds: 7_274 });
    safeRefusal(await f.pool("reserve", { minComputeHoursLeft: 2 }).execute(command("keep-reserve")));
    noDispatch(f);
  });

  it("uses the smaller trial allowance/balance after credit used, not the wallet alone", async () => {
    f.boat.limitsResponse = limits({ trialComputeCapSeconds: 90_000, creditUsedSeconds: 86_326, creditBalanceSeconds: 2_000_000 });
    safeRefusal(await f.pool().execute(command("trial-bound")));
    noDispatch(f);
  });

  it("subtracts outstanding small and default compute in SDK units without mixing wall seconds", async () => {
    f.boat.limitsResponse = limits({ creditBalanceSeconds: 3_712 });
    const g = f.gate();
    const small = f.pool("small", { size: "small" }, async () => { await g.promise; return { exitCode: 0, seconds: 0 }; });
    const first = small.execute(command("small-held")); await flush();
    const second = f.pool("default").execute(command("default-denied")); await advance(2);
    // 37.5 + 75 + 3600 = 3712.5, just beyond the available 3712.
    safeRefusal(await second); g.resolve(); await first;
    expect(f.executions).toEqual(["small-held"]);
  });
});

describe("durable intent and ambiguous external effects", () => {
  it.each(["create", "resume", "warm"] as const)("commits reservation intent before %s effects", async (path) => {
    let writesAtEffect = -1;
    const p = f.pool("intent", {}, async (_vm, cmd) => {
      if (path === "warm" && cmd.commandId === "intent-warm") writesAtEffect = f.state.writes;
      return { exitCode: 0, seconds: 0 };
    });
    if (path !== "create") await p.execute(command("seed"));
    if (path === "resume") await advance(15_000);
    const baselineWrites = f.state.writes;
    if (path === "create") {
      const original = f.boat.create.bind(f.boat);
      f.boat.create = async (args) => { writesAtEffect = f.state.writes; return original(args); };
    } else if (path === "resume") {
      const original = f.boat.resume.bind(f.boat);
      f.boat.resume = async (args) => { writesAtEffect = f.state.writes; return original(args); };
    }
    expect(await p.execute(command(`intent-${path}`))).toMatchObject({ status: "completed" });
    expect(writesAtEffect).toBeGreaterThan(baselineWrites);
  });

  it("fails closed if persistence rejects reservation intent", async () => {
    f.state.failWrites = true;
    const result = await f.pool().execute(command("store-down"));
    safeRefusal(result); noDispatch(f);
    f.state.failWrites = false;
  });

  it.each(["create", "resume"] as const)("retains ambiguous %s reservations across reconstruction until definitive reconciliation", async (operation) => {
    // A resume claims the last active slot; a create claims the last start.
    // Provider counters deliberately lag both external effects.
    f.boat.limitsResponse = operation === "resume"
      ? limits({ maxActiveSandboxes: 1 }) : limits({ starts: starts(69) });
    const p = operation === "resume" ? await stoppedPool() : f.pool();
    const original = f.boat[operation].bind(f.boat);
    const attemptsBefore = f.boat.callsOf(operation).length;
    f.boat[operation] = async (args: Record<string, unknown>) => { await original(args); throw new Error("synthetic reply lost after provider effect"); };
    await p.execute(command("lost-reply")).catch(() => undefined);
    expect(f.boat.callsOf(operation)).toHaveLength(attemptsBefore + 1);
    const before = f.boat.callsOf("create").length + f.boat.callsOf("resume").length;
    const recovered = await restart(f);
    try {
      const next = recovered.pool("recovered");
      safeRefusal(await next.execute(command("after-crash")));
      expect(f.boat.callsOf("create").length + f.boat.callsOf("resume").length).toBe(before);
      // A failed limits/info read is not definitive absence and must not free it.
      f.boat.get = async () => { throw new Error("synthetic provider reconciliation unavailable"); };
      await reconcile(next);
      safeRefusal(await next.execute(command("still-uncertain")));
      expect(recovered.executions).toEqual([]);
    } finally { await recovered.close(); }
  });

  it.each(["create", "resume"] as const)("retains a reservation when the process dies while %s has no reply", async (operation) => {
    f.boat.limitsResponse = operation === "resume"
      ? limits({ maxActiveSandboxes: 1 }) : limits({ starts: starts(69) });
    const p = operation === "resume" ? await stoppedPool() : f.pool();
    const reply = deferred<void>();
    if (operation === "create") {
      const original = f.boat.create.bind(f.boat);
      f.boat.create = async (args) => { const result = await original(args); await reply.promise; return result; };
    } else {
      const original = f.boat.resume.bind(f.boat);
      f.boat.resume = async (args) => { const result = await original(args); await reply.promise; return result; };
    }
    const first = p.execute(command(`crashed-${operation}`)); await flush();
    const before = f.boat.callsOf("create").length + f.boat.callsOf("resume").length;
    const recovered = await restart(f);
    try {
      const next = recovered.pool("recovered");
      const second = next.execute(command("after-process-death")); await flush(); await advance(2);
      const effectsBeforeReply = f.boat.callsOf("create").length + f.boat.callsOf("resume").length;
      reply.resolve(); await first;
      safeRefusal(await second);
      expect(effectsBeforeReply).toBe(before);
      expect(recovered.executions).toEqual([]);
    } finally { reply.resolve(); await first; await recovered.close(); }
  });

  it("recovers an unreflected active reservation in a newly constructed whole-run consumer", async () => {
    f.boat.limitsResponse = limits({ activeSandboxes: 1 });
    await f.pool().execute(command("persisted-active"));
    const recovered = await restart(f);
    try {
      const before = f.boat.callsOf("create").length;
      const outcome = await recovered.acquire(recovered.manager(), "restarted-whole").then(() => "admitted", () => "refused");
      expect(outcome).toBe("refused");
      expect(f.boat.callsOf("create")).toHaveLength(before);
    } finally { await recovered.close(); }
  });

  it("persists outstanding size-weighted compute across a module/process-cache restart", async () => {
    f.boat.limitsResponse = limits({ creditBalanceSeconds: 3_712 });
    const gate = f.gate();
    const first = f.pool("held-small", { size: "small" }, async () => { await gate.promise; return { exitCode: 0, seconds: 0 }; }).execute(command("held-small"));
    await flush();
    expect(f.executions).toEqual(["held-small"]);
    const recovered = await restart(f);
    try {
      // 37.5 reserved + 75 requested + 3600 reserve exceeds 3712.
      safeRefusal(await recovered.pool("restarted-default").execute(command("compute-after-restart")));
      expect(recovered.executions).toEqual([]);
      expect(f.boat.callsOf("create")).toHaveLength(1);
    } finally { gate.resolve(); await first; await recovered.close(); }
  });

  it("restores whole-run reservations before admitting a newly constructed offload pool", async () => {
    f.boat.limitsResponse = limits({ activeSandboxes: 1 });
    await f.acquire(f.manager(), "persisted-whole");
    const recovered = await restart(f);
    try {
      safeRefusal(await recovered.pool("post-whole-restart").execute(command("offload-after-whole")));
      expect(f.boat.callsOf("create")).toHaveLength(1);
      expect(recovered.executions).toEqual([]);
    } finally { await recovered.close(); }
  });

  it("does not mistake an empty provider list for a terminal receipt on an ambiguous create", async () => {
    f.boat.limitsResponse = limits({ starts: starts(69) });
    const original = f.boat.create.bind(f.boat);
    f.boat.create = async (args) => {
      f.boat.calls.push({ method: "create", args: args ?? {} });
      throw new Error("synthetic lost request: provider may still be processing it");
    };
    const p = f.pool("ambiguous-absent");
    await p.execute(command("absent")).catch(() => undefined);
    expect(f.boat.boxes.size).toBe(0);
    f.boat.create = original;
    await reconcile(p); // empty list, but no definitive never-created response
    safeRefusal(await f.pool("after-absence").execute(command("after-absence")));
    expect(f.boat.callsOf("create")).toHaveLength(1);
    expect(f.executions).toEqual([]);
  });

  it("does not duplicate a start reservation when the provider later reflects the same effect", async () => {
    f.boat.limitsResponse = limits({ starts: starts(68) });
    const p = f.pool(); await p.execute(command("start-one")); await advance(15_000);
    f.boat.limitsResponse = limits({ starts: starts(69) });
    await reconcile(p);
    expect(await f.pool("second").execute(command("start-two"))).toMatchObject({ status: "completed" });
    await advance(15_000);
    safeRefusal(await f.pool("third").execute(command("start-three")));
    expect(f.boat.callsOf("create")).toHaveLength(2);
  });

  it("does not double count provider-reflected active slots or release an unreflected second slot", async () => {
    const p = f.pool("first"); await p.execute(command("active-one"));
    f.boat.limitsResponse = limits({ activeSandboxes: 1, starts: starts(1) });
    await reconcile(p);
    expect(await f.pool("second").execute(command("active-two"))).toMatchObject({ status: "completed" });
    safeRefusal(await f.pool("third").execute(command("active-three")));
    expect(f.boat.callsOf("create")).toHaveLength(2);
    expect(f.executions).toEqual(["active-one", "active-two"]);
  });

  it("releases a definitively rejected start, permitting the next consumer without spending twice", async () => {
    f.boat.limitsResponse = limits({ starts: starts(69) });
    f.boat.failNext("create", responseError(429, { code: "rate_limited", message: "not created" }));
    safeRefusal(await f.pool("rejected").execute(command("definite-reject")));
    expect(f.executions).toEqual([]);
    expect(await f.pool("next").execute(command("after-rejection"))).toMatchObject({ status: "completed" });
  });
});

describe("adaptive tail accounting-change simulation", () => {
  it.each([
    { used: 54, provider: 75, stopAt15: true }, // below 80%, even including this start
    { used: 56, provider: 75, stopAt15: false }, // 56/70 = 80%
    { used: 38, provider: 50, stopAt15: true },
    { used: 40, provider: 50, stopAt15: false }, // provider minimum wins
  ])("selects C=300 only at effective daily threshold: used=$used provider=$provider", async ({ used, provider, stopAt15 }) => {
    f.boat.limitsResponse = limits({ starts: starts(used, provider) });
    const p = f.pool(); await p.execute(command("adaptive"));
    await advance(15_000);
    expect(f.boat.callsOf("stop")).toHaveLength(stopAt15 ? 1 : 0);
    if (!stopAt15) { await advance(284_999); expect(f.boat.callsOf("stop")).toHaveLength(0); await advance(1); expect(f.boat.callsOf("stop")).toHaveLength(1); }
  });

  it("refuses adaptive C=300 when only the shorter job+tail+reserve would fit", async () => {
    f.boat.limitsResponse = limits({ starts: starts(56), creditBalanceSeconds: 3_959 });
    // 60 + 300 + 3600 = 3960, not 3675.
    safeRefusal(await f.pool().execute(command("adaptive-no-compute")));
    noDispatch(f);
  });

  it("keeps a running warm VM subject to the longer job+tail compute reservation", async () => {
    const p = f.pool(); await p.execute(command("seed")); await advance(6_000);
    f.boat.limitsResponse = limits({ starts: starts(56), creditBalanceSeconds: 3_959 });
    safeRefusal(await p.execute(command("adaptive-warm-no-compute")));
    expect(f.executions).toEqual(["seed"]);
  });

  it("records a zero-count warm resume without inferring that future resumes are free or extending C", async () => {
    const p = await stoppedPool();
    f.boat.limitsResponse = limits({ starts: starts(1) });
    await p.execute(command("zero-count-resume")); await reconcile(p);
    expect(usage(p).find((r) => r.commandId === "zero-count-resume")).toMatchObject({ observedStartsDelta: 0 });
    await advance(15_000);
    expect(f.boat.callsOf("stop")).toHaveLength(2);
    f.boat.limitsResponse = limits({ starts: starts(70) });
    safeRefusal(await p.execute(command("not-entitled-to-free-resume")));
    expect(f.boat.callsOf("resume")).toHaveLength(1);
  });

  it("switches to C=300 on observed warm-resume starts and persists that observation", async () => {
    const p = await stoppedPool();
    f.boat.limitsResponse = limits({ starts: starts(1) });
    // The provider changes from a free-warm-resume model to counting resumes.
    const original = f.boat.resume.bind(f.boat);
    f.boat.resume = async (args) => { const r = await original(args); f.boat.limitsResponse = limits({ starts: starts(2) }); return r; };
    await p.execute(command("metered-resume"));
    await reconcile(p);
    expect(usage(p).find((r) => r.commandId === "metered-resume")).toMatchObject({ observedStartsDelta: 1 });
    await advance(15_000);
    expect(f.boat.callsOf("stop")).toHaveLength(1); // seed stop only
    const recovered = await restart(f);
    try {
      const q = recovered.pool("new-pool");
      await q.execute(command("after-accounting-change"));
      const before = f.boat.callsOf("stop").length;
      await advance(15_000);
      expect(f.boat.callsOf("stop")).toHaveLength(before);
    } finally { await recovered.close(); }
  });
});
