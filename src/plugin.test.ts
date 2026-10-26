import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import manifest, { DRIVER_KEY, SWEEP_JOB_KEY } from "./manifest.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { cliEngineCalls, largeEnvelopeAcpLaunch } from "./test-support/acp-process-session.js";
import { FakeBoat, responseError, trialLimits } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext, inHostInvocation, scriptOfShDashC } from "./test-support/harness.js";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatProviderError } from "./errors.js";
import { nativeWorkspaceParams } from "./test-support/native-workspace.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const SECRET = "sk-super-secret-value-9f8e7d";

const baseConfig = { apiKey: "boat_test_key_not_real", tunnelTargetHost: "cliproxy" };

function base(config: Record<string, unknown> = {}) {
  return { driverKey: DRIVER_KEY, companyId: COMPANY, environmentId: ENV, config: { ...baseConfig, ...config } };
}

function acquireParams(runId: string, extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return { ...base(config), runId, issueId: ISSUE, executionWorkspaceId: WORKSPACE, agentId: "agent-1", ...extra };
}

let clock: { t: number; now: () => number };
let fake: FakeBoat;
let ssh: FakeSsh;
let harness: ReturnType<typeof createFakeContext>;
let sleeps: number[];

async function setup(
  options: { issues?: Map<string, { status: string }>; hostScopes?: { proactiveCompanies: string[] } } = {},
) {
  harness = createFakeContext(options);
  await plugin.definition.setup(harness.ctx as never);
}

beforeEach(async () => {
  clock = { t: Date.parse("2026-10-22T18:00:00Z"), now: () => clock.t };
  fake = new FakeBoat(clock);
  ssh = new FakeSsh();
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
  delete process.env.BOAT_API_KEY;
  await setup();
});

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  setBoatApiFactoryForTests(null);
});

async function acquire(runId: string, extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return await plugin.definition.onEnvironmentAcquireLease!(acquireParams(runId, extra, config) as never);
}

async function release(lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> }, extra: Record<string, unknown> = {}) {
  return await plugin.definition.onEnvironmentReleaseLease!({
    ...base(),
    issueId: ISSUE,
    providerLeaseId: lease.providerLeaseId,
    leaseMetadata: lease.metadata,
    ...extra,
  } as never);
}

describe("manifest", () => {
  it("declares reusable leases, so Paperclip can stop a card's VM between runs and resume it", () => {
    const driver = manifest.environmentDrivers?.[0] as { sandboxCapabilities?: { reusableLeases?: boolean } };
    expect(driver.sandboxCapabilities?.reusableLeases).toBe(true);
  });

  it("declares a sandbox_provider driver, the sweep job and the usage route", () => {
    expect(manifest.environmentDrivers?.[0]).toMatchObject({
      driverKey: "boat",
      kind: "sandbox_provider",
      supportsTemplateCapture: true,
      templateRefKind: "snapshot",
      templateConfigBinding: { field: "templateSnapshot" },
      supportsTemplateDelete: true,
    });
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["environment.drivers.register", "plugin.state.read", "plugin.state.write", "jobs.schedule", "api.routes.register", "issues.read"]),
    );
    expect(manifest.jobs?.[0]).toMatchObject({ jobKey: SWEEP_JOB_KEY, schedule: "*/5 * * * *" });
    expect(manifest.apiRoutes?.map((route) => route.routeKey)).toEqual(["usage", "sweep", "offload_exec", "offload_read", "offload_heartbeat", "offload_cancel", "offload_report"]);
    expect(harness.jobs.has(SWEEP_JOB_KEY)).toBe(true);
  });

  it("reports the package.json version, so Paperclip records the version that is installed", () => {
    // Paperclip's upgrade stores manifest.version. 0.2.1 shipped with package.json at 0.2.1 and
    // the manifest still at 0.2.0, so the host recorded 0.2.0 for the 0.2.1 code.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });
});

describe("ValidateConfig", () => {
  it("keeps Paperclip's reuseLease flag in the normalized config, so per-card reuse is not dropped on save", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: DRIVER_KEY, config: { ...baseConfig, reuseLease: true } });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({ reuseLease: true });
    const off = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: DRIVER_KEY, config: { ...baseConfig } });
    expect(off.normalizedConfig).toMatchObject({ reuseLease: false });
  });

  it("normalizes defaults that match the boat trial", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { apiKey: "boat_x" } });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({
      size: "small",
      autoStopMinutes: 120,
      idleStopMinutes: 5,
      staleLeaseMinutes: 20,
      maxActive: 2,
      maxStartsPerDay: 70,
      minComputeHoursLeft: 1,
      failFast: true,
      noEnv: true,
      cliproxyTunnel: true,
      tunnelRemotePort: 8317,
    });
  });

  it("rejects bad sizes, missing keys and auto-stop beyond 30 days, and warns above the trial maximum", async () => {
    const bad = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { size: "huge", autoStopMinutes: 99999 } });
    expect(bad.ok).toBe(false);
    expect(bad.errors?.join("\n")).toMatch(/size must be one of/);
    expect(bad.errors?.join("\n")).toMatch(/API key/);
    expect(bad.errors?.join("\n")).toMatch(/autoStopMinutes/);
    const warn = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { apiKey: "k", autoStopMinutes: 180 } });
    expect(warn.ok).toBe(true);
    expect(warn.warnings?.join("\n")).toMatch(/trial refuses auto-stop above 2 hours/);
  });
});

describe("AcquireLease", () => {
  it("creates a VM for a new card with monitoring on, noEnv, fail-fast, an idempotency key and the trial TTL", async () => {
    const lease = await acquire("run-1");
    const create = fake.callsOf("create");
    expect(create).toHaveLength(1);
    expect(create[0].args).toMatchObject({
      type: "small",
      ttlSeconds: 7200,
      monitoring: true,
      noEnv: true,
      failFast: true,
    });
    expect(String(create[0].args.idempotencyKey)).toMatch(/^pcboat-[0-9a-f]{40}$/);
    expect(create[0].args.from).toBeUndefined();
    expect(fake.callsOf("limits")).toHaveLength(1);
    const sandboxId = lease.providerLeaseId!;
    expect(fake.boxes.get(sandboxId)?.name).toMatch(/^paperclip-[0-9a-f]{16}$/);
    expect(lease.metadata).toMatchObject({
      provider: "boat",
      sandboxId,
      vmKeyKind: "executionWorkspace",
      startKind: "create",
      remoteCwd: "/home/user/paperclip-workspace",
      shellCommand: "bash",
      tunnel: "up",
      runId: "run-1",
    });
    expect(lease.expiresAt).toBeUndefined();
  });

  it("pins the host key from the API and opens the CLIProxy reverse tunnel on loopback only", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    const sshKey = fake.callsOf("sshKey");
    expect(sshKey[0].args).toMatchObject({ sandboxId, key: "ssh-ed25519 AAAATESTPUBLICKEY paperclip-boat" });
    const master = ssh.masters()[0];
    expect(master.args).toEqual(expect.arrayContaining(["-R", "127.0.0.1:8317:cliproxy:8317", "ExitOnForwardFailure=yes", "StrictHostKeyChecking=yes", `HostKeyAlias=${sandboxId}`, "BatchMode=yes", "ForwardAgent=no"]));
    expect(master.args.at(-1)).toBe("user@203.0.113.10");
    const knownHosts = master.args.find((arg) => arg.startsWith("UserKnownHostsFile="))!.slice("UserKnownHostsFile=".length);
    expect(readFileSync(knownHosts, "utf8")).toBe(`${sandboxId} ssh-ed25519 AAAAHOSTKEY${sandboxId}\n`);
  });

  it("still runs commands when the reverse tunnel cannot be opened, and says so", async () => {
    ssh.masterFailures = 2;
    const lease = await acquire("run-1");
    expect(lease.metadata).toMatchObject({ tunnel: "down" });
    expect(ssh.masters()).toHaveLength(3);
    expect(ssh.masters()[2].args).not.toContain("-R");
    expect(harness.logs.some((entry) => entry.level === "warn" && entry.message.includes("reverse tunnel could not be opened"))).toBe(true);
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true" } as never);
    expect(result.exitCode).toBe(0);
  });

  it("creates from the configured named snapshot", async () => {
    await acquire("run-1", {}, { templateSnapshot: "two-bot-next-warm" });
    expect(fake.callsOf("create")[0].args).toMatchObject({ from: "two-bot-next-warm" });
  });

  it("reuses the card's stopped VM by resuming it instead of creating a new one", async () => {
    const first = await acquire("run-1");
    await release(first);
    expect(fake.boxes.get(first.providerLeaseId!)?.state).toBe("archived");
    const second = await acquire("run-2");
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(fake.callsOf("resume")[0].args).toMatchObject({ sandboxId: first.providerLeaseId, failFast: true, ttlSeconds: 7200 });
    expect(second.metadata).toMatchObject({ startKind: "resume" });
    // Host key changes on resume: the SSH key call and pin are redone.
    expect(fake.callsOf("sshKey")).toHaveLength(2);
  });

  it("finds the card's VM by its deterministic name when plugin state was lost", async () => {
    const first = await acquire("run-1");
    await release(first);
    harness.state.clear();
    const second = await acquire("run-2");
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(fake.callsOf("create")).toHaveLength(1);
  });

  it("shares a running VM with a second run on the same card without a new start", async () => {
    const first = await acquire("run-1");
    const limitsBefore = fake.callsOf("limits").length;
    const second = await acquire("run-2");
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ startKind: "reuse_running" });
    expect(fake.callsOf("resume")).toHaveLength(0);
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(fake.callsOf("limits")).toHaveLength(limitsBefore);
    // Releasing one run keeps the VM up for the other.
    await release(first);
    expect(fake.callsOf("stop")).toHaveLength(0);
    await release(second);
    expect(fake.callsOf("stop")).toHaveLength(1);
  });

  it("a new run on the card waits for the previous run's release, then resumes the stopped VM", async () => {
    const first = await acquire("run-1");
    const releasing = release(first);
    const acquiring = acquire("run-2");
    await expect(releasing).resolves.toEqual({ providerLeaseId: first.providerLeaseId, state: "stopped" });
    const second = await acquiring;
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ startKind: "resume" });
    expect(fake.boxes.get(first.providerLeaseId!)?.state).toBe("ready");
    const order = fake.calls.filter((call) => call.method === "stop" || call.method === "resume").map((call) => call.method);
    expect(order).toEqual(["stop", "resume"]);
  });

  it("waits for a stop that boat is still saving, then resumes", async () => {
    const first = await acquire("run-1");
    fake.stopMode = "never";
    await expect(release(first)).resolves.toEqual({ providerLeaseId: first.providerLeaseId, state: "stopped" });
    const box = fake.boxes.get(first.providerLeaseId!)!;
    expect(box.state).toBe("archiving");
    // boat finishes the save while the next run waits.
    fake.failNext("get", () => null);
    fake.failNext("get", () => {
      box.state = "archived";
      return null;
    });
    const second = await acquire("run-2");
    expect(second.providerLeaseId).toBe(first.providerLeaseId);
    expect(second.metadata).toMatchObject({ startKind: "resume" });
  });

  it("refuses to resume a VM whose stop does not end in time, without starting anything", async () => {
    const first = await acquire("run-1");
    fake.stopMode = "never";
    await release(first);
    await expect(acquire("run-2")).rejects.toMatchObject({ code: "BOAT_STOP_PENDING" });
    expect(fake.callsOf("resume")).toHaveLength(0);
    expect(fake.callsOf("create")).toHaveLength(1);
  });

  it("bounds the VM to a caller deadline and returns the provider expiry", async () => {
    const deadline = new Date(clock.t + 30 * 60 * 1000).toISOString();
    const lease = await acquire("run-1", { requestedExpiresAt: deadline });
    expect(fake.callsOf("create")[0].args.ttlSeconds).toBe(1800);
    expect(lease.expiresAt).toBe(deadline);
  });

  it("deletes, not stops, a VM it started when SSH setup fails and the disk cannot be checked, so nothing keeps billing or keeps a run JWT", async () => {
    ssh.handler = () => ({ code: 1, stderr: "permission denied" });
    await expect(acquire("run-1")).rejects.toMatchObject({ code: "BOAT_SSH_FAILED" });
    expect(fake.boxes.size).toBe(0);
    expect(fake.callsOf("deleteSandbox")).toHaveLength(1);
    expect(fake.callsOf("stop")).toHaveLength(0);
    const why = harness.logs.find((entry) => entry.message.includes("deleting the VM instead of stopping it (failed start)"));
    expect(why).toMatchObject({ level: "warn", meta: { trigger: "failed start" } });
    expect(String(why?.meta?.reason)).toContain("could not be removed");
  });

  it("a failed start scrubs the VM in every workspace root its stored record names (a new worker knows no other), then stops it", async () => {
    const first = await acquire("run-1");
    const sandboxId = first.providerLeaseId!;
    // A realized root that only plugin state remembers.
    await plugin.definition.onEnvironmentRealizeWorkspace!({
      ...base(),
      lease: { providerLeaseId: sandboxId, metadata: { ...first.metadata, remoteCwd: undefined } },
      workspace: { localPath: "/tmp/x", remotePath: "/srv/ws-other" },
    } as never);
    await release(first);
    await plugin.definition.onShutdown?.();
    await plugin.definition.setup(harness.ctx as never);
    ssh.runtimeSecrets.set(sandboxId, 1); // an earlier run's MCP config, left on the stopped disk
    const timeline: string[] = [];
    fake.timeline = timeline;
    ssh.timeline = timeline;
    ssh.handler = (remoteCommand) => (remoteCommand.includes('"$d" "$s"') ? { code: 1, stderr: "mkdir: Permission denied" } : undefined);
    await expect(acquire("run-2")).rejects.toMatchObject({ code: "BOAT_SSH_FAILED" });
    expect(fake.callsOf("resume")).toHaveLength(1);
    const scrubAt = timeline.indexOf(`ssh:scrub:${sandboxId}`);
    expect(scrubAt).toBeGreaterThan(timeline.indexOf("resume"));
    expect(timeline.indexOf("stop", scrubAt)).toBeGreaterThan(scrubAt);
    expect(ssh.runtimeSecrets.get(sandboxId)).toBe(0);
    expect(unquoteShDashC(ssh.scrubs(sandboxId).at(-1)!.args.at(-1)!)).toContain("'/srv/ws-other'");
    // The scrub verified the disk, so the card keeps its VM, stopped.
    expect(fake.callsOf("deleteSandbox")).toHaveLength(0);
    expect(fake.boxes.get(sandboxId)?.state).toBe("archived");
  });

  it("deletes a VM it started when the VM refuses to prepare .paperclip-runtime, but only stops it when ssh lost that command in transit", async () => {
    ssh.handler = (remoteCommand) =>
      remoteCommand.includes("paperclip-boat-runtime") ? { code: 1, stderr: "rm: cannot remove '.paperclip-runtime/claude': Permission denied" } : undefined;
    await expect(acquire("run-1")).rejects.toMatchObject({ code: "BOAT_RUNTIME_DIR_FAILED" });
    // That disk would fail the same way at every resume; a fresh VM does not.
    expect(fake.callsOf("deleteSandbox")).toHaveLength(1);
    expect(fake.callsOf("stop")).toHaveLength(0);
    expect(harness.logs.some((entry) => entry.message.includes("deleting the VM instead of stopping it (failed start)") && String(entry.meta?.reason).includes("could not be prepared"))).toBe(true);
    ssh.handler = (remoteCommand) => (remoteCommand.includes("paperclip-boat-runtime") ? { code: 255, stderr: "Connection reset by peer" } : undefined);
    await expect(acquire("run-2", { executionWorkspaceId: "55555555-5555-4555-8555-555555555555" })).rejects.toMatchObject({ code: "BOAT_RUNTIME_DIR_FAILED" });
    expect(fake.callsOf("stop")).toHaveLength(1);
    expect(fake.callsOf("deleteSandbox")).toHaveLength(1);
  });

  // Such a root fails at the runtime directory on every VM (~/.boatignore applies only under $HOME): refuse it before boat spends a start.
  it("refuses a remoteWorkspaceDir outside /home/user before it creates or resumes a VM", async () => {
    await expect(acquire("run-1", {}, { remoteWorkspaceDir: "/srv/ws" })).rejects.toMatchObject({ code: "BOAT_CONFIG_INVALID" });
    expect([...fake.callsOf("create"), ...fake.callsOf("resume")]).toEqual([]);
    expect(ssh.execs()).toHaveLength(0);
  });

  // TOG-37714: a resumed card VM holds the card's checkout and caches, and
  // possibly a failed run's unexported work; a fresh VM holds nothing yet.
  it("stops a resumed card VM and keeps its disk when the runtime directory or the scrub fails at its start; only a fresh VM is deleted", async () => {
    const first = await acquire("run-1");
    const sandboxId = first.providerLeaseId!;
    await release(first);
    ssh.handler = (remoteCommand) =>
      remoteCommand.includes("paperclip-boat-runtime") ? { code: 1, stderr: "rm: cannot remove '.paperclip-runtime/claude': Permission denied" } : undefined;
    await expect(acquire("run-2")).rejects.toMatchObject({ code: "BOAT_RUNTIME_DIR_FAILED" });
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(fake.callsOf("deleteSandbox")).toHaveLength(0);
    expect(fake.boxes.get(sandboxId)?.state).toBe("archived");
    const kept = harness.logs.filter((entry) => entry.message.includes("stopping the VM and keeping its disk although") && entry.meta?.sandboxId === sandboxId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ level: "error", meta: { trigger: "failed start", keep: "resumed_disk" } });
    expect(harness.logs.some((entry) => entry.message.includes("deleting the VM instead of stopping it"))).toBe(false);
    // The scrub fails too (the setup step failed after SSH came up): still stopped, disk kept.
    ssh.handler = (remoteCommand) =>
      remoteCommand.includes('"$d" "$s"')
        ? { code: 1, stderr: "mkdir: Permission denied" }
        : remoteCommand.includes("paperclip-boat-scrub")
          ? { code: 1, stdout: "paperclip-boat-scrub found=1 left=1 walk=complete\n" }
          : undefined;
    await expect(acquire("run-3")).rejects.toMatchObject({ code: "BOAT_SSH_FAILED" });
    expect(fake.callsOf("resume")).toHaveLength(2);
    expect(fake.callsOf("deleteSandbox")).toHaveLength(0);
    expect(fake.boxes.get(sandboxId)?.state).toBe("archived");
    // The card keeps its VM: the next run resumes it.
    ssh.handler = null;
    const next = await acquire("run-4");
    expect(next.providerLeaseId).toBe(sandboxId);
  });
});

