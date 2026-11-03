// After a worker restart the sweep keeps stopping VMs without a hook
// re-caching config, and an unreadable VM document fails closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import type { BoatApiLike } from "./boat-client.js";
import { setBoatApiFactoryForTests } from "./boat-client.js";
import { commandDigest } from "./offload-journal.js";
import { scryptSync } from "node:crypto";
import { DEFAULT_API_BASE } from "./config.js";
import { OffloadPoolStore } from "./offload-pool.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { VmStateStore } from "./state.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const companyId = "company-sweep-restart";
const environmentId = "environment-sweep-restart";
const fakeKey = "boat_test_key_not_real";
const baseConfig = { apiKey: fakeKey, cliproxyTunnel: false };
let fake: FakeBoat;
let clock: number;
let harness: ReturnType<typeof createFakeContext>;
let savedHostKey: string | undefined;

function overrides() {
  return {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    sweepDeadlineMs: 5_000,
    offloadUpkeepTimeoutMs: 500,
    sweepVmTimeoutMs: 500,
  };
}

const workspaceId = "33333333-3333-4333-8333-333333333333";
const issue = "issue-sweep-restart";

async function acquire(runId = "run-1") {
  return await plugin.definition.onEnvironmentAcquireLease!({
    companyId, environmentId, driverKey: "boat", config: baseConfig, runId,
    issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
  });
}

async function release(lease: Awaited<ReturnType<typeof acquire>>) {
  return await plugin.definition.onEnvironmentReleaseLease!({
    companyId, environmentId, driverKey: "boat", config: baseConfig, issueId: issue,
    providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
  });
}

/** A worker restart: a fresh manager on the same durable state with empty in-memory configs. */
async function restart() {
  await currentManager().sweepInFlight()?.catch(() => undefined);
  setManagerOverridesForTests(overrides());
  await plugin.definition.setup(harness.ctx as never);
}

async function untilSweepDescriptor() {
  const key = { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "sweep-configs" } as const;
  for (let n = 0; n < 1000; n += 1) {
    const doc = await harness.ctx.state.get(key) as { envs?: Record<string, unknown> } | null;
    if (doc?.envs && Object.keys(doc.envs).length > 0) return doc;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("sweep descriptor was never persisted");
}

beforeEach(async () => {
  clock = Date.parse("2026-10-23T08:00:00Z");
  fake = new FakeBoat({ now: () => clock });
  const ssh = new FakeSsh();
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
  setManagerOverridesForTests(overrides());
  savedHostKey = process.env.BOAT_API_KEY;
  process.env.BOAT_API_KEY = fakeKey;
  harness = createFakeContext();
  await plugin.definition.setup(harness.ctx as never);
});
afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
  if (savedHostKey === undefined) delete process.env.BOAT_API_KEY;
  else process.env.BOAT_API_KEY = savedHostKey;
});

