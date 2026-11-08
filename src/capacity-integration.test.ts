import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBoatApiFactoryForTests, type BoatApiLike } from "./boat-client.js";
import { DEFAULT_API_BASE, parseDriverConfig } from "./config.js";
import { SWEEP_JOB_KEY } from "./manifest.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { VmStateStore } from "./state.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { createFakeContext } from "./test-support/harness.js";

const COMPANY = "company-capacity";
const KEY = "boat_capacity_key_not_real";
const ACCOUNT_DIGEST = scryptSync(KEY, `boat-offload-pool\u0000${DEFAULT_API_BASE}`, 32).toString("hex");
let clock: number;
let fake: FakeBoat;
let harness: ReturnType<typeof createFakeContext>;
let hostKey: string | undefined;

function limits() {
  return {
    ok: true,
    planIncluded: { vmHours: 555.56, vmHoursRemaining: 552, periodEnd: new Date(clock + 30 * 86_400_000) },
    starts: {
      unlimited: false,
      minute: { used: 0, limit: 12, remaining: 12 },
      hour: { used: 0, limit: 60, remaining: 60 },
      day: { used: 160, limit: 200, remaining: 40 },
    },
    activeSandboxes: 0, maxActiveSandboxes: 100, canStart: true,
  };
}

beforeEach(async () => {
  clock = Date.parse("2026-11-08T02:00:00Z");
  fake = new FakeBoat({ now: () => clock });
  fake.limitsResponse = limits();
  hostKey = process.env.BOAT_API_KEY;
  process.env.BOAT_API_KEY = KEY;
  setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
  setManagerOverridesForTests({ now: () => clock });
  harness = createFakeContext();
  await plugin.definition.setup(harness.ctx as never);
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
  vi.restoreAllMocks();
  if (hostKey === undefined) delete process.env.BOAT_API_KEY;
  else process.env.BOAT_API_KEY = hostKey;
});

