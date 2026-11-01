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
const small = { durationSeconds: 300, hourlyRate: 0.018, measuredAt, sampleCount: 1 };
const standard = { durationSeconds: 300, hourlyRate: 0.036, measuredAt, sampleCount: 1 };
const large = { durationSeconds: 1, hourlyRate: 0.072, measuredAt, sampleCount: 1 };
const companyId = "company-size-retention";
const environmentId = "environment-size-retention";
const config = {
  apiKey: "boat_test_key_not_real",
  cliproxyTunnel: false,
  size: "small",
  taskClass: "waiting",
  sizeCostTable: { rust: { default: standard }, waiting: { small, default: standard } },
};
const paths = ["acquire", "reusable resume"] as const;
type LeasePath = typeof paths[number];
let fake: FakeBoat;
let ssh: FakeSsh;
let clock: number;

function base(raw: Record<string, unknown> = config) {
  return { companyId, environmentId, driverKey: "boat", config: raw };
}

async function acquire(runId: string, raw: Record<string, unknown> = config, settings?: Record<string, unknown>) {
  return await plugin.definition.onEnvironmentAcquireLease!({
    ...base(raw), runId, issueId: "issue-size-retention", agentId: "agent-1", executionWorkspaceSettings: settings,
  });
}

type Lease = Awaited<ReturnType<typeof acquire>>;

async function releasedVm(size: "default" | "large" = "default") {
  if (size === "large") {
    fake.limitsResponse = trialLimits({ machineTypes: [{ type: "large", available: true }] });
  }
  const raw = size === "large"
    ? { ...config, sizeCostTable: { ...config.sizeCostTable, rust: { large } } }
    : config;
  const first = await acquire("initial-rust", raw, { boatTaskClass: "rust" });
  expect(first.metadata).toMatchObject({ size, taskClass: "rust" });
  clock += 60_000;
  await plugin.definition.onEnvironmentReleaseLease!({
    ...base(raw), providerLeaseId: first.providerLeaseId, leaseMetadata: first.metadata,
  });
  expect(ssh.masters().every((master) => master.child.killed)).toBe(true);
  fake.limitsResponse = trialLimits();
  fake.boxes.get(first.providerLeaseId!)!.state = "error";
  clock += 60_000;
  return first;
}

async function restart(path: LeasePath, first: Lease, measurements: Record<string, typeof standard> = { small, default: standard }) {
  if (path === "acquire") {
    return await acquire("next-waiting", {
      ...config, sizeCostTable: { ...config.sizeCostTable, waiting: measurements },
    });
  }
  // The environment says waiting, but the reusable lease's persisted class is rust.
  return await plugin.definition.onEnvironmentResumeLease!({
    ...base({ ...config, sizeCostTable: { rust: measurements } }),
    issueId: "issue-size-retention", providerLeaseId: first.providerLeaseId!, leaseMetadata: first.metadata,
  });
}

beforeEach(async () => {
  clock = Date.parse("2026-10-23T08:00:00Z");
  fake = new FakeBoat({ now: () => clock });
  ssh = new FakeSsh();
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
  setManagerOverridesForTests({ now: () => clock, sleep: async (ms) => { clock += ms; } });
  const harness = createFakeContext({
    issues: new Map([["issue-size-retention", { status: "in_progress", executionWorkspaceSettings: {} }]]),
  });
  await plugin.definition.setup(harness.ctx as never);
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
});

