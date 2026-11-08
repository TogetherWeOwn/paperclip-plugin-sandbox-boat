// Cached budget observations on the usage route: fake Boat clients only, no
// network. Each company reads only observations its own probes produced for
// its current environment binding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiFactoryInput, BoatApiLike } from "./boat-client.js";
import { DEFAULT_API_BASE } from "./config.js";
import { DRIVER_KEY } from "./manifest.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat, responseError, trialLimits } from "./test-support/fake-boat.js";
import { FakeSsh, MockChild, createFakeContext, fakeInvocations, inHostInvocation } from "./test-support/harness.js";

const CO_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CO_B = "bbbbbbbb-0000-4000-8000-000000000002";
const CO_C = "cccccccc-0000-4000-8000-000000000003";
const ENV_A1 = "a1a1a1a1-0000-4000-8000-000000000011";
const ENV_A2 = "a2a2a2a2-0000-4000-8000-000000000012";
const ENV_B1 = "b1b1b1b1-0000-4000-8000-000000000021";
const ENV_C1 = "c1c1c1c1-0000-4000-8000-000000000031";

const BASE1 = "https://boat-one.example.test/api/v1";
const BASE2 = "https://boat-two.example.test/api/v1";
const BASE3 = "https://boat-three.example.test/api/v1";
const KEY_A = "fake-ops-key-a";
const KEY_B = "fake-ops-key-b";
const KEY_SHARED = "fake-ops-key-shared";
const KEY_BAD = "fake-ops-key-bad";
const KEY_HOST_1 = "fake-ops-key-host-1";
const KEY_HOST_2 = "fake-ops-key-host-2";

let clock: { t: number; now: () => number };
let ssh: FakeSsh;
let harness: ReturnType<typeof createFakeContext>;
let clients: Map<string, FakeBoat>;
let stateWriters: Set<string | undefined>;

const bindingKey = (apiBase: string, apiKey: string) => `${apiBase}\u0000${apiKey}`;

/** The fake client behind one base+key pair, created on first use. */
function client(apiBase: string, apiKey: string, line?: string, activeSandboxes?: number): FakeBoat {
  let fake = clients.get(bindingKey(apiBase, apiKey));
  if (!fake) {
    fake = new FakeBoat(clock);
    clients.set(bindingKey(apiBase, apiKey), fake);
  }
  if (line !== undefined) fake.limitsResponse = trialLimits({ trialLine: line, activeSandboxes: activeSandboxes ?? 0 });
  return fake;
}

async function setup(): Promise<void> {
  harness = createFakeContext({ hostScopes: { proactiveCompanies: [CO_A, CO_B, CO_C] } });
  stateWriters = new Set();
  const set = harness.ctx.state.set;
  harness.ctx.state.set = async (input, value) => {
    stateWriters.add(fakeInvocations.getStore()?.id);
    return set(input, value);
  };
  await plugin.definition.setup(harness.ctx as never);
}

beforeEach(async () => {
  clock = { t: Date.parse("2026-10-22T18:00:00Z"), now: () => clock.t };
  ssh = new FakeSsh();
  clients = new Map();
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests((input: BoatApiFactoryInput) => client(input.apiBase, input.apiKey) as unknown as BoatApiLike);
  setManagerOverridesForTests({
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  });
  delete process.env.BOAT_API_KEY;
  await setup();
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
  delete process.env.BOAT_API_KEY;
});

/** Hold the next limits answer of a client until released; resolves `started` once the call arrived. */
function hold(fake: FakeBoat): { started: Promise<void>; release: () => void } {
  const original = fake.limits.bind(fake);
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { arrived = resolve; });
  fake.limits = async (args: Record<string, unknown> = {}) => {
    fake.limits = original;
    const answer = await original(args);
    arrived();
    await gate;
    return answer;
  };
  return { started, release };
}

function probe(companyId: string, environmentId: string, config: Record<string, unknown>) {
  return inHostInvocation(companyId, () =>
    plugin.definition.onEnvironmentProbe!({
      driverKey: DRIVER_KEY, companyId, environmentId, config: { cliproxyTunnel: false, ...config },
    } as never),
  );
}

const inline = (apiBase: string, apiKey: string) => ({ apiBase, apiKey });

const providerCalls = () => [...clients.values()].reduce((sum, fake) => sum + fake.calls.length, 0);
const stateJson = () => JSON.stringify([...harness.state.entries()]);

type Budget = {
  snapshot: { trialLine: string | null; activeSandboxes: number | null };
  at: string;
  provenance: { environmentId: string; apiBase: string; credentialSource: string };
} | null;