describe("sweep after a worker restart", () => {
  it("stops a VM left stopping by an unconfirmed release instead of reporting no_config_seen", async () => {
    const lease = await acquire();
    const sandboxId = lease.providerLeaseId!;
    // The release's stop is accepted but never takes effect: the record stays stopping.
    fake.stopMode = "stays_up";
    await expect(release(lease)).resolves.toBeUndefined();
    // Only non-secret fields are persisted for the sweep, never the resolved key.
    const saved = await untilSweepDescriptor();
    expect(JSON.stringify(saved)).not.toContain(fakeKey);

    await restart();
    fake.stopMode = "immediate";
    clock += 10 * 60_000;
    const report = await currentManager().sweep("schedule", { force: true });
    expect(report.skipped).toBeNull();
    expect(report.stopped).toContain(sandboxId);
    expect(fake.callsOf("stop").map((call) => call.args.sandboxId)).toContain(sandboxId);
  });

  it("stops a past-due pool VM with no new command after a restart", async () => {
    const poolId = "pool-restart-1";
    const box = fake.addSandbox({ id: "bx_poolrestart0001", state: "ready" });
    const accountId = "account-restart";
    await new OffloadPoolStore(harness.ctx.state, accountId, poolId).save(
      { maxOffloadVms: 1, offloadIdleStopSeconds: 15 },
      [{ sandboxId: box.id, busy: false, stopped: false, stopping: false, quarantined: false,
        lastActiveAt: clock - 60_000, generation: 1, idleHandle: null,
        stopDueAt: clock - 1_000, stopRequestedAt: null, stopAttempts: 0, identity: null }],
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" },
      { [poolId]: { artifactRoot: "/tmp/paperclip-sweep-restart-artifacts", seenAt: clock - 60_000 } },
    );

    // A restarted runtime: no bindings, no loaded pools, no new command.
    const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger,
      ssh: {} as never, accountId });
    await runtime.sweep([companyId], { boatFor: () => fake as unknown as BoatApiLike });
    expect(fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([box.id]);
    await runtime.shutdown();
  });

  it("fails closed on an unknown-version VM document: update rejects, the stored value is unchanged", async () => {
    const store = new VmStateStore(harness.ctx.state);
    const seeded = { version: 2, vms: { "orphan-key": { sandboxId: "bx_never" } } };
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "vms" }, seeded);
    await expect(store.update(companyId, () => undefined)).rejects.toThrow(/unreadable/);
    expect(await harness.ctx.state.get(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "vms" })).toEqual(seeded);
  });

  it("does not forget another account's records after a restart with a different host key", async () => {
    const inlineKey = "boat_inline_key_other_account_not_real";
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      companyId, environmentId, driverKey: "boat", config: { ...baseConfig, apiKey: inlineKey }, runId: "run-inline",
      issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
    });
    const sandboxId = lease.providerLeaseId!;
    await untilSweepDescriptor();
    // Drain the post-acquire background sweep while the VM still exists: it
    // holds the live inline-key config and must see its own listing, so the
    // forget below is decided only by the restarted worker without that key.
    await currentManager().sweepInFlight()?.catch(() => undefined);
    // The host key now belongs to a different account than the inline key, and
    // the host-account listing does not contain this VM.
    process.env.BOAT_API_KEY = "boat_host_key_different_account_not_real";
    fake.boxes.delete(sandboxId);

    await restart();
    clock += 60_000;
    const report = await currentManager().sweep("schedule", { force: true });
    // The environment stays absent until a hook re-caches it: nothing forgotten.
    expect(JSON.stringify(report.forgotten ?? [])).not.toContain(sandboxId);
    const doc = await harness.ctx.state.get(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "vms" }) as {
      vms?: Record<string, { sandboxId?: string; status?: string }>;
    } | null;
    expect(Object.values(doc?.vms ?? {}).some(
      (record) => record.sandboxId === sandboxId && record.status !== "deleted")).toBe(true);
  });

  it("re-persists the sweep descriptor when only the inline key changes", async () => {
    const keyA = "boat_inline_key_account_a_not_real";
    const keyB = "boat_inline_key_account_b_not_real";
    const digestOf = (key: string) => scryptSync(key, DEFAULT_API_BASE, 32).toString("hex");
    const readDigest = async () => (await harness.ctx.state.get(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "sweep-configs" }) as {
      envs?: Record<string, { accountDigest?: unknown }>;
    } | null)?.envs?.[environmentId]?.accountDigest;
    await plugin.definition.onEnvironmentAcquireLease!({
      companyId, environmentId, driverKey: "boat", config: { ...baseConfig, apiKey: keyA }, runId: "run-key-a",
      issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
    });
    await untilSweepDescriptor();
    expect(await readDigest()).toBe(digestOf(keyA));
    // A key-only rotation keeps every public field: without the marker in the
    // dedupe identity the stale digest would survive, and a restarted sweep
    // under the old account's host key would forget the new account's VMs.
    await plugin.definition.onEnvironmentAcquireLease!({
      companyId, environmentId, driverKey: "boat", config: { ...baseConfig, apiKey: keyB }, runId: "run-key-b",
      issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
    });
    // The persist runs fire-and-forget after the hook: poll until it lands.
    for (let n = 0; n < 1000; n += 1) {
      if ((await readDigest()) === digestOf(keyB)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await readDigest()).toBe(digestOf(keyB));
  });

  it("an unloaded-pool sweep leaves a reservation made mid-sweep alone", async () => {
    const poolId = "pool-restart-race";
    const box = fake.addSandbox({ id: "bx_poolrace000001", state: "ready" });
    const accountId = "account-restart";
    const store = new OffloadPoolStore(harness.ctx.state, accountId, poolId);
    await store.save(
      { maxOffloadVms: 1, offloadIdleStopSeconds: 15 },
      [{ sandboxId: box.id, busy: false, stopped: false, stopping: false, quarantined: false,
        lastActiveAt: clock - 60_000, generation: 1, idleHandle: null,
        stopDueAt: clock - 1_000, stopRequestedAt: null, stopAttempts: 0, identity: null }],
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" },
      { [poolId]: { artifactRoot: "/tmp/paperclip-sweep-restart-artifacts-race", seenAt: clock - 60_000 } },
    );
    // A command resolves the pool after the sweep's snapshot: the first
    // provider call persists a busy reservation, which the sweep must leave
    // alone (no stop, no overwrite of the reservation).
    const realGet = fake.get.bind(fake);
    let injected = false;
    fake.get = async (args: { sandboxId: string }) => {
      if (!injected) {
        injected = true;
        const doc = await store.loadDoc();
        const vm = doc.vms.find((entry) => entry.sandboxId === box.id)!;
        vm.busy = true;
        vm.generation += 1;
        vm.stopDueAt = null;
        await store.save(doc.config, doc.vms);
      }
      return realGet(args);
    };
    try {
      const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger,
        ssh: {} as never, accountId });
      await runtime.sweep([companyId], { boatFor: () => fake as unknown as BoatApiLike });
      await runtime.shutdown();
    } finally {
      fake.get = realGet;
    }
    expect((await store.load()).find((vm) => vm.sandboxId === box.id))
      .toMatchObject({ busy: true, stopping: false });
    expect(fake.callsOf("stop").map((call) => call.args.sandboxId)).not.toContain(box.id);
  });

  it("keeps an unloaded terminal slot fenced when the journal settlement fails", async () => {
    const poolId = "pool-restart-settle-fail";
    const accountId = "account-restart";
    const store = new OffloadPoolStore(harness.ctx.state, accountId, poolId);
    // Provider-gone VM: no box in the fake, so the provider GET 404s to deleted.
    const sandboxId = "bx_terminal0000001";
    await store.save(
      { maxOffloadVms: 1, offloadIdleStopSeconds: 15 },
      [{ sandboxId, busy: false, stopped: false, stopping: false, quarantined: false,
        lastActiveAt: clock - 60_000, generation: 1, idleHandle: null,
        stopDueAt: null, stopRequestedAt: null, stopAttempts: 0, identity: null }],
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" },
      { [poolId]: { artifactRoot: "/tmp/paperclip-sweep-restart-artifacts-settle", seenAt: clock - 60_000 } },
    );
    // Seed a live journal receipt bound to the VM, then fail its write: the
    // settlement reads fine but cannot persist, so settleSandboxUnknown throws
    // after the slot would previously have been freed.
    const journalScope = (stateKey: string) =>
      ({ scopeKind: "company" as const, scopeId: companyId, namespace: `boat-executor-${poolId}`, stateKey });
    const runId = "run-settle-fail";
    const commandId = "cmd-settle-1";
    const journalCommand = { companyId, runId, commandId };
    const digest = commandDigest(journalCommand as never);
    const recordKey = `command/${companyId}/${runId}/${commandId}`;
    await harness.ctx.state.set(journalScope("index"), [recordKey]);
    await harness.ctx.state.set(journalScope(recordKey), {
      version: 1, companyId, runId, commandId, command: journalCommand, digest, state: "running",
      identity: { companyId, runId, commandId, digest, sandboxId, guestBootId: "boot-1", journalGeneration: 1 },
      acceptedAt: clock, updatedAt: clock, resultAt: null, result: null, remoteStarted: null, fallbackSafe: false,
    });
    const realSet = harness.ctx.state.set.bind(harness.ctx.state);
    harness.ctx.state.set = (async (input: Parameters<typeof realSet>[0], value: unknown) => {
      if (input.namespace === `boat-executor-${poolId}`) throw new Error("journal write failed");
      return realSet(input, value);
    }) as typeof harness.ctx.state.set;
    try {
      const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger,
        ssh: {} as never, accountId });
      await runtime.sweep([companyId], { boatFor: () => fake as unknown as BoatApiLike });
      await runtime.shutdown();
    } finally {
      harness.ctx.state.set = realSet;
    }
    // The slot stays fenced for retry instead of being spliced out or freed on
    // an unsettled receipt.
    expect((await store.load()).find((vm) => vm.sandboxId === sandboxId))
      .toMatchObject({ quarantined: true, stopped: false });
  });

  it("an A→B→A hook burst leaves the latest descriptor digest on disk", async () => {
    const keyA = "boat_burst_key_a_not_real";
    const keyB = "boat_burst_key_b_not_real";
    const digestOf = (key: string) => scryptSync(key, DEFAULT_API_BASE, 32).toString("hex");
    const readDigest = async () => (await harness.ctx.state.get(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "sweep-configs" }) as {
      envs?: Record<string, { accountDigest?: unknown }>;
    } | null)?.envs?.[environmentId]?.accountDigest;
    const burstAcquire = (apiKey: string, runId: string) =>
      plugin.definition.onEnvironmentAcquireLease!({
        companyId, environmentId, driverKey: "boat", config: { ...baseConfig, apiKey }, runId,
        issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
      });
    // Settle config A on disk first: the dedupe cache and the doc agree.
    await burstAcquire(keyA, "run-burst-a1");
    for (let n = 0; n < 1000; n += 1) {
      if ((await readDigest()) === digestOf(keyA)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await readDigest()).toBe(digestOf(keyA));

    // Gate sweep-config writes: B's write stays queued while A returns. The
    // hook promises are held, not awaited — B's hook parks on the store chain
    // behind its own gated write, and awaiting either before release hangs.
    const realSet = harness.ctx.state.set.bind(harness.ctx.state);
    let releaseWrites!: () => void;
    const writesBlocked = new Promise<void>((resolve) => { releaseWrites = resolve; });
    let blockedWrites = 0;
    harness.ctx.state.set = (async (input: Parameters<typeof realSet>[0], value: unknown) => {
      if (input.namespace === "boat-sandbox" && input.stateKey === "sweep-configs") {
        blockedWrites += 1;
        await writesBlocked;
      }
      return realSet(input, value);
    }) as typeof harness.ctx.state.set;
    try {
      const pendingB = burstAcquire(keyB, "run-burst-b");
      for (let n = 0; n < 1000 && blockedWrites === 0; n += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(blockedWrites).toBeGreaterThan(0);
      // A returns while B is still queued. Without the claim this skips its
      // write on a stale dedupe hit and B lands last; with it A queues behind B.
      const pendingA = burstAcquire(keyA, "run-burst-a2");
      await new Promise((resolve) => setImmediate(resolve));
      releaseWrites();
      await pendingB;
      await pendingA;
    } finally {
      harness.ctx.state.set = realSet;
    }
    for (let n = 0; n < 1000; n += 1) {
      if ((await readDigest()) === digestOf(keyA)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    // The stored digest matches the live config: a restarted sweep compares
    // the host key against the right account.
    expect(await readDigest()).toBe(digestOf(keyA));
  });

  it("retries the descriptor when a duplicate hook arrives during a failed first write", async () => {
    const keyA = "boat_retry_key_a_not_real";
    const digestOf = (key: string) => scryptSync(key, DEFAULT_API_BASE, 32).toString("hex");
    const readDigest = async () => (await harness.ctx.state.get(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "sweep-configs" }) as {
      envs?: Record<string, { accountDigest?: unknown }>;
    } | null)?.envs?.[environmentId]?.accountDigest;
    const hook = (runId: string) =>
      plugin.definition.onEnvironmentAcquireLease!({
        companyId, environmentId, driverKey: "boat", config: { ...baseConfig, apiKey: keyA }, runId,
        issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
      });
    // Hold the first sweep-config write until the duplicate hook has joined
    // it, then fail that first write only. The duplicate must retry the write
    // instead of having skipped it, or a restart would have no descriptor to
    // rehydrate until another hook arrives.
    const realSet = harness.ctx.state.set.bind(harness.ctx.state);
    let releaseWrites!: () => void;
    const writesBlocked = new Promise<void>((resolve) => { releaseWrites = resolve; });
    let seenWrites = 0;
    let failures = 1;
    harness.ctx.state.set = (async (input: Parameters<typeof realSet>[0], value: unknown) => {
      if (input.namespace === "boat-sandbox" && input.stateKey === "sweep-configs") {
        seenWrites += 1;
        if (seenWrites === 1) await writesBlocked;
        if (failures > 0) {
          failures -= 1;
          throw new Error("transient sweep-config write failed");
        }
      }
      return realSet(input, value);
    }) as typeof harness.ctx.state.set;
    try {
      const pending1 = hook("run-retry-1");
      for (let n = 0; n < 1000 && seenWrites === 0; n += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(seenWrites).toBeGreaterThan(0);
      const pending2 = hook("run-retry-2");
      for (let n = 0; n < 20; n += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      releaseWrites();
      await pending1;
      await pending2;
    } finally {
      harness.ctx.state.set = realSet;
    }
    for (let n = 0; n < 1000; n += 1) {
      if ((await readDigest()) === digestOf(keyA)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await readDigest()).toBe(digestOf(keyA));
  });

  it("leaves name-matching VMs alone when the VM document is unreadable", async () => {
    await acquire();
    // Roll back to a document this version cannot read; the sweep must report
    // it and leave matching VMs alone rather than treating them as orphans.
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "vms" },
      { version: 2, vms: {} });
    fake.addSandbox({ id: "bx_orphan00000001", name: "paperclip-0123456789abcdef", state: "ready",
      updatedAt: new Date(clock - 60 * 60_000) });
    clock += 10 * 60_000;
    const report = await currentManager().sweep("schedule", { force: true });
    expect(report.skipped).toBeNull();
    expect(report.stopped).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(fake.callsOf("stop")).toEqual([]);
    expect(fake.callsOf("deleteSandbox")).toEqual([]);
    expect(report.errors.join("\n")).toMatch(/unreadable/);
  });
});
