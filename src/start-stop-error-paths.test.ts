// boat's start refusals, the stop that the sweep must confirm before it calls
// a VM stopped, and the by-name lookup that keeps a lost plugin state from
// paying for a second VM. Each path decides whether a VM bills.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatProviderError } from "./errors.js";
import { DRIVER_KEY } from "./manifest.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat, responseError } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const VMS_KEY = `company|${COMPANY}|boat-sandbox|vms`;

const baseConfig = { apiKey: "boat_test_key_not_real", tunnelTargetHost: "cliproxy" };

function base(config: Record<string, unknown> = {}) {
  return { driverKey: DRIVER_KEY, companyId: COMPANY, environmentId: ENV, config: { ...baseConfig, ...config } };
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
  setManagerOverridesForTests({
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  });
  delete process.env.BOAT_API_KEY;
  harness = createFakeContext({ issues: new Map([[ISSUE, { status: "in_progress", executionWorkspaceSettings: {} }]]) });
  await plugin.definition.setup(harness.ctx as never);
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
});

async function acquire(runId: string, config: Record<string, unknown> = {}) {
  return await plugin.definition.onEnvironmentAcquireLease!({
    ...base(config),
    runId,
    issueId: ISSUE,
    executionWorkspaceId: WORKSPACE,
    agentId: "agent-1",
  } as never);
}

async function release(lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> }) {
  return await plugin.definition.onEnvironmentReleaseLease!({
    ...base(),
    issueId: ISSUE,
    providerLeaseId: lease.providerLeaseId,
    leaseMetadata: lease.metadata,
  } as never);
}

function vmRecord(): { sandboxId: string; status: string } {
  return (harness.state.get(VMS_KEY) as { vms: Record<string, { sandboxId: string; status: string }> }).vms[`ew:${WORKSPACE}`];
}

describe("boat start refusals", () => {
  const refusals: Array<[string, number, Record<string, unknown>, string, RegExp]> = [
    ["the plan's active limit", 429, { code: "limit_reached" }, "BOAT_ACTIVE_LIMIT", /sandboxes-at-once limit is full/],
    ["a member's active limit", 429, { code: "member_limit_reached" }, "BOAT_ACTIVE_LIMIT", /sandboxes-at-once limit is full/],
    ["used-up trial compute", 429, { code: "trial_compute_limit_reached" }, "BOAT_TRIAL_COMPUTE_USED", /25 hours of compute are used/],
    ["an empty balance", 402, { code: "balance_empty" }, "BOAT_BILLING_REQUIRED", /balance is empty or there is no plan \(balance_empty\)/],
    ["a payment required without a code", 402, {}, "BOAT_BILLING_REQUIRED", /\(billing_required\)/],
    ["a size the trial refuses", 403, { code: "trial_machine_class_not_allowed" }, "BOAT_SIZE_NOT_ALLOWED", /size small is not allowed/],
    ["a size the plan refuses", 403, { code: "machine_class_plan_required" }, "BOAT_SIZE_NOT_ALLOWED", /size small is not allowed/],
    ["a trial auto-stop above 2h", 400, { code: "trial_auto_stop_required" }, "BOAT_AUTO_STOP_TOO_LONG", /autoStopMinutes=120/],
    ["no capacity", 503, { code: "out_of_capacity" }, "BOAT_OUT_OF_CAPACITY", /out of machines/],
    ["an unknown refusal", 403, { code: "something_new", message: "nope" }, "BOAT_START_FAILED", /boat create failed/],
  ];
  for (const [name, status, body, code, message] of refusals) {
    it(`maps ${name} (${status}) to ${code}, with nothing started`, async () => {
      fake.failNext("create", responseError(status, body));
      const error = (await acquire("run-1").catch((e) => e)) as BoatProviderError;
      expect(error.code).toBe(code);
      expect(error.message).toMatch(message);
      // A definitive refusal is not retried: one create, and no VM exists.
      expect(fake.callsOf("create")).toHaveLength(1);
      expect(fake.boxes.size).toBe(0);
    });
  }

  it("names the missing template snapshot", async () => {
    fake.failNext("create", responseError(404, { code: "snapshot_not_found" }));
    const error = (await acquire("run-1", { templateSnapshot: "golden-v2" }).catch((e) => e)) as BoatProviderError;
    expect(error.code).toBe("BOAT_TEMPLATE_NOT_FOUND");
    expect(error.message).toContain(`"golden-v2"`);
  });

  it("creates a fresh VM when boat refuses the resume because the disk expired", async () => {
    const first = await acquire("run-1");
    await release(first);
    fake.failNext("resume", responseError(409, { code: "snapshot_data_expired" }));
    const second = await acquire("run-2");
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(fake.callsOf("create")).toHaveLength(2);
    expect(second.providerLeaseId).not.toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ startKind: "create" });
    expect(harness.logs.some((entry) => entry.message.includes("disk expired after 14 days"))).toBe(true);
  });

  it("refuses a lease deadline under a minute away before any boat call", async () => {
    const error = (await plugin.definition.onEnvironmentAcquireLease!({
      ...base(),
      runId: "run-1",
      issueId: ISSUE,
      executionWorkspaceId: WORKSPACE,
      agentId: "agent-1",
      requestedExpiresAt: new Date(clock.t + 59_000).toISOString(),
    } as never).catch((e) => e)) as BoatProviderError;
    expect(error.code).toBe("BOAT_DEADLINE_TOO_SOON");
    expect(fake.callsOf("create")).toHaveLength(0);
    expect(fake.callsOf("limits")).toHaveLength(0);
  });
});