describe.each(paths)("non-archived actual-size retention: %s", (path) => {
  it("keeps an error-state default VM's lease, cost and new run accounting at default when small is cheaper", async () => {
    const first = await releasedVm();
    const before = await currentManager().usageSummary(companyId);
    expect(before.vms[0].runs).toHaveLength(1);
    const lease = await restart(path, first);

    expect.soft(lease.providerLeaseId).toBe(first.providerLeaseId);
    expect.soft(fake.callsOf("create")).toHaveLength(1);
    expect.soft(fake.callsOf("resume")).toHaveLength(1);
    expect.soft(fake.callsOf("resume")[0].args).not.toHaveProperty("type");
    expect.soft(fake.boxes.get(first.providerLeaseId!)?.type).toBe("default");
    expect.soft(lease.metadata).toMatchObject({
      size: "default",
      taskClass: path === "acquire" ? "waiting" : "rust",
      sizeChoice: { size: "default", expectedCostDollars: expect.closeTo(0.003, 12) },
    });
    const summary = await currentManager().usageSummary(companyId);
    expect.soft(summary.vms[0]).toMatchObject({ size: "default" });
    expect.soft(summary.vms[0].runs).toHaveLength(2);
    expect.soft(summary.vms[0].runs[0]).toMatchObject({ size: "default", endedAt: expect.any(String) });
    expect.soft(summary.vms[0].runs.at(-1)).toMatchObject({
      size: "default", endedAt: null,
    });
    expect.soft(summary.vms[0].runs.at(-1)).not.toMatchObject({ runId: "initial-rust" });
  });

  it("refuses the actual disallowed large VM before resume even when small is cheapest", async () => {
    const first = await releasedVm("large");
    await expect(restart(path, first)).rejects.toMatchObject({
      code: "BOAT_BUDGET_GUARD", limit: "machineType",
    });
    expect(fake.callsOf("resume")).toHaveLength(0);
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(fake.boxes.get(first.providerLeaseId!)).toMatchObject({ type: "large", state: "error" });
    const summary = await currentManager().usageSummary(companyId);
    expect(summary.vms[0]).toMatchObject({ size: "large" });
    expect(summary.vms[0].runs).toHaveLength(1);
  });

  it("resumes an allowed actual default VM rather than refusing a disallowed cheapest large choice", async () => {
    const first = await releasedVm();
    const lease = await restart(path, first, { small, default: standard, large });
    expect(lease.providerLeaseId).toBe(first.providerLeaseId);
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(fake.callsOf("resume")[0].args).not.toHaveProperty("type");
    expect(fake.boxes.get(first.providerLeaseId!)).toMatchObject({ type: "default", state: "ready" });
    expect.soft(lease.metadata).toMatchObject({ size: "default" });
    const summary = await currentManager().usageSummary(companyId);
    expect.soft(summary.vms[0]).toMatchObject({ size: "default" });
    expect.soft(summary.vms[0].runs).toHaveLength(2);
    expect.soft(summary.vms[0].runs.at(-1)).toMatchObject({ size: "default", endedAt: null });
  });
});

describe("mid-lease reconnect", () => {
  it("keeps the selected default size after SSH shutdown and archive despite a small configured fallback", async () => {
    const lease = await acquire("reconnect-rust", config, { boatTaskClass: "rust" });
    expect(lease.metadata).toMatchObject({ size: "default", taskClass: "rust" });
    expect(fake.boxes.get(lease.providerLeaseId!)?.type).toBe("default");
    await currentManager().shutdown();
    expect(ssh.masters().every((master) => master.child.killed)).toBe(true);
    fake.boxes.get(lease.providerLeaseId!)!.state = "archived";
    clock += 60_000;

    const result = await plugin.definition.onEnvironmentExecute!({
      ...base(), lease, command: "true",
    } as never);

    expect(result.exitCode).toBe(0);
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect.soft(fake.callsOf("resume")[0].args).not.toHaveProperty("type");
    expect.soft(fake.boxes.get(lease.providerLeaseId!)).toMatchObject({ type: "default", state: "ready" });
    const summary = await currentManager().usageSummary(companyId);
    expect.soft(summary.vms[0]).toMatchObject({ size: "default" });
    expect.soft(summary.vms[0].runs).toHaveLength(1);
    expect.soft(summary.vms[0].runs[0]).toMatchObject({ runId: "reconnect-rust", size: "default" });
  });
});
