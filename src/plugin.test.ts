import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import manifest, { DRIVER_KEY, SWEEP_JOB_KEY } from "./manifest.js";
import plugin, { currentManager, setManagerOverridesForTests } from "./plugin.js";
import { FakeBoat, responseError, trialLimits } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext, inHostInvocation } from "./test-support/harness.js";
import type { BoatApiLike } from "./boat-client.js";
import type { BoatProviderError } from "./errors.js";

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
    expect(manifest.apiRoutes?.map((route) => route.routeKey)).toEqual(["usage", "sweep"]);
    expect(harness.jobs.has(SWEEP_JOB_KEY)).toBe(true);
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
      size: "default",
      autoStopMinutes: 120,
      idleStopMinutes: 15,
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
  it("creates a VM for a new card with monitoring off, noEnv, fail-fast, an idempotency key and the trial TTL", async () => {
    const lease = await acquire("run-1");
    const create = fake.callsOf("create");
    expect(create).toHaveLength(1);
    expect(create[0].args).toMatchObject({
      type: "default",
      ttlSeconds: 7200,
      monitoring: false,
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
    expect(master.args).toEqual(expect.arrayContaining(["-R", "127.0.0.1:8317:cliproxy:8317", "ExitOnForwardFailure=yes", "StrictHostKeyChecking=yes", `HostKeyAlias=${sandboxId}`, "BatchMode=yes"]));
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
    await expect(release(first)).resolves.toBeUndefined();
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

  it("stops a VM it started when SSH setup fails, so nothing keeps billing", async () => {
    ssh.handler = () => ({ code: 1, stderr: "permission denied" });
    await expect(acquire("run-1")).rejects.toMatchObject({ code: "BOAT_SSH_FAILED" });
    const [sandbox] = [...fake.boxes.values()];
    expect(sandbox.state).toBe("archived");
    expect(fake.callsOf("stop")).toHaveLength(1);
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

  it("returns no receipt (and does not throw) when the stop is still pending, but StopLease throws", async () => {
    const lease = await acquire("run-1");
    fake.stopMode = "never";
    await expect(release(lease)).resolves.toBeUndefined();
    // Another card: this one's VM is still stopping, which a new run waits for.
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

/** The script inside `sh -c '<script>'`, undoing shellQuote. */
function unquoteShDashC(remoteCommand: string): string {
  const quoted = remoteCommand.replace(/^sh -c /, "");
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
      env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
      timeoutMs: 60_000,
    } as never);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: "ok\n" });
    const calls = ssh.spawned.slice(before);
    for (const call of ssh.spawned) {
      expect(call.args.join(" ")).not.toContain(SECRET);
    }

    // Staged over stdin into a fresh 0700 directory under /tmp, which no boat snapshot saves.
    const staging = calls.find((call) => call.args.at(-1)!.includes("umask 077 && mkdir -m 700"));
    expect(staging?.stdin).toContain(`export ANTHROPIC_API_KEY='${SECRET}';`);
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
    const run = calls.find((call) => call.args.at(-1)!.startsWith("sh -c ") && call.args.at(-1)!.includes("claude"));
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
      await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true", env: { A: "1" } } as never);
    }
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
  });

  it("removes the staged env file itself when ssh fails before the script could, and the VM is still up", async () => {
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    ssh.handler = (remoteCommand) => (remoteCommand.startsWith("sh -c ") ? { code: 255, stderr: "Connection reset" } : undefined);
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true", env: { A: SECRET } } as never);
    expect(result.exitCode).toBe(255);
    const commands = ssh.spawned.slice(before).map((call) => call.args.at(-1)!);
    const envDir = commands.find((command) => command.includes("mkdir -m 700"))!.match(/'(\/tmp\/paperclip-boat-env-[0-9a-f]{32})'/)![1];
    expect(commands.at(-1)).toBe(`rm -f '${envDir}/env.sh'; rmdir '${envDir}' 2>/dev/null`);
  });

  it("removes the staged env file when staging fails part way", async () => {
    const lease = await acquire("run-1");
    const before = ssh.spawned.length;
    ssh.handler = (remoteCommand) => (remoteCommand.includes("mkdir -m 700") ? { code: 1, stderr: "No space left on device" } : undefined);
    const result = await plugin.definition.onEnvironmentExecute!({ ...base(), lease, command: "true", env: { A: SECRET } } as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/could not stage the run environment/);
    const commands = ssh.spawned.slice(before).map((call) => call.args.at(-1)!);
    expect(commands.some((command) => command.startsWith("sh -c "))).toBe(false);
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

  it("realizes the workspace directory on the VM", async () => {
    const lease = await acquire("run-1");
    const result = await plugin.definition.onEnvironmentRealizeWorkspace!({ ...base(), lease, workspace: { localPath: "/tmp/x" } } as never);
    expect(result).toEqual({ cwd: "/home/user/paperclip-workspace", metadata: { provider: "boat", remoteCwd: "/home/user/paperclip-workspace" } });
    expect(ssh.execs().at(-1)!.args.at(-1)).toContain("mkdir -p");
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
    clock.t += 10 * 60 * 1000;
    let report = await currentManager().sweep("test", { force: true });
    expect(report.stopped).toEqual([]);
    clock.t += 6 * 60 * 1000;
    report = await currentManager().sweep("test", { force: true });
    expect(report.stopped).toEqual([lease.providerLeaseId]);
    expect(fake.boxes.get(lease.providerLeaseId!)?.state).toBe("archived");
  });

  it("stops a VM whose lease is still held but idle beyond staleLeaseMinutes", async () => {
    const lease = await acquire("run-1");
    clock.t += 30 * 60 * 1000;
    expect((await currentManager().sweep("test", { force: true })).stopped).toEqual([]);
    clock.t += 31 * 60 * 1000;
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
