import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat, trialLimits } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const measuredAt = "2026-10-23T07:14:00Z";
const rust = {
  default: { durationSeconds: 316, hourlyRate: 0.036, measuredAt, sampleCount: 1 },
  large: { durationSeconds: 182, hourlyRate: 0.072, measuredAt, sampleCount: 1 },
};
const waiting = {
  small: { durationSeconds: 300, hourlyRate: 0.018, measuredAt, sampleCount: 1 },
  default: { durationSeconds: 300, hourlyRate: 0.036, measuredAt, sampleCount: 1 },
};
const companyId = "company-size-policy";
const environmentId = "environment-size-policy";
const baseConfig = { apiKey: "boat_test_key_not_real", cliproxyTunnel: false };
const config = { ...baseConfig, taskClass: "waiting", sizeCostTable: { rust, waiting } };
let fake: FakeBoat;
let harness: ReturnType<typeof createFakeContext>;
let clock: number;

function base(raw: Record<string, unknown> = config) {
  return { companyId, environmentId, driverKey: "boat", config: raw };
}
async function acquire(runId = "run-1", raw: Record<string, unknown> = config, settings?: Record<string, unknown>) {
  return await plugin.definition.onEnvironmentAcquireLease!({
    ...base(raw), runId, issueId: "issue-size-policy", executionWorkspaceSettings: settings,
  });
}
async function release(lease: Awaited<ReturnType<typeof acquire>>) {
  return await plugin.definition.onEnvironmentReleaseLease!({
    ...base(), providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
  });
}

beforeEach(async () => {
  clock = Date.parse("2026-10-23T08:00:00Z");
  fake = new FakeBoat({ now: () => clock });
  const ssh = new FakeSsh();
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
  setManagerOverridesForTests({ now: () => clock, sleep: async (ms) => { clock += ms; } });
  harness = createFakeContext();
  await plugin.definition.setup(harness.ctx as never);
});
afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
});

describe("measured size config", () => {
  it("preserves the table and task class through config normalization", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({ taskClass: "waiting", sizeCostTable: { rust, waiting } });
  });

  it.each([0, -1, Infinity, NaN, "316", null])("rejects invalid measured durations (%s)", async (durationSeconds) => {
    const bad = { ...config, sizeCostTable: { rust: { default: { ...rust.default, durationSeconds } } } };
    const result = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: bad });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/sizeCostTable/);
  });

  it.each([
    { ...rust.default, hourlyRate: 0 },
    { ...rust.default, hourlyRate: -0.1 },
    { ...rust.default, measuredAt: "not-a-date" },
    { ...rust.default, sampleCount: 0 },
    { ...rust.default, sampleCount: 1.5 },
  ])("rejects unusable rate, timestamp or sample count", async (measurement) => {
    const bad = { ...config, sizeCostTable: { rust: { default: measurement } } };
    const result = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: bad });
    expect(result.ok).toBe(false);
  });

  it("refuses a malformed saved table before any Boat start", async () => {
    await expect(acquire("bad", { ...config, sizeCostTable: { rust: { tiny: rust.default } } })).rejects.toMatchObject({ code: "BOAT_SIZE_POLICY_INVALID" });
    expect(fake.callsOf("create")).toHaveLength(0);
    expect(fake.callsOf("resume")).toHaveLength(0);
  });
});

