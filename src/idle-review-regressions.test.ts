import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import { parseDriverConfig } from "./config.js";
import plugin from "./plugin.js";
import { FakeBoat, responseError } from "./test-support/fake-boat.js";
import { FakeSsh, MockChild, createFakeContext } from "./test-support/harness.js";
import { BoatVmManager } from "./vm-manager.js";

const companyId = "company-review";
const environmentId = "environment-review";
const config = { apiKey: "boat_test_key_not_real", cliproxyTunnel: false };
let clock: number;
let fake: FakeBoat;
let ssh: FakeSsh;
let harness: ReturnType<typeof createFakeContext>;
let managers: BoatVmManager[];

function manager() {
  const instance = new BoatVmManager({
    state: harness.ctx.state, logger: harness.ctx.logger, now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  managers.push(instance);
  return instance;
}

async function acquire(instance: BoatVmManager, raw: Record<string, unknown> = config) {
  return instance.acquire({ companyId, environmentId, driverKey: "boat", config: raw, runId: "run-review", issueId: "issue-review" });
}

beforeEach(() => {
  clock = Date.parse("2026-10-25T07:00:00Z");
  fake = new FakeBoat({ now: () => clock });
  ssh = new FakeSsh();
  harness = createFakeContext();
  managers = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(ssh.spawn);
  setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
});
afterEach(async () => {
  for (const instance of managers) await instance.shutdown();
  setBoatApiFactoryForTests(null);
  vi.useRealTimers();
});

describe("monitoring privacy boundary", () => {
  it("defaults monitoring on and preserves an explicit opt-out through normalization and creation", async () => {
    expect(parseDriverConfig({})).toHaveProperty("monitoring", true);
    const raw = { ...config, monitoring: false };
    const normalized = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: raw });
    expect(normalized.normalizedConfig).toHaveProperty("monitoring", false);
    await acquire(manager(), raw);
    expect(fake.callsOf("create")[0].args).toMatchObject({ monitoring: false });
  });

  it("does not override an account monitoring-off policy or echo its response body", async () => {
    const opaqueOutput = "opaque-monitoring-credential-fixture";
    fake.failNext("create", responseError(409, { code: "monitoring_off_for_account", message: opaqueOutput }));
    await expect(acquire(manager())).rejects.toMatchObject({ code: "BOAT_MONITORING_OFF_FOR_ACCOUNT" });
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(fake.callsOf("update")).toHaveLength(0);
    expect(JSON.stringify(harness.logs)).not.toContain(opaqueOutput);
  });

  it("discards provider telemetry fields rather than copying captured output into state or logs", async () => {
    const opaqueOutput = "opaque-captured-output-fixture";
    const create = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation(async (args) => {
      const result = await create(args);
      return { ...result, commandHistory: [{ stdout: opaqueOutput }], sandbox: {
        ...result.sandbox, processes: [{ command: opaqueOutput }], monitoringOutput: opaqueOutput,
      } };
    });
    await acquire(manager());
    expect(JSON.stringify([...harness.state])).not.toContain(opaqueOutput);
    expect(JSON.stringify(harness.logs)).not.toContain(opaqueOutput);
  });

  it.each(["failed", "incomplete"])("keeps untrusted %s scrub output out of snapshot errors and logs", async (status) => {
    const instance = manager();
    const lease = await acquire(instance);
    const opaqueOutput = "opaque-scrub-output-credential-fixture";
    ssh.handler = (command) => command.includes("paperclip-boat-scrub") ? {
      code: status === "failed" ? 1 : 3,
      stdout: status === "failed" ? "" : "paperclip-boat-scrub found=0 left=0 walk=incomplete\n",
      stderr: opaqueOutput,
    } : undefined;
    let error: unknown;
    try {
      await instance.captureTemplate({ companyId, environmentId, driverKey: "boat", config,
        providerLeaseId: lease.providerLeaseId!, templateLabel: "privacy-fixture" });
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "BOAT_RUNTIME_SCRUB_FAILED" });
    expect(String(error)).not.toContain(opaqueOutput);
    expect(JSON.stringify(harness.logs)).not.toContain(opaqueOutput);
    expect(JSON.stringify([...harness.state])).not.toContain(opaqueOutput);
    expect(fake.callsOf("saveNamedSnapshot")).toHaveLength(0);
  });
});