describe("budget guard", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["maxActive", { activeSandboxes: 2 }, /maxActive/],
    ["maxStartsPerDay", { starts: { day: { limit: 75, remaining: 5, used: 70 }, hour: { remaining: 10 }, minute: { remaining: 5 } } }, /maxStartsPerDay/],
    ["boatStartsPerMinute", { starts: { day: { limit: 75, used: 3 }, hour: { remaining: 10 }, minute: { remaining: 0 } } }, /boatStartsPerMinute/],
    ["minComputeHoursLeft", { creditUsedSeconds: 89_000 }, /minComputeHoursLeft/],
    ["boat_cannot_start", { canStart: false, startBlockedReason: "trial ended" }, /boat_cannot_start/],
  ];
  for (const [limit, overrides, pattern] of cases) {
    it(`fails fast with an agent-readable error when ${limit} would be exceeded`, async () => {
      fake.limitsResponse = trialLimits(overrides);
      const error = (await acquire("run-1").catch((e) => e)) as BoatProviderError & { limit: string };
      expect(error.code).toBe("BOAT_BUDGET_GUARD");
      expect(error.limit).toBe(limit);
      expect(error.message).toMatch(pattern);
      expect(error.message).toMatch(/Nothing was started or billed/);
      expect(fake.callsOf("create")).toHaveLength(0);
      expect(fake.callsOf("resume")).toHaveLength(0);
      const warn = harness.logs.find((entry) => entry.level === "warn" && entry.message.includes("budget guard refused"));
      expect(warn?.message).toContain(`limit=${limit}`);
    });
  }

  it("refuses a size the plan does not allow", async () => {
    const error = (await acquire("run-1", {}, { size: "large" }).catch((e) => e)) as BoatProviderError & { limit: string };
    expect(error.limit).toBe("machineType");
    expect(fake.callsOf("create")).toHaveLength(0);
  });

  it("guards resumes too", async () => {
    const first = await acquire("run-1");
    await release(first);
    fake.limitsResponse = trialLimits({ activeSandboxes: 2 });
    await expect(acquire("run-2")).rejects.toMatchObject({ code: "BOAT_BUDGET_GUARD" });
    expect(fake.callsOf("resume")).toHaveLength(0);
  });

  it("refuses to start when the limits cannot be read", async () => {
    fake.failNext("limits", responseError(500, { code: "http_500" }));
    fake.failNext("limits", responseError(500, { code: "http_500" }));
    fake.failNext("limits", responseError(500, { code: "http_500" }));
    await expect(acquire("run-1")).rejects.toMatchObject({ code: "BOAT_LIMITS_UNAVAILABLE" });
    expect(fake.callsOf("create")).toHaveLength(0);
  });

  it("retries a fail-fast no_ready_machine answer briefly, then gives up with a clear error", async () => {
    fake.failNext("create", responseError(503, { code: "no_ready_machine", retryAfterSeconds: 5 }));
    const lease = await acquire("run-1");
    expect(lease.providerLeaseId).toBeTruthy();
    expect(sleeps).toContain(5000);

    for (let i = 0; i < 3; i += 1) fake.failNext("create", responseError(503, { code: "no_ready_machine", retryAfterSeconds: 5 }));
    const error = (await acquire("run-x", { executionWorkspaceId: "other-ws" }).catch((e) => e)) as BoatProviderError;
    expect(error.code).toBe("BOAT_NO_READY_MACHINE");
    expect(error.message).toMatch(/fail-fast/);
  });

  it("maps boat's own start-rate refusal to a clear error", async () => {
    fake.failNext("create", responseError(429, { code: "rate_limited", window: "hour", limit: 25 }));
    const error = (await acquire("run-1").catch((e) => e)) as BoatProviderError;
    expect(error.code).toBe("BOAT_START_RATE_LIMITED");
    expect(error.message).toMatch(/hour/);
  });
});

describe("ReleaseLease / StopLease / DestroyLease", () => {
  it("stops the VM at once on release and returns a stop receipt after boat confirms", async () => {
    const lease = await acquire("run-1");
    clock.t += 10 * 60 * 1000;
    const receipt = await release(lease);
    expect(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    expect(fake.callsOf("stop")).toEqual([{ method: "stop", args: { sandboxId: lease.providerLeaseId } }]);
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
    expect(ssh.masters()[0].child.killed).toBe(true);
    const usageCalls = fake.callsOf("usage");
    expect(usageCalls.some((call) => typeof call.args.since === "string" && typeof call.args.until === "string")).toBe(true);
  });

  it("returns a stopped receipt at once when the stop takes 65s, so the next run reuses the VM", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    // boat takes 65s to save the snapshot: the stop leaves the VM archiving.
    fake.stopMode = "never";
    const releaseStart = clock.t;
    const receipt = await release(lease);
    // The release must not wait for the snapshot save: Paperclip's
    // orphan-lease sweep destroys a still-active lease whose run is terminal,
    // so a slow release loses the warm VM. The idle sweep confirms the stop.
    expect(receipt).toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    expect(clock.t - releaseStart).toBeLessThan(10_000);
    expect(fake.callsOf("stop")).toHaveLength(1);
    expect(fake.boxes.get(sandboxId)?.state).toBe("archiving");
    const afterRelease = harness.state.get(`company|${COMPANY}|boat-sandbox|vms`) as {
      vms: Record<string, { status: string; activeRunIds: string[] }>;
    };
    expect(afterRelease.vms[`ew:${WORKSPACE}`]).toMatchObject({ status: "stopping", activeRunIds: [] });
    // 65s later boat confirms the save; the sweep confirms it and the next run reuses the VM.
    clock.t += 65_000;
    fake.boxes.get(sandboxId)!.state = "archived";
    const report = await currentManager().sweep("test", { force: true });
    expect(report.deleted).not.toContain(sandboxId);
    const afterSweep = harness.state.get(`company|${COMPANY}|boat-sandbox|vms`) as {
      vms: Record<string, { status: string }>;
    };
    expect(afterSweep.vms[`ew:${WORKSPACE}`].status).toBe("stopped");
    const second = await acquire("run-2");
    expect(second.providerLeaseId).toBe(sandboxId);
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(second.metadata).toMatchObject({ startKind: "resume" });
  });

  it("waits briefly when an accepted stop has not taken effect yet, then returns stopped", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    const box = fake.boxes.get(sandboxId)!;
    // Boat accepts the stop but the VM still looks up on the first reads.
    fake.stopMode = "stays_up";
    fake.failNext("get", () => null);
    fake.failNext("get", () => {
      box.state = "archiving";
      return null;
    });
    const releaseStart = clock.t;
    const receipt = await release(lease);
    expect(receipt).toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    expect(clock.t - releaseStart).toBeLessThan(10_000);
    expect(box.state).toBe("archiving");
  });

  it("returns no receipt when an accepted stop never takes effect, and StopLease throws", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    fake.stopMode = "stays_up";
    await expect(release(lease)).resolves.toBeUndefined();
    expect(fake.boxes.get(sandboxId)?.state).toBe("ready");
    const afterRelease = harness.state.get(`company|${COMPANY}|boat-sandbox|vms`) as {
      vms: Record<string, { status: string }>;
    };
    // Marked stopping so the sweep retries the stop without waiting for idle thresholds.
    expect(afterRelease.vms[`ew:${WORKSPACE}`].status).toBe("stopping");
    const second = await acquire("run-2", { executionWorkspaceId: "55555555-5555-4555-8555-555555555555" });
    await expect(
      plugin.definition.onEnvironmentStopLease!({
        ...base(),
        providerLeaseId: second.providerLeaseId,
        leaseMetadata: second.metadata,
        resourceDisposition: "stop_and_retain",
      } as never),
    ).rejects.toMatchObject({ code: "BOAT_STOP_UNCONFIRMED" });
  });

  it("returns a stopped receipt at once when the stop is still pending; StopLease only throws when boat refuses the stop", async () => {
    // Receipt-only scenario: the first two VMs remain archiving and must still
    // consume account slots, even though FakeBoat's active counter lags at zero.
    const receiptConfig = { maxActive: 3 };
    fake.limitsResponse = trialLimits({ maxActiveSandboxes: 3 });
    const lease = await acquire("run-1", {}, receiptConfig);
    fake.stopMode = "never";
    await expect(release(lease)).resolves.toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    // Another card: its stop is accepted too, so StopLease returns a receipt instead of waiting.
    const second = await acquire("run-2", { executionWorkspaceId: "55555555-5555-4555-8555-555555555555" }, receiptConfig);
    await expect(
      plugin.definition.onEnvironmentStopLease!({
        ...base(),
        providerLeaseId: second.providerLeaseId,
        leaseMetadata: second.metadata,
        resourceDisposition: "stop_and_retain",
      } as never),
    ).resolves.toEqual({ providerLeaseId: second.providerLeaseId, state: "stopped" });
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("archiving");
    expect(fake.boxes.get(second.providerLeaseId!)?.state).toBe("archiving");
    expect(fake.callsOf("create")).toHaveLength(2);
    // But when boat refuses the stop and the VM stays up, StopLease throws.
    fake.stopMode = "immediate";
    const third = await acquire("run-3", { executionWorkspaceId: "66666666-6666-4666-8666-666666666666" }, receiptConfig);
    expect(fake.callsOf("create")).toHaveLength(3);
    fake.failNext("stop", responseError(500, { code: "http_500" }));
    await expect(
      plugin.definition.onEnvironmentStopLease!({
        ...base(),
        providerLeaseId: third.providerLeaseId,
        leaseMetadata: third.metadata,
        resourceDisposition: "stop_and_retain",
      } as never),
    ).rejects.toMatchObject({ code: "BOAT_STOP_UNCONFIRMED" });
  });

  it("deletes a per-run VM on release because it can never be reused", async () => {
    const lease = await acquire("run-1", { executionWorkspaceId: null, issueId: null });
    expect(lease.metadata).toMatchObject({ vmKeyKind: "run" });
    const receipt = await release(lease);
    expect(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: "destroyed" });
    expect(fake.callsOf("deleteSandbox")[0].args).toEqual({ sandboxId: lease.providerLeaseId, xAsciiConfirmDelete: lease.providerLeaseId });
  });

  it("destroy deletes the VM and forgets the card mapping", async () => {
    const lease = await acquire("run-1");
    const receipt = await plugin.definition.onEnvironmentDestroyLease!({
      ...base(),
      providerLeaseId: lease.providerLeaseId,
      leaseMetadata: lease.metadata,
    } as never);
    expect(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: "destroyed" });
    expect(fake.boxes.has(lease.providerLeaseId!)).toBe(false);
    const next = await acquire("run-2");
    expect(next.providerLeaseId).not.toBe(lease.providerLeaseId);
    expect(fake.callsOf("create")).toHaveLength(2);
  });
});

