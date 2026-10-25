import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests, type BoatApiLike } from "./boat-client.js";
import { DRIVER_KEY } from "./manifest.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const STALE_ISSUE = "55555555-5555-4555-8555-555555555555";
const API_KEY = "boat_synthetic_admission_credential_not_real";
const FQDN = "private-policy.example.test";
const CIDR = "192.0.2.19/32";
const POLICY_SECRET = "synthetic-policy-payload-do-not-emit";
const UNSUPPORTED = "BOAT_NETWORK_EGRESS_UNSUPPORTED";
const UNAVAILABLE = "BOAT_NETWORK_POLICY_UNAVAILABLE";

const explicitPolicies = [
  { name: "FQDN grant", value: { allowFqdns: [FQDN] } },
  { name: "CIDR grant", value: { allowCidrs: [CIDR] } },
  { name: "empty grant", value: {} },
  { name: "empty allow lists", value: { allowFqdns: [], allowCidrs: [] } },
  { name: "false", value: false },
  { name: "zero", value: 0 },
  { name: "empty string", value: "" },
  { name: "string", value: FQDN },
  { name: "array", value: [] },
  { name: "malformed allow list", value: { allowFqdns: FQDN } },
  { name: "unknown policy shape", value: { unexpected: POLICY_SECRET } },
];
const acquirePaths = ["fresh", "archived", "running reuse", "name recovery"] as const;
type AcquirePath = typeof acquirePaths[number];
const resumeStates = ["archived", "running"] as const;
type ResumeState = typeof resumeStates[number];

let clock: number;
let boat: FakeBoat;
let ssh: FakeSsh;
let harness: ReturnType<typeof createFakeContext>;

function base() {
  return {
    driverKey: DRIVER_KEY, companyId: COMPANY, environmentId: ENV,
    config: { apiKey: API_KEY, cliproxyTunnel: false },
  };
}

function acquireParams(runId: string) {
  return { ...base(), runId, issueId: ISSUE, executionWorkspaceId: WORKSPACE, agentId: "test-agent" };
}

type Lease = Awaited<ReturnType<ReturnType<typeof currentManager>["acquire"]>>;

function leaseParams(lease: Lease) {
  // ResumeLease has no executionWorkspaceSettings in the installed SDK.
  return { ...base(), issueId: ISSUE, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata };
}

function livePolicy(settings: Record<string, unknown> | null = {}) {
  harness.issues.set(ISSUE, { status: "in_progress", executionWorkspaceSettings: settings });
}

beforeEach(async () => {
  clock = Date.parse("2026-10-24T12:00:00Z");
  boat = new FakeBoat({ now: () => clock });
  ssh = new FakeSsh();
  harness = createFakeContext();
  livePolicy();
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests(() => boat as unknown as BoatApiLike);
  setManagerOverridesForTests({ now: () => clock, sleep: async (ms) => { clock += ms; } });
  await plugin.definition.setup(harness.ctx as never);
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  vi.restoreAllMocks();
  setBoatApiFactoryForTests(null);
  setManagerOverridesForTests({});
});

