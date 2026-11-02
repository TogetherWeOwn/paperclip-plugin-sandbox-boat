import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests, type BoatApiLike } from "./boat-client.js";
import { DRIVER_KEY } from "./manifest.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { resolveVmKey } from "./vm-manager.js";
import type { StateDoc, VmRecord } from "./state.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const STATE_KEY = `company|${COMPANY}|boat-sandbox|vms`;

function base() {
  return {
    driverKey: DRIVER_KEY,
    companyId: COMPANY,
    environmentId: ENV,
    config: { apiKey: "boat_test_key_not_real", tunnelTargetHost: "proxy.example.test" },
  };
}

let clock: { t: number; now: () => number };
let fake: FakeBoat;
let ssh: FakeSsh;
let harness: ReturnType<typeof createFakeContext>;
let sleeps: number[];

beforeEach(async () => {
  clock = { t: Date.parse("2026-10-22T18:00:00Z"), now: () => clock.t };
  fake = new FakeBoat(clock);
  ssh = new FakeSsh();
  harness = createFakeContext({
    issues: new Map([[ISSUE, { status: "in_progress", executionWorkspaceSettings: {} }]]),
  });
  sleeps = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
  setManagerOverridesForTests({
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
  });
  await plugin.definition.setup(harness.ctx as never);
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  vi.restoreAllMocks();
  setBoatApiFactoryForTests(null);
  setManagerOverridesForTests({});
});

// Use manager lifecycle calls to keep fire-and-forget sweepSoon out of these
// interleavings. Every sweep below is explicit; StopLease still uses its hook.
async function acquire(runId: string) {
  return await currentManager().acquire({
    ...base(), runId, issueId: ISSUE, executionWorkspaceId: WORKSPACE, agentId: "test-agent",
  } as never);
}

type Lease = Awaited<ReturnType<typeof acquire>>;

function leaseParams(lease: Lease) {
  return { ...base(), issueId: ISSUE, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata };
}

async function release(lease: Lease) {
  return await currentManager().release(leaseParams(lease) as never, "release");
}

function record(): VmRecord {
  return (harness.state.get(STATE_KEY) as StateDoc).vms[resolveVmKey({ executionWorkspaceId: WORKSPACE, issueId: ISSUE, runId: "key", agentId: "test-agent" }).key];
}

function confirmationLogs() {
  return harness.logs.filter((entry) => entry.message === "boat: sweep confirmed a release stop");
}

function barrier() {
  let open!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  return { gate, reached, open, entered };
}

// All fake API/state/SSH work settles in microtasks. Yield one event-loop turn
// to drain runnable work while a named barrier remains closed (no wall sleeps).
async function drainRunnableWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function archivedPendingRelease() {
  const lease = await acquire("original");
  fake.stopMode = "never";
  await expect(release(lease)).resolves.toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
  expect(record().status).toBe("stopping");
  expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("archiving");
  clock.t += 65_000;
  fake.boxes.get(lease.providerLeaseId!)!.state = "archived";
  return lease;
}

const successorKinds = ["acquire", "resume"] as const;
type SuccessorKind = typeof successorKinds[number];

async function successor(kind: SuccessorKind, lease: Lease) {
  return kind === "acquire"
    ? await acquire("successor")
    : await currentManager().resumeLease(leaseParams(lease) as never);
}

function successorSession(kind: SuccessorKind) {
  return record().sessions.find((entry) => kind === "acquire" ? entry.runId === "successor" : entry.runId.startsWith("resumed-lease:"));
}