describe("size selection per lease", () => {
  it("chooses the lowest cost per job, not the fastest or lowest hourly price alone", async () => {
    const lease = await acquire("rust", { ...config, taskClass: "rust" });
    expect(lease.metadata).toMatchObject({ size: "default", taskClass: "rust", sizeChoice: { source: "measured", expectedCostDollars: 0.00316 } });
    expect(fake.callsOf("create")[0].args.type).toBe("default");
  });

  it("chooses small for a measured waiting task and logs its expected cost", async () => {
    const lease = await acquire();
    expect(lease.metadata).toMatchObject({ size: "small", taskClass: "waiting", sizeChoice: { expectedCostDollars: expect.closeTo(0.0015, 12) } });
    expect(fake.callsOf("create")[0].args.type).toBe("small");
    expect(harness.logs).toEqual(expect.arrayContaining([expect.objectContaining({
      message: "boat: size choice for lease",
      meta: expect.objectContaining({ taskClass: "waiting", size: "small", expectedCostDollars: expect.closeTo(0.0015, 12), source: "measured" }),
    })]));
  });

  it("uses the per-workspace class instead of the environment class", async () => {
    const lease = await acquire("override", config, { boatTaskClass: "rust" });
    expect(lease.metadata).toMatchObject({ taskClass: "rust", size: "default" });
  });

  it.each([{}, { taskClass: "unknown", sizeCostTable: { rust } }, { taskClass: "empty", sizeCostTable: { empty: {} } }])("falls back to default with no class measurements", async (raw) => {
    const lease = await acquire("fallback", { ...baseConfig, ...raw });
    expect(lease.metadata).toMatchObject({ size: "default", sizeChoice: { source: "fallback", expectedCostDollars: null } });
  });

  it("preserves an explicit configured fallback size for existing environments", async () => {
    const lease = await acquire("fallback-small", { ...baseConfig, size: "small" });
    expect(lease.metadata).toMatchObject({ size: "small", sizeChoice: { source: "fallback" } });
  });

  it("prefers faster measured work when expected job costs are equal", async () => {
    fake.limitsResponse = trialLimits({ machineTypes: [{ type: "large", available: true }] });
    const lease = await acquire("tie", { ...config, sizeCostTable: { waiting: {
      default: { ...waiting.default, durationSeconds: 360 },
      large: { ...waiting.default, durationSeconds: 180, hourlyRate: 0.072 },
    } } });
    expect(lease.metadata).toMatchObject({ size: "large", sizeChoice: { expectedCostDollars: 0.0036 } });
  });

  it("resizes a stopped card on its next acquisition without creating another VM", async () => {
    const first = await acquire("first", { ...config, taskClass: "rust" });
    await release(first);
    const second = await acquire("second");
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(fake.callsOf("resume")[0].args.type).toBe("small");
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(second.metadata?.size).toBe("small");
  });

  it("does not resize a running shared VM or misreport its accounting size", async () => {
    const first = await acquire();
    const second = await acquire("second", { ...config, taskClass: "rust" });
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ size: "small", sizeChoice: { source: "running_vm", expectedCostDollars: null } });
    expect(fake.callsOf("resume")).toHaveLength(0);
    const summary = await currentManager().usageSummary(companyId);
    expect(summary.vms[0].runs).toEqual(expect.arrayContaining([expect.objectContaining({ runId: "second", size: "small" })]));
  });

  it("applies the policy to a reusable lease resume using the persisted class", async () => {
    const first = await acquire("first", { ...config, taskClass: "rust" });
    await release(first);
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      ...base({ ...config, sizeCostTable: { rust: waiting } }),
      providerLeaseId: first.providerLeaseId!, leaseMetadata: first.metadata,
    });
    expect(fake.callsOf("resume")[0].args.type).toBe("small");
    expect(lease.metadata).toMatchObject({ size: "small", taskClass: "rust", sizeChoice: { source: "measured", expectedCostDollars: expect.closeTo(0.0015, 12) } });
    const summary = await currentManager().usageSummary(companyId);
    expect(summary.vms[0]).toMatchObject({ size: "small" });
    expect(summary.vms[0].runs.at(-1)).toMatchObject({ size: "small" });
  });

  it("explicitly requests the chosen size when an archived VM omits its type", async () => {
    const first = await acquire("first", { ...config, taskClass: "rust" });
    await release(first);
    fake.boxes.get(first.providerLeaseId!)!.type = "";
    const second = await acquire("second");
    expect(fake.callsOf("resume")[0].args.type).toBe("small");
    expect(second.metadata?.size).toBe("small");
  });

  it("fails closed on an unknown running size instead of recording a guessed size", async () => {
    const first = await acquire();
    fake.boxes.get(first.providerLeaseId!)!.type = "future-type";
    await expect(acquire("second")).rejects.toMatchObject({ code: "BOAT_SIZE_UNKNOWN" });
    expect(fake.callsOf("resume")).toHaveLength(0);
    expect(fake.callsOf("stop")).toHaveLength(0);
  });

  it("fails closed when a reusable running lease has an unknown size", async () => {
    const first = await acquire();
    fake.boxes.get(first.providerLeaseId!)!.type = "future-type";
    await expect(plugin.definition.onEnvironmentResumeLease!({
      ...base(), providerLeaseId: first.providerLeaseId!, leaseMetadata: first.metadata,
    })).rejects.toMatchObject({ code: "BOAT_SIZE_UNKNOWN" });
  });

  it("still refuses the daily start limit after selecting a cheaper size", async () => {
    fake.limitsResponse = trialLimits({ starts: { day: { limit: 75, used: 70, remaining: 5 } } });
    await expect(acquire()).rejects.toMatchObject({ code: "BOAT_BUDGET_GUARD", limit: "maxStartsPerDay" });
    expect(fake.callsOf("create")).toHaveLength(0);
  });

  it("does not bypass a plan restriction or try another size after refusal", async () => {
    await expect(acquire("large", { ...config, sizeCostTable: { waiting: { large: { ...waiting.default, durationSeconds: 1, hourlyRate: 0.072 } } } })).rejects.toMatchObject({ code: "BOAT_BUDGET_GUARD", limit: "machineType" });
    expect(fake.callsOf("create")).toHaveLength(0);
    expect(fake.callsOf("resume")).toHaveLength(0);
  });
});
