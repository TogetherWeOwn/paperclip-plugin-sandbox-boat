// B13: every created VM is tracked; a VM whose record (or delete) fails is
// stopped instead of billing untracked. Uses fakes only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { DRIVER_KEY } from "./manifest.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat, responseError } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";
import { BoatVmManager } from "./vm-manager.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const VMS_KEY = `company|${COMPANY}|boat-sandbox|vms`;

const baseConfig = { apiKey: "boat_test_key_not_real", tunnelTargetHost: "cliproxy" };
const base = (config: Record<string, unknown> = {}) => ({
  driverKey: DRIVER_KEY, companyId: COMPANY, environmentId: ENV, config: { ...baseConfig, ...config },
});

let clock: { t: number; now: () => number };
let fake: FakeBoat;
let ssh: FakeSsh;
let harness: ReturnType<typeof createFakeContext>;
const extraManagers: BoatVmManager[] = [];

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
  for (const instance of extraManagers.splice(0)) await instance.shutdown().catch(() => undefined);
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
});

const acquire = (runId: string, extra: Record<string, unknown> = {}) =>
  plugin.definition.onEnvironmentAcquireLease!({
    ...base(), runId, issueId: ISSUE, executionWorkspaceId: WORKSPACE, agentId: "agent-1", ...extra,
  } as never);
// A run-keyed lease: no principal, so the card never shares its VM.
const acquireRunKind = (runId: string) =>
  plugin.definition.onEnvironmentAcquireLease!({ ...base(), runId, issueId: ISSUE } as never);
const release = (lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> }, runId: string) =>
  plugin.definition.onEnvironmentReleaseLease!({
    ...base(), issueId: ISSUE, providerLeaseId: lease.providerLeaseId, leaseMetadata: { ...lease.metadata, runId },
  } as never);
const destroy = (lease: { providerLeaseId: string | null }) =>
  plugin.definition.onEnvironmentDestroyLease!({ ...base(), providerLeaseId: lease.providerLeaseId } as never);
const stoppedVm = async (runId: string, extra: Record<string, unknown> = {}) => {
  const lease = await acquire(runId, extra);
  await release(lease, runId);
  return lease;
};
const capture = (providerLeaseId: string, templateLabel: string) =>
  plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId, templateLabel } as never);
// A manager that never saw the lease, sharing the persisted state: a restart.
const restartedManager = () => {
  const instance = new BoatVmManager({
    state: harness.ctx.state, logger: harness.ctx.logger,
    issues: { get: async () => ({ status: "in_progress", executionWorkspaceSettings: {} }) },
    now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; },
  });
  extraManagers.push(instance);
  return instance;
};
const vmDoc = () => harness.state.get(VMS_KEY) as
  { vms: Record<string, { sandboxId: string; status: string; activeRunIds: string[] }> } | undefined;