describe("cross-manager activity", () => {
  it("refuses to launch work when its initial shared heartbeat cannot be persisted", async () => {
    const instance = manager();
    const lease = await acquire(instance);
    const set = harness.ctx.state.set;
    vi.spyOn(harness.ctx.state, "set").mockImplementation(async (input, value) => {
      if (input.stateKey.startsWith("activity:")) throw new Error("state unavailable");
      await set(input, value);
    });
    await expect(instance.execute({ companyId, environmentId, driverKey: "boat", config, lease,
      command: "must-not-launch", args: [], env: {} })).rejects.toThrow("state unavailable");
    expect(ssh.execs().some((call) => call.args.at(-1)?.includes("must-not-launch"))).toBe(false);
    expect(instance.health()).toHaveProperty("commandsInFlight", 0);
  });

  it("does not stop an idle VM when its shared heartbeat cannot be read", async () => {
    const instance = manager();
    await acquire(instance);
    clock += 21 * 60_000;
    const get = harness.ctx.state.get;
    vi.spyOn(harness.ctx.state, "get").mockImplementation(async (input) => {
      if (input.stateKey.startsWith("activity:")) throw new Error("heartbeat unavailable");
      return get(input);
    });
    const report = await instance.sweep("unreadable-heartbeat", { force: true });
    expect(report.stopped).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(fake.callsOf("stop")).toHaveLength(0);
  });

  it("reclaims a crashed worker's VM once its last heartbeat becomes stale", async () => {
    const crashedManager = manager();
    const sweepingManager = manager();
    const lease = await acquire(crashedManager);
    sweepingManager.rememberConfig(companyId, environmentId, parseDriverConfig(config));
    const payload = new MockChild();
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    spawnMock.mockImplementation((command: string, args: string[], options?: { stdio?: unknown[] }) => {
      if (command === "ssh" && args.at(-1)?.includes("crashed-worker-command")) {
        started();
        return payload;
      }
      return ssh.spawn(command, args, options);
    });
    const executing = crashedManager.execute({ companyId, environmentId, driverKey: "boat", config, lease,
      command: "crashed-worker-command", args: [], env: {}, timeoutMs: 3_600_000 });
    try {
      await reached;
      // Loss of the worker stops heartbeats without publishing completion.
      await crashedManager.shutdown();
      clock += 21 * 60_000;
      expect((await sweepingManager.sweep("crashed-worker", { force: true })).stopped).toEqual([lease.providerLeaseId]);
    } finally {
      payload.finish(0);
      await executing;
    }
  });

  it("rechecks a heartbeat published by another manager between stale selection and the sweep lock", async () => {
    const executingManager = manager();
    const sweepingManager = manager();
    const lease = await acquire(executingManager);
    sweepingManager.rememberConfig(companyId, environmentId, parseDriverConfig(config));
    clock += 21 * 60_000;

    let selected!: () => void;
    const selectionReached = new Promise<void>((resolve) => { selected = resolve; });
    let continueSweep!: () => void;
    const selectionHeld = new Promise<void>((resolve) => { continueSweep = resolve; });
    const get = harness.ctx.state.get;
    let holdSelection = true;
    vi.spyOn(harness.ctx.state, "get").mockImplementation(async (input) => {
      const value = await get(input);
      if (holdSelection && input.stateKey === `activity:${lease.providerLeaseId}`) {
        holdSelection = false;
        // Preserve the stale selection read while a different manager admits
        // real work. Only the under-lock shared-state recheck can see it.
        selected();
        await selectionHeld;
      }
      return value;
    });

    const payload = new MockChild();
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => { started = resolve; });
    spawnMock.mockImplementation((command: string, args: string[], options?: { stdio?: unknown[] }) => {
      if (command === "ssh" && args.at(-1)?.includes("admitted-during-sweep-command")) {
        started();
        return payload;
      }
      return ssh.spawn(command, args, options);
    });
    const scrubsBefore = ssh.scrubs().length;
    const sweeping = sweepingManager.sweep("admit-during-sweep", { force: true });
    let executing: ReturnType<BoatVmManager["execute"]> | undefined;
    try {
      await selectionReached;
      executing = executingManager.execute({ companyId, environmentId, driverKey: "boat", config, lease,
        command: "admitted-during-sweep-command", args: [], env: {}, timeoutMs: 3_600_000 });
      await commandStarted;
      continueSweep();
      expect((await sweeping).stopped).toEqual([]);
      expect(fake.callsOf("stop")).toHaveLength(0);
      expect(ssh.scrubs()).toHaveLength(scrubsBefore);
      expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("ready");
      expect(payload.exitCode).toBeNull();
    } finally {
      continueSweep();
      payload.finish(0);
      await executing;
      await sweeping;
    }
    // A fresh heartbeat postpones cleanup, rather than disabling it forever.
    clock += 21 * 60_000;
    expect((await sweepingManager.sweep("idle-after-interleaved-command", { force: true })).stopped).toEqual([lease.providerLeaseId]);
  });

  it("protects a silent 21-minute command from another manager and reclaims it after heartbeats stop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const executingManager = manager();
    const sweepingManager = manager();
    const lease = await acquire(executingManager);
    sweepingManager.rememberConfig(companyId, environmentId, parseDriverConfig(config));
    const payload = new MockChild();
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    spawnMock.mockImplementation((command: string, args: string[], options?: { stdio?: unknown[] }) => {
      if (command === "ssh" && args.at(-1)?.includes("silent-cross-manager-command")) {
        started();
        return payload;
      }
      return ssh.spawn(command, args, options);
    });
    const executing = executingManager.execute({ companyId, environmentId, driverKey: "boat", config, lease,
      command: "silent-cross-manager-command", args: [], env: {}, timeoutMs: 3_600_000 });
    try {
      await reached;
      for (let minute = 0; minute < 21; minute += 1) {
        clock += 60_000;
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect((await sweepingManager.sweep("cross-manager", { force: true })).stopped).toEqual([]);
      expect(fake.callsOf("stop")).toHaveLength(0);
    } finally {
      payload.finish(0);
      await executing;
    }
    clock += 21 * 60_000;
    expect((await sweepingManager.sweep("after-command", { force: true })).stopped).toEqual([lease.providerLeaseId]);
  });
});

describe("unmeasured size guidance", () => {
  it("warns when an unmeasured class falls back to small without guessing its workload", async () => {
    await acquire(manager(), { ...config, taskClass: "unmeasured-build" });
    expect(harness.logs).toContainEqual(expect.objectContaining({
      level: "warn", message: expect.stringContaining("unmeasured"),
      meta: expect.objectContaining({ taskClass: "unmeasured-build", size: "small" }),
    }));
  });

  it("does not warn about small when heavy work explicitly pins default", async () => {
    await acquire(manager(), { ...config, taskClass: "rust-build", size: "default" });
    expect(harness.logs.filter((entry) => entry.level === "warn" && entry.message.includes("unmeasured"))).toEqual([]);
  });
});