describe("release status-read regressions", () => {
  it("retries a thrown first GET and subsequent UP reads until non-UP is actually observed", async () => {
    const lease = await acquire("original");
    const box = fake.boxes.get(lease.providerLeaseId!)!;
    fake.stopMode = "stays_up";
    fake.failNext("get", new Error("status read unavailable"));
    fake.failNext("get", () => null); // A successful read that still reports ready.
    fake.failNext("get", () => {
      box.state = "archiving";
      return null;
    });
    const start = clock.t;
    const gets = fake.callsOf("get").length;
    const receipt = await release(lease);

    expect.soft(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    expect.soft(box.state).toBe("archiving");
    expect.soft(fake.callsOf("get").length - gets).toBeGreaterThanOrEqual(3);
    expect.soft(sleeps).toContain(2000);
    expect.soft(clock.t - start).toBeLessThanOrEqual(10_000);
    expect.soft(fake.callsOf("stop")).toHaveLength(1);
  });

  it.each(["release", "StopLease"] as const)("%s fails closed within 10s when every post-stop GET throws", async (mode) => {
    const lease = await acquire("original");
    fake.stopMode = "stays_up";
    const realGet = fake.get.bind(fake);
    vi.spyOn(fake, "get").mockImplementation(async (args) => {
      await realGet(args); // Record the call, then fail, rather than return a successful null fake.
      throw new Error("status read persistently unavailable");
    });
    const start = clock.t;
    const gets = fake.callsOf("get").length;
    const operation = mode === "release" ? release(lease) : plugin.definition.onEnvironmentStopLease!({
      ...leaseParams(lease), resourceDisposition: "stop_and_retain",
    } as never);
    const outcome = await operation.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: undefined, error }),
    );

    if (mode === "release") {
      expect.soft(outcome.error).toBeNull();
      expect.soft(outcome.value).toBeUndefined();
    } else {
      expect.soft(outcome.error).toMatchObject({ code: "BOAT_STOP_UNCONFIRMED" });
      expect.soft(outcome.value).toBeUndefined();
    }
    expect.soft(fake.callsOf("get").length - gets).toBeGreaterThan(1);
    expect.soft(clock.t - start).toBeGreaterThanOrEqual(2000);
    expect.soft(clock.t - start).toBeLessThanOrEqual(10_000);
    expect.soft(fake.callsOf("stop")).toHaveLength(1);
    expect.soft(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("ready");
    expect.soft(record().status).toBe("stopping");
  });
});