/** Call the usage route as the company, assert it neither calls the provider nor writes state, and return the serialized budget. */
async function budgetOf(companyId: string, refresh?: "0"): Promise<Budget> {
  const callsBefore = providerCalls();
  let invocationId: string | undefined;
  const response = await inHostInvocation(companyId, () => {
    invocationId = fakeInvocations.getStore()?.id;
    return plugin.definition.onApiRequest!({
      routeKey: "usage",
      method: "GET",
      path: "/usage",
      params: {},
      query: refresh ? { companyId, refresh } : { companyId },
      body: null,
      actor: { actorType: "user", actorId: "user-1" },
      companyId,
      headers: {},
    });
  });
  expect(response.status).toBe(200);
  const text = JSON.stringify(response.body);
  expect(text).not.toContain("fake-ops-key");
  expect(text).not.toContain("scrypt:");
  expect(providerCalls()).toBe(callsBefore);
  expect(invocationId).toBeDefined();
  expect(stateWriters.has(invocationId)).toBe(false);
  return (JSON.parse(text) as { budget: Budget }).budget;
}

/** Take over the next `ssh -V` spawn: it stays pending until `release`, then exits with `code`. */
function holdNextSshCheck(code = 0): { spawned: Promise<void>; release: () => void } {
  let spawnedNow!: () => void;
  const spawned = new Promise<void>((resolve) => { spawnedNow = resolve; });
  const child = new MockChild();
  spawnMock.mockImplementationOnce(() => {
    spawnedNow();
    return child;
  });
  return { spawned, release: () => child.finish(code, "", code === 0 ? "OpenSSH_10.0p2" : "ssh unusable") };
}

const iso = () => new Date(clock.t).toISOString();

function expected(line: string, activeSandboxes: number, at: string, environmentId: string, apiBase: string, credentialSource: "inline" | "host") {
  return {
    snapshot: expect.objectContaining({ trialLine: line, activeSandboxes }),
    at,
    provenance: { environmentId, apiBase, credentialSource },
  };
}

