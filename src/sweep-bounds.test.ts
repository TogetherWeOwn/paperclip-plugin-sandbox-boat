// The sweep is single-flight, so anything that can hang inside it — a stalled
// Boat API stream, a blocked offload broker chain — would freeze every later
// sweep and stop idle-VM stops globally. These tests pin the bounds: request
// timeouts surface as sweep errors, offload upkeep cannot delay whole-run
// stops, and an overall deadline frees single-flight for a fresh sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { createSdkBoatApi, setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { parseDriverConfig } from "./config.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const companyId = "company-sweep-bounds";
const environmentId = "environment-sweep-bounds";
const baseConfig = { apiKey: "boat_test_key_not_real", cliproxyTunnel: false };
let fake: FakeBoat;
let ssh: FakeSsh;
let clock: number;
let harness: ReturnType<typeof createFakeContext>;

async function acquireAndRun(runId = "run-1", issueId = "issue-sweep-bounds") {
  const lease = await plugin.definition.onEnvironmentAcquireLease!({
    companyId,
    environmentId,
    driverKey: "boat",
    config: baseConfig,
    runId,
    issueId,
  });
  await currentManager().sweepInFlight();
  const ran = await plugin.definition.onEnvironmentExecute!({
    companyId, environmentId, driverKey: "boat", config: baseConfig, lease,
    command: "true", args: [], env: {},
  });
  expect(ran.exitCode).toBe(0);
  return lease;
}

/**
 * Block every read of the offload brokers' journal state: collectGarbage (and
 * any pool upkeep reading the same namespace) never settles until released.
 */
function blockOffloadReads() {
  const state = harness.ctx.state as unknown as {
    get: (input: { namespace?: string }) => Promise<unknown>;
  };
  const originalGet = state.get.bind(harness.ctx.state);
  const blocked: Array<() => void> = [];
  state.get = (input) =>
    input.namespace === "boat-offload"
      ? new Promise<unknown>((resolve) => blocked.push(() => void originalGet(input).then(resolve)))
      : originalGet(input);
  return () => {
    // Release the blocked reads so the broker chains settle and shutdown can drain.
    state.get = originalGet;
    for (const release of blocked) release();
  };
}

beforeEach(async () => {
  clock = Date.parse("2026-10-23T08:00:00Z");
  fake = new FakeBoat({ now: () => clock });
  ssh = new FakeSsh();
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
  setManagerOverridesForTests({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sweepDeadlineMs: 1_000,
    offloadUpkeepTimeoutMs: 50,
    sweepVmTimeoutMs: 200,
  });
  harness = createFakeContext();
  await plugin.definition.setup(harness.ctx as never);
});
afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
});

describe("sweep bounds", () => {
  it("settles within the request timeout when the Boat API fetch never resolves, and the next sweep runs fresh", async () => {
    await acquireAndRun();
    const calls: string[] = [];
    const hangingFetch = async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input));
      return new Promise<Response>(() => {});
    };
    setBoatApiFactoryForTests((input) =>
      createSdkBoatApi({ ...input, fetchApi: hangingFetch, requestTimeoutMs: 40, longRequestTimeoutMs: 40 }),
    );
    const started = Date.now();
    const report = await currentManager().sweep("schedule", { force: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.errors.some((entry) => entry.startsWith("list:"))).toBe(true);
    const firstRunCalls = calls.length;
    expect(firstRunCalls).toBeGreaterThan(0);

    // Not coalesced onto the stuck sweep: a second sweep starts a fresh doSweep.
    const second = await currentManager().sweep("schedule", { force: true });
    expect(calls.length).toBeGreaterThan(firstRunCalls);
    expect(second.errors.some((entry) => entry.startsWith("list:"))).toBe(true);

    // And once the provider answers again, the sweep works as before.
    setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
    const recovered = await currentManager().sweep("schedule", { force: true });
    expect(recovered.errors.some((entry) => entry.startsWith("list:"))).toBe(false);
  });

  it("still stops idle whole-run VMs when broker garbage collection is blocked", async () => {
    const lease = await acquireAndRun();
    const releaseReads = blockOffloadReads();

    clock += 21 * 60_000; // past idle/stale thresholds, command long finished
    const started = Date.now();
    const report = await currentManager().sweep("schedule", { force: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.stopped).toEqual([lease.providerLeaseId]);
    expect(report.errors).toContain("offload broker retention unverified");
    releaseReads();
  });

  it("bounds all blocked broker upkeep collectively so many companies cannot starve VM stops", async () => {
    const lease = await acquireAndRun();
    // Register many more companies whose broker GCs will all block. A bound
    // per company, awaited in sequence, would spend 25+ × 50 ms of upkeep
    // before any VM is examined — past the 1 s sweep deadline — and every
    // later sweep would repeat the same sequence without reaching VM stops.
    for (let i = 0; i < 25; i++) {
      currentManager().rememberConfig(`company-upkeep-${i}`, `environment-upkeep-${i}`, parseDriverConfig(baseConfig));
    }
    const releaseReads = blockOffloadReads();

    clock += 21 * 60_000;
    const started = Date.now();
    const report = await currentManager().sweep("schedule", { force: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.stopped).toEqual([lease.providerLeaseId]);
    expect(report.errors.filter((entry) => entry === "offload broker retention unverified")).toHaveLength(26);
    releaseReads();
  });

  it("skips a VM whose locked stop never settles and still stops later VMs", async () => {
    const stuck = await acquireAndRun("run-stuck", "issue-sweep-stuck");
    const later = await acquireAndRun("run-later", "issue-sweep-later");
    // The first VM's stop hangs inside its card lock forever (a provider or
    // state call that never settles). The abandoned work keeps that lock, so
    // the sweep must give up on this VM within the per-VM bound and move on —
    // in this pass and in later passes — instead of queueing on the lock.
    const originalStop = fake.stop.bind(fake);
    fake.stop = (async (args: Record<string, unknown>) =>
      String(args.sandboxId) === stuck.providerLeaseId ? new Promise<never>(() => {}) : originalStop(args)) as typeof fake.stop;

    clock += 21 * 60_000;
    const started = Date.now();
    const report = await currentManager().sweep("schedule", { force: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.stopped).toEqual([later.providerLeaseId]);
    expect(report.errors.some((entry) => entry.includes(String(stuck.providerLeaseId)))).toBe(true);

    const second = await currentManager().sweep("schedule", { force: true });
    expect(second.stopped).toEqual([]);
    expect(second.errors.some((entry) => entry.includes(String(stuck.providerLeaseId)))).toBe(true);
  });

  it("rejects at the sweep deadline when a provider call hangs, then sweeps cleanly", async () => {
    await acquireAndRun();
    const original = fake.sandboxes.bind(fake);
    fake.sandboxes = (async () => new Promise<never>(() => {})) as typeof fake.sandboxes;
    const started = Date.now();
    await expect(currentManager().sweep("schedule", { force: true })).rejects.toThrow(/did not settle within 1000 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);

    fake.sandboxes = original as typeof fake.sandboxes;
    const recovered = await currentManager().sweep("schedule", { force: true });
    expect(recovered.errors.some((entry) => entry.startsWith("list:"))).toBe(false);
  });
});