describe("scheduled capacity telemetry", () => {
  it("samples after cleanup through the existing job and exposes reports without provider reads on GET", async () => {
    const manager = currentManager();
    manager.rememberConfig(COMPANY, "environment", parseDriverConfig({ apiKey: KEY }));
    const sweep = vi.spyOn(manager, "sweep").mockResolvedValue({ skipped: null, stopped: [], deleted: [], forgotten: [], errors: [] });
    const sample = vi.spyOn(manager, "sampleCapacity");
    await harness.jobs.get(SWEEP_JOB_KEY)!({});
    expect(sweep).toHaveBeenCalledWith("schedule");
    expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(sample.mock.invocationCallOrder[0]);
    expect(fake.callsOf("limits")).toHaveLength(1);
    const summary = await manager.usageSummary(COMPANY, { refresh: false });
    expect(summary.capacity.error).toBeNull();
    expect(summary.capacity.accounts).toEqual([expect.objectContaining({
      status: "insufficient", warningReasons: ["start_day_pressure"],
      plan: expect.objectContaining({ vmHoursRemaining: 552 }),
    })]);
    expect(fake.callsOf("limits")).toHaveLength(1);
    expect((await manager.usageSummary("other-company")).capacity.accounts).toEqual([]);
    const evidence = JSON.stringify([summary, [...harness.state.values()], harness.logs]);
    expect(evidence).not.toContain(KEY);
    for (const action of ["create", "fork", "resume", "stop", "update", "deleteSandbox"]) expect(fake.callsOf(action)).toEqual([]);
  });

  it("deduplicates warnings and does not present a provider read failure as fresh", async () => {
    const manager = currentManager();
    manager.rememberConfig(COMPANY, "environment", parseDriverConfig({ apiKey: KEY }));
    manager.rememberConfig(COMPANY, "same-account", parseDriverConfig({ apiKey: KEY }));
    await manager.sampleCapacity();
    clock += 5 * 60_000;
    await manager.sampleCapacity();
    expect(fake.callsOf("limits")).toHaveLength(2);
    expect(harness.logs.filter((log) => log.message.includes("capacity warning"))).toHaveLength(1);
    fake.failNext("limits", new Error(`provider transport error ${KEY}`));
    clock += 5 * 60_000;
    await manager.sampleCapacity();
    const summary = await manager.usageSummary(COMPANY);
    expect(summary.capacity.accounts[0].status).toBe("unavailable");
    expect(summary.capacity.accounts[0].reasons).toEqual(["limits_read_failed"]);
    expect(JSON.stringify(harness.logs)).not.toContain(KEY);
  });

  it("persists a source discovery failure without discarding the last numeric evidence", async () => {
    const manager = currentManager();
    manager.rememberConfig(COMPANY, "environment", parseDriverConfig({ apiKey: KEY }));
    await manager.sampleCapacity();
    const get = harness.ctx.state.get.bind(harness.ctx.state);
    const failure = vi.spyOn(harness.ctx.state, "get").mockImplementation(async (input) => {
      if (input.stateKey === "offload.pools") throw new Error(`source read error ${KEY}`);
      return get(input);
    });
    clock += 5 * 60_000;
    await manager.sampleCapacity();
    const summary = await manager.usageSummary(COMPANY);
    expect(summary.capacity.error).toBe("sources_read_failed");
    expect(summary.capacity.accounts[0]).toMatchObject({
      status: "unavailable", reasons: expect.arrayContaining(["sources_read_failed"]),
      plan: { vmHoursRemaining: 552 }, observedAtMs: clock - 5 * 60_000,
    });
    const stored = await get({ scopeKind: "company", scopeId: COMPANY, namespace: "capacity", stateKey: "samples" }) as {
      accounts: Record<string, { report: { status: string; reasons: string[] } }>;
    };
    expect(Object.values(stored.accounts)[0].report).toMatchObject({
      status: "unavailable", reasons: expect.arrayContaining(["sources_read_failed"]),
    });
    expect((await manager.usageSummary("other-company")).capacity).toEqual({ accounts: [], error: null });
    expect(JSON.stringify(harness.logs)).not.toContain(KEY);
    failure.mockRestore();
    await manager.sampleCapacity();
    expect((await manager.usageSummary(COMPANY)).capacity.error).toBeNull();
    expect((await manager.usageSummary(COMPANY)).capacity.accounts[0].status).toBe("insufficient");
  });

  it("exposes a failed sample write to usage readers until a later sample is stored", async () => {
    const manager = currentManager();
    manager.rememberConfig(COMPANY, "environment", parseDriverConfig({ apiKey: KEY }));
    await manager.sampleCapacity();
    const set = harness.ctx.state.set.bind(harness.ctx.state);
    const failure = vi.spyOn(harness.ctx.state, "set").mockImplementation(async (input, value) => {
      if (input.namespace === "capacity") throw new Error(`state write error ${KEY}`);
      return set(input, value);
    });
    fake.limitsResponse = { ...limits(), activeSandboxes: 90 };
    clock += 5 * 60_000;
    await manager.sampleCapacity();
    const summary = await manager.usageSummary(COMPANY);
    expect(summary.capacity.error).toBe("state_write_failed");
    expect(summary.capacity.accounts[0]).toMatchObject({
      status: "unavailable", reasons: expect.arrayContaining(["state_write_failed"]),
      plan: { vmHoursRemaining: 552 }, observedAtMs: clock - 5 * 60_000,
    });
    expect((await manager.usageSummary("other-company")).capacity.error).toBeNull();
    failure.mockRestore();
    await manager.sampleCapacity();
    const recovered = await manager.usageSummary(COMPANY);
    expect(recovered.capacity.error).toBeNull();
    expect(recovered.capacity.accounts[0].warningReasons).toContain("active_sandboxes_pressure");
    expect(JSON.stringify(harness.logs)).not.toContain(KEY);
  });

  it("labels stored reports stale if sampling stops", async () => {
    const manager = currentManager();
    manager.rememberConfig(COMPANY, "environment", parseDriverConfig({ apiKey: KEY }));
    await manager.sampleCapacity();
    clock += 16 * 60_000;
    const summary = await manager.usageSummary(COMPANY);
    expect(summary.capacity.accounts[0].status).toBe("unavailable");
    expect(summary.capacity.accounts[0].reasons).toContain("stale_observation");
  });

  it("reports unreadable telemetry separately without hiding existing usage", async () => {
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, namespace: "capacity", stateKey: "samples" }, { version: 99 });
    const summary = await currentManager().usageSummary(COMPANY);
    expect(summary.capacity).toEqual({ accounts: [], error: "state_unavailable" });
    expect(summary.totals.vms).toBe(0);
  });

  it("rehydrates an offload-only account from matching recorded provenance, never a foreign account", async () => {
    await new VmStateStore(harness.ctx.state).rememberCompany(COMPANY);
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, namespace: "boat-offload", stateKey: "offload.pools" }, {
      pool: { artifactRoot: "/unused", seenAt: clock, credentialDigest: ACCOUNT_DIGEST },
    });
    await currentManager().sampleCapacity();
    expect(fake.callsOf("limits")).toHaveLength(1);
    expect((await currentManager().usageSummary(COMPANY)).capacity.accounts).toHaveLength(1);
    await new VmStateStore(harness.ctx.state).rememberCompany("foreign-company");
    await harness.ctx.state.set({ scopeKind: "company", scopeId: "foreign-company", namespace: "boat-offload", stateKey: "offload.pools" }, {
      pool: { artifactRoot: "/unused", seenAt: clock, credentialDigest: "a".repeat(64) },
    });
    await currentManager().sampleCapacity();
    expect(fake.callsOf("limits")).toHaveLength(2); // the verified company only
    expect((await currentManager().usageSummary("foreign-company")).capacity.accounts).toEqual([]);
  });

  it("does not enroll a keyless live binding under a rotated host credential", async () => {
    const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: {} as never, accountId: "test-account" });
    const realization = (apiKey: string | null) => ({
      companyId: COMPANY, environmentId: "local-environment", config: { apiKey },
      workspace: { localPath: "/tmp/native-source", metadata: { workspaceRealizationRequest: {
        version: 1, companyId: COMPANY, environmentId: "local-environment",
        heartbeatRunId: "native-run", executionWorkspaceId: "native-workspace",
        source: { localPath: "/tmp/native-source", repoUrl: "https://github.com/example/source" },
      } } },
    });
    runtime.remember(realization(null) as never);
    process.env.BOAT_API_KEY = "boat_rotated_other_account_not_real";
    expect(await runtime.capacitySources(COMPANY)).toEqual([]);
    runtime.remember(realization(KEY) as never);
    expect(await runtime.capacitySources(COMPANY)).toHaveLength(1);
    expect(await runtime.capacitySources("other-company")).toEqual([]);
    await runtime.shutdown();
  });

  it("does not infer an account from an unmarked legacy pool or another company", async () => {
    const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger, ssh: {} as never, accountId: "test-account" });
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, namespace: "boat-offload", stateKey: "offload.pools" }, {
      pool: { artifactRoot: "/unused", seenAt: clock },
    });
    expect(await runtime.capacitySources(COMPANY)).toEqual([]);
    expect(await runtime.capacitySources("other-company")).toEqual([]);
    expect(fake.callsOf("limits")).toEqual([]);
    await runtime.shutdown();
  });
});
