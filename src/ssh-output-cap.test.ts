// Whole-run execute must bound the output the host worker holds: a guest
// that floods stdout/stderr for the whole timeout grows the worker heap
// until it takes down every company/lease the worker serves. These tests
// pin the contract: truncate mode keeps exactly the cap-sized byte prefix,
// flags the cut, and preserves the command's own exit; fail mode (control
// plane) rejects instead; output within the cap is byte-identical.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const actualSpawn = vi.hoisted(() => ({ current: null as ((...args: never[]) => unknown) | null }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  actualSpawn.current = actual.spawn as unknown as (...args: never[]) => unknown;
  return { ...actual, spawn: spawnMock };
});

import { setBoatApiFactoryForTests } from "./boat-client.js";
import type { BoatApiLike } from "./boat-client.js";
import plugin, { setManagerOverridesForTests } from "./plugin.js";
import { runProcess, runStreamProcess } from "./ssh.js";
import { FakeBoat } from "./test-support/fake-boat.js";
import { FakeSsh, createFakeContext } from "./test-support/harness.js";

const CAP = 65_536;

function writerScript(stdoutBytes: number, stderrBytes: number, exitCode = 0): string {
  return [
    "import os",
    `os.write(1, b'a' * ${stdoutBytes})`,
    `os.write(2, b'e' * ${stderrBytes})`,
    `raise SystemExit(${exitCode})`,
  ].join("\n") + "\n";
}

describe("runStreamProcess output cap", () => {
  // The module-level spawn mock belongs to the execute tests below; the
  // direct-process tests need the real spawn.
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(actualSpawn.current as never);
  });
  it("truncates each stream to the cap and preserves the command's exit", async () => {
    const result = await runStreamProcess("python3", ["-c", writerScript(3 * CAP, CAP / 2, 7)], {
      timeoutMs: 10_000,
      maxOutputBytes: CAP,
      outputLimitBehavior: "truncate",
    });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("a".repeat(CAP));
    expect(result.stderr).toBe("e".repeat(CAP / 2));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBeUndefined();
  }, 15_000);

  it("flags each cut stream independently", async () => {
    const result = await runStreamProcess("python3", ["-c", writerScript(2 * CAP, 2 * CAP)], {
      timeoutMs: 10_000,
      maxOutputBytes: CAP,
      outputLimitBehavior: "truncate",
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdout).toHaveLength(CAP);
    expect(result.stderr).toHaveLength(CAP);
  }, 15_000);

  it("passes output exactly at the cap through with no truncation flag", async () => {
    const result = await runStreamProcess("python3", ["-c", writerScript(CAP, 0)], {
      timeoutMs: 10_000,
      maxOutputBytes: CAP,
      outputLimitBehavior: "truncate",
    });
    expect(result.stdout).toBe("a".repeat(CAP));
    expect(result.stdoutTruncated).toBeUndefined();
    expect(result.stderrTruncated).toBeUndefined();
  }, 15_000);

  it("rejects past the cap in the default fail mode with SSH_CONTROL_OUTPUT_LIMIT", async () => {
    await expect(
      runStreamProcess("python3", ["-c", writerScript(2 * CAP, 0)], {
        timeoutMs: 10_000,
        maxOutputBytes: CAP,
      }),
    ).rejects.toMatchObject({ code: "SSH_CONTROL_OUTPUT_LIMIT" });
  }, 15_000);

  it("rejects invalid caps and limit behaviors before spawning", async () => {
    await expect(runStreamProcess("python3", ["-c", "pass"], { timeoutMs: 5_000, maxOutputBytes: -1 })).rejects.toThrow(
      "Invalid streaming process limits.",
    );
    await expect(runStreamProcess("python3", ["-c", "pass"], { timeoutMs: 5_000, maxOutputBytes: Number.NaN })).rejects.toThrow(
      "Invalid streaming process limits.",
    );
    await expect(
      runStreamProcess("python3", ["-c", "pass"], {
        timeoutMs: 5_000,
        maxOutputBytes: CAP,
        outputLimitBehavior: "bogus" as never,
      }),
    ).rejects.toThrow("Invalid streaming process limits.");
  }, 15_000);
});