/** How Execute sends a payload script: the login shell execs env, which drops boat's credentials and execs sh. */
const PAYLOAD_PREFIX = "exec env -u ASCII_TOKEN -u BOAT_ID sh -c ";

/** The script inside `sh -c '<script>'` or `exec env -u ... sh -c '<script>'`, undoing shellQuote. */
function unquoteShDashC(remoteCommand: string): string {
  const quoted = remoteCommand.replace(/^(?:exec env -u ASCII_TOKEN -u BOAT_ID )?sh -c /, "");
  expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
  return quoted.slice(1, -1).replaceAll(`'"'"'`, "'");
}

describe("Execute", () => {
  it("stages env in a 0600 file under /tmp over stdin, never in argv, and removes it before the command starts", async () => {
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    const result = await plugin.definition.onEnvironmentExecute!({
      ...base(),
      lease,
      command: "claude",
      args: ["-p", "hello"],
      env: { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
      timeoutMs: 60_000,
    } as never);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: "ok\n" });
    const calls = ssh.spawned.slice(before);
    for (const call of ssh.spawned) {
      expect(call.args.join(" ")).not.toContain(SECRET);
    }

    // Staged over stdin into a fresh 0700 directory under /tmp, which no boat snapshot saves.
    const staging = calls.find((call) => call.args.at(-1)!.includes("umask 077 && mkdir -m 700"));
    expect(staging?.stdin).toContain(`export ANTHROPIC_AUTH_TOKEN='${SECRET}';`);
    const stagingCommand = staging!.args.at(-1)!;
    const dirMatch = stagingCommand.match(/mkdir -m 700 '(\/tmp\/paperclip-boat-env-[0-9a-f]{32})'/);
    expect(dirMatch).not.toBeNull();
    const envDir = dirMatch![1];
    const envFile = `${envDir}/env.sh`;
    expect(stagingCommand).toBe(`umask 077 && mkdir -m 700 '${envDir}' && cat > '${envFile}' && chmod 600 '${envFile}'`);

    // Never inside the workspace (the git checkout, saved in every boat snapshot).
    const cwd = "/home/user/paperclip-workspace";
    expect(envFile.startsWith(`${cwd}/`)).toBe(false);
    expect(envFile.startsWith("/home/")).toBe(false);

    // The script sources the file, removes it, and only then runs the payload.
    const run = calls.find((call) => call.args.at(-1)!.startsWith(PAYLOAD_PREFIX) && call.args.at(-1)!.includes("claude"));
    expect(run).toBeDefined();
    const script = unquoteShDashC(run!.args.at(-1)!);
    expect(script).not.toContain(".paperclip-boat-env-");
    const cdAt = script.indexOf(`cd '${cwd}'`);
    const sourceAt = script.indexOf(`. '${envFile}'`);
    const firstRemoveAt = script.indexOf(`rm -f '${envFile}'`);
    const payloadAt = script.indexOf("'claude' '-p' 'hello'");
    const fallbackRemoveAt = script.indexOf(`rm -f '${envFile}'`, payloadAt);
    expect(cdAt).toBeGreaterThan(-1);
    expect(sourceAt).toBeGreaterThan(cdAt);
    expect(firstRemoveAt).toBeGreaterThan(sourceAt);
    expect(payloadAt).toBeGreaterThan(firstRemoveAt);
    expect(fallbackRemoveAt).toBeGreaterThan(payloadAt);
    // The login shell execs env, which drops boat's credentials and execs the sh that runs the
    // script: the payload's parent shell never had ASCII_TOKEN in its environ, and it waits for the
    // payload, so the payload's exit status (128+n for a signal) reaches ssh.
    expect(run!.args.at(-1)!.startsWith(`${PAYLOAD_PREFIX}'`)).toBe(true);
    expect(script).toContain("&& 'claude' '-p' 'hello'; rc=$?;");
    expect(script).not.toContain("exec 'claude'");
    expect(script).toContain(`rmdir '${envDir}'`);
    expect(run!.args).toEqual(expect.arrayContaining(["ControlMaster=no", "StrictHostKeyChecking=yes"]));
  });

  it("uses a new staging directory for every command", async () => {
    const lease = await acquire("run-1");
    const dirs: string[] = [];
    ssh.handler = (remoteCommand) => {
      const match = remoteCommand.match(/mkdir -m 700 '([^']+)'/);
      if (match) dirs.push(match[1]);
      return undefined;
    };
    for (let i = 0; i < 2; i += 1) {
      await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true", env: { PAPERCLIP_RUN_ID: "1" } } as never);
    }
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
  });

  it("removes the staged env file itself when ssh fails before the script could, and the VM is still up", async () => {
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    ssh.handler = (remoteCommand) => (remoteCommand.startsWith(PAYLOAD_PREFIX) ? { code: 255, stderr: "Connection reset" } : undefined);
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true", env: { ANTHROPIC_AUTH_TOKEN: SECRET } } as never);
    expect(result.exitCode).toBe(255);
    const commands = ssh.spawned.slice(before).map((call) => call.args.at(-1)!);
    const envDir = commands.find((command) => command.includes("mkdir -m 700"))!.match(/'(\/tmp\/paperclip-boat-env-[0-9a-f]{32})'/)![1];
    expect(commands.at(-1)).toBe(`rm -f '${envDir}/env.sh'; rmdir '${envDir}' 2>/dev/null`);
  });

  it("removes the staged env file when staging fails part way", async () => {
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    ssh.handler = (remoteCommand) => (remoteCommand.includes("mkdir -m 700") ? { code: 1, stderr: "No space left on device" } : undefined);
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true", env: { ANTHROPIC_AUTH_TOKEN: SECRET } } as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/could not stage the run environment/);
    const commands = ssh.spawned.slice(before).map((call) => call.args.at(-1)!);
    expect(commands.some((command) => command.startsWith(PAYLOAD_PREFIX))).toBe(false);
    expect(commands.at(-1)).toMatch(/^rm -f '\/tmp\/paperclip-boat-env-[0-9a-f]{32}\/env\.sh'; rmdir /);
  });

  it("extends the auto-stop deadline while a command runs once less than half of it is left", async () => {
    const lease = await acquire("run-1");
    clock.t += 70 * 60 * 1000;
    await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "cargo", args: ["build"] } as never);
    const update = fake.callsOf("update").filter((call) => call.args.ttlSeconds != null);
    expect(update).toEqual([{ method: "update", args: { sandboxId: lease.providerLeaseId, ttlSeconds: 7200 } }]);
  });

  it("does not extend when plenty of the deadline is left", async () => {
    const lease = await acquire("run-1");
    clock.t += 10 * 60 * 1000;
    await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true" } as never);
    expect(fake.callsOf("update").filter((call) => call.args.ttlSeconds != null)).toHaveLength(0);
  });

  it("resumes a VM that auto-stop or the sweep stopped, then runs the command", async () => {
    const lease = await acquire("run-1");
    // Simulate a fresh worker that has no SSH session and a VM boat stopped.
    await currentManager().shutdown();
    fake.boxes.get(lease.providerLeaseId!)!.state = "archived";
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true" } as never);
    expect(result.exitCode).toBe(0);
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(fake.callsOf("limits")).toHaveLength(2);
  });

  it("notices a VM that boat's deadline stopped under a live session and resumes it before the command", async () => {
    const lease = await acquire("run-1");
    fake.boxes.get(lease.providerLeaseId!)!.state = "archived";
    ssh.masters()[0].child.kill();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true" } as never);
    expect(result.exitCode).toBe(0);
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(ssh.masters()).toHaveLength(2);
  });

  it("reports a clear error instead of starting a VM when the budget guard refuses the resume", async () => {
    const lease = await acquire("run-1");
    await currentManager().shutdown();
    fake.boxes.get(lease.providerLeaseId!)!.state = "archived";
    fake.limitsResponse = trialLimits({ starts: { day: { limit: 75, used: 70 } } });
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true" } as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/budget guard \(maxStartsPerDay\)/);
    expect(fake.callsOf("resume")).toHaveLength(0);
  });
});

// Incident TOG-37420 (run eca3f106, 2026-10-22): Paperclip merged the TWO Bot
// Next project env, with PlanetScale prod secrets, into a boat run, and the
// plugin sent every string entry to the VM. These values stand in for the real
// ones; the names are the shapes that reach a provider.
const PROJECT_SECRETS: Record<string, string> = {
  PLANETSCALE_PROD_URL: "mysql://two_prod:pscale_pw_PROD_SECRET_1@aws.connect.psdb.cloud/two?sslaccept=strict",
  PLANETSCALE_SERVICE_TOKEN: "pscale_tkn_PROD_SECRET_2",
  PLANETSCALE_SERVICE_TOKEN_ID: "PROD_SECRET_3",
  PLANETSCALE_ORG: "togetherweown-PROD_SECRET_4",
  DATABASE_URL: "postgres://two_app:PROD_SECRET_5@prod-db.example.net:5432/two",
  DISCORD_BOT_TOKEN: "PROD_SECRET_6",
  CLOUDFLARE_API_TOKEN: "PROD_SECRET_7",
  GITHUB_TOKEN: "ghs_PROD_SECRET_8",
  GH_TOKEN: "ghs_PROD_SECRET_9",
};
// The Paperclip server's own process env, which reaches the command-resolution
// probe ({ ...process.env, ...env } in the claude-local adapter).
const SERVER_SECRETS: Record<string, string> = {
  BETTER_AUTH_SECRET: "HOST_SECRET_1",
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "HOST_SECRET_2",
  PAPERCLIP_GITHUB_SHADOW_PROXY_TOKEN: "HOST_SECRET_3",
  ANTHROPIC_API_KEY: "sk-HOST_SECRET_4",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-HOST_SECRET_5",
};
const BRIDGE_TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";
const RUN_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCIsInJ1biI6InJ1bi0xIn0.c2lnbmF0dXJlLVJVTl9KV1Q";
const ALLOWED_RUN_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
  ANTHROPIC_AUTH_TOKEN: SECRET,
  ANTHROPIC_DEFAULT_OPUS_MODEL: "muse-spark-1.3-contributor",
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
  PAPERCLIP_RUN_ID: "run-1",
  PAPERCLIP_API_URL: "http://127.0.0.1:41234",
  PAPERCLIP_API_KEY: BRIDGE_TOKEN,
  PAPERCLIP_BRIDGE_TOKEN: BRIDGE_TOKEN,
  PAPERCLIP_BRIDGE_QUEUE_DIR: "/home/user/paperclip-workspace/.paperclip-runtime/claude/paperclip-bridge/queue",
  PAPERCLIP_WORKSPACE_REPO_URL: "https://github.com/TogetherWeOwn/two-bot-next",
  HOME: "/home/user",
  LANG: "C.UTF-8",
};

