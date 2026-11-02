import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { createFakeContext } from "./test-support/harness.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

let clock: number;
let harness: ReturnType<typeof createFakeContext>;

beforeEach(async () => {
  clock = Date.parse("2026-10-22T18:00:00Z");
  setManagerOverridesForTests({ now: () => clock, sleep: async (ms: number) => { clock += ms; } });
  harness = createFakeContext();
  await plugin.definition.setup(harness.ctx as never);
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setManagerOverridesForTests({});
});

describe("run-owner state retention", () => {
  it("agent.run.started with an empty company config writes no state but still gates the run", async () => {
    // The fake context's config client already reads every company as {}.
    await harness.emit("agent.run.started", { companyId: COMPANY,
      payload: { runId: "run-1", issueId: null, agentId: "agent-1" } });
    expect(harness.state.size).toBe(0);
    expect(await currentManager().localRunOwnedBy(COMPANY, "run-1", "agent-1")).toBe(true);
    expect(await currentManager().localRunOwnedBy(COMPANY, "run-1", "agent-2")).toBe(false);
  });

  it("concurrent started bursts index every owner", async () => {
    // trackRunOwner is a get-to-set on the per-company index: without the
    // index lock, interleaved bursts lose entries, and an unindexed owner row
    // is one the sweep can never age out.
    const manager = currentManager();
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      manager.startLocalRun(COMPANY, `burst-${i}`, null, "agent-1", true)));
    const index = harness.state.get(`company|${COMPANY}|boat-offload-runs|owners`) as {
      version: number; runs: string[];
    };
    expect([...index.runs].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `burst-${i}`).sort());
    for (let i = 0; i < 20; i += 1) {
      expect(harness.state.has(`company|${COMPANY}|boat-offload-runs|burst-${i}`)).toBe(true);
    }
  });

  it("agent.run.started gates the run before company config resolves", async () => {
    // The ownership gate can run while settings are still being fetched; the
    // in-memory owner is installed first so the run's first offload request
    // never 403s against an event that is still being handled.
    let resolveConfig!: (value: Record<string, unknown>) => void;
    const configPending = new Promise<Record<string, unknown>>((resolve) => { resolveConfig = resolve; });
    harness.ctx.config.get = () => configPending;
    const started = harness.emit("agent.run.started", { companyId: COMPANY,
      payload: { runId: "run-early", issueId: null, agentId: "agent-1" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await currentManager().localRunOwnedBy(COMPANY, "run-early", "agent-1")).toBe(true);
    resolveConfig({});
    await started;
    expect(harness.state.size).toBe(0);
    expect(await currentManager().localRunOwnedBy(COMPANY, "run-early", "agent-1")).toBe(true);
  });

  it("a 25 h old owner of a live issue run survives the sweep", async () => {
    // Age alone never ends an issue run: the gate rehydrates live issue runs
    // from the host, so the sweep applies the same liveness bound instead of
    // deleting the owner and its workspace bindings mid-run.
    harness.issues.set("issue-live", { status: "open", executionRunId: "live-run", checkoutRunId: null });
    const recordKey = `company|${COMPANY}|boat-offload-runs|live-run`;
    const indexKey = `company|${COMPANY}|boat-offload-runs|owners`;
    harness.state.set(recordKey, { version: 1, companyId: COMPANY, runId: "live-run",
      issueId: "issue-live", agentId: "agent-1", startedAt: clock - 25 * 60 * 60_000 });
    harness.state.set(indexKey, { version: 1, runs: ["live-run"] });
    const report = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(report.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toMatchObject({ runId: "live-run" });
    expect(harness.state.get(indexKey)).toEqual({ version: 1, runs: ["live-run"] });
    expect(await currentManager().localRunOwnedBy(COMPANY, "live-run", "agent-1")).toBe(true);
  });

  it("a host lookup failure keeps the 25 h issue owner for the next sweep", async () => {
    // The sweep must delete only positively-disproven runs: a transient host
    // error is "unknown", not proof of death, so the owner row, the index
    // entry, and the fail-closed gate must all survive it.
    harness.issues.set("issue-flaky", { status: "open", executionRunId: "flaky-run", checkoutRunId: null });
    harness.ctx.issues.get = async () => { throw new Error("host outage"); };
    const recordKey = `company|${COMPANY}|boat-offload-runs|flaky-run`;
    const indexKey = `company|${COMPANY}|boat-offload-runs|owners`;
    harness.state.set(recordKey, { version: 1, companyId: COMPANY, runId: "flaky-run",
      issueId: "issue-flaky", agentId: "agent-1", startedAt: clock - 25 * 60 * 60_000 });
    harness.state.set(indexKey, { version: 1, runs: ["flaky-run"] });
    const report = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(report.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toMatchObject({ runId: "flaky-run" });
    expect(harness.state.get(indexKey)).toEqual({ version: 1, runs: ["flaky-run"] });
    expect(await currentManager().localRunOwnedBy(COMPANY, "flaky-run", "agent-1")).toBe(false);
  });

  it("a sweep without an issues provider keeps the 25 h issue owner", async () => {
    // Same tri-state branch as a lookup failure: no provider means "unknown",
    // so the sweep retains the run instead of stranding a possibly-live one.
    setManagerOverridesForTests({ now: () => clock, sleep: async (ms: number) => { clock += ms; }, issues: null });
    harness = createFakeContext();
    await plugin.definition.setup(harness.ctx as never);
    const recordKey = `company|${COMPANY}|boat-offload-runs|flaky-run`;
    const indexKey = `company|${COMPANY}|boat-offload-runs|owners`;
    harness.state.set(recordKey, { version: 1, companyId: COMPANY, runId: "flaky-run",
      issueId: "issue-flaky", agentId: "agent-1", startedAt: clock - 25 * 60 * 60_000 });
    harness.state.set(indexKey, { version: 1, runs: ["flaky-run"] });
    const report = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(report.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toMatchObject({ runId: "flaky-run" });
    expect(harness.state.get(indexKey)).toEqual({ version: 1, runs: ["flaky-run"] });
  });

  it("a 25 h issue owner whose issue is gone is still swept", async () => {
    // A successful lookup that finds no issue is positive disproof, not a
    // transient failure: a deleted issue never reappears, so retaining the
    // row would repeat a futile host lookup on every sweep and leak it
    // forever. Only a thrown lookup error or a missing provider retains.
    const recordKey = `company|${COMPANY}|boat-offload-runs|gone-run`;
    const indexKey = `company|${COMPANY}|boat-offload-runs|owners`;
    harness.state.set(recordKey, { version: 1, companyId: COMPANY, runId: "gone-run",
      issueId: "issue-deleted", agentId: "agent-1", startedAt: clock - 25 * 60 * 60_000 });
    harness.state.set(indexKey, { version: 1, runs: ["gone-run"] });
    const report = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(report.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toBeUndefined();
    expect(harness.state.get(indexKey)).toBeUndefined();
  });

  it("a 25 h issue owner naming another run is still swept", async () => {
    // The fix must not retain every issue run: an issue that exists but names
    // a different run positively disproves liveness, so the sweep deletes it.
    harness.issues.set("issue-moved", { status: "open", executionRunId: "other-run", checkoutRunId: null });
    const recordKey = `company|${COMPANY}|boat-offload-runs|moved-run`;
    const indexKey = `company|${COMPANY}|boat-offload-runs|owners`;
    harness.state.set(recordKey, { version: 1, companyId: COMPANY, runId: "moved-run",
      issueId: "issue-moved", agentId: "agent-1", startedAt: clock - 25 * 60 * 60_000 });
    harness.state.set(indexKey, { version: 1, runs: ["moved-run"] });
    const report = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(report.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toBeUndefined();
    expect(harness.state.get(indexKey)).toBeUndefined();
  });

  it("a failed owner-row delete stays indexed for the next sweep", async () => {
    // The per-company index is the only enumeration source: dropping a run
    // whose row delete failed would orphan the row where no sweep finds it.
    const recordKey = `company|${COMPANY}|boat-offload-runs|old-run`;
    const indexKey = `company|${COMPANY}|boat-offload-runs|owners`;
    harness.state.set(recordKey, { version: 1, companyId: COMPANY, runId: "old-run",
      issueId: null, agentId: "agent-1", startedAt: clock - 25 * 60 * 60_000 });
    harness.state.set(indexKey, { version: 1, runs: ["old-run"] });
    const realDelete = harness.state.delete.bind(harness.state);
    let failNext = true;
    harness.state.delete = (key: string) => {
      if (failNext && key === recordKey) { failNext = false; throw new Error("state outage"); }
      return realDelete(key);
    };
    const report = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(report.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toMatchObject({ runId: "old-run" });
    expect(harness.state.get(indexKey)).toEqual({ version: 1, runs: ["old-run"] });
    const retry = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(retry.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toBeUndefined();
    expect(harness.state.get(indexKey)).toBeUndefined();
  });

  it("a failed terminal forget keeps the tombstone indexed for the next sweep", async () => {
    // The per-company index is the sweep's only enumeration source: when the
    // row delete fails, the ended tombstone must stay indexed so a later
    // sweep retries the delete instead of orphaning a row no sweep finds.
    const recordKey = `company|${COMPANY}|boat-offload-runs|ended-run`;
    const indexKey = `company|${COMPANY}|boat-offload-runs|owners`;
    harness.state.set(recordKey, { version: 1, companyId: COMPANY, runId: "ended-run",
      issueId: null, agentId: "agent-1", startedAt: clock - 25 * 60 * 60_000 });
    harness.state.set(indexKey, { version: 1, runs: ["ended-run"] });
    const realDelete = harness.state.delete.bind(harness.state);
    let failDeletes = true;
    harness.state.delete = (key: string) => {
      if (failDeletes && key === recordKey) throw new Error("state outage");
      return realDelete(key);
    };
    await currentManager().forgetLocalRun(COMPANY, "ended-run");
    expect(harness.state.get(recordKey)).toMatchObject({ ended: true });
    expect(harness.state.get(indexKey)).toEqual({ version: 1, runs: ["ended-run"] });
    failDeletes = false;
    const report = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(report.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toBeUndefined();
    expect(harness.state.get(indexKey)).toBeUndefined();
  });

  it("a 25 h old owner record is gone after the sweep", async () => {
    const recordKey = `company|${COMPANY}|boat-offload-runs|old-run`;
    const indexKey = `company|${COMPANY}|boat-offload-runs|owners`;
    harness.state.set(recordKey, { version: 1, companyId: COMPANY, runId: "old-run",
      issueId: null, agentId: "agent-1", startedAt: clock - 25 * 60 * 60_000 });
    harness.state.set(indexKey, { version: 1, runs: ["old-run"] });
    const report = await currentManager().sweep("test", { force: true, companyId: COMPANY });
    expect(report.errors).toEqual([]);
    expect(harness.state.get(recordKey)).toBeUndefined();
    expect(harness.state.get(indexKey)).toBeUndefined();
  });
});
