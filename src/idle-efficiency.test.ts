import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { parseDriverConfig, validateDriverConfig } from "./config.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const companyId = "company-idle-efficiency";
const environmentId = "environment-idle-efficiency";
const baseConfig = { apiKey: "boat_test_key_not_real", cliproxyTunnel: false };
let fake: FakeBoat;
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
  const ssh = new FakeSsh();
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

  it("creates a heavy-build VM at the explicitly configured default size with monitoring on", async () => {
    const lease = await acquire("run-heavy", { ...baseConfig, size: "default" });
    expect(fake.callsOf("create")[0].args).toMatchObject({ type: "default", monitoring: true });
    expect(lease.metadata).toMatchObject({ size: "default" });
  });
});