describe("reconnect after an accepted stop that stays UP", () => {
  it.each(["ResumeLease", "Execute reconnect"] as const)("%s restores running and an immediate sweep leaves the live session alone", async (path) => {
    const lease = await acquire("original");
    fake.stopMode = "stays_up";
    await expect(release(lease)).resolves.toBeUndefined();
    expect(record().status).toBe("stopping");
    expect(ssh.masters()[0].child.killed).toBe(true);
    fake.stopMode = "immediate"; // A spurious sweep stop would now kill this run.

    if (path === "ResumeLease") {
      const resumed = await plugin.definition.onEnvironmentResumeLease!(leaseParams(lease) as never);
      expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
      expect(resumed.metadata).toMatchObject({ resumedLease: true });
    } else {
      const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true" } as never);
      expect(result.exitCode).toBe(0);
    }
    const session = path === "ResumeLease" ? successorSession("resume") : record().sessions.find((entry) => entry.runId === "original");
    expect(session).toMatchObject({ endedAt: null, usage: null });
    const master = ssh.masters().at(-1)!;
    expect(master).not.toBe(ssh.masters()[0]);
    const stops = fake.callsOf("stop").length;
    expect.soft(record().status).toBe("running");

    const report = await currentManager().sweep("test", { force: true });
    expect.soft(report).toMatchObject({ stopped: [], deleted: [], errors: [] });
    expect.soft(fake.callsOf("stop")).toHaveLength(stops);
    expect.soft(fake.callsOf("resume")).toHaveLength(0); // It was already UP, not an archived resume.
    expect.soft(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("ready");
    expect.soft(record().status).toBe("running");
    expect.soft(record().sessions.find((entry) => entry.runId === session!.runId)).toMatchObject({ endedAt: null, usage: null });
    expect.soft(master.child.killed).toBe(false);
  });
});

describe.each(successorKinds)("archived release confirmation racing successor %s", (kind) => {
  it("does not close usage or log confirmation when the successor won before the conditional flip", async () => {
    const lease = await archivedPendingRelease();
    const listing = barrier();
    const realList = fake.sandboxes.bind(fake);
    vi.spyOn(fake, "sandboxes").mockImplementation(async (args = {}) => {
      const snapshot = structuredClone(await realList(args));
      listing.entered();
      await listing.gate;
      return snapshot; // Sweep keeps its archived + stopping snapshot, even after resume.
    });
    const sweeping = currentManager().sweep("test", { force: true });
    await listing.reached;
    let usageCalls = 0;
    try {
      const next = await successor(kind, lease);
      expect(next.providerLeaseId).toBe(lease.providerLeaseId);
      expect(record().status).toBe("running");
      expect(successorSession(kind)).toMatchObject({ endedAt: null, usage: null });
      usageCalls = fake.callsOf("usage").length;
    } finally {
      listing.open();
    }
    const report = await sweeping;

    expect.soft(report).toMatchObject({ stopped: [], deleted: [], errors: [] });
    expect.soft(fake.callsOf("usage")).toHaveLength(usageCalls);
    expect.soft(confirmationLogs()).toHaveLength(0);
    expect.soft(successorSession(kind)).toMatchObject({ endedAt: null, usage: null });
    expect.soft(record().status).toBe("running");
    expect.soft(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("ready");
  });

  it("does not mutate the confirmation while the successor owns the card lock", async () => {
    const lease = await archivedPendingRelease();
    const starting = barrier();
    const realResume = fake.resume.bind(fake);
    vi.spyOn(fake, "resume").mockImplementation(async (args) => {
      starting.entered(); // Successor owns the card lock, before boat or plugin state changes.
      await starting.gate;
      return await realResume(args);
    });
    const next = successor(kind, lease);
    await starting.reached;
    const usageCalls = fake.callsOf("usage").length;
    const sweeping = currentManager().sweep("test", { force: true });
    try {
      await drainRunnableWork();
      expect.soft(record().status).toBe("stopping");
      expect.soft(fake.callsOf("usage")).toHaveLength(usageCalls);
      expect.soft(confirmationLogs()).toHaveLength(0);
    } finally {
      starting.open();
    }
    const [resumed, report] = await Promise.all([next, sweeping]);

    expect.soft(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect.soft(report).toMatchObject({ stopped: [], deleted: [], errors: [] });
    expect.soft(confirmationLogs()).toHaveLength(0);
    expect.soft(successorSession(kind)).toMatchObject({ endedAt: null, usage: null });
    expect.soft(record().status).toBe("running");
  });

  it("holds the card lock from the confirmation mutation through the usage read and closure", async () => {
    const lease = await archivedPendingRelease();
    const usageRead = barrier();
    const realGet = harness.ctx.state.get;
    let paused = false;
    vi.spyOn(harness.ctx.state, "get").mockImplementation(async (input) => {
      if (!paused && input.scopeKind === "company" && input.scopeId === COMPANY && input.stateKey === "vms" && record().status === "stopped") {
        // The flip has committed. Pause BEFORE the usage ledger snapshot is read,
        // so an unlocked successor would be included and incorrectly closed.
        paused = true;
        usageRead.entered();
        await usageRead.gate;
      }
      return await realGet(input);
    });
    const sweeping = currentManager().sweep("test", { force: true });
    await usageRead.reached;
    expect(record().status).toBe("stopped");
    let successorSettled = false;
    const next = successor(kind, lease).finally(() => { successorSettled = true; });
    try {
      await drainRunnableWork();
      expect.soft(successorSettled).toBe(false);
      expect.soft(fake.callsOf("resume")).toHaveLength(0);
      expect.soft(successorSession(kind)).toBeUndefined();
    } finally {
      usageRead.open();
    }
    const [report, resumed] = await Promise.all([sweeping, next]);

    expect.soft(report).toMatchObject({ stopped: [], deleted: [], errors: [] });
    expect.soft(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect.soft(confirmationLogs()).toHaveLength(1);
    expect.soft(record().status).toBe("running");
    expect.soft(successorSession(kind)).toMatchObject({ endedAt: null, usage: null });
    expect.soft(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("ready");
  });
});