describe("failed start recording", () => {
  it("stops the created VM when the start receipt write fails", async () => {
    // The reserve persists; the started() receipt does not. The failure fires
    // once: the cleanup's own ledger writes must still land.
    let accountWrites = 0, receiptFailed = false;
    const set = harness.ctx.state.set.bind(harness.ctx.state);
    harness.ctx.state.set = (async (input: never, value: unknown) => {
      if ((input as { namespace?: string }).namespace === "boat-account") {
        accountWrites += 1;
        if (accountWrites === 2 && !receiptFailed) { receiptFailed = true; throw new Error("ledger write failed"); }
      }
      return set(input, value);
    }) as typeof harness.ctx.state.set;

    await expect(acquire("run-1")).rejects.toThrow("ledger write failed");
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(accountWrites).toBeGreaterThanOrEqual(2);

    // One stop for the created VM: it still exists (kept, stopped), unrecorded.
    const [id] = [...fake.boxes.keys()];
    expect(fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([id]);
    expect(fake.callsOf("deleteSandbox")).toHaveLength(0);
    expect(fake.boxes.get(id!)?.state).toBe("archived");
    const doc = vmDoc();
    expect(doc == null || Object.values(doc.vms).every((record) => record.sandboxId !== id)).toBe(true);
  });
});

describe("failed deletes", () => {
  it.each(["release", "destroy"] as const)("stops the VM when a %s delete fails", async (kind) => {
    const lease = kind === "release" ? await acquireRunKind("run-1") : await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    fake.failNext("deleteSandbox", responseError(500, { code: "internal" }));
    if (kind === "release") await expect(release(lease, "run-1")).rejects.toMatchObject({ code: "BOAT_DELETE_FAILED" });
    else await expect(destroy(lease)).rejects.toMatchObject({ code: "BOAT_DELETE_FAILED" });

    // One stop, not a delete: the VM still exists, stopped, with no tombstone.
    expect(fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([sandboxId]);
    expect(fake.boxes.get(sandboxId)?.state).toBe("archived");
    const record = Object.values(vmDoc()!.vms).find((entry) => entry.sandboxId === sandboxId)!;
    expect(record).toMatchObject({ status: "stopped", activeRunIds: [] });
    expect(Object.values(vmDoc()!.vms).some((entry) => entry.status === "deleted")).toBe(false);
  });
});

describe("hard deadlines across workers", () => {
  it("restores the persisted cap after a restart and clears it on deadline-free re-acquire", async () => {
    const first = await stoppedVm("run-1", { requestedExpiresAt: new Date(clock.t + 30 * 60 * 1000).toISOString() });
    const sandboxId = first.providerLeaseId!;
    const createdTtl = fake.callsOf("create")[0]!.args.ttlSeconds as number;
    expect(createdTtl).toBe(1800);

    // A worker that never saw the lease caps the resume from the record.
    const restarted = restartedManager();
    const resumed = await restarted.resumeLease({
      ...base(), issueId: ISSUE, providerLeaseId: sandboxId, leaseMetadata: first.metadata,
    } as never);
    expect(fake.callsOf("resume")[0]!.args.ttlSeconds).toBe(createdTtl);
    await release({ providerLeaseId: sandboxId, metadata: resumed.metadata }, "run-1");

    // The new lease has no deadline, so its own resume is uncapped and the
    // re-acquire clears the previous lease's cap from the map and record.
    const second = await stoppedVm("run-2");
    expect(second.providerLeaseId).toBe(sandboxId);
    expect(fake.callsOf("resume")[1]!.args.ttlSeconds).toBe(120 * 60);

    // So the next restart's resume is uncapped too.
    await restartedManager().resumeLease({
      ...base(), issueId: ISSUE, providerLeaseId: sandboxId, leaseMetadata: second.metadata,
    } as never);
    expect(fake.callsOf("resume")).toHaveLength(3);
    expect(fake.callsOf("resume")[2]!.args.ttlSeconds).toBe(120 * 60);
  });
});

describe("template capture", () => {
  it("lets one of two concurrent captures win instead of overshooting the allowance", async () => {
    fake.namedAllowance = { free: 10, used: 9 };
    const first = await acquire("run-a", { executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const second = await acquire("run-b", { executionWorkspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

    const [a, b] = await Promise.allSettled([capture(first.providerLeaseId!, "cap-a"), capture(second.providerLeaseId!, "cap-b")]);
    const codes = [a, b].map((outcome) =>
      outcome.status === "fulfilled" ? "captured" : (outcome.reason as { code?: string }).code);
    expect(codes.sort()).toEqual(["BOAT_NAMED_SNAPSHOT_NOT_FREE", "captured"]);

    // The loser refused before saving: one snapshot, allowance exactly full.
    expect(fake.callsOf("saveNamedSnapshot")).toHaveLength(1);
    expect(fake.namedAllowance.used).toBe(10);
  });

  it("stops a VM the capture resumed, after the snapshot is ready", async () => {
    const sandboxId = (await stoppedVm("run-1")).providerLeaseId!;
    const timeline: string[] = [];
    fake.timeline = timeline;
    expect((await capture(sandboxId, "warm")).templateRef).toBe("warm");
    expect(fake.callsOf("resume").map((call) => call.args.sandboxId)).toEqual([sandboxId]);

    // The resumed VM is stopped again; the stop lands after the save.
    expect(fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([sandboxId, sandboxId]);
    expect(fake.boxes.get(sandboxId)?.state).toBe("archived");
    expect(timeline.indexOf("saveNamedSnapshot")).toBeLessThan(timeline.lastIndexOf("stop"));
  });

  it("stops a resumed VM even when the scrub refuses the capture", async () => {
    const sandboxId = (await stoppedVm("run-1")).providerLeaseId!;
    ssh.handler = (remoteCommand) => remoteCommand.includes("paperclip-boat-scrub")
      ? { code: 3, stdout: "paperclip-boat-scrub found=0 left=0 walk=incomplete\n", stderr: "find: denied" }
      : undefined;

    await expect(capture(sandboxId, "warm")).rejects.toMatchObject({ code: "BOAT_RUNTIME_SCRUB_FAILED" });
    expect(fake.callsOf("saveNamedSnapshot")).toHaveLength(0);
    expect(fake.callsOf("stop").map((call) => call.args.sandboxId)).toEqual([sandboxId, sandboxId]);
  });
});