describe("run env allowlist (incident TOG-37420)", () => {
  async function runWithEnv(env: Record<string, string>, config: Record<string, unknown> = {}) {
    const lease = await acquire("run-1", {}, config);
    const before = ssh.spawned.length;
    const result = await plugin.definition.onEnvironmentExecute!({
      ...base(config),
      lease,
      command: "claude",
      args: ["-p", "hello"],
      env,
    } as never);
    const calls = ssh.spawned.slice(before);
    const staging = calls.find((call) => call.args.at(-1)!.includes("umask 077 && mkdir -m 700"));
    const run = calls.find((call) => call.args.at(-1)!.startsWith(PAYLOAD_PREFIX) && call.args.at(-1)!.includes("'claude'"));
    // Every caller checks what the script and argv do not contain, so a missed payload must fail here.
    expect(run).toBeDefined();
    return { result, staged: staging?.stdin ?? "", script: unquoteShDashC(run!.args.at(-1)!) };
  }

  it("routes an agent's host-side model proxy address through the tunnel", async () => {
    // Agent adapter env wins over the environment's tunnel address in the merge;
    // a docker DNS name like cliproxy does not resolve inside the VM.
    const { result, staged } = await runWithEnv({ ...ALLOWED_RUN_ENV, ANTHROPIC_BASE_URL: "http://cliproxy:8317" },
      { cliproxyTunnel: true, tunnelTargetHost: "cliproxy", tunnelTargetPort: 8317, tunnelRemotePort: 8317 });
    expect(result.exitCode).toBe(0);
    expect(staged).toContain("ANTHROPIC_BASE_URL=");
    expect(staged).toContain("127.0.0.1:8317");
    expect(staged).not.toContain("cliproxy:8317");
  });

  it("delivers none of the project's or the server's secrets to the VM, in the staged env file or in argv", async () => {
    const { result, staged, script } = await runWithEnv({ ...PROJECT_SECRETS, ...SERVER_SECRETS, ...ALLOWED_RUN_ENV });
    expect(result.exitCode).toBe(0);
    const argv = ssh.spawned.map((call) => call.args.join(" ")).join("\n");
    const logs = JSON.stringify(harness.logs);
    for (const [name, value] of Object.entries({ ...PROJECT_SECRETS, ...SERVER_SECRETS })) {
      expect(staged).not.toContain(`${name}=`);
      expect(staged).not.toContain(value);
      expect(argv).not.toContain(value);
      expect(script).not.toContain(value);
      expect(logs).not.toContain(value);
    }
    // The staged file holds exactly the allowlisted keys, nothing else.
    const exported = [...staged.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]).sort();
    expect(exported).toEqual(Object.keys(ALLOWED_RUN_ENV).sort());
    expect(staged).toContain(`export ANTHROPIC_AUTH_TOKEN='${SECRET}';`);
    expect(staged).toContain(`export PAPERCLIP_API_KEY='${BRIDGE_TOKEN}';`);
    expect(staged).toContain("export CLAUDE_CODE_MAX_CONTEXT_TOKENS='200000';");
    // Allowed values never ride argv either.
    expect(argv).not.toContain(SECRET);
    expect(argv).not.toContain(BRIDGE_TOKEN);
  });

  it("logs the dropped keys by name and reason only, once per distinct set per run", async () => {
    const lease = await acquire("run-1");
    const env = { ...PROJECT_SECRETS, ...SERVER_SECRETS, ...ALLOWED_RUN_ENV };
    for (let i = 0; i < 3; i += 1) {
      await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true", env } as never);
    }
    const drops = harness.logs.filter((entry) => entry.message.includes("run env key(s) not allowed into the VM"));
    expect(drops).toHaveLength(1);
    expect(drops[0].level).toBe("warn");
    const dropped = drops[0].meta?.dropped as Record<string, string[]>;
    // Default deny: none of these is on the allowlist. CLAUDE_CODE_OAUTH_TOKEN
    // matches the CLAUDE_CODE_* prefix, but a prefix never delivers a secret name.
    const notListed = Object.keys({ ...PROJECT_SECRETS, ...SERVER_SECRETS }).filter((name) => name !== "CLAUDE_CODE_OAUTH_TOKEN");
    expect(dropped).toEqual({ not_allowlisted: [...notListed].sort(), secret_name_needs_exact_entry: ["CLAUDE_CODE_OAUTH_TOKEN"] });
  });

  it("sends PAPERCLIP_API_KEY only as the per-run bridge token, never as the host-verifiable run JWT", async () => {
    const { staged } = await runWithEnv({ ...ALLOWED_RUN_ENV, PAPERCLIP_API_KEY: RUN_JWT });
    expect(staged).not.toContain("PAPERCLIP_API_KEY");
    expect(staged).not.toContain(RUN_JWT);
    expect(staged).toContain(`export PAPERCLIP_BRIDGE_TOKEN='${BRIDGE_TOKEN}';`);
    const drop = harness.logs.find((entry) => entry.message.includes("not allowed into the VM"));
    expect((drop?.meta?.dropped as Record<string, string[]>).jwt).toEqual(["PAPERCLIP_API_KEY"]);
  });

  it("clears ASCII_TOKEN and BOAT_ID in the payload shell, after every source and before the payload", async () => {
    const { script } = await runWithEnv(ALLOWED_RUN_ENV);
    const bashrcAt = script.indexOf('. "$HOME/.bashrc"');
    const sourceAt = script.indexOf("; then . '/tmp/paperclip-boat-env-");
    const unsetAt = script.indexOf("unset ASCII_TOKEN BOAT_ID");
    const payloadAt = script.indexOf("'claude' '-p' 'hello'");
    expect(bashrcAt).toBeGreaterThan(-1);
    expect(sourceAt).toBeGreaterThan(bashrcAt);
    expect(unsetAt).toBeGreaterThan(sourceAt);
    expect(payloadAt).toBeGreaterThan(unsetAt);
    // With no env to stage, the same unset still comes before the payload.
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "claude", args: ["-v"] } as never);
    const bare = unquoteShDashC(ssh.spawned.slice(before).find((call) => call.args.at(-1)!.includes("'claude'"))!.args.at(-1)!);
    expect(bare).toMatch(/&& unset ASCII_TOKEN BOAT_ID && export TAR_OPTIONS="--exclude=\.paperclip-runtime\$\{TAR_OPTIONS:\+ \$TAR_OPTIONS\}" && 'claude' '-v'; rc=\$\?; exit \$rc$/);
    // Every Execute (Paperclip's sync commands included) tells GNU tar to leave .paperclip-runtime alone, so the host's runtime files are not unpacked over the run's.
    expect(script.indexOf('export TAR_OPTIONS="--exclude=.paperclip-runtime')).toBeGreaterThan(unsetAt);
    expect(script.indexOf('export TAR_OPTIONS="--exclude=.paperclip-runtime')).toBeLessThan(payloadAt);
  });

  it("removes boat's ASCII_TOKEN line from ~/.bashrc when it sets up a VM and after resuming one for a command", async () => {
    const lease = await acquire("run-1");
    const setup = ssh.execs().find((call) => call.args.at(-1)!.includes('"$d" "$s"'));
    expect(setup!.args.at(-1)).toContain("ASCII_TOKEN=/d");
    await currentManager().shutdown();
    fake.boxes.get(lease.providerLeaseId!)!.state = "archived";
    const before = ssh.spawned.length;
    await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true" } as never);
    const commands = ssh.spawned.slice(before).map((call) => call.args.at(-1)!);
    const scrubAt = commands.findIndex((command) => command.includes("ASCII_TOKEN=/d"));
    const payloadAt = commands.findIndex((command) => command.includes("'true'"));
    expect(scrubAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeGreaterThan(scrubAt);
  });

  it("a configured envAllowlist replaces the default: prefixes never deliver secrets, exact names do, database URLs only when VM-local", async () => {
    const config = {
      envAllowlist: [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "CARGO_*",
        "RUSTUP_HOME",
        "TWO_TEST_DATABASE_URL",
        "TWO_OTHER_DATABASE_URL",
        "PROD_DATABASE_URL",
        "PLANETSCALE_*",
        "GITHUB_TOKEN",
      ],
    };
    const { staged } = await runWithEnv(
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
        ANTHROPIC_AUTH_TOKEN: SECRET,
        CARGO_HOME: "/usr/local/cargo",
        CARGO_REGISTRY_TOKEN: "PROD_SECRET_10",
        RUSTUP_HOME: "/usr/local/rustup",
        TWO_TEST_DATABASE_URL: "postgres://postgres:local_pw@127.0.0.1:5432/two_bot_test_local",
        // A one-label host is not provably the VM (a DNS search domain can resolve it elsewhere).
        TWO_OTHER_DATABASE_URL: "postgres://postgres:PROD_SECRET_12@agent-testdb:5432/two_bot_test_local",
        PROD_DATABASE_URL: "postgres://two:PROD_SECRET_11@db.prod.example.com:5432/two",
        PLANETSCALE_PROD_URL: PROJECT_SECRETS.PLANETSCALE_PROD_URL,
        GITHUB_TOKEN: PROJECT_SECRETS.GITHUB_TOKEN,
        PAPERCLIP_RUN_ID: "run-1",
      },
      config,
    );
    const exported = [...staged.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]).sort();
    expect(exported).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CARGO_HOME", "RUSTUP_HOME", "TWO_TEST_DATABASE_URL"]);
    expect(staged).not.toContain("PROD_SECRET_");
    const drop = harness.logs.find((entry) => entry.message.includes("not allowed into the VM"));
    expect(drop?.meta?.dropped).toEqual({
      // Provider families never reach a VM, even when the allowlist names them.
      denied_family: ["GITHUB_TOKEN", "PLANETSCALE_PROD_URL"],
      remote_database_or_credential_url: ["PROD_DATABASE_URL", "TWO_OTHER_DATABASE_URL"],
      secret_name_needs_exact_entry: ["CARGO_REGISTRY_TOKEN"],
      not_allowlisted: ["PAPERCLIP_RUN_ID"],
    });
  });

  // Review round 4: the old URL tokenizer parsed only `https://o/` here and kept the value; JSON-escaped slashes hid a URL entirely.
  it("never stages a URL whose credentials hide behind a quote, a JSON-escaped remote database URL, or a database URL whose real host is elsewhere", async () => {
    const values: Record<string, string> = {
      PAPERCLIP_WORKSPACE_REPO_URL: "https://o/'reilly:SYNTH_PW_QUOTE@github.com/o/r",
      PAPERCLIP_WORKSPACES_JSON: '[{"repoUrl":"postgres:\\/\\/u:SYNTH_PW_JSON@db.example.com\\/x"}]',
      TEST_DATABASE_URL: "postgres://u:SYNTH_PW_HOST@localhost/db?host=prod.example.net",
      TEST2_DATABASE_URL: "postgres://u:SYNTH_PW_HEX@0xc0000214:5432/db",
    };
    const config = { envAllowlist: [...Object.keys(ALLOWED_RUN_ENV), ...Object.keys(values)] };
    const { staged, script } = await runWithEnv({ ...ALLOWED_RUN_ENV, ...values }, config);
    for (const value of Object.values(values)) {
      expect(staged).not.toContain(value);
      expect(script).not.toContain(value);
    }
    expect(staged).not.toContain("SYNTH_PW_");
    expect(JSON.stringify(harness.logs)).not.toContain("SYNTH_PW_");
    const exported = [...staged.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]).sort();
    expect(exported).toEqual(Object.keys(ALLOWED_RUN_ENV).filter((name) => !(name in values)).sort());
    const drop = harness.logs.find((entry) => entry.message.includes("not allowed into the VM"));
    expect((drop?.meta?.dropped as Record<string, string[]>).remote_database_or_credential_url).toEqual(Object.keys(values).sort());
  });

  it("refuses a command that carries an inline env envelope instead of sending env it cannot filter", async () => {
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    const result = await plugin.definition.onEnvironmentExecute!({
      ...base(),
      lease,
      command: "sh",
      args: ["-c", "PAPERCLIP_PROCESS_SESSION_COMMAND_B64='eyJlbnYiOnt9fQ==' nohup node wrapper.js &"],
    } as never);
    expect(result).toMatchObject({ exitCode: 1, metadata: { error: "BOAT_ACP_PROCESS_SESSION_REFUSED" } });
    expect(ssh.spawned.slice(before)).toHaveLength(0);
  });

  it("refuses the ACP command.b64 upload of a large envelope: the exact mkdir and chunk-append commands never reach the VM", async () => {
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    const sessionDir = "/home/user/paperclip-workspace/.paperclip-runtime/claude/process-sessions/0b0f6c2e-3f2a-4f4e-9a51-6d1f4b1c2a77";
    const chunk = Buffer.from(JSON.stringify({ env: { PROD_DATABASE_PASSWORD: "not-a-real-value" } })).toString("base64");
    const shapes = [
      `umask 077 && mkdir -m 700 '${sessionDir}'`,
      `printf '%s' '${chunk}' >> '${sessionDir}/command.b64.5d7c1e0a-8b44-4f0e-b3a2-9c6e2f1d4b10.paperclip-upload.b64'`,
    ];
    for (const script of shapes) {
      const result = await plugin.definition.onEnvironmentExecute!({
        ...base(),
        lease,
        command: "sh",
        args: ["-c", script],
        env: { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" },
      } as never);
      expect(result).toMatchObject({ exitCode: 1, metadata: { error: "BOAT_ACP_PROCESS_SESSION_REFUSED" } });
      expect(result.stderr).toMatch(/engine to cli/);
    }
    // Every other step of the launch, from the first (wrapper-script sync) to
    // the streamed launch that names the session dir only in its env.
    for (const call of largeEnvelopeAcpLaunch()) {
      const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, ...call } as never);
      expect({ label: call.label, error: result.metadata?.error }).toEqual({ label: call.label, error: "BOAT_ACP_PROCESS_SESSION_REFUSED" });
    }
    expect(ssh.spawned.slice(before)).toHaveLength(0);
    // The refusal log never carries the command: its arguments can be envelope chunks.
    const refusals = harness.logs.filter((entry) => entry.message.includes("ACP process-session"));
    expect(refusals.length).toBeGreaterThan(0);
    expect(JSON.stringify(refusals)).not.toContain(chunk);
  });

  it("still runs the commands of a cli-engine run", async () => {
    const lease = await acquire("run-1");
    for (const call of cliEngineCalls()) {
      const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, ...call } as never);
      expect({ label: call.label, error: result.metadata?.error }).toEqual({ label: call.label, error: undefined });
    }
  });

  it("an empty envAllowlist sends the VM nothing, and validation keeps it and warns", async () => {
    const { result, staged } = await runWithEnv({ ...ALLOWED_RUN_ENV, ...PROJECT_SECRETS }, { envAllowlist: [] });
    expect(result.exitCode).toBe(0);
    expect(staged).toBe("");
    const drop = harness.logs.find((entry) => entry.message.includes("not allowed into the VM"));
    expect(Object.keys(drop?.meta?.dropped as Record<string, string[]>)).toEqual(["not_allowlisted"]);
    expect((drop?.meta?.dropped as Record<string, string[]>).not_allowlisted).toEqual(Object.keys({ ...ALLOWED_RUN_ENV, ...PROJECT_SECRETS }).sort());
    const validated = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: DRIVER_KEY, config: { ...baseConfig, envAllowlist: [] } });
    expect(validated.ok).toBe(true);
    expect(validated.normalizedConfig).toMatchObject({ envAllowlist: [] });
    expect(validated.warnings?.join("\n")).toMatch(/envAllowlist is empty: no run env reaches the VM \(deny-all\)/);
  });

  it("drops PAPERCLIP_BRIDGE_SIGNING_KEY and LC_SESSION_KEY though the built-in prefixes match them, and any value holding the run JWT", async () => {
    const { staged } = await runWithEnv({
      ...ALLOWED_RUN_ENV,
      PAPERCLIP_BRIDGE_SIGNING_KEY: "HOST_SECRET_6",
      LC_SESSION_KEY: "HOST_SECRET_7",
      PAPERCLIP_WORKSPACES_JSON: JSON.stringify([{ repoUrl: "https://github.com/o/r", auth: `Bearer ${RUN_JWT}` }]),
      PAPERCLIP_API_KEY: `Bearer ${RUN_JWT}`,
    });
    expect(staged).not.toContain("HOST_SECRET_");
    expect(staged).not.toContain(RUN_JWT);
    const drop = harness.logs.find((entry) => entry.message.includes("not allowed into the VM"));
    expect(drop?.meta?.dropped).toEqual({
      secret_name_needs_exact_entry: ["LC_SESSION_KEY", "PAPERCLIP_BRIDGE_SIGNING_KEY"],
      jwt: ["PAPERCLIP_API_KEY", "PAPERCLIP_WORKSPACES_JSON"],
    });
  });

  it("refuses an ACP step that names a relative process-sessions directory", async () => {
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    const result = await plugin.definition.onEnvironmentExecute!({
      ...base(),
      lease,
      command: "sh",
      args: ["-c", "cd '/home/user/paperclip-workspace/.paperclip-runtime/claude' && mkdir -p process-sessions/0b0f6c2e"],
      env: { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" },
    } as never);
    expect(result).toMatchObject({ exitCode: 1, metadata: { error: "BOAT_ACP_PROCESS_SESSION_REFUSED" } });
    expect(ssh.spawned.slice(before)).toHaveLength(0);
  });

  it("validates envAllowlist entries, warns when a list cannot run Claude, and keeps an unset list unset", async () => {
    const bad = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: DRIVER_KEY, config: { ...baseConfig, envAllowlist: ["OK", "BAD-NAME", "*"] } });
    expect(bad.ok).toBe(false);
    expect(bad.errors?.join("\n")).toMatch(/envAllowlist entries must be an exact NAME or a NAME_\* prefix: BAD-NAME, \*/);
    const thin = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: DRIVER_KEY,
      config: { ...baseConfig, envAllowlist: "ANTHROPIC_BASE_URL, ANTHROPIC_*, GITHUB_TOKEN" },
    });
    expect(thin.ok).toBe(true);
    expect(thin.normalizedConfig).toMatchObject({ envAllowlist: ["ANTHROPIC_BASE_URL", "ANTHROPIC_*", "GITHUB_TOKEN"] });
    expect(thin.warnings?.join("\n")).toMatch(/does not deliver ANTHROPIC_AUTH_TOKEN, PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_BRIDGE_TOKEN/);
    expect(thin.warnings?.join("\n")).toMatch(/never sends to a VM \(provider credentials\): GITHUB_TOKEN/);
    const unset = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: DRIVER_KEY, config: { ...baseConfig } });
    expect(unset.normalizedConfig).not.toHaveProperty("envAllowlist");
    expect(unset.warnings?.join("\n") ?? "").not.toMatch(/envAllowlist/);
  });
});

