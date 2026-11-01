// A card VM's disk belongs to one agent and one env policy. A different
// agent resuming it would run with the previous tenant's planted shell
// hooks; reusing a running VM that still holds its creator's logins
// under noEnv would hand the run credentials the operator turned off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { DRIVER_KEY } from "./manifest.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";

function base(config: Record<string, unknown> = {}) {
  return {
    driverKey: DRIVER_KEY,
    companyId: COMPANY,
    environmentId: ENV,
    config: { apiKey: "boat_test_key_not_real", tunnelTargetHost: "cliproxy", ...config },
  };
}

let clock: { t: number; now: () => number };
let fake: FakeBoat;
let ssh: FakeSsh;
let harness: ReturnType<typeof createFakeContext>;

beforeEach(async () => {
  clock = { t: Date.parse("2026-10-22T18:00:00Z"), now: () => clock.t };
  fake = new FakeBoat(clock);
  ssh = new FakeSsh();
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
  setManagerOverridesForTests({ now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } });
  delete process.env.BOAT_API_KEY;
  harness = createFakeContext({ issues: new Map([[ISSUE, { status: "in_progress", executionWorkspaceSettings: {} }]]) });
  await plugin.definition.setup(harness.ctx as never);
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
});

async function acquire(runId: string, agentId: string | null, config: Record<string, unknown> = {}) {
  return await plugin.definition.onEnvironmentAcquireLease!({
    ...base(config),
    runId,
    issueId: ISSUE,
    executionWorkspaceId: WORKSPACE,
    ...(agentId ? { agentId } : {}),
  } as never);
}

async function release(
  lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> },
  config: Record<string, unknown> = {},
) {
  return await plugin.definition.onEnvironmentReleaseLease!({
    ...base(config),
    issueId: ISSUE,
    providerLeaseId: lease.providerLeaseId,
    leaseMetadata: lease.metadata,
  } as never);
}

describe("a card VM serves one agent only", () => {
  it("creates a fresh VM for a different agent on the same card instead of resuming the first agent's disk", async () => {
    const first = await acquire("run-1", "agent-a");
    await release(first);
    const second = await acquire("run-2", "agent-b");
    expect(second.providerLeaseId).not.toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ startKind: "create" });
    expect(second.metadata?.vmKey).not.toBe(first.metadata?.vmKey);
    expect(fake.callsOf("create")).toHaveLength(2);
    expect(fake.callsOf("resume")).toHaveLength(0);
    // The first agent's disk is untouched and still stopped for its own next run.
    expect(fake.boxes.get(first.providerLeaseId!)!.state).toBe("archived");
  });

  it("still resumes the card VM for the same agent's next run", async () => {
    const first = await acquire("run-1", "agent-a");
    await release(first);
    const second = await acquire("run-2", "agent-a");
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ startKind: "resume" });
    expect(fake.callsOf("create")).toHaveLength(1);
  });

  it("fails closed for an acquire without an agent: a per-run VM, deleted on release", async () => {
    const lease = await acquire("run-1", null);
    expect(lease.metadata).toMatchObject({ vmKeyKind: "run" });
    await release(lease);
    expect(fake.callsOf("deleteSandbox")).toHaveLength(1);
    expect(fake.boxes.has(lease.providerLeaseId!)).toBe(false);
  });
});

describe("resume re-asserts the env policy", () => {
  it("passes noEnv on the acquire resume of a stopped card VM", async () => {
    const first = await acquire("run-1", "agent-a", { noEnv: true });
    await release(first, { noEnv: true });
    await acquire("run-2", "agent-a", { noEnv: true });
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(fake.callsOf("resume")[0].args.noEnv).toBe(true);
  });

  it("re-pins the configured boat environment on resume when noEnv is off", async () => {
    const config = { noEnv: false, boatEnvironment: "proj-env" };
    const first = await acquire("run-1", "agent-a", config);
    await release(first, config);
    await acquire("run-2", "agent-a", config);
    expect(fake.callsOf("resume")[0].args).toMatchObject({ environment: "proj-env" });
    expect(fake.callsOf("resume")[0].args.noEnv).toBeUndefined();
  });

  it("passes noEnv when a lease reconnects to a VM that stopped mid-lease", async () => {
    const lease = await acquire("run-1", "agent-a", { noEnv: true });
    await currentManager().shutdown(); // drop the in-worker session; the next execute reconnects
    fake.boxes.get(lease.providerLeaseId!)!.state = "archived"; // boat's auto-stop
    const result = await plugin.definition.onEnvironmentExecute!({
      ...base({ noEnv: true }),
      lease,
      command: "true",
    } as never);
    expect(result.exitCode).toBe(0);
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(fake.callsOf("resume")[0].args.noEnv).toBe(true);
  });

  it("never reuse_running's a running VM that contradicts the policy: it stops and resumes it under noEnv", async () => {
    const first = await acquire("run-1", "agent-a", { noEnv: true });
    const sandboxId = first.providerLeaseId!;
    await release(first, { noEnv: true });
    // The disk came back up outside the plugin (e.g. resumed by hand) with the creator's logins attached.
    const box = fake.boxes.get(sandboxId)!;
    box.state = "ready";
    box.noEnv = false;
    box.environment = "base";
    box.holdsCreatorLogins = true;
    const stopsBefore = fake.callsOf("stop").length;
    const second = await acquire("run-2", "agent-a", { noEnv: true });
    expect(second.providerLeaseId).toBe(sandboxId);
    expect(second.metadata).toMatchObject({ startKind: "resume" });
    expect(fake.callsOf("stop").length).toBeGreaterThan(stopsBefore);
    expect(fake.callsOf("resume")[0].args.noEnv).toBe(true);
    expect(box.holdsCreatorLogins).toBe(false);
    expect(harness.logs.some((entry) => entry.level === "warn" && entry.message.includes("env policy"))).toBe(true);
  });
});

describe("deleteCardVmOnRelease", () => {
  it("deletes the card VM when the last run releases it", async () => {
    const lease = await acquire("run-1", "agent-a", { deleteCardVmOnRelease: true });
    await release(lease, { deleteCardVmOnRelease: true });
    expect(fake.callsOf("deleteSandbox")).toHaveLength(1);
    expect(fake.boxes.has(lease.providerLeaseId!)).toBe(false);
  });
});