describe("runProcess output cap", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(actualSpawn.current as never);
  });
  it("fails closed on a runaway local helper instead of collecting forever", async () => {
    await expect(
      runProcess("python3", ["-c", writerScript(2 * CAP, 0)], { timeoutMs: 10_000, maxOutputBytes: CAP }),
    ).rejects.toMatchObject({ code: "SSH_CONTROL_OUTPUT_LIMIT" });
  }, 15_000);

  it("returns small output byte-identical", async () => {
    const result = await runProcess("python3", ["-c", writerScript(100, 50)], { timeoutMs: 10_000 });
    expect(result.stdout).toBe("a".repeat(100));
    expect(result.stderr).toBe("e".repeat(50));
    expect(result.exitCode).toBe(0);
  }, 15_000);
});

describe("execute output cap", () => {
  const companyId = "company-output-cap";
  const environmentId = "environment-output-cap";
  const baseConfig = { apiKey: "boat_test_key_not_real", cliproxyTunnel: false, executeMaxOutputBytes: CAP };
  let fake: FakeBoat;
  let ssh: FakeSsh;
  let clock: number;

  beforeEach(async () => {
    clock = Date.parse("2026-10-23T08:00:00Z");
    fake = new FakeBoat({ now: () => clock });
    ssh = new FakeSsh();
    spawnMock.mockReset();
    spawnMock.mockImplementation(ssh.spawn);
    setBoatApiFactoryForTests(() => fake as unknown as BoatApiLike);
    setManagerOverridesForTests({ now: () => clock, sleep: async (ms) => { clock += ms; } });
    const harness = createFakeContext();
    await plugin.definition.setup(harness.ctx as never);
  });

  afterEach(async () => {
    await plugin.definition.onShutdown?.();
    setBoatApiFactoryForTests(null);
  });

  async function acquire() {
    return await plugin.definition.onEnvironmentAcquireLease!({
      companyId, environmentId, driverKey: "boat", config: baseConfig, runId: "run-cap-1", issueId: "issue-cap",
    });
  }

  it("bounds a flooding command to the cap prefix and flags it in the result", async () => {
    const lease = await acquire();
    ssh.handler = (remoteCommand) =>
      remoteCommand.includes("review-storm-command")
        ? { code: 3, stdout: "x".repeat(3 * CAP), stderr: "y".repeat(CAP + 10) }
        : undefined;
    const result = await plugin.definition.onEnvironmentExecute!({
      companyId, environmentId, driverKey: "boat", config: baseConfig, lease,
      command: "review-storm-command", args: [], env: {},
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("x".repeat(CAP));
    expect(result.metadata).toMatchObject({
      provider: "boat",
      outputTruncated: true,
      stdoutTruncated: true,
      stderrTruncated: true,
      maxOutputBytes: CAP,
    });
    expect(result.stderr).toContain(`boat: stdout and stderr exceeded ${CAP} bytes and was truncated`);
  });

  it("returns output within the cap byte-identical with no truncation fields", async () => {
    const lease = await acquire();
    const payload = "hello fixture\n";
    ssh.handler = (remoteCommand) =>
      remoteCommand.includes("review-quiet-command") ? { code: 0, stdout: payload } : undefined;
    const result = await plugin.definition.onEnvironmentExecute!({
      companyId, environmentId, driverKey: "boat", config: baseConfig, lease,
      command: "review-quiet-command", args: [], env: {},
    });
    expect(result.stdout).toBe(payload);
    expect(result.metadata).toMatchObject({ provider: "boat" });
    expect(result.metadata).not.toHaveProperty("outputTruncated");
    expect(result.stderr).not.toContain("was truncated");
  });
});