describe("the sweep's stop confirmation", () => {
  // A release whose stop does not take effect leaves the record "stopping";
  // the next sweep retries the stop and must confirm it.
  async function leaseLeftStopping(): Promise<string> {
    const lease = await acquire("run-1");
    fake.stopMode = "stays_up";
    await release(lease);
    expect(vmRecord().status).toBe("stopping");
    return lease.providerLeaseId!;
  }

  it("keeps the record stopping when the stop call fails and the VM stays up", async () => {
    const sandboxId = await leaseLeftStopping();
    fake.failNext("stop", responseError(500, { code: "http_500" }));
    const report = await currentManager().sweep("test", { force: true });
    expect(report.stopped).toContain(sandboxId);
    expect(fake.boxes.get(sandboxId)?.state).toBe("ready");
    // Never "stopped" while boat still runs (and bills) the VM.
    expect(vmRecord().status).toBe("stopping");
    expect(harness.logs.some((entry) => entry.level === "warn" && entry.message === "boat: stop call failed")).toBe(true);
  });

  it("records stopped when boat answers 404: the VM is gone", async () => {
    const sandboxId = await leaseLeftStopping();
    fake.failNext("stop", responseError(404, { code: "not_found" }));
    await currentManager().sweep("test", { force: true });
    expect(vmRecord()).toMatchObject({ sandboxId, status: "stopped" });
  });

  it("polls through a 409 sandbox_stopping without a warning and records stopped once archived", async () => {
    const sandboxId = await leaseLeftStopping();
    const box = fake.boxes.get(sandboxId)!;
    fake.failNext("stop", () => {
      box.state = "archiving";
      return responseError(409, { code: "sandbox_stopping" });
    });
    let reads = 0;
    const realGet = fake.get.bind(fake);
    fake.get = async (args: { sandboxId: string }) => {
      reads += 1;
      if (reads === 2) box.state = "archived";
      return await realGet(args);
    };
    await currentManager().sweep("test", { force: true });
    fake.get = realGet;
    expect(vmRecord().status).toBe("stopped");
    expect(harness.logs.some((entry) => entry.message === "boat: stop call failed")).toBe(false);
  });

  it("logs a failing snapshot save while it waits, and stays stopping at the deadline", async () => {
    const sandboxId = await leaseLeftStopping();
    const realGet = fake.get.bind(fake);
    fake.get = async (args: { sandboxId: string }) => {
      const reply = await realGet(args);
      return { ...reply, sandbox: { ...reply.sandbox, stop: { status: "failing" } } };
    };
    await currentManager().sweep("test", { force: true });
    fake.get = realGet;
    expect(fake.boxes.get(sandboxId)?.state).toBe("ready");
    expect(vmRecord().status).toBe("stopping");
    expect(harness.logs.some((entry) => entry.level === "warn" && entry.message.includes("snapshot save failed"))).toBe(true);
  });
});

describe("finding a card's VM by name after the plugin state is lost", () => {
  it("follows the list cursor and resumes the newest stopped match instead of creating a VM", async () => {
    const first = await acquire("run-1");
    const name = fake.boxes.get(first.providerLeaseId!)!.name;
    await release(first);
    harness.state.clear();
    // An older copy of the same name, and an expired one: both lose to the newest live disk.
    fake.addSandbox({ id: "bx_older", name, state: "archived", updatedAt: new Date(clock.t - 3_600_000) });
    fake.addSandbox({ id: "bx_expired", name, state: "archived", dataExpiredAt: new Date(clock.t) });
    fake.boxes.get(first.providerLeaseId!)!.updatedAt = new Date(clock.t);
    // boat pages the list: the card's VM is only on the second page.
    const realList = fake.sandboxes.bind(fake);
    fake.sandboxes = (async (args: Record<string, unknown> = {}) => {
      const all = await realList(args);
      const target = all.sandboxes.filter((s) => s.id === first.providerLeaseId);
      const rest = all.sandboxes.filter((s) => s.id !== first.providerLeaseId);
      if (args.cursor === "page-2") return { ...all, sandboxes: target, pageInfo: { hasMore: false, nextCursor: null, limit: 200 } };
      return { ...all, sandboxes: rest, pageInfo: { hasMore: true, nextCursor: "page-2", limit: 200 } };
    }) as unknown as FakeBoat["sandboxes"];
    const second = await acquire("run-2");
    fake.sandboxes = realList;
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ startKind: "resume" });
    expect(fake.callsOf("create")).toHaveLength(1);
  });

  it("prefers a match that is already up over a newer stopped one", async () => {
    const first = await acquire("run-1");
    const name = fake.boxes.get(first.providerLeaseId!)!.name;
    harness.state.clear();
    fake.boxes.get(first.providerLeaseId!)!.updatedAt = new Date(clock.t - 3_600_000);
    fake.addSandbox({ id: "bx_newer_stopped", name, state: "archived", updatedAt: new Date(clock.t) });
    const second = await acquire("run-2");
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ startKind: "reuse_running" });
    expect(fake.callsOf("resume")).toHaveLength(0);
  });
});