describe("run JWT in Paperclip's MCP config on the VM disk", () => {
  let timeline: string[];
  beforeEach(() => {
    timeline = [];
    fake.timeline = timeline;
    ssh.timeline = timeline;
  });

  /** The script of the last scrub sent to a sandbox. */
  function lastScrubScript(sandboxId: string): string {
    const scrubs = ssh.scrubs(sandboxId);
    expect(scrubs.length).toBeGreaterThan(0);
    return unquoteShDashC(scrubs.at(-1)!.args.at(-1)!);
  }

  /** Paperclip synced the run's mcp-config asset into the VM. */
  function paperclipSyncedMcpConfig(sandboxId: string) {
    ssh.runtimeSecrets.set(sandboxId, 1);
  }

  const scrubbedBefore = (sandboxId: string, method: string) => {
    const scrubAt = timeline.indexOf(`ssh:scrub:${sandboxId}`);
    const methodAt = timeline.indexOf(method);
    return { scrubAt: scrubAt > -1, methodAt: methodAt > -1, scrubFirst: scrubAt > -1 && scrubAt < methodAt };
  };

  it("release removes it from the VM before the stop, so the stop snapshot never holds it", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    paperclipSyncedMcpConfig(sandboxId);
    timeline.length = 0;
    await expect(release(lease)).resolves.toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    expect(scrubbedBefore(sandboxId, "stop")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });
    expect(ssh.runtimeSecrets.get(sandboxId)).toBe(0);
    const script = lastScrubScript(sandboxId);
    expect(script).toContain("'/home/user/paperclip-workspace'");
    // Each root's runtime directory and each one under $HOME is scanned for exactly <dir>/<adapter>/mcp-config and its upload tarball.
    expect(script).toContain('sh -c "$scan" sh "$1" "$r/.paperclip-runtime"');
    expect(script).toContain("-name .paperclip-runtime -exec sh -c \"$scan\" sh \"$1\" {} +");
    expect(script).toContain('"$a"/mcp-config "$a"/mcp-config-upload.tar*');
    const removed = harness.logs.find((entry) => entry.message.includes("removed Paperclip's run MCP config"));
    expect(removed).toMatchObject({ level: "info", meta: { sandboxId, before: "stop", removed: 1 } });
    // The SSH session is closed only after the scrub.
    expect(ssh.masters()[0].child.killed).toBe(true);
  });

  it("StopLease removes it before the stop too", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    paperclipSyncedMcpConfig(sandboxId);
    timeline.length = 0;
    await plugin.definition.onEnvironmentStopLease!({ ...base(), providerLeaseId: sandboxId, leaseMetadata: lease.metadata, resourceDisposition: "stop_and_retain" } as never);
    expect(scrubbedBefore(sandboxId, "stop")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });
  });

  it("a per-run VM is scrubbed before its delete on release", async () => {
    const lease = await acquire("run-1", { executionWorkspaceId: null, issueId: null });
    const sandboxId = lease.providerLeaseId!;
    paperclipSyncedMcpConfig(sandboxId);
    timeline.length = 0;
    await expect(release(lease)).resolves.toEqual({ providerLeaseId: sandboxId, state: "destroyed" });
    expect(scrubbedBefore(sandboxId, "deleteSandbox")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });
  });

  it("destroy scrubs before the delete", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    paperclipSyncedMcpConfig(sandboxId);
    timeline.length = 0;
    await plugin.definition.onEnvironmentDestroyLease!({ ...base(), providerLeaseId: sandboxId, leaseMetadata: lease.metadata } as never);
    expect(scrubbedBefore(sandboxId, "deleteSandbox")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });
    expect(ssh.runtimeSecrets.get(sandboxId)).toBe(0);
  });

  it("leaves a VM that stays up for another run on the card alone, and scrubs at the last release", async () => {
    const first = await acquire("run-1");
    const second = await acquire("run-2");
    const sandboxId = first.providerLeaseId!;
    paperclipSyncedMcpConfig(sandboxId);
    await release(first);
    expect(ssh.scrubs(sandboxId)).toHaveLength(0);
    expect(fake.callsOf("stop")).toHaveLength(0);
    timeline.length = 0;
    await release(second);
    expect(scrubbedBefore(sandboxId, "stop")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });
  });

  it("a worker with no SSH session to the running VM opens one to scrub before it stops the VM", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    await currentManager().shutdown(); // a restarted worker: no session
    paperclipSyncedMcpConfig(sandboxId);
    const sshKeysBefore = fake.callsOf("sshKey").length;
    timeline.length = 0;
    await release(lease);
    expect(fake.callsOf("sshKey").length).toBe(sshKeysBefore + 1);
    expect(scrubbedBefore(sandboxId, "stop")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });
    expect(ssh.runtimeSecrets.get(sandboxId)).toBe(0);
  });

  const failScrub = () => {
    ssh.handler = (remoteCommand) =>
      remoteCommand.includes("paperclip-boat-scrub") ? { code: 1, stdout: "paperclip-boat-scrub found=1 left=1 walk=complete\n", stderr: "rm: Permission denied" } : undefined;
  };

  it("release deletes the VM instead of stopping it when the scrub fails, logs why, and the card's next run gets a fresh VM", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    failScrub();
    timeline.length = 0;
    // Not running it would bill and keep the token live; stopping it would save the token in the stop snapshot.
    await expect(release(lease)).resolves.toEqual({ providerLeaseId: sandboxId, state: "destroyed" });
    expect(scrubbedBefore(sandboxId, "deleteSandbox")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });
    expect(fake.callsOf("stop")).toHaveLength(0);
    expect(fake.boxes.has(sandboxId)).toBe(false);
    const failed = harness.logs.find((entry) => entry.message.includes("could not remove Paperclip's run MCP config"));
    expect(failed).toMatchObject({ level: "error", meta: { sandboxId, before: "stop" } });
    expect(String(failed?.meta?.detail)).toContain("1 left");
    const why = harness.logs.find((entry) => entry.message.includes("deleting the VM instead of stopping it (release)"));
    expect(why).toMatchObject({ level: "warn", meta: { sandboxId, trigger: "release" } });
    expect(String(why?.meta?.reason)).toContain("1 left");
    ssh.handler = null;
    const next = await acquire("run-2");
    expect(next.providerLeaseId).not.toBe(sandboxId);
    expect(next.metadata).toMatchObject({ startKind: "create" });
  });

  /** The VM was stopped with its disk kept after a failed scrub, and an error said why. */
  const expectKeptDisk = (sandboxId: string, trigger: string, keep: string) => {
    expect(fake.boxes.get(sandboxId)?.state).toBe("archived");
    expect(fake.callsOf("deleteSandbox").filter((call) => call.args.sandboxId === sandboxId)).toHaveLength(0);
    const kept = harness.logs.filter((entry) => entry.message.includes("stopping the VM and keeping its disk although") && entry.meta?.sandboxId === sandboxId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ level: "error", meta: { sandboxId, trigger, keep } });
    expect(String(kept[0].meta?.reason)).toContain("1 left");
    expect(harness.logs.some((entry) => entry.message.includes("deleting the VM instead of stopping it") && entry.meta?.sandboxId === sandboxId)).toBe(false);
  };

  it("StopLease and a stop_and_retain release stop the VM and keep its disk when the scrub fails: Paperclip keeps a run's unexported work there", async () => {
    // StopLease, as export-resume recovery sends it: it needs a `stopped` receipt and must never fall through to a delete.
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    failScrub();
    const receipt = await plugin.definition.onEnvironmentStopLease!({
      ...base(),
      providerLeaseId: sandboxId,
      leaseMetadata: lease.metadata,
      cancelActiveWork: true,
      resourceDisposition: "stop_and_retain",
    } as never);
    expect(receipt).toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    expectKeptDisk(sandboxId, "stop lease", "stop_lease");

    // A failed run's release (heartbeat sends stop_and_retain), on another card.
    const other = await acquire("run-2", { executionWorkspaceId: "55555555-5555-4555-8555-555555555555" });
    await expect(release(other, { resourceDisposition: "stop_and_retain" })).resolves.toEqual({ providerLeaseId: other.providerLeaseId, state: "stopped" });
    expectKeptDisk(other.providerLeaseId!, "release", "stop_and_retain");

    // A per-run VM is deleted on an ordinary release, but stop_and_retain keeps it too.
    const perRun = await acquire("run-3", { executionWorkspaceId: null, issueId: null });
    expect(perRun.metadata).toMatchObject({ vmKeyKind: "run" });
    await expect(release(perRun, { resourceDisposition: "stop_and_retain" })).resolves.toEqual({ providerLeaseId: perRun.providerLeaseId, state: "stopped" });
    expectKeptDisk(perRun.providerLeaseId!, "release", "stop_and_retain");

    // The kept disk resumes for the export, with its work in place.
    ssh.handler = null;
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...base(), providerLeaseId: sandboxId, leaseMetadata: lease.metadata } as never);
    expect(resumed.providerLeaseId).toBe(sandboxId);
  });

  it("a forced release of a VM that another run on the card still holds keeps its disk when the scrub fails", async () => {
    const first = await acquire("run-1");
    await acquire("run-2");
    const sandboxId = first.providerLeaseId!;
    failScrub();
    await expect(release(first, { cancelActiveWork: true })).resolves.toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    expectKeptDisk(sandboxId, "release", "held_lease");
  });

  it("a scrub that cannot reach a running VM over SSH counts as failed: the VM is deleted, not stopped", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    ssh.handler = (remoteCommand) => (remoteCommand.includes("paperclip-boat-scrub") ? { code: 255, stderr: "kex_exchange_identification: Connection closed" } : undefined);
    await expect(release(lease)).resolves.toEqual({ providerLeaseId: sandboxId, state: "destroyed" });
    expect(fake.callsOf("stop")).toHaveLength(0);
  });

  it("stops the VM after all when the delete that replaces the stop fails (a running VM bills and keeps the token live)", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    failScrub();
    fake.failNext("deleteSandbox", responseError(500, { code: "http_500" }));
    await expect(release(lease)).resolves.toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    expect(fake.callsOf("deleteSandbox")).toHaveLength(1);
    expect(fake.boxes.get(sandboxId)?.state).toBe("archived");
    expect(harness.logs.find((entry) => entry.message.includes("could not delete the VM whose disk may keep the run JWT; stopping it instead"))?.level).toBe("error");
  });

  /** Paperclip ended every lease on the card without a confirmed stop (for example the host crashed in release). */
  async function forgetLeasesInState() {
    const doc = harness.state.get(`company|${COMPANY}|boat-sandbox|vms`) as {
      vms: Record<string, { activeRunIds: string[]; sessions: Array<{ endedAt: string | null }> }>;
    };
    for (const record of Object.values(doc.vms)) {
      record.activeRunIds = [];
      for (const entry of record.sessions) entry.endedAt ??= new Date(clock.t).toISOString();
    }
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, namespace: "boat-sandbox", stateKey: "vms" }, doc);
  }

  it("the sweep deletes, instead of stopping, an idle VM that no run holds (or an orphan) when its scrub fails", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    await forgetLeasesInState();
    fake.addSandbox({ id: "bx_orphan", name: "paperclip-0123456789abcdef", state: "ready", updatedAt: new Date(clock.t) });
    failScrub();
    clock.t += 16 * 60 * 1000;
    const report = await currentManager().sweep("test", { force: true });
    expect(report.deleted.sort()).toEqual([sandboxId, "bx_orphan"].sort());
    expect(report.stopped).toEqual([]);
    expect(fake.callsOf("stop")).toHaveLength(0);
    expect(fake.boxes.has(sandboxId)).toBe(false);
    expect(harness.logs.some((entry) => entry.message.includes("deleting the VM instead of stopping it (sweep)"))).toBe(true);
    expect(harness.logs.some((entry) => entry.message.includes("sweep deleted an idle VM instead of stopping it (runtime_scrub_failed)"))).toBe(true);
    expect(harness.logs.some((entry) => entry.message.includes("keeping its disk"))).toBe(false);
  });

  it("the sweep stops, and keeps the disk of, a VM that a run still holds when its scrub fails: a stale lease or a resumed lease", async () => {
    // A held lease idle beyond staleLeaseMinutes (a wedged run): its work is not synced back yet.
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    failScrub();
    clock.t += 61 * 60 * 1000;
    let report = await currentManager().sweep("test", { force: true });
    expect(report).toMatchObject({ stopped: [sandboxId], deleted: [] });
    expectKeptDisk(sandboxId, "sweep", "held_lease");

    // A resumed lease never joins activeRunIds; its open run window counts as held.
    ssh.handler = null;
    const other = await acquire("run-2", { executionWorkspaceId: "55555555-5555-4555-8555-555555555555" });
    await release(other, { resourceDisposition: "stop_and_retain" });
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...base(), providerLeaseId: other.providerLeaseId, leaseMetadata: other.metadata } as never);
    expect(fake.boxes.get(resumed.providerLeaseId!)?.state).toBe("ready");
    failScrub();
    clock.t += 16 * 60 * 1000;
    report = await currentManager().sweep("test", { force: true });
    expect(report).toMatchObject({ stopped: [other.providerLeaseId], deleted: [] });
    expectKeptDisk(other.providerLeaseId!, "sweep", "held_lease");
  });

  // Review round 4: a scrub that could not search part of the disk reported found=0 left=0 and passed.
  const incompleteScrub = () => {
    ssh.handler = (remoteCommand) =>
      remoteCommand.includes("paperclip-boat-scrub")
        ? { code: 3, stdout: "paperclip-boat-scrub found=0 left=0 walk=incomplete\n", stderr: "find: '/home/user/locked': Permission denied" }
        : undefined;
  };

  const keptForIncompleteScan = (sandboxId: string) =>
    harness.logs.filter(
      (entry) => entry.message.includes("stopping the VM and keeping its disk although") && entry.meta?.sandboxId === sandboxId && entry.meta?.keep === "incomplete_scan",
    );

  it("a scrub that could not search the whole disk is not clean: capture is refused, and release and the sweep stop the VM and keep its disk instead of deleting it", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    incompleteScrub();
    await expect(
      plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: sandboxId, templateLabel: "warm" } as never),
    ).rejects.toMatchObject({ code: "BOAT_RUNTIME_SCRUB_FAILED" });
    expect(fake.callsOf("saveNamedSnapshot")).toHaveLength(0);
    const unverified = harness.logs.find((entry) => entry.message.includes("could not verify") && entry.meta?.sandboxId === sandboxId);
    expect(unverified).toMatchObject({ level: "error", meta: { before: "template capture" } });
    expect(unverified?.meta?.detail).toBe("walk incomplete (diagnostics withheld)");
    expect(JSON.stringify(harness.logs)).not.toContain("Permission denied");
    expect(JSON.stringify(harness.logs)).not.toContain("/home/user/locked");

    await expect(release(lease)).resolves.toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    expect(fake.callsOf("deleteSandbox")).toHaveLength(0);
    expect(fake.boxes.get(sandboxId)?.state).toBe("archived");
    expect(keptForIncompleteScan(sandboxId)).toHaveLength(1);

    // The sweep, for an idle VM that no run holds (the case that would otherwise delete on a failed scrub).
    ssh.handler = null;
    const other = await acquire("run-2", { executionWorkspaceId: "55555555-5555-4555-8555-555555555555" });
    await forgetLeasesInState();
    incompleteScrub();
    clock.t += 16 * 60 * 1000;
    const report = await currentManager().sweep("test", { force: true });
    expect(report).toMatchObject({ stopped: [other.providerLeaseId], deleted: [] });
    expect(fake.boxes.get(other.providerLeaseId!)?.state).toBe("archived");
    expect(keptForIncompleteScan(other.providerLeaseId!)).toHaveLength(1);
    expect(harness.logs.some((entry) => entry.message.includes("deleting the VM instead of stopping it"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("captureTemplate refuses when the real scrub script cannot search a directory under $HOME, and captures once it can", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    const home = mkdtempSync(path.join(tmpdir(), "pcb-capture-"));
    const locked = path.join(home, "locked");
    const secret = path.join(locked, ".paperclip-runtime", "claude", "mcp-config", "mcp-config.json");
    mkdirSync(path.dirname(secret), { recursive: true });
    writeFileSync(secret, RUN_JWT);
    // The fake VM runs the plugin's own scrub script in a local sh, with this HOME.
    ssh.handler = (remoteCommand) => {
      if (!remoteCommand.includes("paperclip-boat-scrub")) return undefined;
      const run = spawnSync("sh", ["-c", scriptOfShDashC(remoteCommand)!], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
      return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
    };
    try {
      chmodSync(locked, 0o000);
      await expect(
        plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: sandboxId, templateLabel: "warm" } as never),
      ).rejects.toMatchObject({ code: "BOAT_RUNTIME_SCRUB_FAILED" });
      expect(fake.callsOf("saveNamedSnapshot")).toHaveLength(0);
      chmodSync(locked, 0o755);
      expect(readFileSync(secret, "utf8")).toBe(RUN_JWT);
      await plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: sandboxId, templateLabel: "warm" } as never);
      expect(fake.callsOf("saveNamedSnapshot").map((call) => call.args.name)).toEqual(["warm"]);
      expect(() => readFileSync(secret)).toThrow();
    } finally {
      chmodSync(locked, 0o755);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prepares .paperclip-runtime (real directory, ~/.boatignore rule) before each lease goes to Paperclip: acquire, resume, resumed lease and realize", async () => {
    const first = await acquire("run-1");
    const sandboxId = first.providerLeaseId!;
    const links = () => ssh.runtimeLinks.get(sandboxId) ?? [];
    const runtimeDir = String(first.metadata?.runtimeDir);
    expect(runtimeDir).toBe("/home/user/paperclip-workspace/.paperclip-runtime");
    expect(links()).toEqual([{ root: "/home/user/paperclip-workspace", runtimeDir }]);
    // After the setup step, before acquire returns (Paperclip syncs the runtime assets after that).
    const commands = ssh.execs().map((call) => call.args.at(-1)!);
    expect(commands.findIndex((command) => command.includes('"$d" "$s"'))).toBeLessThan(commands.findIndex((command) => command.includes("paperclip-boat-runtime")));
    expect(commands.some((command) => command.startsWith(PAYLOAD_PREFIX))).toBe(false);
    await release(first);
    // A resumed VM: the plugin always prepares the directory again (the VM keeps a valid one).
    const second = await acquire("run-2");
    expect(second.metadata).toMatchObject({ startKind: "resume" });
    expect(second.metadata?.runtimeDir).toBe(links().at(-1)!.runtimeDir);
    expect(links()).toHaveLength(2);
    await release(second, { resourceDisposition: "stop_and_retain" });
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...base(), providerLeaseId: sandboxId, leaseMetadata: second.metadata } as never);
    expect(resumed.metadata).toMatchObject({ resumedLease: true, runtimeDir: links().at(-1)!.runtimeDir });
    const realized = await plugin.definition.onEnvironmentRealizeWorkspace!({ ...base(), lease: resumed, workspace: { localPath: "/tmp/x" } } as never);
    expect(realized).toEqual({
      cwd: "/home/user/paperclip-workspace",
      metadata: { provider: "boat", remoteCwd: "/home/user/paperclip-workspace", runtimeDir: links().at(-1)!.runtimeDir },
    });
    expect(new Set(links().map((link) => link.root))).toEqual(new Set(["/home/user/paperclip-workspace"]));
  });

  it("prepares .paperclip-runtime again after resuming a VM that stopped mid-lease, before the command runs", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    await currentManager().shutdown();
    fake.boxes.get(sandboxId)!.state = "archived"; // boat's auto-stop; the resume may land on a new machine
    const before = ssh.execs().length;
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true" } as never);
    expect(result.exitCode).toBe(0);
    const commands = ssh.execs().slice(before).map((call) => call.args.at(-1)!);
    const linkAt = commands.findIndex((command) => command.includes("paperclip-boat-runtime"));
    expect(linkAt).toBeGreaterThan(-1);
    expect(commands.findIndex((command) => command.startsWith(PAYLOAD_PREFIX))).toBeGreaterThan(linkAt);
    expect(ssh.runtimeLinks.get(sandboxId)!.at(-1)!.root).toBe("/home/user/paperclip-workspace");
  });

  it("passes a payload's own exit status through, 128+n for a signal, without treating it as a lost VM", async () => {
    const lease = await acquire("run-1");
    ssh.handler = (remoteCommand) => (remoteCommand.startsWith(PAYLOAD_PREFIX) ? { code: 143, stderr: "Terminated" } : undefined);
    const gets = fake.callsOf("get").length;
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "sleep", args: ["600"] } as never);
    expect(result).toMatchObject({ exitCode: 143, timedOut: false });
    expect(result.stderr).not.toMatch(/was stopped while the command ran/);
    expect(fake.callsOf("get")).toHaveLength(gets);
  });

  it("warns, without starting anything, when the VM was already stopped by someone else", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    await currentManager().shutdown();
    fake.boxes.get(sandboxId)!.state = "archived"; // boat's auto-stop
    await release(lease);
    expect(ssh.scrubs(sandboxId)).toHaveLength(0);
    expect(fake.callsOf("resume")).toHaveLength(0);
    expect(harness.logs.some((entry) => entry.level === "warn" && entry.message.includes("could not reach the VM to remove Paperclip's run MCP config"))).toBe(true);
  });

  it("captureTemplate scrubs before the named snapshot, and refuses to capture when the scrub cannot be verified", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    paperclipSyncedMcpConfig(sandboxId);
    timeline.length = 0;
    await plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: sandboxId, templateLabel: "warm" } as never);
    expect(scrubbedBefore(sandboxId, "saveNamedSnapshot")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });

    ssh.handler = (remoteCommand) => (remoteCommand.includes("paperclip-boat-scrub") ? { code: 1, stdout: "paperclip-boat-scrub found=1 left=1 walk=complete\n" } : undefined);
    await expect(
      plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: sandboxId, templateLabel: "warm-2" } as never),
    ).rejects.toMatchObject({ code: "BOAT_RUNTIME_SCRUB_FAILED" });
    // A reply without the scrub's result line is not a verified scrub either.
    ssh.handler = (remoteCommand) => (remoteCommand.includes("paperclip-boat-scrub") ? { code: 0, stdout: "ok\n" } : undefined);
    await expect(
      plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: sandboxId, templateLabel: "warm-3" } as never),
    ).rejects.toMatchObject({ code: "BOAT_RUNTIME_SCRUB_FAILED" });
    expect(fake.callsOf("saveNamedSnapshot").map((call) => call.args.name)).toEqual(["warm"]);
  });

  it("captureTemplate of a VM that boat stopped resumes it (budget-guarded) and scrubs before the snapshot", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    await currentManager().shutdown();
    fake.boxes.get(sandboxId)!.state = "archived";
    paperclipSyncedMcpConfig(sandboxId); // left on the disk by the auto-stop
    timeline.length = 0;
    await plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: sandboxId, templateLabel: "warm" } as never);
    expect(timeline.indexOf("limits")).toBeLessThan(timeline.indexOf("resume"));
    expect(scrubbedBefore(sandboxId, "saveNamedSnapshot")).toEqual({ scrubAt: true, methodAt: true, scrubFirst: true });
    expect(ssh.runtimeSecrets.get(sandboxId)).toBe(0);
  });

  it("the sweep scrubs every VM it stops: a held-but-idle lease, one with no SSH session in this worker, and an orphan", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    paperclipSyncedMcpConfig(sandboxId);
    await currentManager().shutdown(); // no session: the sweep must open one
    fake.addSandbox({ id: "bx_orphan", name: "paperclip-0123456789abcdef", state: "ready", updatedAt: new Date(clock.t - 60 * 60 * 1000) });
    ssh.runtimeSecrets.set("bx_orphan", 1);
    clock.t += 61 * 60 * 1000;
    timeline.length = 0;
    const report = await currentManager().sweep("test", { force: true });
    expect(report.stopped.sort()).toEqual([sandboxId, "bx_orphan"].sort());
    for (const id of [sandboxId, "bx_orphan"]) {
      const scrubAt = timeline.indexOf(`ssh:scrub:${id}`);
      const stopAt = timeline.findIndex((entry, index) => entry === "stop" && index > scrubAt);
      expect({ id, scrubAt: scrubAt > -1, stopAfter: stopAt > scrubAt }).toEqual({ id, scrubAt: true, stopAfter: true });
      expect(ssh.runtimeSecrets.get(id)).toBe(0);
    }
    expect(lastScrubScript(sandboxId)).toContain("'/home/user/paperclip-workspace'");
  });

  it("scrubs every workspace root the plugin knows of: the realized one (kept in state for a new worker) and remoteWorkspaceDir", async () => {
    const lease = await acquire("run-1", {}, { remoteWorkspaceDir: "/home/user/custom-ws" });
    const sandboxId = lease.providerLeaseId!;
    const leaseWithoutCwd = { providerLeaseId: sandboxId, metadata: { ...lease.metadata, remoteCwd: undefined } };
    await plugin.definition.onEnvironmentRealizeWorkspace!({
      ...base({ remoteWorkspaceDir: "/home/user/custom-ws" }),
      lease: leaseWithoutCwd,
      workspace: { localPath: "/tmp/x", remotePath: "/home/user/ws-other" },
    } as never);
    // A new worker (state kept, memory lost) releases the lease.
    await plugin.definition.onShutdown?.();
    await plugin.definition.setup(harness.ctx as never);
    await plugin.definition.onEnvironmentReleaseLease!({
      ...base({ remoteWorkspaceDir: "/home/user/custom-ws" }),
      issueId: ISSUE,
      providerLeaseId: sandboxId,
      leaseMetadata: leaseWithoutCwd.metadata,
    } as never);
    const script = lastScrubScript(sandboxId);
    for (const root of ["'/home/user/paperclip-workspace'", "'/home/user/ws-other'", "'/home/user/custom-ws'", '"$HOME/paperclip-workspace"']) {
      expect([root, script.includes(root)]).toEqual([root, true]);
    }
  });
});

