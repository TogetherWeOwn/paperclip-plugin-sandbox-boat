import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { responseError } from "./test-support/fake-boat.js";
import { EPOCH, advance, command, fixture, providerMeter, reconcile, restart, safeRefusal, usage } from "./test-support/account-admission.fixture.js";
import type { AccountUsage } from "./test-support/account-admission.fixture.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers({ now: EPOCH, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f = fixture();
});
afterEach(async () => { await f.close(); vi.useRealTimers(); });
const iso = (seconds: number) => new Date(EPOCH + seconds * 1000).toISOString();

function disjoint(rows: AccountUsage[]) {
  const byVm = new Map<string, Array<{ since: string; until: string }>>();
  for (const row of rows) {
    expect(row.intervals, "accounting must expose paid intervals, not overlapping lease envelopes").toBeInstanceOf(Array);
    for (const interval of row.intervals) {
      expect(Date.parse(interval.until)).toBeGreaterThan(Date.parse(interval.since));
      const intervals = byVm.get(row.sandboxId!) ?? [];
      intervals.push(interval); byVm.set(row.sandboxId!, intervals);
    }
  }
  for (const intervals of byVm.values()) {
    intervals.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
    for (let i = 1; i < intervals.length; i++) expect(Date.parse(intervals[i].since)).toBeGreaterThanOrEqual(Date.parse(intervals[i - 1].until));
  }
}