describe("usage budget observations", () => {
  it("keeps usage observations scoped to their current source", async () => {
    // Observed company A, empty company B, distinct fake clients.
    client(BASE1, KEY_A, "line-a1", 1);
    client(BASE1, KEY_B, "line-b1", 2);
    expect(await budgetOf(CO_A)).toBeNull();
    expect(await budgetOf(CO_B)).toBeNull();

    const tA1 = iso();
    expect((await probe(CO_A, ENV_A1, inline(BASE1, KEY_A))).ok).toBe(true);
    expect(await budgetOf(CO_B)).toBeNull();
    expect(await budgetOf(CO_A)).toEqual(expected("line-a1", 1, tA1, ENV_A1, BASE1, "inline"));
    expect(await budgetOf(CO_A, "0")).toEqual(expected("line-a1", 1, tA1, ENV_A1, BASE1, "inline"));
    expect(await budgetOf(CO_B)).toBeNull();
    expect(client(BASE1, KEY_A).callsOf("limits")).toHaveLength(1);
    expect(client(BASE1, KEY_B).calls).toEqual([]);

    clock.t += 60_000;
    const tB1 = iso();
    expect((await probe(CO_B, ENV_B1, inline(BASE1, KEY_B))).ok).toBe(true);
    expect(await budgetOf(CO_B)).toEqual(expected("line-b1", 2, tB1, ENV_B1, BASE1, "inline"));
    expect(await budgetOf(CO_A)).toEqual(expected("line-a1", 1, tA1, ENV_A1, BASE1, "inline"));

    // Interleaved probes with deferred limits: a result becomes visible only when its probe completes.
    client(BASE1, KEY_A, "line-a2", 1);
    client(BASE1, KEY_B, "line-b2", 2);
    const heldA = hold(client(BASE1, KEY_A));
    const heldB = hold(client(BASE1, KEY_B));
    const pendingA = probe(CO_A, ENV_A1, inline(BASE1, KEY_A));
    const pendingB = probe(CO_B, ENV_B1, inline(BASE1, KEY_B));
    await Promise.all([heldA.started, heldB.started]);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a1", 1, tA1, ENV_A1, BASE1, "inline"));
    expect(await budgetOf(CO_B)).toEqual(expected("line-b1", 2, tB1, ENV_B1, BASE1, "inline"));
    clock.t += 1_000;
    const tB2 = iso();
    heldB.release();
    expect((await pendingB).ok).toBe(true);
    expect(await budgetOf(CO_B)).toEqual(expected("line-b2", 2, tB2, ENV_B1, BASE1, "inline"));
    expect(await budgetOf(CO_A)).toEqual(expected("line-a1", 1, tA1, ENV_A1, BASE1, "inline"));
    clock.t += 1_000;
    let tA2 = iso();
    heldA.release();
    expect((await pendingA).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a2", 1, tA2, ENV_A1, BASE1, "inline"));
    expect(await budgetOf(CO_B)).toEqual(expected("line-b2", 2, tB2, ENV_B1, BASE1, "inline"));

    // A successful limits read followed by a failing ssh check is not a completed probe: the earlier observation stays.
    clock.t += 1_000;
    const failedSsh = holdNextSshCheck(1);
    const pendingFailedSsh = probe(CO_A, ENV_A1, inline(BASE1, KEY_A));
    await failedSsh.spawned;
    expect(client(BASE1, KEY_A).callsOf("limits")).toHaveLength(3);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a2", 1, tA2, ENV_A1, BASE1, "inline"));
    failedSsh.release();
    expect((await pendingFailedSsh).ok).toBe(false);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a2", 1, tA2, ENV_A1, BASE1, "inline"));

    // Two probes whose limits reads finish in start order but whose ssh checks finish in reverse order:
    // observations become visible, and are ranked, by whole-probe completion.
    client(BASE1, KEY_B, "line-a-env2", 8);
    const sshFirst = holdNextSshCheck();
    const sshSecond = holdNextSshCheck();
    const wholeFirst = probe(CO_A, ENV_A1, inline(BASE1, KEY_A));
    await sshFirst.spawned;
    const wholeSecond = probe(CO_A, ENV_A2, inline(BASE1, KEY_B));
    await sshSecond.spawned;
    expect(await budgetOf(CO_A)).toEqual(expected("line-a2", 1, tA2, ENV_A1, BASE1, "inline"));
    clock.t += 1_000;
    const tEnv2 = iso();
    sshSecond.release();
    expect((await wholeSecond).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a-env2", 8, tEnv2, ENV_A2, BASE1, "inline"));
    clock.t += 1_000;
    tA2 = iso();
    sshFirst.release();
    expect((await wholeFirst).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a2", 1, tA2, ENV_A1, BASE1, "inline"));
    expect(await budgetOf(CO_B)).toEqual(expected("line-b2", 2, tB2, ENV_B1, BASE1, "inline"));

    // Identical credentials in two companies do not share observations.
    client(BASE1, KEY_SHARED, "line-shared", 0);
    clock.t += 1_000;
    const tShared = iso();
    expect((await probe(CO_A, ENV_A2, inline(BASE1, KEY_SHARED))).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-shared", 0, tShared, ENV_A2, BASE1, "inline"));
    expect(await budgetOf(CO_B)).toEqual(expected("line-b2", 2, tB2, ENV_B1, BASE1, "inline"));
    expect(await budgetOf(CO_C)).toBeNull();
    clock.t += 1_000;
    const tSharedC = iso();
    expect((await probe(CO_C, ENV_C1, inline(BASE1, KEY_SHARED))).ok).toBe(true);
    expect(await budgetOf(CO_C)).toEqual(expected("line-shared", 0, tSharedC, ENV_C1, BASE1, "inline"));
    expect(await budgetOf(CO_A)).toEqual(expected("line-shared", 0, tShared, ENV_A2, BASE1, "inline"));
    expect(client(BASE1, KEY_SHARED).callsOf("limits")).toHaveLength(2);

    // A failed probe on an unchanged binding keeps its earlier observation and timestamp.
    clock.t += 1_000;
    client(BASE1, KEY_A).failNext("limits", responseError(403, { code: "forbidden", message: "refused" }));
    expect((await probe(CO_A, ENV_A1, inline(BASE1, KEY_A))).ok).toBe(false);
    expect(await budgetOf(CO_A)).toEqual(expected("line-shared", 0, tShared, ENV_A2, BASE1, "inline"));

    // An invalid key on A2 invalidates it at once; A falls back to A1 with its original timestamp.
    client(BASE1, KEY_BAD).failNext("limits", responseError(401, { code: "unauthorized", message: "bad key" }));
    expect((await probe(CO_A, ENV_A2, inline(BASE1, KEY_BAD))).ok).toBe(false);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a2", 1, tA2, ENV_A1, BASE1, "inline"));

    // A missing key invalidates A1 as well.
    expect((await probe(CO_A, ENV_A1, {})).ok).toBe(false);
    expect(await budgetOf(CO_A)).toBeNull();
    expect(await budgetOf(CO_B)).toEqual(expected("line-b2", 2, tB2, ENV_B1, BASE1, "inline"));

    // Changed apiBase: the old observation disappears before the new probe answers.
    client(BASE1, KEY_A, "line-a3", 3);
    clock.t += 1_000;
    const tA3 = iso();
    expect((await probe(CO_A, ENV_A1, inline(BASE1, KEY_A))).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a3", 3, tA3, ENV_A1, BASE1, "inline"));
    client(BASE2, KEY_A, "line-a-base2", 4);
    client(BASE3, KEY_A, "line-a-base3", 5);
    const heldOld = hold(client(BASE2, KEY_A));
    const pendingOld = probe(CO_A, ENV_A1, inline(BASE2, KEY_A));
    await heldOld.started;
    expect(await budgetOf(CO_A)).toBeNull();
    // A newer binding completes first; the delayed older response is ignored.
    clock.t += 1_000;
    const tBase3 = iso();
    expect((await probe(CO_A, ENV_A1, inline(BASE3, KEY_A))).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a-base3", 5, tBase3, ENV_A1, BASE3, "inline"));
    clock.t += 1_000;
    heldOld.release();
    expect((await pendingOld).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-a-base3", 5, tBase3, ENV_A1, BASE3, "inline"));

    // Host credential: observed as "host", dropped when the host key changes, and again when the source becomes inline.
    process.env.BOAT_API_KEY = KEY_HOST_1;
    client(DEFAULT_API_BASE, KEY_HOST_1, "line-h1", 6);
    clock.t += 1_000;
    const tH1 = iso();
    expect((await probe(CO_B, ENV_B1, {})).ok).toBe(true);
    expect(await budgetOf(CO_B)).toEqual(expected("line-h1", 6, tH1, ENV_B1, DEFAULT_API_BASE, "host"));
    delete process.env.BOAT_API_KEY;
    expect(await budgetOf(CO_B)).toBeNull();
    process.env.BOAT_API_KEY = KEY_HOST_1;
    expect(await budgetOf(CO_B)).toBeNull();
    await probe(CO_B, ENV_B1, {});
    process.env.BOAT_API_KEY = KEY_HOST_2;
    expect(await budgetOf(CO_B)).toBeNull();
    client(DEFAULT_API_BASE, KEY_HOST_2, "line-h2", 7);
    const heldHost = hold(client(DEFAULT_API_BASE, KEY_HOST_2));
    const pendingHost = probe(CO_B, ENV_B1, {});
    await heldHost.started;
    expect(await budgetOf(CO_B)).toBeNull();
    clock.t += 1_000;
    const tH2 = iso();
    heldHost.release();
    expect((await pendingHost).ok).toBe(true);
    expect(await budgetOf(CO_B)).toEqual(expected("line-h2", 7, tH2, ENV_B1, DEFAULT_API_BASE, "host"));
    const heldSwitch = hold(client(DEFAULT_API_BASE, KEY_HOST_2));
    const pendingSwitch = probe(CO_B, ENV_B1, inline(DEFAULT_API_BASE, KEY_HOST_2));
    await heldSwitch.started;
    expect(await budgetOf(CO_B)).toBeNull();
    clock.t += 1_000;
    const tSwitch = iso();
    heldSwitch.release();
    expect((await pendingSwitch).ok).toBe(true);
    expect(await budgetOf(CO_B)).toEqual(expected("line-h2", 7, tSwitch, ENV_B1, DEFAULT_API_BASE, "inline"));
    expect(await budgetOf(CO_A)).toEqual(expected("line-a-base3", 5, tBase3, ENV_A1, BASE3, "inline"));

    // Worker reset: observations are memory-only, even with prior state and a probe still in flight.
    const heldReset = hold(client(BASE1, KEY_A));
    const pendingReset = probe(CO_A, ENV_A1, inline(BASE1, KEY_A));
    await heldReset.started;
    await plugin.definition.onShutdown?.();
    await plugin.definition.setup(harness.ctx as never);
    expect(stateJson()).not.toContain("line-");
    heldReset.release();
    await pendingReset.catch(() => undefined);
    for (const company of [CO_A, CO_B, CO_C]) expect(await budgetOf(company)).toBeNull();

    // Only limits reads were ever made against the provider.
    for (const fake of clients.values()) {
      expect(fake.calls.every((call) => call.method === "limits")).toBe(true);
    }
  });

  it("selects the latest completed observation across environments", async () => {
    client(BASE1, KEY_A, "line-env1", 1);
    client(BASE1, KEY_B, "line-env2", 2);
    const held = hold(client(BASE1, KEY_A));
    const first = probe(CO_A, ENV_A1, inline(BASE1, KEY_A));
    await held.started;
    const tSecond = iso();
    expect((await probe(CO_A, ENV_A2, inline(BASE1, KEY_B))).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-env2", 2, tSecond, ENV_A2, BASE1, "inline"));
    // Completion order selects the first probe even when timestamps tie.
    const tFirst = iso();
    held.release();
    expect((await first).ok).toBe(true);
    expect(await budgetOf(CO_A)).toEqual(expected("line-env1", 1, tFirst, ENV_A1, BASE1, "inline"));
    expect(await budgetOf(CO_B)).toBeNull();
    expect(await budgetOf(CO_C)).toBeNull();
  });
});