async function seedLease(state: ResumeState = "running", issueBacked = true) {
  // Direct manager calls avoid unrelated fire-and-forget admission sweeps.
  const lease = await currentManager().acquire((issueBacked ? acquireParams("original") : {
    ...base(), runId: "without-issue",
  }) as never);
  expect(lease.providerLeaseId).toEqual(expect.any(String));
  if (state === "archived") {
    await currentManager().release({ ...leaseParams(lease), resourceDisposition: "stop_and_retain" } as never, "release");
    expect(boat.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
  }
  return lease;
}

async function prepareAcquire(path: AcquirePath) {
  if (path === "fresh") return;
  await seedLease(path === "running reuse" ? "running" : "archived");
  if (path === "name recovery") {
    harness.state.clear();
    await currentManager().shutdown();
    await plugin.definition.setup(harness.ctx as never);
    expect(boat.boxes.size).toBe(1);
  }
}

function checkpoint() {
  return {
    providerAt: boat.calls.length, spawnAt: ssh.spawned.length, logAt: harness.logs.length,
    state: structuredClone([...harness.state]), boxes: structuredClone([...boat.boxes]),
    snapshots: structuredClone([...boat.named]),
    set: vi.spyOn(harness.ctx.state, "set").mockClear(),
    delete: vi.spyOn(harness.ctx.state, "delete").mockClear(),
  };
}

type Checkpoint = ReturnType<typeof checkpoint>;

function expectNoAdmissionEffects(before: Checkpoint, acquire = false) {
  const providerCalls = boat.calls.slice(before.providerAt);
  if (acquire) {
    // Acquire must reject even before provider reads, limits checks or recovery lookup.
    expect.soft(providerCalls).toEqual([]);
  } else {
    // A read-only provider lookup is not a start; all mutating API calls are forbidden.
    expect.soft(providerCalls.filter((call) => !["get", "sandboxes", "limits", "usage", "listNamedSnapshots"].includes(call.method))).toEqual([]);
  }
  expect.soft(ssh.spawned.slice(before.spawnAt)).toEqual([]);
  expect.soft(before.set).not.toHaveBeenCalled();
  expect.soft(before.delete).not.toHaveBeenCalled();
  expect.soft([...harness.state]).toEqual(before.state);
  expect.soft([...boat.boxes]).toEqual(before.boxes);
  expect.soft([...boat.named]).toEqual(before.snapshots);
}

async function settle(operation: Promise<unknown>) {
  return await operation.then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

type Outcome = Awaited<ReturnType<typeof settle>>;

function expectNoDisclosure(outcome: Outcome, before: Checkpoint) {
  const emitted = JSON.stringify({
    outcome, logs: harness.logs.slice(before.logAt), providerCalls: boat.calls.slice(before.providerAt),
    processes: ssh.spawned.slice(before.spawnAt).map(({ command, args, stdin }) => ({ command, args, stdin })),
  }, (_key, value: unknown) => value instanceof Error
    ? Object.fromEntries(Object.getOwnPropertyNames(value).map((key) => [key, (value as unknown as Record<string, unknown>)[key]]))
    : value);
  for (const sentinel of [API_KEY, FQDN, CIDR, POLICY_SECRET]) expect.soft(emitted).not.toContain(sentinel);
}

function expectRefusal(outcome: Outcome, before: Checkpoint, code: string, acquire = false) {
  expect.soft(outcome.error).toMatchObject({ code });
  expect.soft(outcome.value).toBeUndefined(); // A warning on a usable lease is not refusal.
  expectNoAdmissionEffects(before, acquire);
  expectNoDisclosure(outcome, before);
}

describe.each(acquirePaths)("native network policy AcquireLease: %s", (path) => {
  it.each(explicitPolicies)("refuses $name before provider, state or SSH effects", async ({ value }) => {
    await prepareAcquire(path);
    const before = checkpoint();
    const outcome = await settle(plugin.definition.onEnvironmentAcquireLease!({
      ...acquireParams("denied"), executionWorkspaceSettings: { networkEgress: value },
    }));
    expectRefusal(outcome, before, UNSUPPORTED, true);
  });

  it.each([
    { name: "omitted settings", settings: undefined },
    { name: "omitted policy", settings: {} },
    { name: "null policy", settings: { networkEgress: null } },
  ])("keeps explicitly unrestricted legacy compatibility for $name", async ({ settings }) => {
    await prepareAcquire(path);
    const existingId = [...boat.boxes.keys()][0];
    const creates = boat.callsOf("create").length;
    const resumes = boat.callsOf("resume").length;
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      ...acquireParams("compatible"), ...(settings === undefined ? {} : { executionWorkspaceSettings: settings }),
    });
    expect(lease.providerLeaseId).toBe(path === "fresh" ? [...boat.boxes.keys()][0] : existingId);
    expect(lease.metadata).toMatchObject({
      startKind: path === "fresh" ? "create" : path === "running reuse" ? "reuse_running" : "resume",
    });
    expect(boat.callsOf("create").length - creates).toBe(path === "fresh" ? 1 : 0);
    expect(boat.callsOf("resume").length - resumes).toBe(path === "archived" || path === "name recovery" ? 1 : 0);
  });
});