describe("disjoint command and preceding-command tail attribution", () => {
  it("finalizes A's idle tail at B's reservation and B's tail at stop, allocating each paid second once", async () => {
    const p = f.pool("usage", {}, async (_vm, cmd) => {
      const seconds = cmd.commandId === "a" ? 10 : 20;
      await advance(seconds * 1000); return { exitCode: 0, seconds };
    });
    providerMeter(f, 50, 0.0005, { running: true, until: EPOCH + 50_000 });
    await p.execute(command("a")); await advance(5_000);
    await p.execute(command("b")); await advance(15_000);
    providerMeter(f, 50, 0.0005, { until: EPOCH + 50_000 });
    await reconcile(p);
    const rows = usage(p).filter((r) => r.kind === "command");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.commandId === "a")).toMatchObject({
      seconds: 15, dollars: expect.closeTo(0.00015, 10), meterProvenance: "provider",
      intervals: [{ since: iso(0), until: iso(10), phase: "command" }, { since: iso(10), until: iso(15), phase: "idle_tail" }],
    });
    expect(rows.find((r) => r.commandId === "b")).toMatchObject({
      seconds: 35, dollars: expect.closeTo(0.00035, 10), meterProvenance: "provider",
      intervals: [{ since: iso(15), until: iso(35), phase: "command" }, { since: iso(35), until: iso(50), phase: "idle_tail" }],
    });
    disjoint(usage(p));
    expect(usage(p).reduce((sum, row) => sum + row.seconds, 0)).toBe(50);
  });

  it("finalizes the preceding tail when the next command reserves, before that command finishes", async () => {
    const gate = f.gate();
    const p = f.pool("usage", {}, async (_vm, cmd) => {
      if (cmd.commandId === "b") await gate.promise;
      else await advance(10_000);
      return { exitCode: 0, seconds: cmd.commandId === "a" ? 10 : 0 };
    });
    providerMeter(f, 15, 0.00015, { running: true });
    await p.execute(command("a")); await advance(5_000);
    const b = p.execute(command("b"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const a = usage(p).find((r) => r.commandId === "a");
    expect(a?.intervals).toEqual([{ since: iso(0), until: iso(10), phase: "command" }, { since: iso(10), until: iso(15), phase: "idle_tail" }]);
    gate.resolve(); await b;
  });

  it("keeps unavailable readings pending rather than presenting a final fabricated bill", async () => {
    providerMeter(f, 0, 0, { unavailable: true });
    const p = f.pool("pending", {}, async () => { await advance(10_000); return { exitCode: 0, seconds: 10 }; });
    await p.execute(command("pending")); await advance(15_000);
    await reconcile(p);
    const row = usage(p).find((r) => r.commandId === "pending");
    expect(row).toMatchObject({ meterProvenance: "pending" });
    expect(row?.usageRecordId).toEqual(expect.any(String));
    expect(row?.usageRecordId.length).toBeGreaterThan(0);
  });

  it("upserts late provider corrections under the same stable record ID, never appending another command", async () => {
    providerMeter(f, 0, 0, { unavailable: true });
    const p = f.pool("late", {}, async () => { await advance(10_000); return { exitCode: 0, seconds: 10 }; });
    await p.execute(command("late")); await advance(15_000);
    const initial = usage(p).find((r) => r.commandId === "late");
    expect(initial?.usageRecordId).toEqual(expect.any(String));
    providerMeter(f, 25, 0.00025, { until: EPOCH + 25_000 });
    await reconcile(p); await reconcile(p);
    const rows = usage(p).filter((r) => r.commandId === "late");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usageRecordId: initial!.usageRecordId, seconds: 25, dollars: expect.closeTo(0.00025, 10), meterProvenance: "provider" });
    disjoint(usage(p));
    expect(usage(p).reduce((sum, row) => sum + row.seconds, 0)).toBe(25);
  });

  it("persists the same pending usage record through reconstruction and late reconciliation", async () => {
    providerMeter(f, 0, 0, { unavailable: true });
    const p = f.pool("persisted-usage", {}, async () => { await advance(10_000); return { exitCode: 0, seconds: 10 }; });
    await p.execute(command("persisted-usage")); await advance(15_000);
    const id = usage(p).find((r) => r.commandId === "persisted-usage")?.usageRecordId;
    expect(id).toEqual(expect.any(String));
    const recovered = await restart(f);
    try {
      const q = recovered.pool("persisted-usage");
      providerMeter(recovered, 25, 0.00025, { until: EPOCH + 25_000 });
      await reconcile(q); await reconcile(q);
      expect(usage(q).filter((r) => r.commandId === "persisted-usage")).toEqual([
        expect.objectContaining({ usageRecordId: id, seconds: 25, meterProvenance: "provider" }),
      ]);
      disjoint(usage(q));
    } finally { await recovered.close(); }
  });

  it("does not multiply SDK-weighted small-VM readings twice or substitute static dollars", async () => {
    const p = f.pool("small-usage", { size: "small" }, async () => { await advance(10_000); return { exitCode: 0, seconds: 10 }; });
    // SDK seconds already include the 0.5 multiplier: 25 wall seconds = 12.5.
    providerMeter(f, 12.5, 0.0000625, { multiplier: 0.5, secondsPerDollar: 200_000, until: EPOCH + 25_000 });
    await p.execute(command("small-usage")); await advance(15_000); await reconcile(p);
    expect(usage(p).find((r) => r.commandId === "small-usage")).toMatchObject({ seconds: 12.5, dollars: expect.closeTo(0.0000625, 10), meterProvenance: "provider" });
    expect(usage(p).reduce((sum, row) => sum + row.seconds, 0)).toBe(12.5);
  });

  it("includes resume and setup time in the resumed command, not in another overlapping lease", async () => {
    const p = f.pool("resume-usage", {}, async () => { await advance(10_000); return { exitCode: 0, seconds: 10 }; });
    await p.execute(command("seed")); await advance(15_000);
    const original = f.boat.resume.bind(f.boat);
    f.boat.resume = async (args) => { const result = await original(args); await advance(3_000); return result; };
    providerMeter(f, 53, 0.00053, { until: EPOCH + 53_000 });
    await p.execute(command("resumed")); await advance(15_000); await reconcile(p);
    const row = usage(p).find((r) => r.commandId === "resumed");
    expect(row).toMatchObject({ seconds: 28,
      intervals: [{ since: iso(25), until: iso(38), phase: "command" }, { since: iso(38), until: iso(53), phase: "idle_tail" }] });
    disjoint(usage(p));
    expect(usage(p).reduce((sum, r) => sum + r.seconds, 0)).toBe(53);
  });
});