describe("ResumeLease and RealizeWorkspace", () => {
  it("reports an expired lease when the VM is gone", async () => {
    const result = await plugin.definition.onEnvironmentResumeLease!({ ...base(), providerLeaseId: "bx_missing" } as never);
    expect(result).toEqual({ providerLeaseId: null, metadata: { provider: "boat", expired: true } });
  });

  it("resumes a stopped VM for a resumed lease", async () => {
    const lease = await acquire("run-1");
    await release(lease);
    const resumed = await plugin.definition.onEnvironmentResumeLease!({
      ...base(),
      providerLeaseId: lease.providerLeaseId,
      leaseMetadata: lease.metadata,
    } as never);
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect(resumed.metadata).toMatchObject({ resumedLease: true, remoteCwd: "/home/user/paperclip-workspace" });
    expect(fake.callsOf("resume")).toHaveLength(1);
  });

  it("records a run window for a resumed lease, and release still stops the VM", async () => {
    const lease = await acquire("run-1");
    await release(lease, { resourceDisposition: "stop_and_retain" });
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
    const resumed = await plugin.definition.onEnvironmentResumeLease!({
      ...base(),
      issueId: ISSUE,
      providerLeaseId: lease.providerLeaseId!,
      leaseMetadata: lease.metadata,
    } as never);
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("ready");
    clock.t += 5 * 60 * 1000;
    await release({ providerLeaseId: resumed.providerLeaseId, metadata: resumed.metadata }, { resourceDisposition: "stop_and_retain" });
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
    const summary = await currentManager().usageSummary(COMPANY, { refresh: false });
    const runs = summary.vms[0].runs as Array<{ runId: string; endedAt: string | null }>;
    expect(runs.some((run) => run.runId.startsWith("resumed-lease:") && run.endedAt)).toBe(true);
  });

  // Review round 4: ResumeLease resumed a VM that boat was still stopping (boat refuses that), and ran outside the card lock.
  it("a resumed lease waits for a stop that boat is still saving, then resumes", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    fake.stopMode = "never";
    await expect(release(lease)).resolves.toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    const box = fake.boxes.get(sandboxId)!;
    expect(box.state).toBe("archiving");
    // boat finishes the save 6 s later (fake clock), while the resumed lease waits.
    const savedAt = clock.t + 6000;
    let saved = false;
    for (let i = 0; i < 20; i += 1) {
      fake.failNext("get", () => {
        if (!saved && clock.t >= savedAt) {
          box.state = "archived";
          saved = true;
        }
        return null;
      });
    }
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...base(), providerLeaseId: sandboxId, leaseMetadata: lease.metadata } as never);
    expect(resumed.providerLeaseId).toBe(sandboxId);
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(box.state).toBe("ready");
    expect(sleeps.filter((ms) => ms === 2000).length).toBeGreaterThan(0);
  });

  it("a resumed lease refuses, without starting anything, a VM whose stop does not end in time", async () => {
    const lease = await acquire("run-1");
    fake.stopMode = "never";
    await release(lease);
    await expect(
      plugin.definition.onEnvironmentResumeLease!({ ...base(), providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata } as never),
    ).rejects.toMatchObject({ code: "BOAT_STOP_PENDING" });
    expect(fake.callsOf("resume")).toHaveLength(0);
  });

  it("a resumed lease that overlaps the card's release waits for it, then resumes the stopped VM", async () => {
    const lease = await acquire("run-1");
    const sandboxId = lease.providerLeaseId!;
    const releasing = release(lease, { resourceDisposition: "stop_and_retain" });
    const resuming = plugin.definition.onEnvironmentResumeLease!({ ...base(), providerLeaseId: sandboxId, leaseMetadata: lease.metadata } as never);
    await expect(releasing).resolves.toEqual({ providerLeaseId: sandboxId, state: "stopped" });
    const resumed = await resuming;
    expect(resumed.providerLeaseId).toBe(sandboxId);
    expect(fake.boxes.get(sandboxId)?.state).toBe("ready");
    const order = fake.calls.filter((call) => call.method === "stop" || call.method === "resume").map((call) => call.method);
    expect(order).toEqual(["stop", "resume"]);
  });

  it("realizes the workspace directory on the VM", async () => {
    const lease = await acquire("run-1");
    const result = await plugin.definition.onEnvironmentRealizeWorkspace!({ ...base(), lease, workspace: { localPath: "/tmp/x" } } as never);
    expect(result).toEqual({
      cwd: "/home/user/paperclip-workspace",
      metadata: { provider: "boat", remoteCwd: "/home/user/paperclip-workspace", runtimeDir: "/home/user/paperclip-workspace/.paperclip-runtime" },
    });
    // One command makes the workspace and its .paperclip-runtime, and puts the rule into ~/.boatignore.
    expect(ssh.execs().at(-1)!.args.at(-1)).toContain('mkdir -p "$root"');
    expect(ssh.execs().at(-1)!.args.at(-1)).toContain("paperclip-boat-runtime");
  });
});