describe.each(resumeStates)("native network policy ResumeLease: %s VM", (state) => {
  it.each(explicitPolicies)("re-reads current issue policy and refuses $name despite unrestricted stale metadata", async ({ value }) => {
    const lease = await seedLease(state);
    livePolicy({ networkEgress: value });
    const reader = vi.spyOn(harness.ctx.issues, "get");
    const before = checkpoint();
    const outcome = await settle(plugin.definition.onEnvironmentResumeLease!({
      ...leaseParams(lease), leaseMetadata: {
        ...lease.metadata, executionWorkspaceSettings: { networkEgress: null }, networkEgress: null,
      },
    } as never));
    expect.soft(reader).toHaveBeenCalledWith(ISSUE, COMPANY);
    expectRefusal(outcome, before, UNSUPPORTED);
  });

  it.each([
    { name: "omitted policy", settings: {} },
    { name: "null policy", settings: { networkEgress: null } },
    { name: "null settings", settings: null },
  ])("allows authoritative $name, not a stale restrictive lease hint", async ({ settings }) => {
    const lease = await seedLease(state);
    livePolicy(settings);
    const reader = vi.spyOn(harness.ctx.issues, "get");
    const creates = boat.callsOf("create").length;
    const resumes = boat.callsOf("resume").length;
    const resumed = await plugin.definition.onEnvironmentResumeLease!({
      ...leaseParams(lease), leaseMetadata: {
        ...lease.metadata, executionWorkspaceSettings: { networkEgress: { allowFqdns: [FQDN] } },
        networkEgress: { allowFqdns: [FQDN] },
      },
    } as never);
    expect.soft(reader).toHaveBeenCalledWith(ISSUE, COMPANY);
    expect.soft(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect.soft(resumed.metadata).toMatchObject({ resumedLease: true });
    expect.soft(boat.callsOf("create")).toHaveLength(creates);
    expect.soft(boat.callsOf("resume").length - resumes).toBe(state === "archived" ? 1 : 0);
  });

  it.each([
    { name: "absent", issue: { status: "in_progress" } },
    { name: "undefined", issue: { status: "in_progress", executionWorkspaceSettings: undefined } },
    { name: "false", issue: { status: "in_progress", executionWorkspaceSettings: false } },
    { name: "zero", issue: { status: "in_progress", executionWorkspaceSettings: 0 } },
    { name: "empty string", issue: { status: "in_progress", executionWorkspaceSettings: "" } },
    { name: "string", issue: { status: "in_progress", executionWorkspaceSettings: POLICY_SECRET } },
    { name: "array", issue: { status: "in_progress", executionWorkspaceSettings: [] } },
  ])("fails closed for $name authoritative settings before provider, state or SSH effects", async ({ issue }) => {
    const lease = await seedLease(state);
    harness.issues.set(ISSUE, issue as never);
    const reader = vi.spyOn(harness.ctx.issues, "get");
    const before = checkpoint();
    const outcome = await settle(plugin.definition.onEnvironmentResumeLease!(leaseParams(lease) as never));
    expect.soft(reader.mock.calls).toEqual([[ISSUE, COMPANY]]);
    expectRefusal(outcome, before, UNAVAILABLE, true);
  });

  it.each(["missing issue", "read failure", "missing reader", "missing issue client"] as const)(
    "fails closed for %s, without treating unknown policy as unrestricted", async (missing) => {
      const lease = await seedLease(state);
      if (missing === "missing issue") harness.issues.delete(ISSUE);
      if (missing === "read failure") {
        vi.spyOn(harness.ctx.issues, "get").mockRejectedValue(new Error(`lookup failed: ${FQDN} ${CIDR} ${API_KEY} ${POLICY_SECRET}`));
      }
      if (missing === "missing reader" || missing === "missing issue client") {
        await currentManager().shutdown();
        await plugin.definition.setup({
          ...harness.ctx, issues: missing === "missing reader" ? {} : undefined,
        } as never);
      }
      const before = checkpoint();
      const outcome = await settle(plugin.definition.onEnvironmentResumeLease!(leaseParams(lease) as never));
      expectRefusal(outcome, before, UNAVAILABLE);
    },
  );

  it("does not resume or delete a VM with no issue identity", async () => {
    const lease = await seedLease(state, false);
    const before = checkpoint();
    const outcome = await settle(plugin.definition.onEnvironmentResumeLease!({
      ...base(), providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata,
    } as never));
    // Both contract-safe choices are allowed; do not presume a deployed host retry path.
    if (outcome.error !== null) expect.soft(outcome.error).toMatchObject({ code: UNAVAILABLE });
    else expect.soft(outcome.value).toMatchObject({ providerLeaseId: null });
    expectNoAdmissionEffects(before);
    expectNoDisclosure(outcome, before);
  });
});

describe("authoritative issue policy is not cached at resume admission", () => {
  describe.each(resumeStates)("current host issue identity: %s VM", (state) => {
    it("refuses metadata-only issue identity when the SDK request omits issueId", async () => {
      const lease = await seedLease(state);
      livePolicy({ networkEgress: null });
      const reader = vi.spyOn(harness.ctx.issues, "get");
      const { issueId: _issueId, ...params } = leaseParams(lease);
      const before = checkpoint();
      const outcome = await settle(plugin.definition.onEnvironmentResumeLease!({
        ...params, leaseMetadata: { ...lease.metadata, issueId: ISSUE },
      } as never));
      expect.soft(reader).not.toHaveBeenCalled();
      expectRefusal(outcome, before, UNAVAILABLE, true);
    });

    it("queries only current issueId and refuses its restrictive policy despite a permissive metadata identity", async () => {
      const lease = await seedLease(state);
      harness.issues.set(STALE_ISSUE, { status: "in_progress", executionWorkspaceSettings: { networkEgress: null } });
      livePolicy({ networkEgress: { allowFqdns: [FQDN] } });
      const reader = vi.spyOn(harness.ctx.issues, "get");
      const before = checkpoint();
      const outcome = await settle(plugin.definition.onEnvironmentResumeLease!({
        ...leaseParams(lease), leaseMetadata: {
          ...lease.metadata, issueId: STALE_ISSUE, executionWorkspaceSettings: { networkEgress: null }, networkEgress: null,
        },
      } as never));
      expect.soft(reader.mock.calls).toEqual([[ISSUE, COMPANY]]);
      expectRefusal(outcome, before, UNSUPPORTED, true);
    });
  });

  it("re-reads after a successful resume when the current policy changes", async () => {
    const lease = await seedLease("archived");
    const reader = vi.spyOn(harness.ctx.issues, "get");
    const first = await plugin.definition.onEnvironmentResumeLease!(leaseParams(lease) as never);
    expect(first.providerLeaseId).toBe(lease.providerLeaseId);
    await currentManager().release({ ...leaseParams(first), resourceDisposition: "stop_and_retain" } as never, "release");
    reader.mockClear();
    livePolicy({ networkEgress: { allowFqdns: [FQDN] } });
    const before = checkpoint();
    const outcome = await settle(plugin.definition.onEnvironmentResumeLease!(leaseParams(first) as never));
    expect.soft(reader).toHaveBeenCalledWith(ISSUE, COMPANY);
    expectRefusal(outcome, before, UNSUPPORTED);
  });

  it("waits for the authoritative read before start, SSH or persistence, then refuses its restrictive result", async () => {
    const lease = await seedLease("archived");
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let readStarted = false;
    vi.spyOn(harness.ctx.issues, "get").mockImplementation(async () => {
      readStarted = true;
      await gate;
      return { status: "in_progress", executionWorkspaceSettings: { networkEgress: { allowCidrs: [CIDR] } } };
    });
    const before = checkpoint();
    let settled = false;
    const pending = settle(plugin.definition.onEnvironmentResumeLease!(leaseParams(lease) as never))
      .then((outcome) => { settled = true; return outcome; });
    try {
      // The fake boundaries settle in microtasks; no wall-clock sleep or live provider.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect.soft(readStarted).toBe(true);
      expect.soft(settled).toBe(false);
      expectNoAdmissionEffects(before);
    } finally {
      open();
    }
    expectRefusal(await pending, before, UNSUPPORTED);
  });
});

describe("network policy refusal preserves recovery and cleanup", () => {
  it.each(["release", "stop", "destroy"] as const)("keeps ordinary %s usable when issue policy cannot be read", async (operation) => {
    const lease = await seedLease();
    livePolicy({ networkEgress: { allowFqdns: [FQDN] } });
    vi.spyOn(harness.ctx.issues, "get").mockRejectedValue(new Error("policy lookup unavailable"));
    const creates = boat.callsOf("create").length;
    const resumes = boat.callsOf("resume").length;
    ssh.runtimeSecrets.set(lease.providerLeaseId!, 2);
    const params = leaseParams(lease);
    const receipt = operation === "release"
      ? await plugin.definition.onEnvironmentReleaseLease!(params as never)
      : operation === "stop"
        ? await plugin.definition.onEnvironmentStopLease!({ ...params, resourceDisposition: "stop_and_retain" } as never)
        : await plugin.definition.onEnvironmentDestroyLease!(params as never);
    expect(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: operation === "destroy" ? "destroyed" : "stopped" });
    expect(boat.callsOf("create")).toHaveLength(creates);
    expect(boat.callsOf("resume")).toHaveLength(resumes);
    expect(ssh.runtimeSecrets.get(lease.providerLeaseId!)).toBe(0);
    expect(boat.callsOf("deleteSandbox")).toHaveLength(operation === "destroy" ? 1 : 0);
    if (operation !== "destroy") expect(boat.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
    else expect(boat.boxes.has(lease.providerLeaseId!)).toBe(false);
  });

  it("keeps a refused retained disk available for recovery after an authoritative policy change", async () => {
    const lease = await seedLease("archived");
    livePolicy({ networkEgress: { allowCidrs: [CIDR] } });
    const before = checkpoint();
    const denied = await settle(plugin.definition.onEnvironmentResumeLease!(leaseParams(lease) as never));
    expectRefusal(denied, before, UNSUPPORTED);

    livePolicy({ networkEgress: null });
    const recovered = await plugin.definition.onEnvironmentResumeLease!(leaseParams(lease) as never);
    expect(recovered.providerLeaseId).toBe(lease.providerLeaseId);
    expect(boat.callsOf("create")).toHaveLength(1);
    expect(boat.callsOf("deleteSandbox")).toHaveLength(0);
    expect(boat.boxes.get(lease.providerLeaseId!)?.state).toBe("ready");
    await expect(plugin.definition.onEnvironmentStopLease!({
      ...leaseParams(recovered), resourceDisposition: "stop_and_retain",
    } as never)).resolves.toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    expect(boat.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
  });
});
