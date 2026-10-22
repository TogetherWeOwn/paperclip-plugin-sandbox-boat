import { describe, expect, it } from "vitest";
import { checkBudget, readBudget } from "./budget.js";
import { parseDriverConfig } from "./config.js";
import { describeBoatError } from "./errors.js";
import { buildLoginShellScript, buildRemoteEnvFileContents } from "./shell.js";
import { endpointFromSshKeyResponse } from "./ssh.js";
import { resolveVmKey, sandboxNameFor, sanitizeSnapshotName } from "./vm-manager.js";
import { responseError, trialLimits } from "./test-support/fake-boat.js";

describe("readBudget", () => {
  it("reads the flat GET /limits shape that boat returns on the trial", () => {
    const snapshot = readBudget(trialLimits({ creditUsedSeconds: 3600 }));
    expect(snapshot).toMatchObject({
      accessTier: "trial",
      canStart: true,
      activeSandboxes: 0,
      maxActiveSandboxes: 2,
      startsDayUsed: 0,
      startsDayLimit: 75,
      startsMinuteRemaining: 5,
      trialComputeCapHours: 25,
    });
    expect(snapshot.computeHoursLeft).toBe(24);
  });

  it("also reads fields nested under upgradeEffects (older SDK typings)", () => {
    const snapshot = readBudget({ ok: true, upgradeEffects: { canStart: true, activeSandboxes: 1, maxActiveSandboxes: 100, creditBalanceSeconds: 7200 } });
    expect(snapshot).toMatchObject({ activeSandboxes: 1, maxActiveSandboxes: 100, computeHoursLeft: 2 });
  });

  it("uses the smaller of the trial cap and the balance", () => {
    expect(readBudget(trialLimits({ creditBalanceSeconds: 1800 })).computeHoursLeft).toBe(0.5);
  });

  it("passes when everything is within limits and never counts past boat's own plan limits", () => {
    const config = parseDriverConfig({ maxActive: 50, maxStartsPerDay: 500 });
    expect(checkBudget(readBudget(trialLimits()), config, "default")).toBeNull();
    const refusal = checkBudget(readBudget(trialLimits({ activeSandboxes: 2 })), config, "default");
    expect(refusal?.limit).toBe("maxActive");
  });
});

describe("config", () => {
  it("defaults match the boat trial and the owner's cost rules", () => {
    expect(parseDriverConfig({})).toMatchObject({
      size: "default",
      autoStopMinutes: 120,
      idleStopMinutes: 15,
      maxActive: 2,
      maxStartsPerDay: 70,
      minComputeHoursLeft: 1,
      noEnv: true,
      failFast: true,
      apiBase: "https://boat.dev/api/v1",
      templateSnapshot: null,
    });
  });
});

describe("errors", () => {
  it("reads boat's error envelope from a ResponseError", async () => {
    const info = await describeBoatError(responseError(429, { code: "rate_limited", window: "day", limit: 75, requestId: "req_1" }));
    expect(info).toMatchObject({ status: 429, code: "rate_limited", window: "day", limit: 75, requestId: "req_1" });
    const nested = await describeBoatError(
      responseError(502, { code: "sandbox_direct_failed", error: { code: "sandbox_direct_failed", details: { retryable: true } } }),
    );
    expect(nested.retryable).toBe(true);
  });
});

describe("ssh endpoint", () => {
  it("uses sshEndpoint when boat sets it, else machineIp:22", () => {
    expect(endpointFromSshKeyResponse({ sshEndpoint: "ssh.boat.dev:40022", hostKey: "ssh-ed25519 A", sshUser: "user" })).toEqual({
      host: "ssh.boat.dev",
      port: 40022,
      user: "user",
      hostKey: "ssh-ed25519 A",
    });
    expect(endpointFromSshKeyResponse({ sshEndpoint: "[2001:db8::1]:2222", hostKey: "k" })).toMatchObject({ host: "2001:db8::1", port: 2222 });
    expect(endpointFromSshKeyResponse({ machineIp: "203.0.113.5", hostKey: "k" })).toEqual({ host: "203.0.113.5", port: 22, user: "user", hostKey: "k" });
    expect(() => endpointFromSshKeyResponse({ machineIp: "203.0.113.5" })).toThrow(/host key/);
  });
});

describe("keys and names", () => {
  it("keys a VM to the execution workspace, then the issue, then the run", () => {
    expect(resolveVmKey({ executionWorkspaceId: "ew1", issueId: "i1", runId: "r1" })).toEqual({ key: "ew:ew1", kind: "executionWorkspace" });
    expect(resolveVmKey({ issueId: "i1", runId: "r1" })).toEqual({ key: "issue:i1", kind: "issue" });
    expect(resolveVmKey({ runId: "r1" })).toEqual({ key: "run:r1", kind: "run" });
  });

  it("names are deterministic, prefixed and opaque", () => {
    const a = sandboxNameFor("paperclip", "c", "e", "ew:1");
    expect(a).toMatch(/^paperclip-[0-9a-f]{16}$/);
    expect(sandboxNameFor("paperclip", "c", "e", "ew:1")).toBe(a);
    expect(sandboxNameFor("paperclip", "c", "e", "ew:2")).not.toBe(a);
  });

  it("sanitizes template names", () => {
    expect(sanitizeSnapshotName("Two Bot Next / warm!", "fallback")).toBe("two-bot-next-warm");
    expect(sanitizeSnapshotName("", "fallback")).toBe("fallback");
  });
});

describe("shell", () => {
  it("quotes env values for the staged file", () => {
    expect(buildRemoteEnvFileContents([["A", "it's"]])).toBe("export A='it'\"'\"'s';\n");
  });

  it("sources then removes the env file around the payload", () => {
    const script = buildLoginShellScript({ command: "node", args: ["x.js"], cwd: "/w", remoteEnvPath: "/w/.e.sh" });
    expect(script).toContain("cd '/w'");
    expect(script).toContain("if [ -f '/w/.e.sh' ]; then . '/w/.e.sh'; fi");
    expect(script).toContain("'node' 'x.js'; rc=$?; rm -f '/w/.e.sh'; exit $rc");
    expect(script).not.toContain("exec 'node'");
  });
});