describe("idle sweep", () => {
  it("stops a running VM with no active lease after idleStopMinutes and leaves busy ones alone", async () => {
    const lease = await acquire("run-1");
    // Lease ended without a confirmed stop (for example the host crashed before release).
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, namespace: "boat-sandbox", stateKey: "vms" },
      (() => {
        const doc = harness.state.get(`company|${COMPANY}|boat-sandbox|vms`) as { vms: Record<string, { activeRunIds: string[] }> };
        for (const record of Object.values(doc.vms)) record.activeRunIds = [];
        return doc;
      })(),
    );
    clock.t += 4 * 60 * 1000;
    let report = await currentManager().sweep("test", { force: true });
    expect(report.stopped).toEqual([]);
    clock.t += 2 * 60 * 1000;
    report = await currentManager().sweep("test", { force: true });
    expect(report.stopped).toEqual([lease.providerLeaseId]);
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
  });

  it("stops a VM whose lease is still held but idle beyond staleLeaseMinutes", async () => {
    const lease = await acquire("run-1");
    clock.t += 10 * 60 * 1000;
    expect((await currentManager().sweep("test", { force: true })).stopped).toEqual([]);
    clock.t += 11 * 60 * 1000;
    expect((await currentManager().sweep("test", { force: true })).stopped).toEqual([lease.providerLeaseId]);
  });

  it("deletes a stopped VM whose card is done", async () => {
    await plugin.definition.onShutdown?.();
    const issues = new Map([[ISSUE, { status: "in_progress" }]]);
    await setup({ issues });
    const lease = await acquire("run-1");
    await release(lease);
    expect((await currentManager().sweep("test", { force: true })).deleted).toEqual([]);
    issues.set(ISSUE, { status: "done" });
    const report = await currentManager().sweep("test", { force: true });
    expect(report.deleted).toEqual([lease.providerLeaseId]);
    expect(fake.boxes.has(lease.providerLeaseId!)).toBe(false);
  });

  it("deletes a stopped VM untouched for deleteAfterDays and ignores VMs that are not ours", async () => {
    const lease = await acquire("run-1");
    await release(lease);
    fake.addSandbox({ id: "bx_owner_manual", name: "owner-experiment", state: "running" });
    clock.t += 8 * 24 * 3600 * 1000;
    const report = await currentManager().sweep("test", { force: true });
    expect(report.deleted).toEqual([lease.providerLeaseId]);
    expect(report.stopped).toEqual([]);
    expect(fake.boxes.get("bx_owner_manual")?.state).toBe("running");
  });

  it("stops an orphan VM that carries our name prefix", async () => {
    await acquire("run-0"); // makes the worker see a config
    fake.addSandbox({ id: "bx_orphan", name: "paperclip-0123456789abcdef", state: "ready", updatedAt: new Date(clock.t - 60 * 60 * 1000) });
    const report = await currentManager().sweep("test", { force: true });
    expect(report.stopped).toContain("bx_orphan");
  });

  it("does nothing before any boat config was seen (auto-stop stays the backstop)", async () => {
    const report = await currentManager().sweep("test", { force: true });
    expect(report.skipped).toBe("no_config_seen");
  });

  it("runs from the scheduled job", async () => {
    await acquire("run-1");
    await harness.jobs.get(SWEEP_JOB_KEY)!({ jobKey: SWEEP_JOB_KEY, runId: "j1", trigger: "schedule", scheduledAt: new Date().toISOString() });
    expect(fake.callsOf("sandboxes").length).toBeGreaterThan(0);
  });

  /** A promise that only settles when `open` is called, and a promise that settles when someone waits on it. */
  function barrier() {
    let open!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    return { gate, reached, open, entered };
  }

  // Review round 4: the sweep chose to delete a stopped VM from what it read
  // before an awaited issue lookup, and deleted it without the card lock.
  it("the sweep's delete of a stopped VM re-checks under the card lock: a run that resumed the card meanwhile keeps its VM and mapping", async () => {
    await plugin.definition.onShutdown?.();
    const issues = new Map([[ISSUE, { status: "in_progress" }]]);
    await setup({ issues });
    const first = await acquire("run-1");
    const sandboxId = first.providerLeaseId!;
    await release(first);
    await currentManager().sweepInFlight();
    clock.t += 8 * 24 * 3600 * 1000; // untouched past deleteAfterDays
    const pause = barrier();
    const realGet = harness.ctx.issues.get;
    harness.ctx.issues.get = async (issueId: string) => {
      pause.entered();
      await pause.gate;
      return issues.get(issueId) ?? null;
    };
    const sweeping = currentManager().sweep("test", { force: true });
    await pause.reached;
    // While the sweep waits on the card's issue, a new run resumes the card's VM.
    const second = await acquire("run-2");
    expect(second.providerLeaseId).toBe(sandboxId);
    harness.ctx.issues.get = realGet;
    pause.open();
    const report = await sweeping;
    expect(report.deleted).toEqual([]);
    expect(fake.callsOf("deleteSandbox")).toHaveLength(0);
    expect(fake.boxes.get(sandboxId)?.state).toBe("ready");
    const doc = harness.state.get(`company|${COMPANY}|boat-sandbox|vms`) as { vms: Record<string, { sandboxId: string; status: string; activeRunIds: string[] }> };
    expect(doc.vms[`ew:${WORKSPACE}`]).toMatchObject({ sandboxId, status: "running", activeRunIds: ["run-2"] });
    // Once the run releases it and it is untouched again, the sweep still cleans it up.
    await release(second);
    clock.t += 8 * 24 * 3600 * 1000;
    expect((await currentManager().sweep("test", { force: true })).deleted).toEqual([sandboxId]);
  });

  it("the sweep's delete of a stopped orphan waits for a run that is adopting it by name, and then leaves it alone", async () => {
    const first = await acquire("run-1");
    const sandboxId = first.providerLeaseId!;
    await release(first);
    await currentManager().sweepInFlight();
    harness.state.clear(); // plugin state lost: the VM is an orphan the next run finds by its name
    clock.t += 8 * 24 * 3600 * 1000;
    const pause = barrier();
    const realLimits = fake.limits.bind(fake);
    fake.limits = async (args: Record<string, unknown> = {}) => {
      pause.entered();
      await pause.gate;
      return await realLimits(args);
    };
    // The run finds the orphan by name and stops at the budget check before its resume.
    const adopting = acquire("run-2");
    await pause.reached;
    const sweeping = currentManager().sweep("test", { force: true });
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    fake.limits = realLimits;
    pause.open();
    const second = await adopting;
    expect(second.providerLeaseId).toBe(sandboxId);
    const report = await sweeping;
    expect(report.deleted).toEqual([]);
    expect(fake.boxes.get(sandboxId)?.state).toBe("ready");
  });

  it("the sweep's stop of an idle orphan waits for a run that is adopting it by name, then leaves it running", async () => {
    const first = await acquire("run-1");
    const sandboxId = first.providerLeaseId!;
    await currentManager().sweepInFlight();
    harness.state.clear(); // plugin state lost while the VM runs: an orphan
    clock.t += 20 * 60 * 1000; // idle past idleStopMinutes
    const pause = barrier();
    const realList = fake.sandboxes.bind(fake);
    let calls = 0;
    fake.sandboxes = async (args: Record<string, unknown> = {}) => {
      calls += 1;
      if (calls === 1) {
        // The run's lookup by name; the sweep's own listing below passes.
        pause.entered();
        await pause.gate;
      }
      return await realList(args);
    };
    const adopting = acquire("run-2");
    await pause.reached;
    const sweeping = currentManager().sweep("test", { force: true });
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    pause.open();
    const second = await adopting;
    expect(second.providerLeaseId).toBe(sandboxId);
    expect(second.metadata).toMatchObject({ startKind: "reuse_running" });
    const report = await sweeping;
    fake.sandboxes = realList;
    expect(report.stopped).toEqual([]);
    expect(fake.callsOf("stop")).toHaveLength(0);
    expect(fake.boxes.get(sandboxId)?.state).toBe("ready");
  });

  // Review round 4: an unreadable company state hid its records, so its VMs looked like orphans.
  it("treats VMs as of unknown ownership while a company's state cannot be read: no orphan stop or delete, other companies still swept", async () => {
    const OTHER = "66666666-6666-4666-8666-666666666666";
    const unreadable = await acquire("run-a");
    const readable = await acquire("run-b", { companyId: OTHER, executionWorkspaceId: "77777777-7777-4777-8777-777777777777" });
    await currentManager().sweepInFlight();
    const realGet = harness.ctx.state.get;
    harness.ctx.state.get = async (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
      if (input.scopeKind === "company" && input.scopeId === COMPANY) throw new Error("state store unavailable");
      return await realGet(input);
    };
    clock.t += 61 * 60 * 1000; // past idleStopMinutes and staleLeaseMinutes
    const report = await currentManager().sweep("test", { force: true });
    expect(report.errors.some((line) => line.startsWith(`state ${COMPANY}`))).toBe(true);
    expect(report.stopped).toEqual([readable.providerLeaseId]);
    expect(report.deleted).toEqual([]);
    expect(fake.boxes.get(unreadable.providerLeaseId!)?.state).toBe("ready");
    expect(fake.boxes.get(readable.providerLeaseId!)?.state).toBe("archived");
    // Readable again: its lease is now stale, and it is stopped like any other.
    harness.ctx.state.get = realGet;
    expect((await currentManager().sweep("test", { force: true })).stopped).toEqual([unreadable.providerLeaseId]);
  });
});

