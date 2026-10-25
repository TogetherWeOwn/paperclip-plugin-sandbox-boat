import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { parseDriverConfig, validateDriverConfig } from "./config.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { FakeSsh, MockChild, createFakeContext } from "./test-support/harness.js";

const companyId = "company-idle-efficiency";
const environmentId = "environment-idle-efficiency";
const baseConfig = { apiKey: "boat_test_key_not_real", cliproxyTunnel: false };
let fake: FakeBoat;
let ssh: FakeSsh;
let clock: number;

async function acquire(runId = "run-1", raw: Record<string, unknown> = baseConfig) {
  return await plugin.definition.onEnvironmentAcquireLease!({
    companyId,
    environmentId,
    driverKey: "boat",
    config: raw,
    runId,
    issueId: "issue-idle-efficiency",
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
  const harness = createFakeContext();
  await plugin.definition.setup(harness.ctx as never);
});
afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
});

describe("idle efficiency defaults", () => {
  it("stops idle VMs after 5 minutes and stale leases after 20 minutes", () => {
    expect(parseDriverConfig({})).toMatchObject({
      idleStopMinutes: 5,
      staleLeaseMinutes: 20,
    });
  });

  it("keeps staleLeaseMinutes above idleStopMinutes, so the defaults validate", () => {
    const config = parseDriverConfig({ apiKey: "k" });
    expect(config.staleLeaseMinutes).toBeGreaterThanOrEqual(config.idleStopMinutes);
    expect(validateDriverConfig(config, { apiKey: "k" }).errors).toEqual([]);
  });

  it("defaults light work to small while an explicit default size is preserved for heavy builds", () => {
    expect(parseDriverConfig({}).size).toBe("small");
    expect(parseDriverConfig({ size: "default" }).size).toBe("default");
  });

  it("creates managed VMs with monitoring on", async () => {
    const lease = await acquire();
    const create = fake.callsOf("create");
    expect(create).toHaveLength(1);
    expect(create[0].args).toMatchObject({ type: "small", monitoring: true });
    expect(lease.metadata).toMatchObject({ size: "small" });
  });

  it("preserves an installed environment's explicit pre-upgrade defaults", async () => {
    const raw = { ...baseConfig, size: "default", idleStopMinutes: 15, staleLeaseMinutes: 60, reuseLease: true };
    const result = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: raw });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject(raw);
  });

  it("does not stop a silent command past the stale threshold, but reclaims its idle lease after it finishes", async () => {
    const lease = await acquire();
    await currentManager().sweepInFlight();
    const payload = new MockChild();
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    spawnMock.mockImplementation((command: string, args: string[], options?: { stdio?: unknown[] }) => {
      if (command === "ssh" && args.at(-1)?.includes("review-silent-command")) {
        started();
        return payload;
      }
      return ssh.spawn(command, args, options);
    });
    const executing = plugin.definition.onEnvironmentExecute!({
      companyId, environmentId, driverKey: "boat", config: baseConfig, lease,
      command: "review-silent-command", args: [], env: {}, timeoutMs: 3_600_000,
    });
    try {
      await reached;
      clock += 21 * 60_000;
      expect((await currentManager().sweep("silent-command", { force: true })).stopped).toEqual([]);
      expect(fake.callsOf("stop")).toHaveLength(0);
      const concurrent = await plugin.definition.onEnvironmentExecute!({
        companyId, environmentId, driverKey: "boat", config: baseConfig, lease,
        command: "review-concurrent-command", args: [], env: {},
      });
      expect(concurrent.exitCode).toBe(0);
    } finally {
      payload.finish(0);
      await executing;
    }
    expect((await currentManager().sweep("just-finished", { force: true })).stopped).toEqual([]);
    clock += 21 * 60_000;
    expect((await currentManager().sweep("stale-after-finish", { force: true })).stopped).toEqual([lease.providerLeaseId]);
  });

  it.each(["execute", "sync-in", "sync-out"] as const)("admits %s only after an idle sweep finishes scrubbing and stopping its VM", async (kind) => {
    const lease = await acquire();
    await currentManager().sweepInFlight();
    clock += 21 * 60_000;
    const scrub = new MockChild();
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => { paused = resolve; });
    let gateScrub = true;
    spawnMock.mockImplementation((command: string, args: string[], options?: { stdio?: unknown[] }) => {
      const remote = args.at(-1) ?? "";
      if (command === "ssh" && gateScrub && remote.includes("paperclip-boat-scrub")) {
        gateScrub = false;
        paused();
        return scrub;
      }
      return ssh.spawn(command, args, options);
    });
    const sweeping = currentManager().sweep("command-admission", { force: true });
    await reached;
    const params = { companyId, environmentId, driverKey: "boat", config: baseConfig, lease };
    const executing = kind === "execute"
      ? plugin.definition.onEnvironmentExecute!({ ...params, command: "review-arriving-command", args: [], env: {} })
      : plugin.definition[kind === "sync-in" ? "onEnvironmentSyncIn" : "onEnvironmentSyncOut"]!({ ...params, operations: [] });
    let settled = false;
    void executing.then(() => { settled = true; }, () => { settled = true; });
    try {
      // Drain asynchronous SSH and state work while the scrub deliberately holds the sweep lock.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect.soft(settled, "work must wait while its VM is being scrubbed for a stop").toBe(false);
    } finally {
      scrub.finish(0, "paperclip-boat-scrub found=0 left=0 walk=complete\n");
    }
    expect((await sweeping).stopped).toEqual([lease.providerLeaseId]);
    expect(await executing).toMatchObject(kind === "execute" ? { exitCode: 0 } : { operations: [] });
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("ready");
  });

  it("creates a heavy-build VM at the explicitly configured default size with monitoring on", async () => {
    const lease = await acquire("run-heavy", { ...baseConfig, size: "default" });
    expect(fake.callsOf("create")[0].args).toMatchObject({ type: "default", monitoring: true });
    expect(lease.metadata).toMatchObject({ size: "default" });
  });
});
