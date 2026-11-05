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
import { DEFAULT_API_BASE, parseDriverConfig } from "./config.js";
import { OffloadPoolStore } from "./offload-pool.js";
import { SshOffloadRuntime } from "./offload-ssh-runtime.js";
import { sweepDigestCacheSizeForTests } from "./vm-manager.js";
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

/** The existing pool credential digest (same scrypt KDF as the runtime; no pool rekey). */
const poolDigestOf = (key: string) =>
  scryptSync(key, `boat-offload-pool\u0000${DEFAULT_API_BASE}`, 32).toString("hex");

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
      { [poolId]: { artifactRoot: "/tmp/paperclip-sweep-restart-artifacts", seenAt: clock - 60_000, credentialDigest: poolDigestOf(fakeKey) } },
    );

    // A restarted runtime: no bindings, no loaded pools, no new command.
    const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger,
      ssh: {} as never, accountId, boat: () => fake as unknown as BoatApiLike });
    await runtime.sweep([companyId], { configsFor: () => [parseDriverConfig(baseConfig)] });
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
    const digestOf = (key: string) => `scrypt:${scryptSync(key, DEFAULT_API_BASE, 32).toString("hex")}`;
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

  it("versions the account digest and never rehydrates a pre-scrypt descriptor", async () => {
    const legacyKey = "boat_inline_key_legacy_format_not_real";
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      companyId, environmentId, driverKey: "boat", config: { ...baseConfig, apiKey: legacyKey }, runId: "run-legacy",
      issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
    });
    const sandboxId = lease.providerLeaseId!;
    // The release's stop is accepted but never takes effect: the record stays stopping.
    fake.stopMode = "stays_up";
    await expect(release(lease)).resolves.toBeUndefined();
    const saved = await untilSweepDescriptor();
    const persisted = saved.envs?.[environmentId] as { accountDigest?: unknown; config?: Record<string, unknown> };
    // The stored form carries the KDF format prefix: a digest written by an
    // older primitive never compares equal after an upgrade.
    expect(typeof persisted?.accountDigest).toBe("string");
    expect(persisted.accountDigest as string).toMatch(/^scrypt:[0-9a-f]{64}$/);
    await currentManager().sweepInFlight()?.catch(() => undefined);

    // A pre-scrypt descriptor (fast-hash hex, no prefix) for the same key,
    // seen under the same host key, stays absent: the format mismatch fails
    // closed until a hook rewrites it, so the stopping VM is left alone
    // instead of being stopped under a mismatched account. Overwrite after
    // the restart, when no hook can rewrite the doc under the test.
    process.env.BOAT_API_KEY = legacyKey;
    await restart();
    const store = new VmStateStore(harness.ctx.state);
    await store.saveSweepDescriptor(companyId, environmentId, {
      version: 1, companyId, environmentId, seenAt: clock, config: { ...(persisted.config ?? {}) },
      hadInlineKey: true, accountDigest: "ab".repeat(32),
    });
    fake.stopMode = "immediate";
    clock += 10 * 60_000;
    // The release above already made one stop call: only post-restart calls count.
    const stopsBefore = fake.callsOf("stop").length;
    const report = await currentManager().sweep("schedule", { force: true });
    expect(report.stopped ?? []).not.toContain(sandboxId);
    expect(fake.callsOf("stop").slice(stopsBefore).map((call) => call.args.sandboxId)).not.toContain(sandboxId);
  });

  it("bounds the digest memo and drops it on shutdown", async () => {
    for (let n = 0; n < 20; n += 1) {
      await plugin.definition.onEnvironmentAcquireLease!({
        companyId, environmentId, driverKey: "boat",
        config: { ...baseConfig, apiKey: `boat_test_rotating_key_${n}_not_real` },
        runId: `run-memo-${n}`, issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
      });
    }
    // More distinct keys than the memo holds: retired keys are evicted, not kept.
    expect(sweepDigestCacheSizeForTests()).toBeLessThanOrEqual(16);
    await plugin.definition.onShutdown!();
    expect(sweepDigestCacheSizeForTests()).toBe(0);
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
      { [poolId]: { artifactRoot: "/tmp/paperclip-sweep-restart-artifacts-race", seenAt: clock - 60_000, credentialDigest: poolDigestOf(fakeKey) } },
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
        ssh: {} as never, accountId, boat: () => fake as unknown as BoatApiLike });
      await runtime.sweep([companyId], { configsFor: () => [parseDriverConfig(baseConfig)] });
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
      { [poolId]: { artifactRoot: "/tmp/paperclip-sweep-restart-artifacts-settle", seenAt: clock - 60_000, credentialDigest: poolDigestOf(fakeKey) } },
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
        ssh: {} as never, accountId, boat: () => fake as unknown as BoatApiLike });
      await runtime.sweep([companyId], { configsFor: () => [parseDriverConfig(baseConfig)] });
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
    const digestOf = (key: string) => `scrypt:${scryptSync(key, DEFAULT_API_BASE, 32).toString("hex")}`;
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
    const digestOf = (key: string) => `scrypt:${scryptSync(key, DEFAULT_API_BASE, 32).toString("hex")}`;
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

  describe("host-key rehydration of sweep descriptors", () => {
    const keylessConfig = { cliproxyTunnel: false };
    const vmDoc = async () => await harness.ctx.state.get(
      { scopeKind: "company", scopeId: companyId, namespace: "boat-sandbox", stateKey: "vms" }) as {
      vms?: Record<string, { sandboxId?: string; status?: string }>;
    } | null;
    const liveRecord = async (sandboxId: string) =>
      Object.values((await vmDoc())?.vms ?? {}).some((record) => record.sandboxId === sandboxId && record.status !== "deleted");
    /** Acquire and release with a stop that never takes effect: the record stays stopping. */
    async function leaveStopping(config: Record<string, unknown>, runId: string) {
      const lease = await plugin.definition.onEnvironmentAcquireLease!({
        companyId, environmentId, driverKey: "boat", config, runId,
        issueId: issue, executionWorkspaceId: workspaceId, agentId: "agent-1",
      });
      fake.stopMode = "stays_up";
      await expect(plugin.definition.onEnvironmentReleaseLease!({
        companyId, environmentId, driverKey: "boat", config, issueId: issue,
        providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
      })).resolves.toBeUndefined();
      const saved = await untilSweepDescriptor();
      await currentManager().sweepInFlight()?.catch(() => undefined);
      return { sandboxId: lease.providerLeaseId!, saved };
    }

    it.each([
      ["an inline-key origin", { ...baseConfig, apiKey: "boat_legacy_inline_origin_not_real" }],
      ["a keyless origin", keylessConfig],
    ])("never rehydrates a markerless legacy descriptor of %s under a new account host key", async (_name, config) => {
      const { sandboxId, saved } = await leaveStopping(config, "run-legacy-markerless");
      const persisted = saved.envs?.[environmentId] as { config?: Record<string, unknown> };
      process.env.BOAT_API_KEY = "boat_new_account_host_key_not_real";
      await restart();
      // Legacy shape: no hadInlineKey, no account digest. Its origin cannot be
      // told apart, so the new host key must not be trusted to be its account.
      // Written after the restart so no hook can rewrite it under the test.
      const legacy = { version: 1 as const, companyId, environmentId, seenAt: clock, config: { ...(persisted.config ?? {}) } };
      await new VmStateStore(harness.ctx.state).saveSweepDescriptor(companyId, environmentId, legacy);

      // The foreign account's listing succeeds and still shows the VM: it must
      // not be stopped through an unproven config.
      fake.stopMode = "immediate";
      clock += 10 * 60_000;
      const stopsBefore = fake.callsOf("stop").length;
      const deletesBefore = fake.callsOf("deleteSandbox").length;
      const first = await currentManager().sweep("schedule", { force: true });
      expect(first.stopped ?? []).not.toContain(sandboxId);
      expect(fake.callsOf("stop").length).toBe(stopsBefore);
      expect(fake.callsOf("deleteSandbox").length).toBe(deletesBefore);

      // The foreign account's successful listing lacks the VM: absence proves
      // nothing about this account, so neither VM nor plugin record is dropped.
      fake.boxes.delete(sandboxId);
      clock += 60_000;
      const second = await currentManager().sweep("schedule", { force: true });
      expect(JSON.stringify(second.forgotten ?? [])).not.toContain(sandboxId);
      expect(JSON.stringify(second.deleted ?? [])).not.toContain(sandboxId);
      expect(await liveRecord(sandboxId)).toBe(true);
      // Nothing was enrolled: a later sweep still does not act on the config.
      expect(fake.callsOf("stop").length).toBe(stopsBefore);
      expect(fake.callsOf("deleteSandbox").length).toBe(deletesBefore);
    });

    it("rehydrates a host-sourced descriptor under the same host key and stops the stopping VM", async () => {
      const { sandboxId } = await leaveStopping(keylessConfig, "run-host-same");
      await restart();
      fake.stopMode = "immediate";
      clock += 10 * 60_000;
      const stopsBefore = fake.callsOf("stop").length;
      const report = await currentManager().sweep("schedule", { force: true });
      expect(report.stopped).toContain(sandboxId);
      expect(fake.callsOf("stop").slice(stopsBefore).map((call) => call.args.sandboxId)).toContain(sandboxId);
    });

    it("fails closed when the host key rotates to another account after a host-sourced descriptor was written", async () => {
      const { sandboxId } = await leaveStopping(keylessConfig, "run-host-rotated");
      process.env.BOAT_API_KEY = "boat_rotated_host_key_other_account_not_real";
      await restart();
      fake.stopMode = "immediate";
      clock += 10 * 60_000;
      const stopsBefore = fake.callsOf("stop").length;
      const deletesBefore = fake.callsOf("deleteSandbox").length;
      const first = await currentManager().sweep("schedule", { force: true });
      expect(first.stopped ?? []).not.toContain(sandboxId);
      expect(fake.callsOf("stop").length).toBe(stopsBefore);
      // The rotated account's listing is successful and lacks the VM.
      fake.boxes.delete(sandboxId);
      clock += 60_000;
      const second = await currentManager().sweep("schedule", { force: true });
      expect(JSON.stringify(second.forgotten ?? [])).not.toContain(sandboxId);
      expect(await liveRecord(sandboxId)).toBe(true);
      expect(fake.callsOf("deleteSandbox").length).toBe(deletesBefore);
    });
  });

  describe("unloaded pool account matching", () => {
    const keyA = "boat_pool_account_a_not_real";
    const keyB = "boat_pool_account_b_not_real";
    const poolId = "pool-account-match";
    const accountId = "account-restart";
    const sandboxId = "bx_accountmatch001";
    const configFor = (apiKey: string) => parseDriverConfig({ ...baseConfig, apiKey });
    const journalScope = (stateKey: string) =>
      ({ scopeKind: "company" as const, scopeId: companyId, namespace: `boat-executor-${poolId}`, stateKey });
    const runId = "run-account-match";
    const recordKey = `command/${companyId}/${runId}/cmd-account-1`;

    async function seed(credentialDigest: string | undefined) {
      const store = new OffloadPoolStore(harness.ctx.state, accountId, poolId);
      await store.save(
        { maxOffloadVms: 1, offloadIdleStopSeconds: 15 },
        [{ sandboxId, busy: false, stopped: false, stopping: false, quarantined: false,
          lastActiveAt: clock - 60_000, generation: 1, idleHandle: null,
          stopDueAt: null, stopRequestedAt: null, stopAttempts: 0, identity: null }],
      );
      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" },
        { [poolId]: { artifactRoot: "/tmp/paperclip-sweep-restart-artifacts-account", seenAt: clock - 60_000,
          ...(credentialDigest !== undefined ? { credentialDigest } : {}) } },
      );
      const command = { companyId, runId, commandId: "cmd-account-1" };
      const digest = commandDigest(command as never);
      await harness.ctx.state.set(journalScope("index"), [recordKey]);
      await harness.ctx.state.set(journalScope(recordKey), {
        version: 1, companyId, runId, commandId: "cmd-account-1", command, digest, state: "running",
        identity: { companyId, runId, commandId: "cmd-account-1", digest, sandboxId, guestBootId: "boot-1", journalGeneration: 1 },
        acceptedAt: clock, updatedAt: clock, resultAt: null, result: null, remoteStarted: null, fallbackSafe: false,
      });
      return store;
    }
    const journalState = async () =>
      (await harness.ctx.state.get(journalScope(recordKey)) as { state?: string; resultAt?: number | null } | null);

    it("does not settle, delete or query anything for pool A when only account B is available, then converges with A", async () => {
      // A's VM is provider-gone (absent from A's fake): real terminal evidence,
      // but only A's client may read it. B's client answers 404 for every VM.
      const fakeA = fake;
      const fakeB = new FakeBoat({ now: () => clock });
      const built: string[] = [];
      const store = await seed(poolDigestOf(keyA));
      const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger,
        ssh: {} as never, accountId,
        boat: (config) => {
          built.push(config.apiKey ?? "");
          return (config.apiKey === keyA ? fakeA : fakeB) as unknown as BoatApiLike;
        } });
      try {
        await runtime.sweep([companyId], { configsFor: () => [configFor(keyB)] }).catch(() => undefined);
        // No provider call of any kind under B, none under A, and no client for A built.
        expect(fakeB.calls).toEqual([]);
        expect(fakeA.calls).toEqual([]);
        expect(built).not.toContain(keyA);
        // The slot, the journal receipt and the registry entry are untouched.
        expect((await store.load()).find((vm) => vm.sandboxId === sandboxId))
          .toMatchObject({ quarantined: false, stopped: false, stopping: false });
        expect(await journalState()).toMatchObject({ state: "running", resultAt: null });
        const registry = await harness.ctx.state.get(
          { scopeKind: "company", scopeId: companyId, namespace: "boat-offload", stateKey: "offload.pools" }) as Record<string, unknown>;
        expect(Object.keys(registry)).toContain(poolId);

        // The matching account's config is offered: it proves the VM gone and converges.
        await runtime.sweep([companyId], { configsFor: () => [configFor(keyB), configFor(keyA)] }).catch(() => undefined);
        expect(fakeB.calls).toEqual([]);
        expect(fakeA.callsOf("get").map((call) => call.args.sandboxId)).toContain(sandboxId);
        expect((await store.load()).find((vm) => vm.sandboxId === sandboxId)).toBeUndefined();
        expect(await journalState()).toMatchObject({ state: "unknown" });
        expect((await journalState())?.resultAt).not.toBeNull();
      } finally {
        await runtime.shutdown();
      }
    });

    it("never queries any account for a legacy registry entry that has no credential digest", async () => {
      const built: string[] = [];
      const store = await seed(undefined);
      const runtime = new SshOffloadRuntime({ state: harness.ctx.state, logger: harness.ctx.logger,
        ssh: {} as never, accountId,
        boat: (config) => { built.push(config.apiKey ?? ""); return fake as unknown as BoatApiLike; } });
      try {
        await runtime.sweep([companyId], { configsFor: () => [configFor(keyA), configFor(keyB)] }).catch(() => undefined);
        expect(fake.calls).toEqual([]);
        expect(built).toEqual([]);
        expect((await store.load()).find((vm) => vm.sandboxId === sandboxId))
          .toMatchObject({ quarantined: false, stopped: false });
        expect(await journalState()).toMatchObject({ state: "running", resultAt: null });
      } finally {
        await runtime.shutdown();
      }
    });
  });
});