describe("failed starts, aborted starts and unattributed overhead are explicit", () => {
  it("records a definitive failed start separately instead of hiding it in successful jobs", async () => {
    f.boat.failNext("create", responseError(429, { code: "rate_limited", message: "no VM was created" }));
    const p = f.pool("failed-start");
    safeRefusal(await p.execute(command("failed-start")));
    const rows = usage(p);
    expect(rows.filter((r) => r.kind === "failed_start")).toEqual([
      expect.objectContaining({ commandId: "failed-start", seconds: 0, usageRecordId: expect.any(String) }),
    ]);
    expect(rows.filter((r) => r.kind === "command")).toHaveLength(0);
    expect(f.executions).toEqual([]);
  });

  it("retains an aborted-start row pending after a lost resume reply, then reconciles actual provider cost", async () => {
    providerMeter(f, 0, 0, { unavailable: true });
    const p = f.pool("aborted-start");
    await p.execute(command("seed")); await advance(15_000);
    const original = f.boat.resume.bind(f.boat);
    f.boat.resume = async (args) => { await original(args); await advance(7_000); throw new Error("synthetic crash before exec"); };
    await p.execute(command("aborted-start")).catch(() => undefined);
    expect(f.executions).toEqual(["seed"]);
    const pending = usage(p).find((r) => r.kind === "aborted_start");
    expect(pending).toMatchObject({ commandId: "aborted-start", meterProvenance: "pending", usageRecordId: expect.any(String) });
    // The known VM's provider-enforced deadline now definitively stopped it.
    // No attempt is made to guess an unknown create's VM identity from a list.
    for (const box of f.boat.boxes.values()) box.state = "archived";
    providerMeter(f, 22, 0.00022, { until: EPOCH + 22_000 });
    await reconcile(p); await reconcile(p);
    expect(usage(p).filter((r) => r.kind === "aborted_start")).toEqual([
      expect.objectContaining({ usageRecordId: pending!.usageRecordId, seconds: 7, dollars: expect.closeTo(0.00007, 10), meterProvenance: "provider" }),
    ]);
    expect(usage(p).filter((r) => r.kind === "command")).toHaveLength(1);
    expect(usage(p).reduce((sum, r) => sum + r.seconds, 0)).toBe(22);
    disjoint(usage(p));
  });

  it("uses an explicit overhead row for provider cost outside command intervals and reconciles the full total", async () => {
    const p = f.pool("overhead", {}, async () => { await advance(10_000); return { exitCode: 0, seconds: 10 }; });
    // Two paid seconds predate this worker's command. They cannot be invented
    // as command execution or counted again through a whole-run lease window.
    providerMeter(f, 27, 0.00027, { since: EPOCH - 2_000, until: EPOCH + 25_000 });
    await p.execute(command("with-overhead")); await advance(15_000); await reconcile(p);
    const rows = usage(p);
    expect(rows.find((r) => r.commandId === "with-overhead" && r.kind === "command")).toMatchObject({ seconds: 25 });
    expect(rows.filter((r) => r.kind === "overhead")).toEqual([
      expect.objectContaining({ commandId: null, seconds: 2, dollars: expect.closeTo(0.00002, 10), usageRecordId: expect.any(String) }),
    ]);
    expect(rows.reduce((sum, row) => sum + row.seconds, 0)).toBe(27);
    expect(rows.reduce((sum, row) => sum + row.dollars, 0)).toBeCloseTo(0.00027, 10);
    disjoint(rows);
    const ids = rows.map((r) => r.usageRecordId).sort();
    await reconcile(p);
    expect(usage(p).map((r) => r.usageRecordId).sort()).toEqual(ids);
    expect(usage(p).reduce((sum, row) => sum + row.seconds, 0)).toBe(27);
  });
});