describe("host invocation scopes (as the Paperclip host enforces them)", () => {
  beforeEach(async () => {
    await plugin.definition.onShutdown?.();
    setManagerOverridesForTests({
      now: () => clock.t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock.t += ms;
      },
    });
    await setup({ hostScopes: { proactiveCompanies: [COMPANY] } });
  });

  it("the scheduled sweep runs outside the job's company-less invocation and stops an idle VM", async () => {
    // A run that never released (a crash): the VM is up and idle.
    const lease = await inHostInvocation(COMPANY, () => acquire("run-1"));
    await currentManager().sweepInFlight();
    clock.t += 70 * 60 * 1000;
    await inHostInvocation(null, () =>
      harness.jobs.get(SWEEP_JOB_KEY)!({ jobKey: SWEEP_JOB_KEY, runId: "j1", trigger: "schedule", scheduledAt: new Date().toISOString() }),
    );
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
    expect(harness.logs.filter((entry) => entry.level === "warn" && /sweep failed/.test(entry.message))).toEqual([]);
  });

  it("the sweep started after an acquire does not reuse the finished request", async () => {
    await inHostInvocation(COMPANY, () => acquire("run-1"));
    await currentManager().sweepInFlight();
    expect(harness.logs.filter((entry) => entry.level === "warn" && /sweep failed/.test(entry.message))).toEqual([]);
    expect(fake.callsOf("sandboxes").length).toBeGreaterThan(0);
  });

  it("skips a company the host refuses instead of failing the whole sweep", async () => {
    await inHostInvocation(COMPANY, () => acquire("run-1"));
    await currentManager().sweepInFlight();
    await inHostInvocation("99999999-9999-4999-8999-999999999999", () =>
      plugin.definition.onEnvironmentProbe!({ ...base(), companyId: "99999999-9999-4999-8999-999999999999" } as never),
    );
    clock.t += 2 * 60 * 1000;
    const report = await currentManager().sweep("test", { force: true });
    expect(report.errors.some((line) => line.startsWith("state 99999999-"))).toBe(true);
    expect(fake.callsOf("sandboxes").length).toBeGreaterThan(0);
  });
});

describe("usage accounting API", () => {
  it("returns cost per card and per run from boat's usage meter", async () => {
    fake.usageDollarsPerSecond = 0.00001;
    const lease = await acquire("run-1");
    clock.t += 30 * 60 * 1000;
    await release(lease);
    fake.usageSeconds.set(lease.providerLeaseId!, 1900);
    const response = await plugin.definition.onApiRequest!({
      routeKey: "usage",
      method: "GET",
      path: "/usage",
      params: {},
      query: { companyId: COMPANY },
      body: null,
      actor: { actorType: "user", actorId: "u1" },
      companyId: COMPANY,
      headers: {},
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      totals: { seconds: number; dollars: number; runs: number };
      cards: Array<{ issueId: string; seconds: number }>;
      vms: Array<{ runs: Array<{ runId: string; seconds: number; dollars: number; source: string }> }>;
    };
    expect(body.totals).toMatchObject({ seconds: 1900, dollars: 0.019, runs: 1 });
    expect(body.cards[0]).toMatchObject({ issueId: ISSUE, seconds: 1900 });
    expect(body.vms[0].runs[0]).toMatchObject({ runId: "run-1", seconds: 1800, source: "boat" });
    expect(body.vms[0].runs[0].dollars).toBeCloseTo(0.018, 6);
  });
});

describe("usage refresh", () => {
  it("re-reads run windows that were read right at the stop, because boat's meter can lag", async () => {
    const lease = await acquire("run-1");
    clock.t += 10 * 60 * 1000;
    await release(lease);
    fake.usageDollarsPerSecond = 0.00002;
    clock.t += 5 * 60 * 1000;
    const summary = await currentManager().usageSummary(COMPANY, { refresh: true });
    const run = (summary.vms[0].runs as Array<{ dollars: number }>)[0];
    expect(run.dollars).toBeCloseTo(600 * 0.00002, 6);
  });
});

describe("templates", () => {
  it("captures a named snapshot and waits until it is ready", async () => {
    const lease = await acquire("run-1");
    fake.namedSnapshotPolls = 2;
    const result = await plugin.definition.onEnvironmentCaptureTemplate!({
      ...base(),
      providerLeaseId: lease.providerLeaseId,
      templateLabel: "Two Bot Next warm",
    } as never);
    expect(result).toMatchObject({ templateRef: "two-bot-next-warm", templateKind: "snapshot" });
    expect(fake.callsOf("saveNamedSnapshot")[0].args).toEqual({ sandboxId: lease.providerLeaseId, name: "two-bot-next-warm" });
    expect(fake.callsOf("getNamedSnapshot")).toHaveLength(2);
  });

  it("refuses to capture beyond the free named-snapshot allowance", async () => {
    const lease = await acquire("run-1");
    fake.namedAllowance = { free: 10, used: 10 };
    await expect(
      plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: lease.providerLeaseId, templateLabel: "x" } as never),
    ).rejects.toMatchObject({ code: "BOAT_NAMED_SNAPSHOT_NOT_FREE" });
    expect(fake.callsOf("saveNamedSnapshot")).toHaveLength(0);
  });

  it("deletes a named snapshot template", async () => {
    const lease = await acquire("run-1");
    await plugin.definition.onEnvironmentCaptureTemplate!({ ...base(), providerLeaseId: lease.providerLeaseId, templateLabel: "tpl" } as never);
    await expect(plugin.definition.onEnvironmentDeleteTemplate!({ ...base(), templateRef: "tpl" } as never)).resolves.toMatchObject({ deleted: true });
    await expect(plugin.definition.onEnvironmentDeleteTemplate!({ ...base(), templateRef: "tpl" } as never)).resolves.toMatchObject({ deleted: false });
  });
});

describe("Probe", () => {
  it("checks the API, the budget and ssh without starting a VM", async () => {
    const result = await plugin.definition.onEnvironmentProbe!({ ...base({ cliproxyTunnel: false }) } as never);
    expect(result.ok).toBe(true);
    expect(fake.callsOf("create")).toHaveLength(0);
    expect(fake.callsOf("resume")).toHaveLength(0);
    expect(result.diagnostics?.map((entry) => entry.code)).toContain("budget_ok");
  });

  it("warns when a start would be refused right now", async () => {
    fake.limitsResponse = trialLimits({ activeSandboxes: 2 });
    const result = await plugin.definition.onEnvironmentProbe!({ ...base({ cliproxyTunnel: false }) } as never);
    expect(result.diagnostics?.map((entry) => entry.code)).toContain("budget_maxActive");
  });
});

describe("offload API routes", () => {
  const RUN_ID = "run-offload-1";
  const CMD_ID = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";

  async function seedWorkspace(): Promise<void> {
    await currentManager().rememberOffloadWorkspace(nativeWorkspaceParams(COMPANY, RUN_ID, WORKSPACE));
  }

  function apiInput(routeKey: string, extra: Record<string, unknown> = {}) {
    return {
      routeKey,
      method: "POST",
      path: "/",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "agent", actorId: "agent-1", runId: RUN_ID },
      companyId: COMPANY,
      headers: {},
      ...extra,
    };
  }

  function submitBody(over: Record<string, unknown> = {}) {
    return {
      version: 1,
      commandId: CMD_ID,
      executionWorkspaceId: WORKSPACE,
      cwdRelative: ".",
      argv: ["test", "--locked"],
      env: { CARGO_TERM_COLOR: "never" },
      queueTimeoutMs: 30000,
      timeoutMs: 1200000,
      dryRun: false,
      ...over,
    };
  }

  it("declares agent-authenticated offload routes", () => {
    const routes = manifest.apiRoutes ?? [];
    expect(routes.map((route) => route.routeKey)).toEqual(
      expect.arrayContaining(["offload_exec", "offload_read", "offload_heartbeat", "offload_cancel"]),
    );
    for (const key of ["offload_exec", "offload_read", "offload_heartbeat", "offload_cancel"]) {
      expect(routes.find((route) => route.routeKey === key)).toMatchObject({ auth: "agent", capability: "api.routes.register" });
    }
    // execution.workspaces.read serves only the local-run binding (local-run-binding.ts), never the request body.
    expect(manifest.capabilities).toContain("execution.workspaces.read");
  });

  it("submits, reads, heartbeats and cancels through the plugin dispatch", async () => {
    await seedWorkspace();
    const submit = await plugin.definition.onApiRequest!(apiInput("offload_exec", { body: submitBody() }) as never);
    expect(submit.status).toBe(202);
    // Until the executor wires in, every submit journals not_started and the
    // shim falls back locally: safe by construction.
    const read = await plugin.definition.onApiRequest!(apiInput("offload_read", { method: "GET", params: { commandId: CMD_ID } }) as never);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ state: "not_started", remoteStarted: false, fallbackSafe: true });
    const beat = await plugin.definition.onApiRequest!(apiInput("offload_heartbeat", { params: { commandId: CMD_ID } }) as never);
    expect(beat.status).toBe(200);
    const cancel = await plugin.definition.onApiRequest!(apiInput("offload_cancel", { params: { commandId: CMD_ID }, body: { reason: "client_signal" } }) as never);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ state: "not_started" });
  });

  it("denies user actors and unknown workspaces at the dispatch", async () => {
    await seedWorkspace();
    const userActor = await plugin.definition.onApiRequest!(
      apiInput("offload_exec", { body: submitBody(), actor: { actorType: "user", actorId: "u1" } }) as never,
    );
    expect(userActor.status).toBe(401);
    const unknownWs = await plugin.definition.onApiRequest!(
      apiInput("offload_exec", { body: submitBody({ executionWorkspaceId: "00000000-0000-4000-8000-000000000099" }) }) as never,
    );
    expect(unknownWs.status).toBe(403);
  });

  it("dry-runs through the dispatch with no journal effect", async () => {
    await seedWorkspace();
    const dry = await plugin.definition.onApiRequest!(apiInput("offload_exec", { body: submitBody({ dryRun: true }) }) as never);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ mode: "remote_candidate", profileId: "rust-public-1" });
    const read = await plugin.definition.onApiRequest!(apiInput("offload_read", { method: "GET", params: { commandId: CMD_ID } }) as never);
    expect(read.status).toBe(400);
  });
});
