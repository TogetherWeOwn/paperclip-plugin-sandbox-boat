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
